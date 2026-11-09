import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** A JSON file exists but cannot be parsed. Never overwrite it automatically. */
export class StoreCorruptError extends Error {
	/** @param {string} path @param {unknown} cause */
	constructor(path, cause) {
		super(`corrupt JSON file: ${path}`, { cause });
		this.name = "StoreCorruptError";
		this.path = path;
	}
}

/**
 * Read a JSON file.
 * @template T
 * @param {string} path
 * @param {T} fallback returned when the file does not exist
 * @returns {T}
 */
export function readJson(path, fallback) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if (err?.code === "ENOENT") return fallback;
		throw err;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new StoreCorruptError(path, err);
	}
}

/** @param {string} path @param {(msg: string) => void} warn */
function restrictPermissions(path, warn) {
	if (process.platform !== "win32") return;
	try {
		execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { stdio: "ignore" });
	} catch (err) {
		warn(`could not restrict permissions on ${path}: ${err?.message ?? err}`);
	}
}

/**
 * Write JSON atomically: tmp file, fsync, rename.
 * @param {string} path
 * @param {unknown} data
 * @param {{ secret?: boolean, warn?: (msg: string) => void }} [opts]
 */
export function writeJsonAtomic(path, data, opts = {}) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", opts.secret ? 0o600 : 0o644);
	try {
		writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
	if (opts.secret) restrictPermissions(path, opts.warn ?? (() => {}));
}
