import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeartbeat } from "../lib/heartbeat.js";
import { FleetError } from "../lib/fleet.js";
import { requestMember } from "../lib/transport/client.js";
import { PIN, startFleet, startNode } from "./helpers/net.js";

const isCode = (code) => (err) => err instanceof FleetError && err.code === code;
const hb = (node) => (node.hb ??= createHeartbeat({ fleet: node.fleet, settings: node.fleet.settings }));
const tick = (...nodes) => nodes.reduce((p, n) => p.then(() => hb(n).tick()), Promise.resolve());
const member = (node, name) => node.fleet.status().members.find((m) => m.name === name);

async function three() {
	const f = await startFleet(["a", "b", "c"]);
	const [a, b, c] = f.nodes;
	return { f, a, b, c };
}

test("C joins via A; after A.tick() and B.tick() B lists C and has C's address", async () => {
	const { f, a, b, c } = await three();
	try {
		assert.equal(member(b, "c"), undefined, "B does not know C yet");
		await tick(a, b);
		const seen = member(b, "c");
		assert.ok(seen, "B lists C");
		assert.deepEqual(seen.addresses, [c.address()]);
	} finally { await f.stop(); }
});

test("B marks C offline after 3 failed ticks and online after the next success", async () => {
	const { f, a, b, c } = await three();
	try {
		await tick(a, b, b); // B learns C via A's sync + directory, then reaches it
		assert.equal(member(b, "c").online, true);
		await c.fleet.stop();
		for (let i = 0; i < 3; i++) await tick(b);
		assert.equal(member(b, "c").online, false);
		await c.fleet.listen(); // back on a new port
		await tick(c, b);
		assert.equal(member(b, "c").online, true);
		assert.deepEqual(member(b, "c").addresses[0], c.address(), "the new address is tried first");
	} finally { await f.stop(); }
});

test("A removes C with the right PIN; after ticks B no longer lists C; C's heartbeat gets not-a-member and C.status().self.rejected is true", async () => {
	const { f, a, b, c } = await three();
	try {
		await tick(a, b, c);
		const cId = c.fleet.identity.memberId;
		await a.fleet.removeMember({ memberId: cId, pin: PIN });
		assert.equal(member(a, "c"), undefined);
		await tick(a);
		assert.equal(member(b, "c"), undefined);
		await tick(c);
		assert.equal(c.fleet.status().self.rejected, true);
	} finally { await f.stop(); }
});

test("remove with a wrong PIN fails bad-pin and counts toward the critical lockout", async () => {
	const { f, a, c } = await three();
	try {
		const cId = c.fleet.identity.memberId;
		for (let i = 0; i < 5; i++) await assert.rejects(a.fleet.removeMember({ memberId: cId, pin: "000000" }), isCode("bad-pin"));
		await assert.rejects(a.fleet.removeMember({ memberId: cId, pin: PIN }), isCode("pin-locked"));
		await assert.rejects(a.fleet.changePin({ oldPin: PIN, newPin: "135790" }), isCode("pin-locked"), "same critical key");
		assert.ok(member(a, "c"));
		await assert.rejects(a.fleet.removeMember({ memberId: a.fleet.identity.memberId, pin: PIN }), isCode("self-remove"));
	} finally { await f.stop(); }
});

test("A changes PIN; after sync, join via B with the old PIN fails bad-pin and with the new PIN succeeds", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	const d = await startNode("d");
	try {
		await a.fleet.changePin({ oldPin: PIN, newPin: "135790" });
		await tick(a);
		await assert.rejects(d.fleet.join({ address: b.address(), pin: PIN, memberName: "d" }), isCode("bad-pin"));
		const s = await d.fleet.join({ address: b.address(), pin: "135790", memberName: "d" });
		assert.equal(s.members.length, 3);
		await assert.rejects(a.fleet.changePin({ oldPin: "000000", newPin: "111111" }), isCode("bad-pin"));
		await assert.rejects(a.fleet.changePin({ oldPin: "135790", newPin: "12345" }), isCode("pin-format"));
	} finally { await Promise.all([f.stop(), d.stop()]); }
});

test("concurrent changePin on A and B while partitioned → after sync both report the same pinConflict winner", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	try {
		await tick(a);
		await a.fleet.changePin({ oldPin: PIN, newPin: "111111" });
		await b.fleet.changePin({ oldPin: PIN, newPin: "222222" });
		await tick(a, b);
		const ca = a.fleet.status().pinConflict;
		assert.ok(ca, "conflict is reported");
		assert.deepEqual(b.fleet.status().pinConflict, ca);
	} finally { await f.stop(); }
});

test("B.describe updates B's description on A after sync", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	try {
		await b.fleet.describe({ name: "nas", description: "维护 NAS" });
		await tick(b);
		const seen = a.fleet.status().members.find((m) => m.memberId === b.fleet.identity.memberId);
		assert.deepEqual([seen.name, seen.description], ["nas", "维护 NAS"]);
	} finally { await f.stop(); }
});

