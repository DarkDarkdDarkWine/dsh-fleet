import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, createEvent, hashEvent } from "../lib/roster/events.js";
import { RosterLog } from "../lib/roster/log.js";
import { FLEET_ID, join_, makeFleet, pin_, remove_ } from "./helpers/roster.js";

test("canonicalize sorts keys recursively and keeps array order", () => {
	assert.equal(canonicalize({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
});

test("createEvent hash covers everything but hash and sig", async () => {
	const { create } = await makeFleet(1);
	assert.equal(create.hash, hashEvent(create));
	assert.equal(hashEvent({ ...create, sig: "other" }), create.hash);
	assert.notEqual(hashEvent({ ...create, at: create.at + 1 }), create.hash);
});

test("accepts a create and a join by the creator", async () => {
	const { ids, create } = await makeFleet(2);
	const log = new RosterLog([create]);
	assert.deepEqual(log.add(join_(ids[0], ids[1], [create.hash])), { added: true });
	assert.equal(log.all().length, 2);
});

test("rejects tampered body with bad-hash", async () => {
	const { ids, create } = await makeFleet(2);
	const log = new RosterLog([create]);
	const e = join_(ids[0], ids[1], [create.hash]);
	assert.equal(log.add({ ...e, body: { ...e.body, name: "evil" } }).reason, "bad-hash");
});

test("rejects a valid hash signed by another key with bad-sig", async () => {
	const { ids, create } = await makeFleet(3);
	const log = new RosterLog([create]);
	const e = join_(ids[0], ids[1], [create.hash]);
	const forged = join_(ids[2], ids[1], [create.hash]); // same body, signed by ids[2]
	assert.equal(log.add({ ...e, sig: forged.sig }).reason, "bad-sig");
});

test("rejects an event whose author never joined in its ancestry with not-a-member", async () => {
	const { ids, create } = await makeFleet(3);
	const log = new RosterLog([create]);
	assert.equal(log.add(join_(ids[1], ids[2], [create.hash])).reason, "not-a-member");
});

test("rejects a second fleet.create", async () => {
	const { create } = await makeFleet(1);
	const other = await makeFleet(1, { at: 999 });
	const log = new RosterLog([create]);
	assert.equal(log.add(other.create).reason, "second-create");
});

test("rejects an event with an unknown parent, an unknown type and a duplicate", async () => {
	const { ids, create } = await makeFleet(2);
	const log = new RosterLog([create]);
	assert.equal(log.add(join_(ids[0], ids[1], ["0".repeat(64)])).reason, "missing-parent");
	const bogus = createEvent(ids[0], { fleetId: FLEET_ID, type: "member.promote", parents: [create.hash], body: {} });
	assert.equal(log.add(bogus).reason, "bad-type");
	assert.equal(log.add(create).reason, "duplicate");
});

test("rejects a join whose publicKeyPem does not hash to its memberId", async () => {
	const { ids, create } = await makeFleet(3);
	const log = new RosterLog([create]);
	const e = createEvent(ids[0], { fleetId: FLEET_ID, type: "member.join", parents: [create.hash], body: { memberId: ids[1].memberId, publicKeyPem: ids[2].publicKeyPem, name: "x" } });
	assert.equal(log.add(e).reason, "bad-type");
});

test("merge of the same events in shuffled order yields identical digest and all()", async () => {
	const { ids, create } = await makeFleet(4);
	const j1 = join_(ids[0], ids[1], [create.hash]);
	const j2 = join_(ids[1], ids[2], [j1.hash]);
	const j3 = join_(ids[0], ids[3], [create.hash]);
	const r = remove_(ids[2], ids[3], [j2.hash, j3.hash]);
	const p = pin_(ids[1], "v1", [j2.hash]);
	const events = [create, j1, j2, j3, r, p];
	const a = new RosterLog();
	const resA = a.merge(events);
	const b = new RosterLog();
	const resB = b.merge([p, r, j3, j2, j1, create]);
	assert.equal(resA.added, 6);
	assert.equal(resB.added, 6);
	assert.deepEqual(resB.rejected, []);
	assert.equal(a.digest(), b.digest());
	assert.deepEqual(a.all().map((e) => e.hash), b.all().map((e) => e.hash));
	assert.equal(a.all()[0].hash, create.hash);
	assert.deepEqual(new Set(a.heads()), new Set([r.hash, p.hash]));
});

test("isAncestor follows parents transitively", async () => {
	const { ids, create } = await makeFleet(3);
	const j1 = join_(ids[0], ids[1], [create.hash]);
	const j2 = join_(ids[1], ids[2], [j1.hash]);
	const log = new RosterLog([create, j1, j2]);
	assert.equal(log.isAncestor(create.hash, j2.hash), true);
	assert.equal(log.isAncestor(j1.hash, j2.hash), true);
	assert.equal(log.isAncestor(j2.hash, j1.hash), false);
	assert.equal(log.isAncestor(j2.hash, j2.hash), false);
	assert.equal(log.get(j1.hash).type, "member.join");
});

test("merge reports rejected events with their reasons", async () => {
	const { ids, create } = await makeFleet(3);
	const bad = join_(ids[1], ids[2], [create.hash]);
	const res = new RosterLog().merge([create, bad]);
	assert.equal(res.added, 1);
	assert.deepEqual(res.rejected, [{ hash: bad.hash, reason: "not-a-member" }]);
});
