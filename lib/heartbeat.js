import { DEFAULT_TIMEOUT_MS, UnreachableError, requestMember } from "./transport/client.js";

/**
 * Periodic heartbeat to every other member: exchanges addresses and roster
 * digests, triggers roster sync, and drives online/offline state.
 * @param {{ fleet: import("./fleet.js").FleetService, settings: import("./settings.js").Settings }} opts
 */
export function createHeartbeat({ fleet, settings }) {
	let running = null;
	let timer = null;
	const budgetMs = (settings.heartbeatSec * 1000) / 2;

	async function beat(memberId) {
		const addresses = fleet.book.candidates(memberId);
		if (!addresses.length) return fleet.book.miss(memberId);
		const timeoutMs = Math.max(200, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(budgetMs / addresses.length)));
		let r;
		try {
			r = await requestMember({ identity: fleet.identity, addresses, expectMemberId: memberId, method: "POST", path: "/v1/heartbeat", body: fleet.heartbeatPayload(), timeoutMs });
		} catch (err) {
			if (!(err instanceof UnreachableError)) throw err;
			for (const a of err.attempts) fleet.book.fail(memberId, a.address);
			return fleet.book.miss(memberId);
		}
		if (r.status === 401 && r.body?.error === "not-a-member") return fleet.markRejected();
		if (r.status !== 200) return fleet.book.miss(memberId);
		fleet.acceptPeerReport(memberId, r.body, { address: r.address, verified: true });
		if (r.body?.rosterDigest !== fleet.log.digest()) await fleet.syncWith(memberId, r.address);
	}

	/** One round to all other members, concurrently. Overlapping calls share the round. */
	function tick() {
		if (running) return running;
		running = (async () => {
			if (!fleet.fold || fleet.error) return;
			const others = [...fleet.fold.members.keys()].filter((id) => id !== fleet.selfId);
			const results = await Promise.allSettled(others.map((id) => beat(id)));
			for (const r of results) if (r.status === "rejected") fleet.logger.warn(`dsh-fleet: heartbeat failed: ${r.reason?.message ?? r.reason}`);
		})().finally(() => { running = null; });
		return running;
	}

	return {
		tick,
		/** @param {(fn: () => void, ms: number) => unknown} setIntervalFn — ctx.setInterval in the plugin */
		start(setIntervalFn = setInterval) {
			timer = setIntervalFn(() => { tick().catch((err) => fleet.logger.warn(`dsh-fleet: heartbeat: ${err?.message ?? err}`)); }, settings.heartbeatSec * 1000);
		},
		stop() {
			if (typeof timer === "function") timer();
			else if (timer) clearInterval(timer);
			timer = null;
		},
	};
}
