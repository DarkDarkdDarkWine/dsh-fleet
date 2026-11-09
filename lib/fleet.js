import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { AddressBook, localAddresses } from "./addresses.js";
import { memberIdOf } from "./identity.js";
import { PIN_PATTERN, PinGuard, checkPin, createVerifier } from "./pin.js";
import { createEvent } from "./roster/events.js";
import { RosterLog } from "./roster/log.js";
import { foldState } from "./roster/state.js";
import { StoreCorruptError, readJson, writeJsonAtomic } from "./store.js";
import { UnreachableError, requestMember } from "./transport/client.js";
import { startFleetServer } from "./transport/server.js";
import { VERSION } from "./version.js";

/**
 * Orchestrates one fleet member: roster, PIN, address book, fleet port.
 * Files in dataDir: identity.json (Task 2), roster.json (secret: holds the PIN
 * verifier), state.json (self name, address book, PIN lockouts, rejected flag).
 */

export class FleetError extends Error {
	/** @param {string} code @param {object} [extra] */
	constructor(code, extra = {}) {
		super(code);
		this.name = "FleetError";
		this.code = code;
		Object.assign(this, extra);
	}
}

const REMOTE_CODES = new Set(["bad-pin", "pin-locked", "pin-format", "key-mismatch", "not-joined", "removed", "rate-limited", "roster-corrupt"]);
const MAX_NAME = 64;
const cleanName = (name, fallback) => (typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME) : fallback);
const json = (status, body) => ({ status, body });

export class FleetService {
	/** @param {{ dataDir: string, settings: import("./settings.js").Settings, identity: import("./identity.js").Identity, discovery: object, logger: { info(m: string): void, warn(m: string): void }, now?: () => number }} opts */
	constructor({ dataDir, settings, identity, discovery, logger, now = Date.now }) {
		this.dataDir = dataDir;
		this.settings = settings;
		this.identity = identity;
		this.discovery = discovery;
		this.logger = logger;
		this.now = now;
		this.rosterPath = join(dataDir, "roster.json");
		this.statePath = join(dataDir, "state.json");
		this.error = null;
		this.listening = { error: "not-started" };
		this.server = null;
		this.chain = Promise.resolve();
		this.log = new RosterLog();
		this.fold = null;
		this.state = { v: 1, selfName: null, addressBook: {}, pinGuard: {}, rejected: false };
	}

	// ── lifecycle ──────────────────────────────────────────────

	/** @param {{ extraRoutes?: Record<string, import("./transport/server.js").Route> }} [opts] */
	async start({ extraRoutes = {} } = {}) {
		this.loadFiles();
		this.guard = new PinGuard({ load: () => this.state.pinGuard, save: (pinGuard) => this.saveState({ pinGuard }), now: this.now });
		this.book = new AddressBook({ load: () => this.state.addressBook, save: (addressBook) => this.saveState({ addressBook }), now: this.now });
		this.extraRoutes = extraRoutes;
		await this.listen();
		this.advertise();
	}

	loadFiles() {
		try {
			this.state = { ...this.state, ...readJson(this.statePath, {}) };
		} catch (err) {
			if (!(err instanceof StoreCorruptError)) throw err;
			this.error = "state-corrupt";
			this.logger.warn(`dsh-fleet: ${err.path} is corrupt; fleet disabled until it is fixed or removed`);
		}
		try {
			this.setLog(new RosterLog(readJson(this.rosterPath, { events: [] }).events ?? []));
		} catch (err) {
			if (!(err instanceof StoreCorruptError)) throw err;
			this.error = "roster-corrupt";
			this.logger.warn(`dsh-fleet: ${err.path} is corrupt; fleet disabled until it is fixed or removed`);
		}
	}

	async listen() {
		try {
			this.server = await startFleetServer({
				identity: this.identity,
				host: this.settings.host,
				port: this.settings.port,
				bodyLimitBytes: this.settings.bodyLimitBytes,
				isMember: (id) => this.isMember(id),
				routes: { ...this.protocolRoutes(), ...this.extraRoutes },
				logger: this.logger,
			});
			this.listening = { port: this.server.port };
		} catch (err) {
			this.server = null;
			this.listening = { error: err?.code ?? String(err) };
			this.logger.warn(`dsh-fleet: cannot listen on ${this.settings.host}:${this.settings.port}: ${err?.message ?? err}`);
		}
	}

