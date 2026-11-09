/**
 * Fold a RosterLog into the current fleet state (spec §5.3).
 * @typedef {{ memberId: string, publicKeyPem: string, name: string, description: string, joinedAt: number, admittedBy: string | null }} Member
 * @typedef {{ fleetId: string, fleetName: string, members: Map<string, Member>, removed: Set<string>, pinVerifier: string, pinConflict: { winner: string, losers: string[] } | null }} FleetState
 * @typedef {import("./events.js").SignedEvent} SignedEvent
 */

/** Concurrent maxima: candidates that are not an ancestor of another candidate, best first. */
function maxima(log, candidates) {
	const top = candidates.filter((c) => !candidates.some((d) => d !== c && log.isAncestor(c.hash, d.hash)));
	return top.sort((a, b) => b.at - a.at || (a.author < b.author ? 1 : a.author > b.author ? -1 : 0) || (a.hash < b.hash ? 1 : -1));
}

/**
 * Removes in log order. A remove is effective unless its author was already
 * removed by an effective remove it does not precede; concurrent mutual
 * removals therefore resolve identically on every node (log order is canonical).
 */
function effectiveRemoves(log, events) {
	const removes = [];
	for (const e of events) {
		if (e.type !== "member.remove") continue;
		if (!removes.some((r) => r.body.memberId === e.author && !log.isAncestor(e.hash, r.hash))) removes.push(e);
	}
	return removes;
}

/**
 * @param {import("./log.js").RosterLog} log
 * @returns {FleetState | null} null when the log has no fleet.create
 */
export function foldState(log) {
	const create = log.create;
	if (!create) return null;
	const events = log.all();
	const removes = effectiveRemoves(log, events);
	const removed = new Set(removes.map((r) => r.body.memberId));
	const invalid = (e) => removes.some((r) => r.body.memberId === e.author && !log.isAncestor(e.hash, r.hash));
	const valid = events.filter((e) => !invalid(e));

	const { creator } = create.body;
	const all = new Map([[creator.memberId, { memberId: creator.memberId, publicKeyPem: creator.publicKeyPem, name: creator.name, description: "", joinedAt: create.at, admittedBy: null }]]);
	for (const e of valid) {
		if (e.type !== "member.join" || all.has(e.body.memberId)) continue;
		all.set(e.body.memberId, { memberId: e.body.memberId, publicKeyPem: e.body.publicKeyPem, name: e.body.name, description: "", joinedAt: e.at, admittedBy: e.author });
	}
	const members = new Map();
	for (const [id, m] of all) {
		if (removed.has(id)) continue;
		const [latest] = maxima(log, valid.filter((e) => e.type === "member.describe" && e.author === id));
		members.set(id, latest ? { ...m, name: latest.body.name || m.name, description: latest.body.description ?? "" } : m);
	}

	const pins = maxima(log, valid.filter((e) => e.type === "fleet.create" || e.type === "pin.change"));
	const [winner, ...losers] = pins;
	return {
		fleetId: create.fleetId,
		fleetName: create.body.name,
		members,
		removed,
		pinVerifier: winner.body.pinVerifier,
		pinConflict: losers.length ? { winner: winner.hash, losers: losers.map((e) => e.hash) } : null,
	};
}
