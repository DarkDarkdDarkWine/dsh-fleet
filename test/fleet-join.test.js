import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FleetError } from "../lib/fleet.js";
import { requestMember } from "../lib/transport/client.js";
import { PIN, startNode } from "./helpers/net.js";
import { makeIdentities } from "./helpers/roster.js";

const isCode = (code) => (err) => err instanceof FleetError && err.code === code;

test("createFleet makes a one-member fleet; short matches /^[0-9A-F]{4}-[0-9A-F]{4}$/", async () => {
	const a = await startNode("a");
	try {
		const s = await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		assert.equal(s.joined, true);
		assert.match(s.fleet.short, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
		assert.match(s.fleet.id, /^[0-9a-f]{32}$/);
		assert.equal(s.fleet.short, `${s.fleet.id.slice(0, 4)}-${s.fleet.id.slice(4, 8)}`.toUpperCase());
		assert.equal(s.fleet.name, "家");
		assert.equal(s.members.length, 1);
		assert.deepEqual({ name: s.members[0].name, isSelf: s.members[0].isSelf, online: s.members[0].online }, { name: "mac", isSelf: true, online: true });
		assert.equal(s.self.name, "mac");
	} finally { await a.stop(); }
});

test("createFleet with \"12345\" fails pin-format", async () => {
	const a = await startNode("a");
	try {
		await assert.rejects(a.fleet.createFleet({ name: "家", pin: "12345", memberName: "mac" }), isCode("pin-format"));
		assert.equal(a.fleet.status().joined, false);
	} finally { await a.stop(); }
});

test("join with the right PIN: both A and N list two members, N admittedBy A", async () => {
	const a = await startNode("a");
	const n = await startNode("n");
	try {
		await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		const s = await n.fleet.join({ address: a.address(), pin: PIN, memberName: "nas" });
		assert.equal(s.joined, true);
		assert.equal(s.fleet.id, a.fleet.status().fleet.id);
		for (const st of [s, a.fleet.status()]) {
			assert.deepEqual(st.members.map((m) => m.name).sort(), ["mac", "nas"]);
			assert.equal(st.members.find((m) => m.name === "nas").admittedBy, a.fleet.status().self.memberId);
		}
		const aOnN = s.members.find((m) => m.name === "mac");
		assert.deepEqual(aOnN.addresses, [a.address()], "the joiner learns the admitting member's address");
	} finally { await Promise.all([a.stop(), n.stop()]); }
});

test("join with a wrong PIN fails bad-pin; 5th failure → 6th attempt fails pin-locked with retryAfterMs > 0", async () => {
	const a = await startNode("a");
	const n = await startNode("n");
	try {
		await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		for (let i = 0; i < 5; i++) await assert.rejects(n.fleet.join({ address: a.address(), pin: "000000", memberName: "nas" }), isCode("bad-pin"));
		await assert.rejects(n.fleet.join({ address: a.address(), pin: PIN, memberName: "nas" }), (err) => isCode("pin-locked")(err) && err.retryAfterMs > 0);
		assert.equal(n.fleet.status().joined, false);
		assert.equal(a.fleet.status().members.length, 1);
	} finally { await Promise.all([a.stop(), n.stop()]); }
});

test("join whose publicKeyPem does not match the TLS client key fails key-mismatch", async () => {
	const a = await startNode("a");
	const n = await startNode("n");
	try {
		await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		const [other] = await makeIdentities(1);
		const r = await requestMember({ identity: n.fleet.identity, addresses: [a.address()], expectMemberId: null, method: "POST", path: "/v1/join", body: { pin: PIN, memberId: other.memberId, publicKeyPem: other.publicKeyPem, name: "x" } });
		assert.equal(r.status, 400);
		assert.equal(r.body.error, "key-mismatch");
		assert.equal(a.fleet.status().members.length, 1);
	} finally { await Promise.all([a.stop(), n.stop()]); }
});

test("hello on an unjoined node returns fleetId null and its memberId", async () => {
	const n = await startNode("n");
	try {
		const h = n.fleet.hello();
		assert.equal(h.fleetId, null);
		assert.equal(h.fleetName, null);
		assert.equal(h.memberId, n.fleet.identity.memberId);
		assert.equal(typeof h.version, "string");
		const r = await requestMember({ identity: null, addresses: [n.address()], expectMemberId: n.fleet.identity.memberId, method: "GET", path: "/v1/hello" });
		assert.deepEqual(r.body, h);
	} finally { await n.stop(); }
});

test("createFleet or join when already joined fails already-joined", async () => {
	const a = await startNode("a");
	const n = await startNode("n");
	try {
		await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		await n.fleet.join({ address: a.address(), pin: PIN, memberName: "nas" });
		await assert.rejects(a.fleet.createFleet({ name: "x", pin: PIN, memberName: "mac" }), isCode("already-joined"));
		await assert.rejects(n.fleet.join({ address: a.address(), pin: PIN, memberName: "nas" }), isCode("already-joined"));
	} finally { await Promise.all([a.stop(), n.stop()]); }
});

test("join through an unjoined node fails not-joined; an unreachable address fails unreachable", async () => {
	const a = await startNode("a");
	const n = await startNode("n");
	try {
		await assert.rejects(n.fleet.join({ address: a.address(), pin: PIN, memberName: "nas" }), isCode("not-joined"));
		await assert.rejects(n.fleet.join({ address: { host: "127.0.0.1", port: 1 }, pin: PIN, memberName: "nas" }), isCode("unreachable"));
	} finally { await Promise.all([a.stop(), n.stop()]); }
});

test("roster.json and state.json are written and identity unchanged after join", async () => {
	const a = await startNode("a");
	const n = await startNode("n");
	try {
		await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		const before = readFileSync(join(n.dir, "identity.json"), "utf8");
		await n.fleet.join({ address: a.address(), pin: PIN, memberName: "nas" });
		assert.equal(readFileSync(join(n.dir, "identity.json"), "utf8"), before);
		for (const d of [a.dir, n.dir]) {
			assert.equal(JSON.parse(readFileSync(join(d, "roster.json"), "utf8")).events.length, 2);
			assert.ok(existsSync(join(d, "state.json")));
			if (process.platform !== "win32") assert.equal(statSync(join(d, "roster.json")).mode & 0o777, 0o600);
		}
		assert.equal(readFileSync(join(n.dir, "state.json"), "utf8").includes(PIN), false, "PIN never stored");
	} finally { await Promise.all([a.stop(), n.stop()]); }
});

test("a restarted node reloads its fleet from disk", async () => {
	const a = await startNode("a");
	const s = await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
	await a.stop();
	const again = await startNode("a", { dir: a.dir });
	try {
		assert.equal(again.fleet.status().fleet.id, s.fleet.id);
		assert.equal(again.fleet.status().self.name, "mac");
	} finally { await again.stop(); }
});
