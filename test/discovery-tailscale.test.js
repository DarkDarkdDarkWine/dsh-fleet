import { test } from "node:test";
import assert from "node:assert/strict";
import { createTailscaleDiscovery, findTailscaleCli, parseTailscalePeers } from "../lib/discovery-tailscale.js";

// Trimmed, anonymised `tailscale status --json`.
const SAMPLE = {
	BackendState: "Running",
	Self: { HostName: "mac", OS: "macOS", TailscaleIPs: ["100.114.0.1", "fd7a:115c:a1e0::1"], Online: true },
	Peer: {
		"nodekey:1": { HostName: "nas", OS: "linux", TailscaleIPs: ["fd7a:115c:a1e0::2", "100.85.0.2"], Online: true },
		"nodekey:2": { HostName: "pc", OS: "windows", TailscaleIPs: ["100.73.0.3"], Online: false },
		"nodekey:3": { HostName: "phone", OS: "iOS", TailscaleIPs: ["100.68.0.4"], Online: true },
	},
};

test("findTailscaleCli prefers configured path, then platform paths in order, then PATH; returns null when none exist", () => {
	const only = (...paths) => (p) => paths.includes(p);
	assert.equal(findTailscaleCli({ platform: "darwin", exists: only("/x/ts"), configured: "/x/ts" }), "/x/ts");
	assert.equal(findTailscaleCli({ platform: "darwin", exists: only(), configured: "/x/ts" }), null, "a configured path that does not exist is not replaced");
	assert.equal(findTailscaleCli({ platform: "darwin", exists: only("/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale") }), "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
	assert.equal(findTailscaleCli({ platform: "linux", exists: only("/usr/sbin/tailscale") }), "/usr/sbin/tailscale");
	assert.equal(findTailscaleCli({ platform: "win32", exists: only("C:\\Program Files\\Tailscale\\tailscale.exe") }), "C:\\Program Files\\Tailscale\\tailscale.exe");
	assert.equal(findTailscaleCli({ platform: "linux", exists: only("/home/u/bin/tailscale"), pathEnv: "/home/u/bin:/usr/bin" }), "/home/u/bin/tailscale");
	assert.equal(findTailscaleCli({ platform: "linux", exists: only(), pathEnv: "/usr/bin" }), null);
});

test("parseTailscalePeers keeps only Online peers' first IPv4 and returns [] when BackendState is \"Stopped\"", () => {
	assert.deepEqual(parseTailscalePeers(SAMPLE), [
		{ host: "100.85.0.2", hostName: "nas", os: "linux" },
		{ host: "100.68.0.4", hostName: "phone", os: "iOS" },
	]);
	assert.deepEqual(parseTailscalePeers({ ...SAMPLE, BackendState: "Stopped" }), []);
	assert.deepEqual(parseTailscalePeers(null), []);
});

const hello = (memberId, fleetId = "f".repeat(32)) => ({ fleetId, fleetName: "家", memberId, name: memberId.slice(0, 3), version: "1.0.0-alpha.1" });

test("tailscale scan probes online peers and reports those that answer /v1/hello with source \"tailscale\"", async () => {
	const probed = [];
	const d = createTailscaleDiscovery({
		runStatus: async () => SAMPLE,
		probe: async (host, port) => { probed.push(`${host}:${port}`); return host === "100.85.0.2" ? hello("n".repeat(32)) : null; },
		port: 43190, scanSec: 60, logger: { warn() {} }, setIntervalFn: () => () => {},
	});
	const found = [];
	d.onFound((x) => found.push(x));
	await d.scanNow();
	assert.deepEqual(probed.sort(), ["100.68.0.4:43190", "100.85.0.2:43190"]);
	assert.deepEqual(found, [{ source: "tailscale", fleetId: "f".repeat(32), fleetName: "家", memberId: "n".repeat(32), name: "nnn", host: "100.85.0.2", port: 43190 }]);
	d.stop();
});

test("a probe that times out does not block the others; runStatus failure logs one warning and yields nothing", async () => {
	const many = { BackendState: "Running", Peer: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, { HostName: `h${i}`, OS: "linux", TailscaleIPs: [`100.64.0.${i}`], Online: true }])) };
	let inFlight = 0;
	let peak = 0;
	const d = createTailscaleDiscovery({
		runStatus: async () => many,
		probe: async (host) => {
			inFlight++; peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, host === "100.64.0.0" ? 300 : 10));
			inFlight--;
			return host === "100.64.0.0" ? null : hello(host.split(".").pop().padStart(32, "0"));
		},
		port: 1, scanSec: 60, logger: { warn() {} }, setIntervalFn: () => () => {},
	});
	const found = [];
	d.onFound((x) => found.push(x));
	await d.scanNow();
	assert.equal(found.length, 11);
	assert.ok(peak <= 8, `at most 8 concurrent probes (peak ${peak})`);

	const warnings = [];
	const broken = createTailscaleDiscovery({ runStatus: async () => { throw new Error("tailscaled not running"); }, probe: async () => null, port: 1, scanSec: 60, logger: { warn: (m) => warnings.push(m) }, setIntervalFn: () => () => {} });
	const none = [];
	broken.onFound((x) => none.push(x));
	await broken.scanNow();
	await broken.scanNow();
	assert.deepEqual(none, []);
	assert.equal(warnings.length, 1, "the same failure is warned once");
});

test("scanning starts on the first listener and stops with stop()", async () => {
	let interval = null;
	let cleared = false;
	const d = createTailscaleDiscovery({ runStatus: async () => SAMPLE, probe: async () => null, port: 1, scanSec: 60, logger: { warn() {} }, setIntervalFn: (fn, ms) => { interval = ms; return () => { cleared = true; }; } });
	assert.equal(interval, null);
	d.onFound(() => {});
	assert.equal(interval, 60000);
	d.stop();
	assert.equal(cleared, true);
});
