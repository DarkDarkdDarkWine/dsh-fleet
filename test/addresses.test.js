import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressBook, localAddresses } from "../lib/addresses.js";

const v4 = (address, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "", cidr: null });
const v6 = (address) => ({ address, family: "IPv6", internal: false, netmask: "", mac: "", cidr: null, scopeid: 0 });

test("localAddresses skips internal and IPv6, keeps 100.x tailscale", () => {
	const ifaces = { lo0: [v4("127.0.0.1", true)], en0: [v4("192.168.0.250"), v6("fe80::1")], utun4: [v4("100.114.210.24")] };
	assert.deepEqual(localAddresses(43190, ifaces), [
		{ host: "100.114.210.24", port: 43190 },
		{ host: "192.168.0.250", port: 43190 },
	]);
});

test("localAddresses skips docker0, br-1a2b, veth9, 169.254.x.x and 198.18.x.x but keeps enp2s0", () => {
	const ifaces = {
		enp2s0: [v4("192.168.31.14")],
		docker0: [v4("172.17.0.1")],
		"br-1a2b": [v4("192.168.0.1")],
		veth9: [v4("10.9.0.1")],
		eth1: [v4("169.254.10.2")],
		utun7: [v4("198.18.0.1")], // proxy TUN fake-IP range (Shadowrocket/Clash)
	};
	assert.deepEqual(localAddresses(1, ifaces), [{ host: "192.168.31.14", port: 1 }]);
});

function book(clock = { t: 1000 }) {
	const store = { saved: null };
	return { b: new AddressBook({ load: () => store.saved, save: (s) => { store.saved = s; }, now: () => clock.t }), clock, store };
}

test("candidates puts last-ok first, caps at 8", () => {
	const { b, clock } = book();
	for (let i = 0; i < 10; i++) { clock.t += 10; b.record("m", { host: `10.0.0.${i}`, port: 1 }, false); }
	clock.t += 10;
	b.record("m", { host: "10.0.0.3", port: 1 }, true);
	const c = b.candidates("m");
	assert.equal(c.length, 8);
	assert.deepEqual(c[0], { host: "10.0.0.3", port: 1 });
	assert.deepEqual(c[1], { host: "10.0.0.9", port: 1 }, "then most recently seen");
	assert.deepEqual(b.candidates("unknown"), []);
});

test("mergeGossip ignores self and never drops existing entries", () => {
	const { b } = book();
	b.record("a", { host: "1.1.1.1", port: 1 }, true);
	b.mergeGossip({ a: [{ host: "2.2.2.2", port: 1 }], self: [{ host: "3.3.3.3", port: 1 }], c: [{ host: "4.4.4.4", port: 2 }] }, "self");
	assert.deepEqual(b.candidates("a"), [{ host: "1.1.1.1", port: 1 }, { host: "2.2.2.2", port: 1 }]);
	assert.deepEqual(b.candidates("self"), []);
	assert.deepEqual(b.candidates("c"), [{ host: "4.4.4.4", port: 2 }]);
});

test("online after markSeen, offline after offlineAfterMisses misses", () => {
	const { b, store, clock } = book();
	assert.equal(b.isOnline("m", 3), false);
	b.markSeen("m");
	assert.equal(b.isOnline("m", 3), true);
	b.miss("m");
	b.miss("m");
	assert.equal(b.isOnline("m", 3), true);
	b.miss("m");
	assert.equal(b.isOnline("m", 3), false);
	b.markSeen("m");
	assert.equal(b.isOnline("m", 3), true);
	const again = new AddressBook({ load: () => store.saved, save: () => {}, now: () => clock.t });
	assert.equal(again.snapshot().m.lastSeenAt, 1000);
});

test("a failed attempt demotes an address below one not yet tried", () => {
	const { b, clock } = book();
	b.record("m", { host: "10.0.0.1", port: 1 }, false);
	clock.t += 10;
	b.record("m", { host: "10.0.0.2", port: 1 }, false);
	assert.deepEqual(b.candidates("m")[0], { host: "10.0.0.2", port: 1 });
	clock.t += 10;
	b.fail("m", { host: "10.0.0.2", port: 1 });
	assert.deepEqual(b.candidates("m").map((a) => a.host), ["10.0.0.1", "10.0.0.2"]);
	clock.t += 10;
	b.record("m", { host: "10.0.0.2", port: 1 }, false); // reported again later: fresh again
	assert.deepEqual(b.candidates("m")[0], { host: "10.0.0.2", port: 1 });
	b.fail("m", { host: "9.9.9.9", port: 1 }); // unknown address: no-op
	assert.equal(b.candidates("m").length, 2);
});

