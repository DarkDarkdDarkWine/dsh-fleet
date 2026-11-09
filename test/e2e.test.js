import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeartbeat } from "../lib/heartbeat.js";
import { PIN, startNode } from "./helpers/net.js";

const HEARTBEAT_SEC = 5;
const TWO_BEATS_MS = 2 * HEARTBEAT_SEC * 1000 + 1500;

async function live(name, dir) {
	const node = await startNode(name, { dir, settings: { heartbeatSec: HEARTBEAT_SEC } });
	node.hb = createHeartbeat({ fleet: node.fleet, settings: node.fleet.settings });
	node.hb.start((fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); });
	node.hb.tick();
	const stop = node.stop;
	node.stop = async () => { node.hb.stop(); await stop(); };
	return node;
}

async function until(predicate, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

const onlineCount = (node) => node.fleet.status().members.filter((m) => m.online).length;

test("create on A, join B and C via A; within 2 heartbeats all three list three online members; restart and remove propagate", { timeout: 90_000 }, async () => {
	let a = await live("a");
	let b = await live("b");
	let c = await live("c");
	try {
		await a.fleet.createFleet({ name: "家", pin: PIN, memberName: "a" });
		await b.fleet.join({ address: a.address(), pin: PIN, memberName: "b" });
		await c.fleet.join({ address: a.address(), pin: PIN, memberName: "c" });
		await until(() => [a, b, c].every((n) => n.fleet.status().members.length === 3 && onlineCount(n) === 3), TWO_BEATS_MS, "three online members on every node");

		// restart B (stop + start on the same dir): same memberId, still a member, online again within 2 heartbeats
		const bId = b.fleet.identity.memberId;
		await b.stop();
		b = await live("b", b.dir);
		assert.equal(b.fleet.identity.memberId, bId);
		assert.equal(b.fleet.status().members.length, 3);
		await until(() => [a, c].every((n) => n.fleet.status().members.find((m) => m.memberId === bId)?.online) && onlineCount(b) === 3, TWO_BEATS_MS, "B online again after restart");

		// remove C from B; within 2 heartbeats A no longer lists C
		const cId = c.fleet.identity.memberId;
		await b.fleet.removeMember({ memberId: cId, pin: PIN });
		await until(() => !a.fleet.status().members.some((m) => m.memberId === cId), TWO_BEATS_MS, "A drops C");
		await until(() => c.fleet.status().self.rejected, TWO_BEATS_MS, "C learns it was removed");
	} finally {
		await Promise.all([a.stop(), b.stop(), c.stop()]);
	}
});
