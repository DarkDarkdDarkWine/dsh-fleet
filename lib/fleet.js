import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AddressBook, localAddresses } from "./addresses.js";
import { helloProbe } from "./discovery-tailscale.js";
import { loadOrCreateIdentity, memberIdOf } from "./identity.js";
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

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", ""]);
const MAX_DESCRIPTION = 1000;
const REMOTE_CODES = new Set(["bad-pin", "pin-locked", "pin-format", "key-mismatch", "not-joined", "removed", "rate-limited", "roster-corrupt"]);
const MAX_NAME = 64;
const cleanName = (name, fallback) => (typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME) : fallback);
const json = (status, body) => ({ status, body });
const DISCOVERY_TTL_MS = 10 * 60_000;
const shortOf = (fleetId) => `${fleetId.slice(0, 4)}-${fleetId.slice(4, 8)}`.toUpperCase();
const validAddrs = (list) => (Array.isArray(list) ? list.filter((a) => typeof a?.host === "string" && a.host && Number.isInteger(a?.port) && a.port > 0 && a.port < 65536).slice(0, 16) : []);
const stripV4Mapped = (host) => (host?.startsWith("::ffff:") ? host.slice(7) : host);

export class FleetService {
	/** @param {{ dataDir: string, settings: import("./settings.js").Settings, identity: import("./identity.js").Identity, discovery: import("./discovery.js").Discovery, discoveryInfo?: { mdns: string, tailscale: string }, logger: { info(m: string): void, warn(m: string): void }, now?: () => number }} opts */
	constructor({ dataDir, settings, identity, discovery, discoveryInfo = { mdns: "off", tailscale: "off" }, logger, now = Date.now }) {
		this.dataDir = dataDir;
		this.settings = settings;
		this.identity = identity;
		this.discovery = discovery;
		this.discoveryInfo = discoveryInfo;
		/** @type {Map<string, import("./discovery.js").Found & { at: number }>} keyed by memberId */
		this.discovered = new Map();
		this.subscribed = false;
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
		if (!this.subscribed) {
			this.subscribed = true;
			this.discovery?.onFound?.((f) => this.onDiscovered(f));
		}
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
				unavailable: () => this.error,
				notMemberDetail: (id) => ({ removed: Boolean(this.fold?.removed.has(id)) }),
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
			addresses: isSelf ? this.advertisedAddresses() : this.book.candidates(m.memberId),
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
			fleet: f ? { id: f.fleetId, short: shortOf(f.fleetId), name: f.fleetName } : null,
			self: { memberId: this.selfId, name: this.selfName(), rejected: Boolean(this.state.rejected || f?.removed.has(this.selfId)) },
			members,
			pinConflict: f?.pinConflict ?? null,
			listening: this.listening,
			discovery: { ...this.discoveryInfo },
			error: this.error,
		};
	}

	// ── discovery (Task 9) ─────────────────────────────────────

	/** @param {import("./discovery.js").Found} f */
	onDiscovered(f) {
		if (!f?.memberId || f.memberId === this.selfId || !f.host || !Number.isInteger(f.port)) return;
		this.discovered.set(f.memberId, { ...f, at: this.now() });
		if (this.fold?.members.has(f.memberId)) this.book.record(f.memberId, { host: f.host, port: f.port }, true);
	}

	freshDiscovered() {
		const cutoff = this.now() - DISCOVERY_TTL_MS;
		return [...this.discovered.values()].filter((d) => d.at >= cutoff);
	}

	/** Fleets seen on the network, one join address each (mDNS preferred). */
	async discoverFleets() {
		await this.discovery?.scanNow?.();
		const groups = new Map();
		for (const d of this.freshDiscovered()) {
			if (!d.fleetId) continue;
			const best = groups.get(d.fleetId);
			if (!best || (best.source !== "mdns" && d.source === "mdns")) groups.set(d.fleetId, { ...d, fleetName: d.fleetName ?? best?.fleetName });
			else if (!best.fleetName && d.fleetName) groups.set(d.fleetId, { ...best, fleetName: d.fleetName });
		}
		const out = [];
		for (const [fleetId, d] of groups) {
			const fleetName = d.fleetName ?? (await this.helloName({ host: d.host, port: d.port }));
			out.push({ fleetId, short: shortOf(fleetId), fleetName: fleetName ?? null, via: { memberId: d.memberId, host: d.host, port: d.port, source: d.source } });
		}
		return out.sort((a, b) => String(a.fleetName).localeCompare(String(b.fleetName)));
	}

	async helloName(address) {
		return (await helloProbe(address.host, address.port))?.fleetName ?? null;
	}

	/** Devices on the network that run dsh-fleet but have not joined any fleet. */
	discoveredUnjoined() {
		return this.freshDiscovered().filter((d) => !d.fleetId).map(({ memberId, name, host, port, source }) => ({ memberId, name, host, port, source }));
	}

	/** Where others can reach this member: the bound host when it is specific, otherwise every local IPv4. */
	advertisedAddresses() {
		const port = this.listening.port ?? this.settings.port;
		return WILDCARD_HOSTS.has(this.settings.host) ? localAddresses(port) : [{ host: this.settings.host, port }];
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
			const r = await this.callJoin(address, { pin, memberId: this.selfId, publicKeyPem: this.identity.publicKeyPem, name: selfName, addresses: this.advertisedAddresses() });
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
			"/v1/heartbeat": { auth: "member", method: "POST", handler: async (ctx) => this.handleHeartbeat(ctx) },
			"/v1/roster/sync": { auth: "member", method: "POST", handler: async (ctx) => json(200, { events: (await this.mergeRemote(ctx.body?.events), this.log.all()) }) },
		};
	}

	/** Server side of PIN join (spec §5.4 step 3–4). */
	async handleJoin({ memberId: tlsMemberId, remoteAddress, body }) {
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
		this.acceptPeerReport(memberId, { addresses: body.addresses }, { remoteAddress, verified: false });
		return json(200, { events: this.log.all() });
	}

	// ── heartbeat & sync (Task 8) ──────────────────────────────

	heartbeatPayload() {
		return { addresses: this.advertisedAddresses(), version: VERSION, status: { active: 0, queued: 0 }, rosterDigest: this.log.digest(), directory: this.book.directory() };
	}

	/**
	 * Learn a peer's addresses: those it reports, the source it connected from,
	 * and its gossiped directory. `address` (when verified) is the one that just answered.
	 */
	acceptPeerReport(memberId, report, { address, remoteAddress, verified }) {
		const reported = validAddrs(report?.addresses);
		for (const a of reported) this.book.record(memberId, a, false);
		const source = stripV4Mapped(remoteAddress);
		if (source && reported[0]) this.book.record(memberId, { host: source, port: reported[0].port }, false);
		if (address && verified) this.book.record(memberId, address, true);
		if (verified || remoteAddress) this.book.markSeen(memberId);
		if (report?.directory) this.book.mergeGossip(report.directory, this.selfId);
	}

	handleHeartbeat({ memberId, remoteAddress, body }) {
		this.acceptPeerReport(memberId, body, { remoteAddress, verified: false });
		return json(200, this.heartbeatPayload());
	}

	/** Merge events from a peer; persist when anything was new. @returns {Promise<number>} */
	mergeRemote(events) {
		return this.exclusive(async () => {
			if (!Array.isArray(events) || !events.length) return 0;
			const { added } = this.log.merge(events);
			if (added) {
				this.setLog(this.log);
				this.saveRoster();
			}
			return added;
		});
	}

	async syncWith(memberId, address) {
		const r = await requestMember({ identity: this.identity, addresses: [address], expectMemberId: memberId, method: "POST", path: "/v1/roster/sync", body: { events: this.log.all() } });
		if (r.status === 200) await this.mergeRemote(r.body?.events);
	}

	/** A peer reported this member as removed from its roster. */
	markRejected() {
		if (!this.state.rejected) this.saveState({ rejected: true });
	}

	/** A peer accepted our heartbeat: any earlier rejection is stale. */
	clearRejected() {
		if (this.state.rejected) this.saveState({ rejected: false });
	}

	// ── membership operations (Task 8) ─────────────────────────

	assertJoined() {
		this.assertUsable();
		if (!this.fold) throw new FleetError("not-joined");
	}

	/** Check a PIN for a critical operation, with the shared "critical" lockout. */
	async verifyCritical(pin) {
		const lock = this.guard.status("critical");
		if (lock.locked) throw new FleetError("pin-locked", { retryAfterMs: lock.retryAfterMs });
		if (!(await checkPin(this.fold.pinVerifier, pin))) {
			this.guard.fail("critical");
			throw new FleetError("bad-pin");
		}
		this.guard.succeed("critical");
	}

	/** @param {{ memberId: string, pin: string }} req */
	removeMember({ memberId, pin }) {
		return this.exclusive(async () => {
			this.assertJoined();
			if (memberId === this.selfId) throw new FleetError("self-remove");
			if (!this.fold.members.has(memberId)) throw new FleetError("unknown-member");
			this.assertPinFormat(pin);
			await this.verifyCritical(pin);
			this.appendEvent("member.remove", { memberId });
			return this.status();
		});
	}

	/** @param {{ oldPin: string, newPin: string }} req */
	changePin({ oldPin, newPin }) {
		return this.exclusive(async () => {
			this.assertJoined();
			this.assertPinFormat(oldPin, newPin);
			await this.verifyCritical(oldPin);
			this.appendEvent("pin.change", { pinVerifier: await createVerifier(newPin) });
			return this.status();
		});
	}

	/** Reset without the old PIN. Only exposed on the loopback-only local routes. */
	resetPin({ newPin }) {
		return this.exclusive(async () => {
			this.assertJoined();
			this.assertPinFormat(newPin);
			this.appendEvent("pin.change", { pinVerifier: await createVerifier(newPin) });
			this.guard.succeed("critical");
			this.guard.succeed("join");
			return this.status();
		});
	}

	/** @param {{ name?: string, description?: string }} req */
	describe({ name, description }) {
		return this.exclusive(async () => {
			this.assertJoined();
			const current = this.fold.members.get(this.selfId);
			const body = { name: cleanName(name, current?.name ?? this.selfName()), description: typeof description === "string" ? description.slice(0, MAX_DESCRIPTION) : current?.description ?? "" };
			this.appendEvent("member.describe", body);
			this.saveState({ selfName: body.name });
			return this.status();
		});
	}

	/** Forget the fleet and take a new identity (a removed member can only rejoin as someone new). */
	leave() {
		return this.exclusive(async () => {
			await this.stop();
			rmSync(this.rosterPath, { force: true });
			rmSync(this.statePath, { force: true });
			this.identity = await loadOrCreateIdentity(this.dataDir, { regenerate: true });
			this.error = null;
			this.setLog(new RosterLog());
			this.state = { v: 1, selfName: this.state.selfName, addressBook: {}, pinGuard: {}, rejected: false };
			this.guard = new PinGuard({ load: () => ({}), save: (pinGuard) => this.saveState({ pinGuard }), now: this.now });
			this.book = new AddressBook({ load: () => ({}), save: (addressBook) => this.saveState({ addressBook }), now: this.now });
			await this.listen();
			this.advertise();
			return this.status();
		});
	}
}