	async stop() {
		const server = this.server;
		this.server = null;
		await server?.close();
	}

	// ── persistence ────────────────────────────────────────────

	saveState(patch) {
		this.state = { ...this.state, ...patch };
		writeJsonAtomic(this.statePath, this.state, { warn: (m) => this.logger.warn(m) });
	}

	saveRoster() {
		writeJsonAtomic(this.rosterPath, { v: 1, events: this.log.all() }, { secret: true, warn: (m) => this.logger.warn(m) });
	}

	setLog(log) {
		this.log = log;
		this.fold = foldState(log);
	}

	/** Sign and append an event authored by this member. */
	appendEvent(type, body) {
		const e = createEvent(this.identity, { fleetId: this.fold.fleetId, type, parents: this.log.heads(), body, at: this.now() });
		const r = this.log.add(e);
		if (!r.added) throw new Error(`own ${type} event rejected: ${r.reason}`);
		this.setLog(this.log);
		this.saveRoster();
		return e;
	}

	/** Run mutations one at a time. */
	exclusive(fn) {
		const run = this.chain.then(fn);
		this.chain = run.catch(() => {});
		return run;
	}

	// ── queries ────────────────────────────────────────────────

	get selfId() {
		return this.identity.memberId;
	}

	isMember(memberId) {
		return !this.error && Boolean(this.fold?.members.has(memberId));
	}

	selfName() {
		return this.fold?.members.get(this.selfId)?.name ?? this.state.selfName ?? hostname();
	}

	hello() {
		return { fleetId: this.fold?.fleetId ?? null, fleetName: this.fold?.fleetName ?? null, memberId: this.selfId, name: this.selfName(), version: VERSION };
	}

	memberView(m) {
		const isSelf = m.memberId === this.selfId;
		const seen = this.book.entry(m.memberId).lastSeenAt;
		return {
			memberId: m.memberId,
			name: m.name,
			description: m.description,
			online: isSelf || this.book.isOnline(m.memberId, this.settings.offlineAfterMisses),
			lastSeenAt: isSelf ? this.now() : seen || null,
			addresses: isSelf ? localAddresses(this.listening.port ?? this.settings.port) : this.book.candidates(m.memberId),
			admittedBy: m.admittedBy,
			isSelf,
		};
	}

	/** @returns {object} FleetStatus (plan Task 7) */
	status() {
		const f = this.fold;
		const members = f ? [...f.members.values()].map((m) => this.memberView(m)).sort((a, b) => a.name.localeCompare(b.name)) : [];
		return {
			version: VERSION,
			joined: Boolean(f),
			fleet: f ? { id: f.fleetId, short: `${f.fleetId.slice(0, 4)}-${f.fleetId.slice(4, 8)}`.toUpperCase(), name: f.fleetName } : null,
			self: { memberId: this.selfId, name: this.selfName(), rejected: Boolean(this.state.rejected || f?.removed.has(this.selfId)) },
			members,
			pinConflict: f?.pinConflict ?? null,
			listening: this.listening,
			error: this.error,
		};
	}

	advertise() {
		try {
			this.discovery?.advertise?.({ fleetId: this.fold?.fleetId ?? "", memberId: this.selfId, name: this.selfName(), port: this.listening.port ?? this.settings.port });
		} catch (err) {
			this.logger.warn(`dsh-fleet: advertise failed: ${err?.message ?? err}`);
		}
	}

	// ── guards ─────────────────────────────────────────────────

	assertUsable() {
		if (this.error) throw new FleetError(this.error);
	}

	assertPinFormat(...pins) {
		if (!pins.every((p) => typeof p === "string" && PIN_PATTERN.test(p))) throw new FleetError("pin-format");
	}

	// ── create & join ──────────────────────────────────────────

