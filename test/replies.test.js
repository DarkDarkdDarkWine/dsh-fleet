import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startFleet, tool, api, readJson, until } from "./helpers/fleet-net.js";

const pendingFor = (node, dev) => readJson(join(node.dir, "fleet-replies.json")).pending.filter((r) => r.toDevice === dev && !r.delivered);

test("pull from an executor returns only the caller's own receipts", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }, { device: "c" }]);
	try {
		const { a, b, c } = fleet.nodes;
		await tool(a, "fleet_send", { device: "b", text: "task-a" });
		await tool(c, "fleet_send", { device: "b", text: "task-c" });
		await until(() => pendingFor(b, "a").length === 1 && pendingFor(b, "c").length === 1);

		const aInbox = JSON.parse(await tool(a, "fleet_inbox", { device: "b" }));
		const aTexts = aInbox.receipts.map((r) => r.text);
		assert.equal(aTexts.length, 1);
		assert.match(aTexts[0], /task-a/);

		const cInbox = JSON.parse(await tool(c, "fleet_inbox", { device: "b" }));
		assert.equal(cInbox.receipts?.length, 1, "c's receipt must survive a's pull");
		assert.match(cInbox.receipts[0].text, /task-c/);
	} finally {
		await fleet.close();
	}
});

test("scoped pull keeps receipts until the caller acks them", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a, b } = fleet.nodes;
		await tool(a, "fleet_send", { device: "b", text: "job" });
		await until(() => pendingFor(b, "a").length === 1);

		const first = await api(b, "/fleet/replies?for=a");
		assert.equal(first.payload.scoped, true);
		assert.equal(first.payload.receipts.length, 1);
		const again = await api(b, "/fleet/replies?for=a");
		assert.equal(again.payload.receipts.length, 1, "unacked receipt must still be available");

		const ack = await api(b, "/fleet/replies", { method: "POST", body: { for: "a", keys: [first.payload.receipts[0].key] } });
		assert.equal(ack.payload.acked, 1);
		const after = await api(b, "/fleet/replies?for=a");
		assert.equal(after.payload.receipts.length, 0);
	} finally {
		await fleet.close();
	}
});

test("fleet_inbox pull acks what it stored", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a, b } = fleet.nodes;
		await tool(a, "fleet_send", { device: "b", text: "job" });
		await until(() => pendingFor(b, "a").length === 1);
		await tool(a, "fleet_inbox", { device: "b" });
		assert.equal(pendingFor(b, "a").length, 0);
	} finally {
		await fleet.close();
	}
});

test("unscoped pull (pre-0.3.2 callers) keeps the legacy consume-on-read behaviour", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a, b } = fleet.nodes;
		await tool(a, "fleet_send", { device: "b", text: "old" });
		await until(() => pendingFor(b, "a").length === 1);
		const legacy = await api(b, "/fleet/replies");
		assert.equal(legacy.payload.scoped, undefined);
		assert.equal(legacy.payload.receipts.length, 1);
		assert.equal(pendingFor(b, "a").length, 0);
	} finally {
		await fleet.close();
	}
});

test("the same receipt pushed twice lands in the inbox once", async () => {
	const fleet = await startFleet([{ device: "a" }, { device: "b" }]);
	try {
		const { a } = fleet.nodes;
		const receipt = { type: "receipt", device: "b", deliveryId: "d-dup", kind: "reply", text: "hi" };
		await api(a, "/fleet/message", { method: "POST", body: receipt });
		const second = await api(a, "/fleet/message", { method: "POST", body: receipt });
		assert.equal(second.payload.duplicate, true);
		const inbox = JSON.parse(await tool(a, "fleet_inbox", {}));
		assert.equal(inbox.receipts.length, 1);
	} finally {
		await fleet.close();
	}
});

test("push mode still delivers the reply and closes the outbox entry", async () => {
	const fleet = await startFleet([{ device: "a", advertise: true }, { device: "b" }]);
	try {
		const { a } = fleet.nodes;
		await tool(a, "fleet_send", { device: "b", text: "pushed" });
		await until(() => readJson(join(a.dir, "fleet-inbox.json")).messages.length === 1);
		const [delivery] = readJson(join(a.dir, "fleet-outbox.json")).deliveries;
		assert.equal(delivery.state, "replied");
		assert.match(delivery.replyText, /pushed/);
	} finally {
		await fleet.close();
	}
});
