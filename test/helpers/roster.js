/** Test helpers for roster tests: identities, a fleet.create event and shortcuts for common events. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../../lib/identity.js";
import { createEvent } from "../../lib/roster/events.js";

export const FLEET_ID = "f".repeat(32);

/** @param {number} n */
export async function makeIdentities(n) {
	const ids = [];
	for (let i = 0; i < n; i++) ids.push(await loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "fleet-roster-"))));
	return ids;
}

/**
 * n identities; ids[0] creates the fleet.
 * @param {number} n
 * @param {{ pinVerifier?: string, at?: number }} [opts]
 */
export async function makeFleet(n, opts = {}) {
	const ids = await makeIdentities(n);
	const create = createEvent(ids[0], {
		fleetId: FLEET_ID,
		type: "fleet.create",
		parents: [],
		at: opts.at ?? 1000,
		body: { name: "家", pinVerifier: opts.pinVerifier ?? "v0", creator: { memberId: ids[0].memberId, publicKeyPem: ids[0].publicKeyPem, name: "n0" } },
	});
	return { ids, create };
}

export const join_ = (author, member, parents, at = 2000) =>
	createEvent(author, { fleetId: FLEET_ID, type: "member.join", parents, at, body: { memberId: member.memberId, publicKeyPem: member.publicKeyPem, name: `n-${member.memberId.slice(0, 4)}` } });

export const remove_ = (author, member, parents, at = 3000) =>
	createEvent(author, { fleetId: FLEET_ID, type: "member.remove", parents, at, body: { memberId: member.memberId } });

export const pin_ = (author, pinVerifier, parents, at = 3000) =>
	createEvent(author, { fleetId: FLEET_ID, type: "pin.change", parents, at, body: { pinVerifier } });

export const describe_ = (author, name, description, parents, at = 3000) =>
	createEvent(author, { fleetId: FLEET_ID, type: "member.describe", parents, at, body: { name, description } });