	/** @param {{ name: string, pin: string, memberName?: string }} req */
	createFleet({ name, pin, memberName }) {
		return this.exclusive(async () => {
			this.assertUsable();
			if (this.fold) throw new FleetError("already-joined");
			this.assertPinFormat(pin);
			const selfName = cleanName(memberName, hostname());
			const create = createEvent(this.identity, {
				fleetId: randomBytes(16).toString("hex"),
				type: "fleet.create",
				parents: [],
				at: this.now(),
				body: { name: cleanName(name, "fleet"), pinVerifier: await createVerifier(pin), creator: { memberId: this.selfId, publicKeyPem: this.identity.publicKeyPem, name: selfName } },
			});
			this.setLog(new RosterLog([create]));
			this.saveRoster();
			this.saveState({ selfName, rejected: false });
			this.advertise();
			return this.status();
		});
	}

	/** @param {{ address: { host: string, port: number }, pin: string, memberName?: string }} req */
	join({ address, pin, memberName }) {
		return this.exclusive(async () => {
			this.assertUsable();
			if (this.fold) throw new FleetError("already-joined");
			this.assertPinFormat(pin);
			const selfName = cleanName(memberName, hostname());
			const r = await this.callJoin(address, { pin, memberId: this.selfId, publicKeyPem: this.identity.publicKeyPem, name: selfName });
			const log = new RosterLog();
			log.merge(Array.isArray(r.body?.events) ? r.body.events : []);
			const fold = foldState(log);
			if (!fold?.members.has(this.selfId) || !fold.members.has(r.peerMemberId)) throw new FleetError("join-failed", { reason: "roster-mismatch" });
			this.setLog(log);
			this.saveRoster();
			this.saveState({ selfName, rejected: false });
			this.book.record(r.peerMemberId, address, true);
			this.book.markSeen(r.peerMemberId);
			this.advertise();
			return this.status();
		});
	}

	async callJoin(address, body) {
		let r;
		try {
			r = await requestMember({ identity: this.identity, addresses: [address], expectMemberId: null, method: "POST", path: "/v1/join", body });
		} catch (err) {
			if (err instanceof UnreachableError) throw new FleetError("unreachable", { attempts: err.attempts });
			throw err;
		}
		if (r.status === 200) return r;
		const code = REMOTE_CODES.has(r.body?.error) ? r.body.error : "join-failed";
		throw new FleetError(code, { status: r.status, ...(r.body?.retryAfterMs ? { retryAfterMs: r.body.retryAfterMs } : {}) });
	}

	// ── protocol routes ────────────────────────────────────────

	protocolRoutes() {
		return {
			"/v1/hello": { auth: "open", method: "GET", handler: async () => json(200, this.hello()) },
			"/v1/join": { auth: "open", method: "POST", handler: (ctx) => this.exclusive(() => this.handleJoin(ctx)) },
		};
	}

	/** Server side of PIN join (spec §5.4 step 3–4). */
	async handleJoin({ memberId: tlsMemberId, body }) {
		if (this.error) return json(503, { error: this.error });
		if (!this.fold) return json(409, { error: "not-joined" });
		const lock = this.guard.status("join");
		if (lock.locked) return json(423, { error: "pin-locked", retryAfterMs: lock.retryAfterMs });
		const { pin, memberId, publicKeyPem, name } = body ?? {};
		if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) return json(400, { error: "pin-format" });
		let keyId = null;
		try { keyId = memberIdOf(publicKeyPem); } catch { keyId = null; }
		if (!tlsMemberId || keyId !== memberId || tlsMemberId !== memberId) return json(400, { error: "key-mismatch" });
		if (this.fold.removed.has(memberId)) return json(403, { error: "removed" });
		if (!(await checkPin(this.fold.pinVerifier, pin))) {
			this.guard.fail("join");
			return json(400, { error: "bad-pin" });
		}
		this.guard.succeed("join");
		if (!this.fold.members.has(memberId)) this.appendEvent("member.join", { memberId, publicKeyPem, name: cleanName(name, `member-${memberId.slice(0, 4)}`) });
		return json(200, { events: this.log.all() });
	}
}
