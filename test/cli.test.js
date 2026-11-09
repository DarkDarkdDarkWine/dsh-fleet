import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { callLocal } from "../lib/local-client.js";
import { dataDir, runPlugin } from "./helpers/plugin.js";

const BIN = fileURLToPath(new URL("../bin/dsh-fleet.js", import.meta.url));
const PIN = "246810";

/** Run the CLI with --dir and the given stdin lines. */
function cli(dir, args, lines = []) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, "--dir", dir, ...args], { env: { ...process.env, NO_COLOR: "1" } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
		child.stdin.end(lines.map((l) => `${l}\n`).join(""));
	});
}

const status = async (dir) => (await callLocal({ dataDir: dir, path: "/local/status" })).body;
const portOf = async (dir) => (await status(dir)).listening.port;

test("create reads PIN twice from stdin; status --json shows joined true", async () => {
	const a = await runPlugin(dataDir());
	try {
		const r = await cli(a.dir, ["create", "家", "--name", "mac"], [PIN, PIN]);
		assert.equal(r.code, 0, r.out);
		const s = await cli(a.dir, ["status", "--json"]);
		assert.equal(s.code, 0, s.out);
		const parsed = JSON.parse(s.stdout);
		assert.equal(parsed.joined, true);
		assert.equal(parsed.fleet.name, "家");
		assert.equal(parsed.self.name, "mac");
		const human = await cli(a.dir, []);
		assert.match(human.stdout, /家/);
		assert.match(human.stdout, /mac/);
	} finally { await a.ctx.dispose(); }
});

test("create with mismatched PIN entries exits non-zero without creating", async () => {
	const a = await runPlugin(dataDir());
	try {
		const r = await cli(a.dir, ["create", "家"], [PIN, "135790"]);
		assert.notEqual(r.code, 0);
		assert.match(r.out, /两次输入的 PIN 不一致/);
		assert.equal((await status(a.dir)).joined, false);
		const bad = await cli(a.dir, ["create", "家"], ["12345", "12345"]);
		assert.notEqual(bad.code, 0);
		assert.match(bad.out, /6 位数字/);
	} finally { await a.ctx.dispose(); }
});

test("join --address joins the second node", async () => {
	const a = await runPlugin(dataDir());
	const n = await runPlugin(dataDir());
	try {
		await cli(a.dir, ["create", "家", "--name", "mac"], [PIN, PIN]);
		const r = await cli(n.dir, ["join", "--address", `127.0.0.1:${await portOf(a.dir)}`, "--name", "nas"], [PIN]);
		assert.equal(r.code, 0, r.out);
		const s = await status(n.dir);
		assert.deepEqual(s.members.map((m) => m.name).sort(), ["mac", "nas"]);
		const members = await cli(n.dir, ["members"]);
		assert.match(members.stdout, /mac/);
		assert.match(members.stdout, /nas/);
	} finally { await Promise.all([a.ctx.dispose(), n.ctx.dispose()]); }
});

test("remove by 8-char memberId prefix removes the member and prints the hint \"建议修改 PIN（dsh-fleet pin change）\"", async () => {
	const a = await runPlugin(dataDir());
	const n = await runPlugin(dataDir());
	try {
		await cli(a.dir, ["create", "家", "--name", "mac"], [PIN, PIN]);
		await cli(n.dir, ["join", "--address", `127.0.0.1:${await portOf(a.dir)}`, "--name", "nas"], [PIN]);
		const nId = (await status(n.dir)).self.memberId;
		const r = await cli(a.dir, ["remove", nId.slice(0, 8)], [PIN]);
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /建议修改 PIN（dsh-fleet pin change）/);
		assert.equal((await status(a.dir)).members.length, 1);
		const ambiguous = await cli(a.dir, ["remove", "zz"], [PIN]);
		assert.notEqual(ambiguous.code, 0);
	} finally { await Promise.all([a.ctx.dispose(), n.ctx.dispose()]); }
});

test("--pin 123456 is rejected with the interactive-only message", async () => {
	const a = await runPlugin(dataDir());
	try {
		for (const args of [["create", "家", "--pin", "123456"], ["join", "--pin=123456"]]) {
			const r = await cli(a.dir, args);
			assert.notEqual(r.code, 0);
			assert.match(r.out, /PIN 只能交互输入/);
		}
		assert.equal((await status(a.dir)).joined, false);
	} finally { await a.ctx.dispose(); }
});

test("status shows \"端口被占用\" when listening.error is EADDRINUSE", async () => {
	const blocker = net.createServer();
	await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
	const a = await runPlugin(dataDir({ port: blocker.address().port }));
	try {
		const r = await cli(a.dir, ["status"]);
		assert.match(r.stdout, /端口被占用/);
	} finally { await a.ctx.dispose(); blocker.close(); }
});

test("pin change and pin reset ask for the new PIN twice; describe and leave work", async () => {
	const a = await runPlugin(dataDir());
	try {
		await cli(a.dir, ["create", "家", "--name", "mac"], [PIN, PIN]);
		assert.equal((await cli(a.dir, ["pin", "change"], [PIN, "135790", "135790"])).code, 0);
		assert.notEqual((await cli(a.dir, ["pin", "change"], [PIN, "111111", "111111"])).code, 0, "old PIN no longer valid");
		assert.equal((await cli(a.dir, ["pin", "reset"], ["222222", "222222"])).code, 0);
		const d = await cli(a.dir, ["describe", "--description", "维护 NAS"]);
		assert.equal(d.code, 0, d.out);
		assert.equal((await status(a.dir)).members[0].description, "维护 NAS");
		const before = (await status(a.dir)).self.memberId;
		const no = await cli(a.dir, ["leave"], ["no"]);
		assert.notEqual(no.code, 0);
		assert.equal((await status(a.dir)).joined, true);
		const yes = await cli(a.dir, ["leave"], ["yes"]);
		assert.equal(yes.code, 0, yes.out);
		const after = await status(a.dir);
		assert.equal(after.joined, false);
		assert.notEqual(after.self.memberId, before);
	} finally { await a.ctx.dispose(); }
});

test("after 5 wrong PINs and a plugin restart, the next join still fails pin-locked", async () => {
	let a = await runPlugin(dataDir());
	const n = await runPlugin(dataDir());
	try {
		await cli(a.dir, ["create", "家", "--name", "mac"], [PIN, PIN]);
		const address = `127.0.0.1:${await portOf(a.dir)}`;
		for (let i = 0; i < 5; i++) {
			const r = await cli(n.dir, ["join", "--address", address], ["000000"]);
			assert.match(r.out, /PIN 错误/);
		}
		await a.ctx.dispose();
		a = await runPlugin(a.dir);
		const r = await cli(n.dir, ["join", "--address", `127.0.0.1:${await portOf(a.dir)}`], [PIN]);
		assert.notEqual(r.code, 0);
		assert.match(r.out, /已锁定/);
		assert.equal((await status(n.dir)).joined, false);
	} finally { await Promise.all([a.ctx.dispose(), n.ctx.dispose()]); }
});

test("a stopped plugin is reported instead of crashing", async () => {
	const a = await runPlugin(dataDir());
	await a.ctx.dispose();
	const r = await cli(a.dir, ["status"]);
	assert.notEqual(r.code, 0);
	assert.match(r.out, /插件没有在运行/);
});
