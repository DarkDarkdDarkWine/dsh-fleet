/**
 * In-process multi-node harness: each node gets its own data dir, identity and
 * FleetService on an ephemeral 127.0.0.1 port, with a fake discovery.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetService } from "../../lib/fleet.js";
import { loadOrCreateIdentity } from "../../lib/identity.js";
import { loadSettings } from "../../lib/settings.js";
import { fakeDiscovery } from "./fake-discovery.js";

export const PIN = "246810";
export const quietLogger = { info() {}, warn() {} };

/**
 * @param {string} name
 * @param {{ dir?: string, settings?: object, discovery?: object, discoveryInfo?: object, now?: () => number }} [opts]
 */
export async function startNode(name, opts = {}) {
	const dir = opts.dir ?? mkdtempSync(join(tmpdir(), `fleet-${name}-`));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ port: 0, host: "127.0.0.1", ...opts.settings }));
	const identity = await loadOrCreateIdentity(dir);
	const discovery = opts.discovery ?? fakeDiscovery();
	const fleet = new FleetService({ dataDir: dir, settings: loadSettings(dir), identity, discovery, discoveryInfo: opts.discoveryInfo, logger: quietLogger, now: opts.now });
	await fleet.start();
	return { name, dir, fleet, discovery, address: () => ({ host: "127.0.0.1", port: fleet.status().listening.port }), stop: () => fleet.stop() };
}

/** Start `names.length` nodes; the first creates the fleet, the rest join through it. */
export async function startFleet(names) {
	const nodes = [];
	for (const n of names) nodes.push(await startNode(n));
	const [first, ...rest] = nodes;
	await first.fleet.createFleet({ name: "家", pin: PIN, memberName: first.name });
	for (const n of rest) await n.fleet.join({ address: first.address(), pin: PIN, memberName: n.name });
	return { nodes, stop: () => Promise.all(nodes.map((n) => n.stop())) };
}
