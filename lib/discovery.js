/**
 * Discovery sources share one interface:
 * @typedef {{ source: "mdns" | "tailscale", fleetId: string | null, fleetName?: string, memberId: string, name: string, host: string, port: number }} Found
 * @typedef {{ advertise(info: { fleetId: string, memberId: string, name: string, port: number }): void, onFound(cb: (f: Found) => void): void, scanNow(): Promise<void>, stop(): void }} Discovery
 */

const SERVICE_TYPE = "dsh-fleet";
const isHex32 = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const isUsableIPv4 = (a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && !a.startsWith("169.254.");

/**
 * mDNS source (bonjour-service). The Bonjour instance is created lazily so
 * nothing binds a multicast socket until the source is used.
 * @param {{ bonjour?: object, createBonjour?: () => Promise<object> }} [opts]
 * @returns {Discovery}
 */
export function createDiscovery({ bonjour, createBonjour } = {}) {
	let instance = bonjour ?? null;
	let published = null;
	let browser = null;
	let stopped = false;
	let creating = null;
	const listeners = [];
	const create = async () => (createBonjour ? createBonjour() : new (await import("bonjour-service")).Bonjour());
	/** Run fn with the instance; an instance that arrives after stop() is destroyed instead. */
	const withInstance = (fn) => {
		if (stopped) return;
		if (instance) return fn(instance);
		creating ??= create().then((b) => {
			if (stopped) { b.destroy?.(); return null; }
			instance = b;
			return b;
		});
		creating.then((b) => { if (b && !stopped) fn(b); }).catch(() => {});
	};

	const onUp = (svc) => {
		const txt = svc?.txt ?? {};
		if (txt.v !== "1" || !isHex32(txt.member) || !Number.isInteger(svc.port)) return;
		for (const host of (svc.addresses ?? []).filter(isUsableIPv4)) {
			const found = { source: "mdns", fleetId: isHex32(txt.fleet) ? txt.fleet : null, memberId: txt.member, name: String(txt.name ?? ""), host, port: svc.port };
			for (const cb of listeners) cb(found);
		}
	};

	return {
		advertise(info) {
			withInstance((b) => {
				published?.stop?.();
				published = b.publish({ name: `dsh-fleet-${info.memberId.slice(0, 8)}`, type: SERVICE_TYPE, protocol: "tcp", port: info.port, txt: { v: "1", fleet: info.fleetId || "", member: info.memberId, name: info.name } });
			});
		},
		onFound(cb) {
			listeners.push(cb);
			if (!browser) withInstance((b) => { browser ??= b.find({ type: SERVICE_TYPE }, onUp); });
		},
		async scanNow() {
			browser?.update?.();
		},
		stop() {
			stopped = true;
			published?.stop?.();
			browser?.stop?.();
			instance?.destroy?.();
		},
	};
}

/**
 * Merge several sources into one.
 * @param {Discovery[]} sources
 * @returns {Discovery}
 */
export function combineDiscovery(sources) {
	return {
		advertise: (info) => sources.forEach((s) => s.advertise(info)),
		onFound: (cb) => sources.forEach((s) => s.onFound(cb)),
		scanNow: async () => { await Promise.allSettled(sources.map((s) => s.scanNow())); },
		stop: () => sources.forEach((s) => s.stop()),
	};
}

/**
 * Build the plugin's discovery from settings (Tasks 9–10).
 * @param {{ settings: import("./settings.js").Settings, createMdns: () => Discovery, createTailscale: (cli: string) => Discovery, findCli: (configured: string) => string | null, logger: { warn(m: string): void } }} deps
 * @returns {{ discovery: Discovery, info: { mdns: string, tailscale: string } }}
 */
export function composeDiscovery({ settings, createMdns, createTailscale, findCli, logger }) {
	const sources = [createMdns()];
	const info = { mdns: "on", tailscale: "off" };
	const mode = settings.tailscale.enabled;
	if (mode !== false) {
		const cli = findCli(settings.tailscale.cli);
		if (cli) {
			sources.push(createTailscale(cli));
			info.tailscale = "on";
		} else if (mode === true) {
			info.tailscale = "cli-not-found";
			logger.warn("dsh-fleet: tailscale discovery is enabled but the tailscale CLI was not found; set tailscale.cli in settings.json");
		}
	}
	return { discovery: combineDiscovery(sources), info };
}
