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

test("concurrent mutual removal removes both sides, identically on every node", async () => {
	const { ids, create } = await makeFleet(3);
	const jB = join_(ids[0], ids[1], [create.hash]);
	const jC = join_(ids[0], ids[2], [jB.hash]);
	const rB = remove_(ids[2], ids[1], [jC.hash]); // C removes B
	const rC = remove_(ids[1], ids[2], [jC.hash]); // B removes C, concurrently
	const a = fold([create, jB, jC, rB, rC]);
	const b = fold([rC, rB, jC, jB, create]);
	assert.deepEqual([...a.members.keys()], [ids[0].memberId], "removal wins on both sides (spec §5.3)");
	assert.deepEqual([...b.members.keys()], [ids[0].memberId]);
});

test("a removed member cannot backdate a remove of its remover and take over the PIN", async () => {
	const { ids, create } = await makeFleet(3); // A=0 creates, B=1, X=2
	const [A, B, X] = ids;
	const jB = join_(A, B, [create.hash]);
	const jX = join_(A, X, [jB.hash]);
	const chain = [];
	let head = jX;
	for (let i = 0; i < 6; i++) { head = describe_(A, "a", `d${i}`, [head.hash], 4000 + i); chain.push(head); } // push A's chain deep
	const rX = remove_(A, X, [head.hash], 5000);
	const evilRemove = remove_(X, A, [jX.hash], 4500); // X picks shallow parents to look early
	const evilPin = pin_(X, "evil", [evilRemove.hash], 4600);
	const all = [create, jB, jX, ...chain, rX, evilRemove, evilPin];
	for (const order of [all, [...all].reverse()]) {
		const s = fold(order);
		assert.equal(s.members.has(X.memberId), false, "X stays removed");
		assert.equal(s.members.has(B.memberId), true, "B is untouched");
		assert.notEqual(s.pinVerifier, "evil", "X's PIN change has no effect");
	}
});

test("a remove by a member who is concurrently being removed has no effect on a third member", async () => {
	const { ids, create } = await makeFleet(3); // A=0, B=1, C=2
	const [A, B, C] = ids;
	const jB = join_(A, B, [create.hash]);
	const jC = join_(A, C, [jB.hash]);
	const rC = remove_(B, C, [jC.hash], 5000); // B removes C
	const rA = remove_(C, A, [jC.hash], 5000); // C, unaware, removes A concurrently
	for (const events of [[create, jB, jC, rC, rA], [rA, rC, jC, jB, create]]) {
		const s = fold(events);
		assert.equal(s.members.has(A.memberId), true, "A stays: C's remove is invalid");
		assert.equal(s.removed.has(A.memberId), false);
		assert.equal(s.members.has(C.memberId), false);
	}
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
