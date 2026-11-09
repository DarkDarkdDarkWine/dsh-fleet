import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetError } from "../lib/fleet.js";
import { loadOrCreateIdentity } from "../lib/identity.js";
import { StoreCorruptError } from "../lib/store.js";
import { PIN, startFleet, startNode } from "./helpers/net.js";
import { makeIdentities } from "./helpers/roster.js";

/** A two-member fleet on disk; returns A's data dir with A stopped. */
async function savedFleet() {
	const f = await startFleet(["a", "b"]);
	await f.stop();
	return f.nodes[0].dir;
}

async function expectRosterCorrupt(dir) {
	const before = readFileSync(join(dir, "roster.json"), "utf8");
	const n = await startNode("a", { dir }).catch((err) => assert.fail(`start must not throw: ${err?.message}`));
	try {
		assert.equal(n.fleet.status().error, "roster-corrupt");
		await assert.rejects(n.fleet.createFleet({ name: "x", pin: PIN }), (e) => e instanceof FleetError && e.code === "roster-corrupt");
		assert.equal(readFileSync(join(dir, "roster.json"), "utf8"), before, "never rebuilt");
	} finally { await n.stop(); }
}

test("a roster.json whose event was altered (still valid JSON) is reported roster-corrupt and kept", async () => {
	const dir = await savedFleet();
	const roster = JSON.parse(readFileSync(join(dir, "roster.json"), "utf8"));
	roster.events[1].body.name = "tampered";
	writeFileSync(join(dir, "roster.json"), JSON.stringify(roster));
	await expectRosterCorrupt(dir);
});

test("roster.json of {} or null is reported roster-corrupt", async () => {
	for (const text of ["{}", "null", "[]", "{\"events\":\"x\"}"]) {
		const dir = await savedFleet();
		writeFileSync(join(dir, "roster.json"), text);
		await expectRosterCorrupt(dir);
	}
});

test("identity.json without keys, or with a cert for another key, throws StoreCorruptError", async () => {
	const [a, b] = await makeIdentities(2);
	for (const stored of [{}, { v: 1 }, { v: 1, keyPem: a.keyPem, certPem: b.certPem }, { v: 1, keyPem: "nope", certPem: "nope" }]) {
		const dir = mkdtempSync(join(tmpdir(), "fleet-idc-"));
		writeFileSync(join(dir, "identity.json"), JSON.stringify(stored));
		const before = readFileSync(join(dir, "identity.json"), "utf8");
		await assert.rejects(loadOrCreateIdentity(dir), StoreCorruptError);
		assert.equal(readFileSync(join(dir, "identity.json"), "utf8"), before);
	}
});

test("while state.json is corrupt it is never overwritten", async () => {
	const dir = await savedFleet();
	writeFileSync(join(dir, "state.json"), "{broken");
	const n = await startNode("a", { dir });
	try {
		assert.equal(n.fleet.status().error, "state-corrupt");
		const known = n.fleet.status().members.find((m) => !m.isSelf);
		n.discovery.emit({ source: "mdns", fleetId: n.fleet.status().fleet.id, memberId: known.memberId, name: "b", host: "10.1.1.1", port: 43190 });
		assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{broken");
	} finally { await n.stop(); }
	assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{broken");
});
