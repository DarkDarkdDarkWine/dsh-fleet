import { DEFAULT_TIMEOUT_MS, UnreachableError, requestMember } from "./transport/client.js";

/**
 * Periodic heartbeat to every other member: exchanges addresses and roster
 * digests, triggers roster sync, and drives online/offline state.
 * @param {{ fleet: import("./fleet.js").FleetService, settings: import("./settings.js").Settings }} opts
 */
const MIN_ATTEMPT_MS = 200;

export function createHeartbeat({ fleet, settings }) {
	let running = null;
	let timer = null;
	const budgetMs = (settings.heartbeatSec * 1000) / 2;

	/**
	 * Try addresses in order within budgetMs. The first (best) candidate gets a
	 * full request timeout; the rest share what is left, so a member with many
	 * stale addresses is still reached over a slow working link.
	 */
	async function reach(memberId, addresses) {
		const deadline = Date.now() + budgetMs;
		const failed = [];
		for (let i = 0; i < addresses.length; i++) {
			const remaining = deadline - Date.now();
			if (remaining < MIN_ATTEMPT_MS) break;
			const share = i === 0 ? remaining : Math.max(MIN_ATTEMPT_MS, Math.floor(remaining / (addresses.length - i)));
			try {
				return await requestMember({ identity: fleet.identity, addresses: [addresses[i]], expectMemberId: memberId, method: "POST", path: "/v1/heartbeat", body: fleet.heartbeatPayload(), timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, share) });
			} catch (err) {
				if (!(err instanceof UnreachableError)) throw err;
				failed.push(addresses[i]);
			}
		}
		for (const a of failed) fleet.book.fail(memberId, a);
		return null;
	}

	async function beat(memberId) {
		const addresses = fleet.book.candidates(memberId);
		if (!addresses.length) return fleet.book.miss(memberId);
		const r = await reach(memberId, addresses);
		if (!r) return fleet.book.miss(memberId);
		if (r.status === 401 && r.body?.error === "not-a-member") {
			// Only a peer that holds our removal counts; an unsynced peer just does not know us yet.
			if (r.body.removed === true) fleet.markRejected();
			return fleet.book.miss(memberId);
		}
		if (r.status !== 200) return fleet.book.miss(memberId);
		fleet.clearRejected();
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
