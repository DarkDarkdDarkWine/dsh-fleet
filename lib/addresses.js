import { networkInterfaces } from "node:os";

/** @typedef {{ host: string, port: number }} Address */

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|kube)/;
const MAX_ADDRS = 8;

const isIPv4 = (a) => a.family === "IPv4" || a.family === 4;

/**
 * This device's reachable IPv4 addresses, skipping loopback, link-local and
 * container/VM bridges (findings §4: a NAS can expose dozens of docker bridges).
 * @param {number} port
 * @param {ReturnType<typeof networkInterfaces>} [ifaces]
 * @returns {Address[]}
 */
export function localAddresses(port, ifaces = networkInterfaces()) {
	const hosts = new Set();
	for (const [name, list] of Object.entries(ifaces)) {
		if (VIRTUAL_IFACE.test(name)) continue;
		for (const a of list ?? []) {
			if (a.internal || !isIPv4(a) || a.address.startsWith("169.254.")) continue;
			hosts.add(a.address);
		}
	}
	return [...hosts].sort().map((host) => ({ host, port }));
}

const sameAddr = (a, b) => a.host === b.host && a.port === b.port;

/**
 * Where each member can be reached. Addresses are hints, never identity.
 * Persisted through `save` on every change.
 */
export class AddressBook {
	/** @param {{ load(): object | null, save(snapshot: object): void, now(): number }} io */
	constructor({ load, save, now }) {
		this.persist = save;
		this.now = now;
		this.state = structuredClone(load() ?? {});
	}

	entry(memberId) {
		return this.state[memberId] ?? { addrs: [], lastSeenAt: 0, misses: 0 };
	}

	update(memberId, entry) {
		this.state = { ...this.state, [memberId]: entry };
		this.persist(this.snapshot());
	}

	/** Remember that `addr` was tried (`ok` = it answered). */
	record(memberId, addr, ok) {
		const e = this.entry(memberId);
		const prev = e.addrs.find((a) => sameAddr(a, addr));
		const next = { host: addr.host, port: addr.port, lastOk: ok ? this.now() : prev?.lastOk ?? 0, lastSeen: this.now() };
		const addrs = [next, ...e.addrs.filter((a) => !sameAddr(a, addr))].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_ADDRS);
		this.update(memberId, { ...e, addrs });
	}

	/** Addresses to try: last-ok first, then most recently seen. @returns {Address[]} */
	candidates(memberId) {
		return [...this.entry(memberId).addrs]
			.sort((a, b) => b.lastOk - a.lastOk || b.lastSeen - a.lastSeen)
			.map(({ host, port }) => ({ host, port }));
	}

	/** Learn addresses from a peer's directory without overriding what we know. */
	mergeGossip(directory, selfId) {
		for (const [memberId, list] of Object.entries(directory ?? {})) {
			if (memberId === selfId || !Array.isArray(list)) continue;
			const e = this.entry(memberId);
			const fresh = list.filter((a) => typeof a?.host === "string" && Number.isInteger(a?.port) && !e.addrs.some((b) => sameAddr(a, b)));
			if (!fresh.length) continue;
			const learnt = fresh.map((a) => ({ host: a.host, port: a.port, lastOk: 0, lastSeen: this.now() }));
			this.update(memberId, { ...e, addrs: [...e.addrs, ...learnt].slice(0, MAX_ADDRS) });
		}
	}

	markSeen(memberId) {
		this.update(memberId, { ...this.entry(memberId), lastSeenAt: this.now(), misses: 0 });
	}

	miss(memberId) {
		const e = this.entry(memberId);
		this.update(memberId, { ...e, misses: e.misses + 1 });
	}

	isOnline(memberId, offlineAfterMisses) {
		const e = this.entry(memberId);
		return e.lastSeenAt > 0 && e.misses < offlineAfterMisses;
	}

	/** Addresses that answered at least once, for gossip. @returns {Record<string, Address[]>} */
	directory() {
		const out = {};
		for (const [id, e] of Object.entries(this.state)) {
			const ok = e.addrs.filter((a) => a.lastOk > 0).map(({ host, port }) => ({ host, port }));
			if (ok.length) out[id] = ok;
		}
		return out;
	}

	snapshot() {
		return structuredClone(this.state);
	}
}
