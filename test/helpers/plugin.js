/** Run the real plugin entry in-process against a temp data dir, with a fake cordis ctx. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../../lib/index.js";

/** Fake cordis ctx: effect() runs at once and collects disposers, like Fiber.effect. */
export function fakeCtx() {
	const disposers = [];
	return {
		disposers,
		logger: { info() {}, warn() {} },
		effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return () => d?.(); },
		setInterval(fn, ms) { const t = setInterval(fn, ms); t.unref?.(); const d = () => clearInterval(t); disposers.push(d); return d; },
		dispose: async () => { for (const d of disposers.splice(0).reverse()) await d(); },
	};
}

/** A temp data dir whose settings bind 127.0.0.1 on an ephemeral port, Tailscale off. */
export function dataDir(settings = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fleet-plugin-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ port: 0, host: "127.0.0.1", tailscale: { enabled: false }, ...settings }));
	return dir;
}

/** apply() the plugin with DSH_FLEET_DIR=dir and wait until it is up. */
export async function runPlugin(dir) {
	process.env.DSH_FLEET_DIR = dir;
	const ctx = fakeCtx();
	const handle = plugin.apply(ctx, {});
	await handle.ready;
	return { ctx, handle, dir };
}
