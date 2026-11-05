import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startFleet, tool, api, readJson, until } from "./helpers/fleet-net.js";

const CLI = fileURLToPath(new URL("../bin/dsh-fleet.js", import.meta.url));
const run = promisify(execFile);

function cli(node, args) {
	return run(process.execPath, [CLI, ...args, "--api", node.url], {
		env: { ...process.env, DSH_FLEET_CONFIG: node.cfgPath, DSH_FLEET_API: "", DSH_FLEET_SECRET: "" },
	});
}

const pendingFor = (node, dev) => readJson(join(node.dir, "fleet-replies.json")).pending.filter((r) => r.toDevice === dev && !r.delivered);

test("cli send delivers to the named peer, not the local steward", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a, b } = fleet.nodes;
		const { stdout } = await cli(a, ["send", "b", "hello-cli", "--json"]);
		assert.equal(JSON.parse(stdout).async, true);
		assert.deepEqual(b.followups, ["hello-cli"]);
		assert.deepEqual(a.followups, []);
		await until(() => pendingFor(b, "a").length === 1);
	} finally {
		await fleet.close();
	}
});

test("cli send refuses to target the local device", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a } = fleet.nodes;
		await assert.rejects(cli(a, ["send", "a", "oops"]), /本机/);
		assert.deepEqual(a.followups, []);
	} finally {
		await fleet.close();
	}
});

test("cli inbox stores pulled receipts locally and acks the peer", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a, b } = fleet.nodes;
		await cli(a, ["send", "b", "job"]);
		await until(() => pendingFor(b, "a").length === 1);

		const { stdout } = await cli(a, ["inbox", "b"]);
		assert.match(stdout, /done: job/);
		assert.equal(pendingFor(b, "a").length, 0, "peer must be acked after local store");

		const local = JSON.parse(await tool(a, "fleet_inbox", {}));
		assert.equal(local.receipts.length, 1);
		assert.match(local.receipts[0].text, /done: job/);

		const leftover = await api(b, "/fleet/replies?for=a");
		assert.equal(leftover.payload.receipts.length, 0);
	} finally {
		await fleet.close();
	}
});
