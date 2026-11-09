import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../lib/index.js";
import { callLocal } from "../lib/local-client.js";

/** Fake cordis ctx: effect() runs at once and collects disposers, like Fiber.effect. */
function fakeCtx() {
	const disposers = [];
	return {
		disposers,
		logger: { info() {}, warn() {} },
		effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return () => d?.(); },
		setInterval(fn, ms) { const t = setInterval(fn, ms); t.unref?.(); const d = () => clearInterval(t); disposers.push(d); return d; },
		dispose: async () => { for (const d of disposers.splice(0).reverse()) await d(); },
	};
}

function dataDir(settings = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fleet-plugin-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ port: 0, host: "127.0.0.1", tailscale: { enabled: false }, ...settings }));
	return dir;
}

async function run(dir) {
	process.env.DSH_FLEET_DIR = dir;
	const ctx = fakeCtx();
	const handle = plugin.apply(ctx, {});
	await handle.ready;
	return { ctx, handle };
}

const portFree = (port) => new Promise((resolve) => {
	const s = net.createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});

test("exports the plugin shape", () => {
	assert.equal(plugin.name, "dsh-fleet");
	assert.deepEqual(plugin.inject, ["timer"]);
	assert.equal(typeof plugin.apply, "function");
});

test("local route without token gets 401; with token returns status", async () => {
	const dir = dataDir();
	const { ctx } = await run(dir);
	try {
		const control = JSON.parse(readFileSync(join(dir, "control.json"), "utf8"));
		const status = await new Promise((resolve, reject) => {
			https.get({ host: "127.0.0.1", port: control.port, path: "/local/status", rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
		});
		assert.equal(status, 401);
		const r = await callLocal({ dataDir: dir, path: "/local/status" });
		assert.equal(r.status, 200);
		assert.equal(r.body.joined, false);
		assert.equal(typeof r.body.listening.port, "number");
	} finally { await ctx.dispose(); }
});

test("apply with a fake ctx starts listening and writes control.json (0600 on POSIX)", async () => {
	const dir = dataDir();
	const { ctx } = await run(dir);
	try {
		const control = JSON.parse(readFileSync(join(dir, "control.json"), "utf8"));
		assert.match(control.token, /^[0-9a-f]{64}$/);
		assert.equal(Number.isInteger(control.port), true);
		if (process.platform !== "win32") assert.equal(statSync(join(dir, "control.json")).mode & 0o777, 0o600);
		const r = await callLocal({ dataDir: dir, method: "POST", path: "/local/create", body: { name: "家", pin: "246810", memberName: "mac" } });
		assert.equal(r.status, 200);
		assert.equal(r.body.members.length, 1);
		const bad = await callLocal({ dataDir: dir, method: "POST", path: "/local/create", body: { name: "x", pin: "246810" } });
		assert.deepEqual([bad.status, bad.body.error], [400, "already-joined"]);
	} finally { await ctx.dispose(); }
});

test("running the collected effect disposers closes the fleet port (a new listen on it succeeds)", async () => {
	const dir = dataDir();
	const { ctx } = await run(dir);
	const { body } = await callLocal({ dataDir: dir, path: "/local/status" });
	assert.equal(await portFree(body.listening.port), false);
	await ctx.dispose();
	assert.equal(await portFree(body.listening.port), true);
});

test("apply twice on the same ctx after disposing the first does not throw", async () => {
	const dir = dataDir({ port: 0 });
	const first = await run(dir);
	await first.ctx.dispose();
	const second = await run(dir);
	try {
		const r = await callLocal({ dataDir: dir, path: "/local/status" });
		assert.equal(r.status, 200);
	} finally { await second.ctx.dispose(); }
});

test("apply when the port is taken does not throw; status().listening.error === \"EADDRINUSE\"", async () => {
	const blocker = net.createServer();
	await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
	const dir = dataDir({ port: blocker.address().port });
	const { ctx } = await run(dir);
	try {
		const r = await callLocal({ dataDir: dir, path: "/local/status" });
		assert.equal(r.body.listening.error, "EADDRINUSE");
	} finally { await ctx.dispose(); blocker.close(); }
});

test("apply with a corrupt roster.json does not throw; status().error === \"roster-corrupt\" and the file is unchanged", async () => {
	const dir = dataDir();
	writeFileSync(join(dir, "roster.json"), "{broken");
	const { ctx } = await run(dir);
	try {
		const r = await callLocal({ dataDir: dir, path: "/local/status" });
		assert.equal(r.body.error, "roster-corrupt");
		assert.equal(readFileSync(join(dir, "roster.json"), "utf8"), "{broken");
		const create = await callLocal({ dataDir: dir, method: "POST", path: "/local/create", body: { name: "家", pin: "246810" } });
		assert.deepEqual([create.status, create.body.error], [400, "roster-corrupt"]);
	} finally { await ctx.dispose(); }
});

test("a locked PIN maps to 423 with retryAfterMs on the local routes", async () => {
	const dir = dataDir();
	const { ctx } = await run(dir);
	try {
		await callLocal({ dataDir: dir, method: "POST", path: "/local/create", body: { name: "家", pin: "246810", memberName: "mac" } });
		for (let i = 0; i < 5; i++) await callLocal({ dataDir: dir, method: "POST", path: "/local/pin/change", body: { oldPin: "000000", newPin: "111111" } });
		const r = await callLocal({ dataDir: dir, method: "POST", path: "/local/pin/change", body: { oldPin: "246810", newPin: "111111" } });
		assert.equal(r.status, 423);
		assert.ok(r.body.retryAfterMs > 0);
	} finally { await ctx.dispose(); }
});
