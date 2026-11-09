import { createHash } from "node:crypto";
import { memberIdOf, verifyBytes } from "../identity.js";
import { EVENT_TYPES, hashEvent } from "./events.js";

/**
 * Append-only DAG of signed roster events. `add` only checks structural
 * validity (hash, signature, author joined in its own ancestry); membership
 * effects such as "remove wins" are applied later by foldState.
 * @typedef {import("./events.js").SignedEvent} SignedEvent
 * @typedef {"bad-hash"|"bad-sig"|"missing-parent"|"not-a-member"|"duplicate"|"bad-type"|"second-create"} RejectReason
 */

const isHex = (s, len) => typeof s === "string" && s.length === len && /^[0-9a-f]+$/.test(s);

/** Shape checks that need no other events. @returns {boolean} */
function wellFormed(e) {
	if (e?.v !== 1 || !EVENT_TYPES.includes(e.type) || !isHex(e.author, 32) || !isHex(e.fleetId, 32)) return false;
	if (!Array.isArray(e.parents) || !Number.isFinite(e.at) || e.body === null || typeof e.body !== "object") return false;
	const b = e.body;
	try {
		switch (e.type) {
			case "fleet.create":
				return typeof b.name === "string" && typeof b.pinVerifier === "string" && typeof b.creator?.name === "string" && b.creator.memberId === e.author && memberIdOf(b.creator.publicKeyPem) === e.author;
			case "member.join":
				return isHex(b.memberId, 32) && typeof b.name === "string" && memberIdOf(b.publicKeyPem) === b.memberId;
			case "member.remove":
				return isHex(b.memberId, 32);
			case "pin.change":
				return typeof b.pinVerifier === "string";
			case "member.describe":
				return typeof (b.name ?? "") === "string" && typeof (b.description ?? "") === "string";
		}
	} catch {
		return false;
	}
	return false;
}

export class RosterLog {
	/** @param {SignedEvent[]} [events] */
	constructor(events = []) {
		/** @type {Map<string, SignedEvent>} */
		this.events = new Map();
		/** @type {Map<string, Set<string>>} hash → strict ancestors */
		this.ancestors = new Map();
		/** @type {Map<string, number>} */
		this.depth = new Map();
		/** @type {SignedEvent | null} */
		this.create = null;
		this.merge(events);
	}

	/** Public key of `memberId` as admitted in the given ancestor set. */
	keyIn(ancestorSet, memberId) {
		for (const h of ancestorSet) {
			const e = this.events.get(h);
			if (e.type === "fleet.create" && e.body.creator.memberId === memberId) return e.body.creator.publicKeyPem;
			if (e.type === "member.join" && e.body.memberId === memberId) return e.body.publicKeyPem;
		}
		return null;
	}

	/**
	 * @param {SignedEvent} e
	 * @returns {{ added: boolean, reason?: RejectReason }}
	 */
	add(e) {
		if (this.events.has(e?.hash)) return { added: false, reason: "duplicate" };
		if (!wellFormed(e)) return { added: false, reason: "bad-type" };
		if (hashEvent(e) !== e.hash) return { added: false, reason: "bad-hash" };
		const reject = (reason) => ({ added: false, reason });
		let key;
		const anc = new Set();
		if (e.type === "fleet.create") {
			if (this.create) return reject("second-create");
			if (e.parents.length) return reject("bad-type");
			key = e.body.creator.publicKeyPem;
		} else {
			if (!e.parents.length || e.parents.some((p) => !this.events.has(p))) return reject("missing-parent");
			if (this.create && e.fleetId !== this.create.fleetId) return reject("bad-type");
			for (const p of e.parents) {
				anc.add(p);
				for (const a of this.ancestors.get(p)) anc.add(a);
			}
			key = this.keyIn(anc, e.author);
			if (!key) return reject("not-a-member");
		}
		if (!verifyBytes(key, Buffer.from(e.hash, "hex"), e.sig)) return reject("bad-sig");
		this.events.set(e.hash, e);
		this.ancestors.set(e.hash, anc);
		this.depth.set(e.hash, e.parents.length ? 1 + Math.max(...e.parents.map((p) => this.depth.get(p))) : 0);
		if (e.type === "fleet.create") this.create = e;
		return { added: true };
	}

	/**
	 * Add events in any order, retrying until no progress.
	 * @param {SignedEvent[]} events
	 * @returns {{ added: number, rejected: { hash: string, reason: RejectReason }[] }}
	 */
	merge(events) {
		let pending = [...events];
		let added = 0;
		for (;;) {
			const next = [];
			let progress = false;
			for (const e of pending) {
				const r = this.add(e);
				if (r.added) { added++; progress = true; } else if (r.reason !== "duplicate") next.push({ e, reason: r.reason });
			}
			pending = next.map((x) => x.e);
			if (!progress || !pending.length) {
				const rejected = next.map(({ e, reason }) => ({ hash: e?.hash, reason }));
				return { added, rejected };
			}
		}
	}

	/** @param {string} hash */
	get(hash) {
		return this.events.get(hash);
	}

	/** Topological order: by depth, then hash. @returns {SignedEvent[]} */
	all() {
		return [...this.events.values()].sort((a, b) => this.depth.get(a.hash) - this.depth.get(b.hash) || (a.hash < b.hash ? -1 : 1));
	}

	/** Events that are nobody's parent. @returns {string[]} */
	heads() {
		const parents = new Set();
		for (const e of this.events.values()) for (const p of e.parents) parents.add(p);
		return [...this.events.keys()].filter((h) => !parents.has(h)).sort();
	}

	/** Whether `a` is a strict ancestor of `b`. */
	isAncestor(a, b) {
		return this.ancestors.get(b)?.has(a) ?? false;
	}

	/** sha256 over the sorted event hashes. */
	digest() {
		return createHash("sha256").update([...this.events.keys()].sort().join("\n")).digest("hex");
	}
}
