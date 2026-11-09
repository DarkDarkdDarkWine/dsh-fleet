/**
 * dsh-fleet v1 — plugin entry (host half).
 *
 * Starts the fleet on its own mutual-TLS port, the heartbeat, discovery
 * (mDNS + Tailscale) and a loopback-only control listener for the CLI.
 * apply() never throws; failures are logged and reported through status().
 * All cleanup is registered with ctx.effect — cordis 4 has no "dispose" event
 * (platform-findings §9).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDiscovery, composeDiscovery } from "./discovery.js";
import { createTailscaleDiscovery, findTailscaleCli, helloProbe, runTailscaleStatus } from "./discovery-tailscale.js";
import { hostname } from "node:os";
import { FleetError, FleetService } from "./fleet.js";
import { createHeartbeat } from "./heartbeat.js";
import { createEphemeralIdentity, loadOrCreateIdentity } from "./identity.js";
import { createLocalRoutes } from "./local-routes.js";
import { resolveDataDir } from "./paths.js";
import { DEFAULT_SETTINGS, loadSettings } from "./settings.js";
import { StoreCorruptError, readJson, writeJsonAtomic } from "./store.js";
import { startFleetServer } from "./transport/server.js";
import { VERSION } from "./version.js";

export const name = "dsh-fleet";
export const inject = ["timer"];
export { VERSION };

const consoleLogger = { info() {}, warn: (m) => process.emitWarning(m) };

function loggerOf(ctx) {
	return { info: (m) => ctx.logger?.info?.(m) ?? consoleLogger.info(m), warn: (m) => ctx.logger?.warn?.(m) ?? consoleLogger.warn(m) };
}

function settingsOrDefaults(dataDir, logger) {
	try {
		return loadSettings(dataDir);
	} catch (err) {
		logger.warn(`dsh-fleet: ${err?.message ?? err}; using defaults`);
		return structuredClone(DEFAULT_SETTINGS);
	}
}

function buildDiscovery(ctx, settings, logger) {
	return composeDiscovery({
		settings,
		createMdns: () => createDiscovery(),
		createTailscale: (cli) => createTailscaleDiscovery({ runStatus: () => runTailscaleStatus(cli), probe: helloProbe, port: settings.port, scanSec: settings.tailscale.scanSec, logger, setIntervalFn: (fn, ms) => ctx.setInterval(fn, ms) }),
		findCli: (configured) => findTailscaleCli({ configured }),
		logger,
	});
}

/** Loopback control listener for the CLI; its port and token go to control.json. */
async function startControl({ dataDir, fleet, identity, settings, logger }) {
	const path = join(dataDir, "control.json");
	let token;
	try { token = readJson(path, null)?.token; } catch { token = undefined; }
	if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) token = randomBytes(32).toString("hex");
	const server = await startFleetServer({ identity, host: "127.0.0.1", port: 0, bodyLimitBytes: settings.bodyLimitBytes, isMember: () => false, routes: createLocalRoutes({ fleet, token }), logger });
	writeJsonAtomic(path, { port: server.port, token, pid: process.pid, version: VERSION }, { secret: true, warn: logger.warn });
	return server;
}

/**
 * Stand-in for FleetService when the device identity cannot be loaded: the
 * CLI can still read status (error "identity-corrupt"); every action fails.
 */
function disabledFleet(code) {
	const fail = async () => { throw new FleetError(code); };
	return {
		status: () => ({ version: VERSION, joined: false, fleet: null, self: { memberId: "", name: hostname(), rejected: false }, members: [], pinConflict: null, listening: { error: code }, discovery: { mdns: "off", tailscale: "off" }, error: code }),
		discoverFleets: async () => [],
		discoveredUnjoined: () => [],
		createFleet: fail, join: fail, removeMember: fail, changePin: fail, resetPin: fail, describe: fail, leave: fail,
	};
}

/** Start everything; returns the parts so the effect can stop them. */
async function start(ctx, logger, isDisposed) {
	const dataDir = resolveDataDir();
	const settings = settingsOrDefaults(dataDir, logger);
	let identity;
	try {
		identity = await loadOrCreateIdentity(dataDir);
	} catch (err) {
		if (!(err instanceof StoreCorruptError)) throw err;
		logger.warn(`dsh-fleet: ${err.path} is corrupt; fleet disabled until it is fixed or removed`);
		const control = await startControl({ dataDir, fleet: disabledFleet("identity-corrupt"), identity: await createEphemeralIdentity(), settings, logger });
		return { control };
	}
	const { discovery, info } = buildDiscovery(ctx, settings, logger);
	const fleet = new FleetService({ dataDir, settings, identity, discovery, discoveryInfo: info, logger });
	await fleet.start();
	const control = await startControl({ dataDir, fleet, identity, settings, logger });
	const heartbeat = createHeartbeat({ fleet, settings });
	if (!isDisposed()) {
		heartbeat.start((fn, ms) => ctx.setInterval(fn, ms));
		heartbeat.tick().catch(() => {});
	}
	logger.info(`dsh-fleet ${VERSION} ready: ${fleet.status().joined ? `fleet ${fleet.status().fleet.short}` : "not joined"}, port ${JSON.stringify(fleet.listening)}`);
	return { fleet, discovery, control, heartbeat };
}

async function stopParts(parts) {
	if (!parts) return;
	parts.heartbeat?.stop();
	try { parts.discovery?.stop(); } catch {}
	await Promise.allSettled([parts.fleet?.stop(), parts.control?.close()]);
}

/**
 * @param {any} ctx cordis context
 * @returns {{ ready: Promise<void> }} for tests; DSH ignores the return value
 */
export function apply(ctx) {
	const logger = loggerOf(ctx);
	let parts = null;
	let disposed = false;
	const ready = start(ctx, logger, () => disposed)
		.then(async (p) => {
			parts = p;
			if (disposed) await stopParts(p);
		})
		.catch((err) => logger.warn(`dsh-fleet: failed to start: ${err?.stack ?? err}`));
	ctx.effect(() => () => {
		disposed = true;
		return ready.then(() => stopParts(parts));
	}, "dsh-fleet: fleet port, control listener, discovery");
	return { ready };
}
