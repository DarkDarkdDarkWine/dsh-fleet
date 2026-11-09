import { join } from "node:path";
import { readJson } from "./store.js";

/** @typedef {typeof DEFAULT_SETTINGS} Settings */

export const DEFAULT_SETTINGS = Object.freeze({
	port: 43190,
	host: "0.0.0.0",
	heartbeatSec: 30,
	offlineAfterMisses: 3,
	concurrency: 2,
	archiveDays: 7,
	deliveryTtlHours: 24,
	bodyLimitBytes: 2097152,
	agent: Object.freeze({ provider: "", model: "", preset: "", cwd: "" }),
	tailscale: Object.freeze({ enabled: "auto", scanSec: 60, cli: "" }),
});

/** Invalid value in settings.json. */
export class SettingsError extends Error {
	/** @param {string} field @param {string} message */
	constructor(field, message) {
		super(`settings.${field}: ${message}`);
		this.name = "SettingsError";
		this.field = field;
	}
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Deep-merge `override` onto `base`, returning new objects. */
function merge(base, override) {
	if (!isPlainObject(override)) return structuredClone(base);
	const out = {};
	for (const [key, value] of Object.entries(base)) {
		if (!(key in override)) out[key] = structuredClone(value);
		else if (isPlainObject(value)) out[key] = merge(value, override[key]);
		else out[key] = override[key];
	}
	return out;
}

const isInt = (v) => Number.isInteger(v);

/** @param {Settings} s */
function validate(s) {
	if (!isInt(s.port) || s.port < 0 || s.port > 65535) throw new SettingsError("port", "must be an integer 0–65535");
	if (typeof s.host !== "string" || s.host === "") throw new SettingsError("host", "must be a non-empty string");
	if (!isInt(s.heartbeatSec) || s.heartbeatSec < 5) throw new SettingsError("heartbeatSec", "must be an integer ≥ 5");
	if (!isInt(s.offlineAfterMisses) || s.offlineAfterMisses < 1) throw new SettingsError("offlineAfterMisses", "must be an integer ≥ 1");
	if (!isInt(s.concurrency) || s.concurrency < 1) throw new SettingsError("concurrency", "must be an integer ≥ 1");
	if (!isInt(s.bodyLimitBytes) || s.bodyLimitBytes < 1024) throw new SettingsError("bodyLimitBytes", "must be an integer ≥ 1024");
	if (!["auto", true, false].includes(s.tailscale.enabled)) throw new SettingsError("tailscale.enabled", 'must be "auto", true or false');
	if (!isInt(s.tailscale.scanSec) || s.tailscale.scanSec < 10) throw new SettingsError("tailscale.scanSec", "must be an integer ≥ 10");
}

/**
 * Load settings.json from the data dir, merged over the defaults.
 * @param {string} dataDir
 * @returns {Settings}
 */
export function loadSettings(dataDir) {
	const settings = merge(DEFAULT_SETTINGS, readJson(join(dataDir, "settings.json"), {}));
	validate(settings);
	return settings;
}
