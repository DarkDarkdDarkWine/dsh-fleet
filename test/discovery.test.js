import { test } from "node:test";
import assert from "node:assert/strict";
import { combineDiscovery, composeDiscovery, createDiscovery } from "../lib/discovery.js";
import { PIN, startFleet, startNode } from "./helpers/net.js";
import { fakeDiscovery } from "./helpers/fake-discovery.js";

function fakeBonjour() {
	const b = { published: [], browsers: [], destroyed: false };
	b.publish = (opts) => { const svc = { ...opts, stopped: false, stop(cb) { svc.stopped = true; cb?.(); } }; b.published.push(svc); return svc; };
	b.find = (opts, onUp) => { const br = { opts, onUp, updated: 0, update() { br.updated++; }, stop() {} }; b.browsers.push(br); return br; };
	b.destroy = () => { b.destroyed = true; };
	return b;
}

test("advertise carries fleet id after create and empty fleet before", async () => {
	const a = await startNode("a");
	try {
		assert.equal(a.discovery.advertised.at(-1).fleetId, "");
		const s = await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "mac" });
		const last = a.discovery.advertised.at(-1);
		assert.deepEqual(last, { fleetId: s.fleet.id, memberId: s.self.memberId, name: "mac", port: a.address().port });
	} finally { await a.stop(); }
});

test("discoverFleets groups two members of one fleet into one entry with its name", async () => {
	const f = await startFleet(["a", "b"]);
	const n = await startNode("n");
	try {
		const fleetId = f.nodes[0].fleet.status().fleet.id;
		for (const node of f.nodes) n.discovery.emit({ source: "mdns", fleetId, memberId: node.fleet.identity.memberId, name: node.name, ...node.address() });
		const found = await n.fleet.discoverFleets();
		assert.equal(found.length, 1);
		assert.equal(found[0].fleetId, fleetId);
		assert.equal(found[0].fleetName, "家", "the name comes from /v1/hello because mDNS txt has none");
		assert.equal(found[0].short, f.nodes[0].fleet.status().fleet.short);
		assert.equal(found[0].via.source, "mdns");
		const joined = await n.fleet.join({ address: { host: found[0].via.host, port: found[0].via.port }, pin: PIN, memberName: "n" });
		assert.equal(joined.members.length, 3);
	} finally { await Promise.all([f.stop(), n.stop()]); }
});

test("discovering a known member adds its new address to the address book", async () => {
	const f = await startFleet(["a", "b"]);
	const [a, b] = f.nodes;
	try {
		const bId = b.fleet.identity.memberId;
		a.discovery.emit({ source: "tailscale", fleetId: a.fleet.status().fleet.id, memberId: bId, name: "b", host: "100.64.0.9", port: 43190 });
		assert.ok(a.fleet.book.candidates(bId).some((x) => x.host === "100.64.0.9" && x.port === 43190));
	} finally { await f.stop(); }
});

test("discoveredUnjoined lists a node with empty fleet, never itself", async () => {
	const f = await startFleet(["a"]);
	const [a] = f.nodes;
	try {
		a.discovery.emit({ source: "mdns", fleetId: null, memberId: "1".repeat(32), name: "new-pc", host: "192.168.0.7", port: 43190 });
		a.discovery.emit({ source: "mdns", fleetId: null, memberId: a.fleet.identity.memberId, name: "me", host: "127.0.0.1", port: 1 });
		assert.deepEqual(a.fleet.discoveredUnjoined(), [{ memberId: "1".repeat(32), name: "new-pc", host: "192.168.0.7", port: 43190, source: "mdns" }]);
	} finally { await f.stop(); }
});

test("mDNS source publishes dsh-fleet with txt and reports IPv4 peers, skipping link-local and IPv6", async () => {
	const bonjour = fakeBonjour();
	const d = createDiscovery({ bonjour });
	d.advertise({ fleetId: "", memberId: "a".repeat(32), name: "mac", port: 43190 });
	d.advertise({ fleetId: "f".repeat(32), memberId: "a".repeat(32), name: "mac", port: 43190 });
	assert.equal(bonjour.published.length, 2);
	assert.equal(bonjour.published[0].stopped, true, "the previous advertisement is withdrawn");
	assert.deepEqual({ type: bonjour.published[1].type, port: bonjour.published[1].port, txt: bonjour.published[1].txt }, { type: "dsh-fleet", port: 43190, txt: { v: "1", fleet: "f".repeat(32), member: "a".repeat(32), name: "mac" } });
	const found = [];
	d.onFound((x) => found.push(x));
	bonjour.browsers[0].onUp({ port: 43190, addresses: ["fe80::1", "169.254.3.3", "192.168.31.14", "172.17.0.1"], txt: { v: "1", fleet: "", member: "b".repeat(32), name: "nas" } });
	bonjour.browsers[0].onUp({ port: 1, addresses: ["10.0.0.2"], txt: { v: "2", member: "c".repeat(32) } });
	assert.deepEqual(found.map((x) => x.host), ["192.168.31.14", "172.17.0.1"]);
	assert.deepEqual(found[0], { source: "mdns", fleetId: null, memberId: "b".repeat(32), name: "nas", host: "192.168.31.14", port: 43190 });
	await d.scanNow();
	assert.equal(bonjour.browsers[0].updated, 1);
	d.stop();
	assert.equal(bonjour.destroyed, true);
});

test("combineDiscovery fans out advertise/scan/stop and merges onFound", async () => {
	const x = fakeDiscovery();
	const y = fakeDiscovery();
	const c = combineDiscovery([x, y]);
	const seen = [];
	c.onFound((f) => seen.push(f.source));
	c.advertise({ fleetId: "" });
	x.emit({ source: "mdns" });
	y.emit({ source: "tailscale" });
	await c.scanNow();
	c.stop();
	assert.deepEqual(seen, ["mdns", "tailscale"]);
	assert.equal(x.advertised.length + y.advertised.length, 2);
	assert.equal(x.stopped && y.stopped, true);
});

test("with tailscale.enabled \"auto\" and no CLI found, no tailscale source is created and status().discovery.tailscale is \"off\"", async () => {
	let tailscaleCreated = false;
	const built = composeDiscovery({
		settings: { port: 0, tailscale: { enabled: "auto", scanSec: 60, cli: "" } },
		createMdns: () => fakeDiscovery(),
		createTailscale: () => { tailscaleCreated = true; return fakeDiscovery(); },
		findCli: () => null,
		logger: { warn() {} },
	});
	assert.equal(tailscaleCreated, false);
	assert.deepEqual(built.info, { mdns: "on", tailscale: "off" });
	const forced = composeDiscovery({ settings: { port: 0, tailscale: { enabled: true, scanSec: 60, cli: "" } }, createMdns: () => fakeDiscovery(), createTailscale: () => fakeDiscovery(), findCli: () => null, logger: { warn() {} } });
	assert.equal(forced.info.tailscale, "cli-not-found");
	const on = composeDiscovery({ settings: { port: 0, tailscale: { enabled: "auto", scanSec: 60, cli: "" } }, createMdns: () => fakeDiscovery(), createTailscale: () => fakeDiscovery(), findCli: () => "/usr/bin/tailscale", logger: { warn() {} } });
	assert.equal(on.info.tailscale, "on");
	const n = await startNode("n", { discovery: built.discovery, discoveryInfo: built.info });
	try {
		assert.deepEqual(n.fleet.status().discovery, { mdns: "on", tailscale: "off" });
	} finally { await n.stop(); }
});
