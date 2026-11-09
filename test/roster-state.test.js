import { test } from "node:test";
import assert from "node:assert/strict";
import { RosterLog } from "../lib/roster/log.js";
import { foldState } from "../lib/roster/state.js";
import { describe_, join_, makeFleet, pin_, remove_ } from "./helpers/roster.js";

const fold = (events) => foldState(new RosterLog(events));

test("creator is the only member and pinVerifier comes from create", async () => {
	const { ids, create } = await makeFleet(1, { pinVerifier: "v-create" });
	const s = fold([create]);
	assert.equal(s.fleetId, create.fleetId);
	assert.equal(s.fleetName, "家");
	assert.deepEqual([...s.members.keys()], [ids[0].memberId]);
	assert.equal(s.members.get(ids[0].memberId).name, "n0");
	assert.equal(s.members.get(ids[0].memberId).admittedBy, null);
	assert.equal(s.pinVerifier, "v-create");
	assert.equal(s.pinConflict, null);
	assert.equal(s.removed.size, 0);
});

test("join adds member with admittedBy = author", async () => {
	const { ids, create } = await makeFleet(2);
	const j = join_(ids[0], ids[1], [create.hash], 2500);
	const m = fold([create, j]).members.get(ids[1].memberId);
	assert.equal(m.admittedBy, ids[0].memberId);
	assert.equal(m.joinedAt, 2500);
	assert.equal(m.publicKeyPem, ids[1].publicKeyPem);
});

test("remove wins over a concurrent join of the same member", async () => {
	const { ids, create } = await makeFleet(3);
	const jB = join_(ids[0], ids[1], [create.hash]);
	const jC = join_(ids[0], ids[2], [jB.hash]);
	const rejoin = join_(ids[1], ids[2], [jC.hash], 4000); // B re-admits C concurrently
	const r = remove_(ids[0], ids[2], [jC.hash]);
	const s = fold([create, jB, jC, rejoin, r]);
	assert.equal(s.members.has(ids[2].memberId), false);
	assert.equal(s.removed.has(ids[2].memberId), true);
});

test("a join signed by X that is not an ancestor of remove(X) has no effect", async () => {
	const { ids, create } = await makeFleet(3);
	const jX = join_(ids[0], ids[1], [create.hash]);
	const r = remove_(ids[0], ids[1], [jX.hash]);
	const late = join_(ids[1], ids[2], [jX.hash]); // X admits Y concurrently with X's removal
	const s = fold([create, jX, r, late]);
	assert.equal(s.members.has(ids[2].memberId), false);
	assert.equal(s.members.has(ids[1].memberId), false);
});

test("a join signed by X that is an ancestor of remove(X) stays, admittedBy X", async () => {
	const { ids, create } = await makeFleet(3);
	const jX = join_(ids[0], ids[1], [create.hash]);
	const early = join_(ids[1], ids[2], [jX.hash]);
	const r = remove_(ids[0], ids[1], [early.hash]);
	const s = fold([create, jX, early, r]);
	assert.equal(s.members.get(ids[2].memberId).admittedBy, ids[1].memberId);
	assert.equal(s.members.has(ids[1].memberId), false);
});

test("concurrent mutual removal is resolved the same way on every node", async () => {
	const { ids, create } = await makeFleet(3);
	const jB = join_(ids[0], ids[1], [create.hash]);
	const jC = join_(ids[0], ids[2], [jB.hash]);
	const rB = remove_(ids[2], ids[1], [jC.hash]); // C removes B
	const rC = remove_(ids[1], ids[2], [jC.hash]); // B removes C, concurrently
	const a = fold([create, jB, jC, rB, rC]);
	const b = fold([rC, rB, jC, jB, create]);
	assert.deepEqual([...a.members.keys()].sort(), [...b.members.keys()].sort());
	assert.equal(a.members.size, 2, "exactly one of B and C is removed");
	assert.equal(a.members.has(ids[0].memberId), true);
});

test("concurrent pin.change: later at wins; equal at → larger memberId wins; pinConflict lists the loser", async () => {
	const { ids, create } = await makeFleet(3);
	const jB = join_(ids[0], ids[1], [create.hash]);
	const jC = join_(ids[0], ids[2], [jB.hash]);
	const pA = pin_(ids[0], "vA", [jC.hash], 5000);
	const pB = pin_(ids[1], "vB", [jC.hash], 6000);
	const s1 = fold([create, jB, jC, pA, pB]);
	assert.equal(s1.pinVerifier, "vB");
	assert.deepEqual(s1.pinConflict, { winner: pB.hash, losers: [pA.hash] });

	const pC = pin_(ids[2], "vC", [jC.hash], 5000);
	const s2 = fold([create, jB, jC, pA, pC]);
	const larger = ids[0].memberId > ids[2].memberId ? "vA" : "vC";
	assert.equal(s2.pinVerifier, larger);

	const pFollow = pin_(ids[0], "vD", [pA.hash, pB.hash], 7000);
	const s3 = fold([create, jB, jC, pA, pB, pFollow]);
	assert.equal(s3.pinVerifier, "vD");
	assert.equal(s3.pinConflict, null);
});

test("describe by B about itself applies; a describe authored by A cannot rename B", async () => {
	const { ids, create } = await makeFleet(2);
	const jB = join_(ids[0], ids[1], [create.hash]);
	const dB = describe_(ids[1], "nas", "维护 NAS", [jB.hash], 4000);
	const dA = describe_(ids[0], "pc", "操作 PC", [dB.hash], 5000);
	const s = fold([create, jB, dB, dA]);
	assert.equal(s.members.get(ids[1].memberId).name, "nas");
	assert.equal(s.members.get(ids[1].memberId).description, "维护 NAS");
	assert.equal(s.members.get(ids[0].memberId).name, "pc");
	assert.equal(s.members.get(ids[0].memberId).description, "操作 PC");
});

test("pin.change by a removed member after its removal has no effect", async () => {
	const { ids, create } = await makeFleet(2);
	const jB = join_(ids[0], ids[1], [create.hash]);
	const r = remove_(ids[0], ids[1], [jB.hash]);
	const late = pin_(ids[1], "evil", [jB.hash], 9000);
	assert.equal(fold([create, jB, r, late]).pinVerifier, "v0");
});