test("resetPin needs no old PIN and replaces the verifier", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	const d = await startNode("d");
	try {
		await a.fleet.resetPin({ newPin: "999999" });
		await d.fleet.join({ address: a.address(), pin: "999999", memberName: "d" });
		assert.equal(d.fleet.status().members.length, 3);
	} finally { await Promise.all([f.stop(), d.stop()]); }
});

test("C.leave() yields a new memberId and joined false; C can join again with the PIN", async () => {
	const { f, a, c } = await three();
	try {
		const old = c.fleet.identity.memberId;
		const s = await c.fleet.leave();
		assert.equal(s.joined, false);
		assert.notEqual(s.self.memberId, old);
		assert.equal(c.fleet.hello().memberId, s.self.memberId, "the fleet port presents the new identity");
		const again = await c.fleet.join({ address: a.address(), pin: PIN, memberName: "c2" });
		assert.equal(again.joined, true);
		assert.ok(again.members.some((m) => m.memberId === s.self.memberId));
	} finally { await f.stop(); }
});

test("a member whose first address went stale is reached via a gossiped address", async () => {
	const { f, a, b, c } = await three();
	try {
		await tick(c, a, b); // B learns C's real address through A's directory
		const cId = c.fleet.identity.memberId;
		b.fleet.book.record(cId, { host: "127.0.0.1", port: 1 }, true); // a stale address now ranks first
		assert.deepEqual(b.fleet.book.candidates(cId)[0], { host: "127.0.0.1", port: 1 });
		for (let i = 0; i < 2; i++) b.fleet.book.miss(cId);
		await tick(b);
		assert.equal(member(b, "c").online, true);
		assert.deepEqual(member(b, "c").addresses[0], c.address());
	} finally { await f.stop(); }
});

test("one tick against an unreachable member stays within heartbeatSec / 2", async () => {
	const { f, b, c } = await three();
	try {
		await tick(c, b);
		await c.fleet.stop();
		const started = Date.now();
		await tick(b);
		assert.ok(Date.now() - started < (b.fleet.settings.heartbeatSec * 1000) / 2);
	} finally { await f.stop(); }
});

test("a peer with a corrupt file answers 503 and does not mark others rejected", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	try {
		await tick(a, b);
		b.fleet.error = "roster-corrupt"; // as if B started with a damaged roster.json
		const r = await requestMember({ identity: a.fleet.identity, addresses: [b.address()], expectMemberId: b.fleet.identity.memberId, method: "POST", path: "/v1/heartbeat", body: a.fleet.heartbeatPayload() });
		assert.equal(r.status, 503);
		await tick(a);
		assert.equal(a.fleet.status().self.rejected, false);
	} finally { await f.stop(); }
});

test("a new member that reaches B before B has synced its join is not marked rejected", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	const c = await startNode("c");
	try {
		await tick(a, b);
		await c.fleet.join({ address: a.address(), pin: PIN, memberName: "c" });
		c.fleet.book.record(b.fleet.identity.memberId, b.address(), true); // e.g. learnt from a Tailscale scan
		await tick(c);
		assert.equal(c.fleet.status().self.rejected, false, "B simply does not know C yet");
		await tick(a, c);
		assert.equal(member(b, "c").online, true);
		assert.equal(c.fleet.status().self.rejected, false);
	} finally { await Promise.all([f.stop(), c.stop()]); }
});

test("the rejected flag clears on the next successful heartbeat", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	try {
		await tick(a, b);
		b.fleet.markRejected();
		assert.equal(b.fleet.status().self.rejected, true);
		await tick(b);
		assert.equal(b.fleet.status().self.rejected, false);
	} finally { await f.stop(); }
});

test("with 8 known addresses, the address that last worked still gets a full timeout on a slow link", { timeout: 30_000 }, async () => {
	const { f, a, b, c } = await three();
	try {
		await tick(a, b, b);
		const cId = c.fleet.identity.memberId;
		assert.equal(member(b, "c").online, true);
		for (let i = 1; i <= 7; i++) b.fleet.book.record(cId, { host: `10.255.0.${i}`, port: 43190 }, false); // stale LAN addresses
		assert.deepEqual(b.fleet.book.candidates(cId)[0], c.address(), "the working address ranks first");
		const handle = c.fleet.handleHeartbeat.bind(c.fleet);
		c.fleet.handleHeartbeat = async (ctx) => { await new Promise((r) => setTimeout(r, 2500)); return handle(ctx); }; // relayed path
		await tick(b);
		assert.equal(b.fleet.book.entry(cId).misses, 0, "default heartbeatSec 30 → 15 s budget; 15/8 s per address would time out");
	} finally { await f.stop(); }
});
