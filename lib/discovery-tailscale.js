import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Tailscale discovery: list online tailnet peers from the local CLI (no API
 * key) and ask each one's fleet port for /v1/hello. Only finds peers that use
 * the same fleet port as this member.
 */

const CANDIDATES = {
	darwin: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"],
	linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"],
	win32: ["C:\\Program Files\\Tailscale\\tailscale.exe"],
};
const MAX_CONCURRENT_PROBES = 8;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * @param {{ platform?: string, exists?: (p: string) => boolean, configured?: string, pathEnv?: string }} [opts]
 * @returns {string | null}
 */
export function findTailscaleCli({ platform = process.platform, exists = existsSync, configured = "", pathEnv = process.env.PATH ?? "" } = {}) {
	if (configured) return exists(configured) ? configured : null;
	for (const p of CANDIDATES[platform] ?? []) if (exists(p)) return p;
	const exe = platform === "win32" ? "tailscale.exe" : "tailscale";
	const sep = platform === "win32" ? ";" : delimiter;
	for (const dir of pathEnv.split(sep).filter(Boolean)) {
		const p = platform === "win32" ? `${dir.replace(/\\$/, "")}\\${exe}` : join(dir, exe);
		if (exists(p)) return p;
	}
	return null;
}

/**
 * @param {any} status parsed `tailscale status --json`
 * @returns {{ host: string, hostName: string, os: string }[]}
 */
export function parseTailscalePeers(status) {
	if (status?.BackendState !== "Running") return [];
	const peers = [];
	for (const p of Object.values(status.Peer ?? {})) {
		if (p?.Online !== true) continue;
		const host = (p.TailscaleIPs ?? []).find((ip) => IPV4.test(ip));
		if (host) peers.push({ host, hostName: String(p.HostName ?? ""), os: String(p.OS ?? "") });
	}
	return peers;
}

/** @param {string} cli */
export function runTailscaleStatus(cli) {
	return new Promise((resolve, reject) => {
		execFile(cli, ["status", "--json"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
			if (err) return reject(err);
			try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
		});
	});
}

/** Run `fn` over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
	let next = 0;
	const worker = async () => { while (next < items.length) await fn(items[next++]); };
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * @param {{ runStatus(): Promise<any>, probe(host: string, port: number): Promise<any>, port: number, scanSec: number, logger: { warn(m: string): void }, setIntervalFn?: (fn: () => void, ms: number) => unknown }} opts
 * @returns {import("./discovery.js").Discovery}
 */
export function createTailscaleDiscovery({ runStatus, probe, port, scanSec, logger, setIntervalFn = setInterval }) {
	const listeners = [];
	let timer = null;
	let scanning = null;
	let lastError = null;

	const emit = (found) => { for (const cb of listeners) cb(found); };

	async function scan() {
		let peers;
		try {
			peers = parseTailscalePeers(await runStatus());
			lastError = null;
		} catch (err) {
			const msg = err?.message ?? String(err);
			if (msg !== lastError) logger.warn(`dsh-fleet: tailscale status failed: ${msg}`);
			lastError = msg;
			return;
		}
		await pool(peers, MAX_CONCURRENT_PROBES, async ({ host }) => {
			const h = await probe(host, port).catch(() => null);
			if (!h || typeof h.memberId !== "string") return;
			emit({ source: "tailscale", fleetId: h.fleetId ?? null, ...(h.fleetName ? { fleetName: h.fleetName } : {}), memberId: h.memberId, name: String(h.name ?? ""), host, port });
		});
	}

	const scanNow = () => (scanning ??= scan().finally(() => { scanning = null; }));

	return {
		advertise() {},
		onFound(cb) {
			listeners.push(cb);
			if (!timer) {
				timer = setIntervalFn(() => { scanNow(); }, scanSec * 1000);
				scanNow();
			}
		},
		scanNow,
		stop() {
			if (typeof timer === "function") timer();
			else if (timer) clearInterval(timer);
			timer = null;
		},
	};
}
