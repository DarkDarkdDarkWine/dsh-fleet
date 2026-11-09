import { createHash } from "node:crypto";
import { signBytes } from "../identity.js";

/**
 * Signed, hash-linked roster events.
 * @typedef {"fleet.create"|"member.join"|"member.remove"|"pin.change"|"member.describe"} EventType
 * @typedef {{ v: 1, type: EventType, fleetId: string, author: string, parents: string[], at: number, body: object, hash: string, sig: string }} SignedEvent
 */

export const EVENT_TYPES = Object.freeze(["fleet.create", "member.join", "member.remove", "pin.change", "member.describe"]);

/**
 * JSON with object keys sorted recursively; arrays keep their order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * sha256 hex of the canonical event without `hash` and `sig`.
 * @param {Partial<SignedEvent>} e
 * @returns {string}
 */
export function hashEvent(e) {
	const { hash: _hash, sig: _sig, ...rest } = e;
	return createHash("sha256").update(canonicalize(rest)).digest("hex");
}

/**
 * Create and sign an event authored by `identity`.
 * @param {import("../identity.js").Identity} identity
 * @param {{ fleetId: string, type: EventType, parents: string[], body: object, at?: number }} spec
 * @returns {SignedEvent}
 */
export function createEvent(identity, { fleetId, type, parents, body, at = Date.now() }) {
	const unsigned = { v: 1, type, fleetId, author: identity.memberId, parents: [...parents].sort(), at, body };
	const hash = hashEvent(unsigned);
	return { ...unsigned, hash, sig: signBytes(identity, Buffer.from(hash, "hex")) };
}
