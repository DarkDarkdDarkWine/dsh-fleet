import https from "node:https";
import { join } from "node:path";
import { readJson } from "./store.js";

/** The plugin is not running (no control.json, or nothing answers on its port). */
export class LocalUnavailableError extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(`dsh-fleet plugin not reachable: ${reason}`);
		this.name = "LocalUnavailableError";
		this.reason = reason;
	}
}

/** @param {string} dataDir @returns {{ port: number, token: string } | null} */
export function readControl(dataDir) {
	const c = readJson(join(dataDir, "control.json"), null);
	return Number.isInteger(c?.port) && typeof c?.token === "string" ? c : null;
}

/**
 * Call a /local/* route on the running plugin.
 * @param {{ dataDir: string, method?: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number }} req
 * @returns {Promise<{ status: number, body: any }>}
 */
export function callLocal({ dataDir, method = "GET", path, body, timeoutMs = 20_000 }) {
	const control = readControl(dataDir);
	if (!control) return Promise.reject(new LocalUnavailableError("no control.json"));
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = https.request({
			host: "127.0.0.1", port: control.port, method, path, agent: false,
			rejectUnauthorized: false, // same-machine call, authenticated by the token
			timeout: timeoutMs,
			headers: { "x-fleet-token": control.token, "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) },
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => {
				let parsed = {};
				try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
				resolve({ status: res.statusCode, body: parsed });
			});
		});
		req.on("timeout", () => req.destroy(new LocalUnavailableError("timeout")));
		req.on("error", (err) => reject(err instanceof LocalUnavailableError ? err : new LocalUnavailableError(err?.code ?? err?.message ?? String(err))));
		req.end(payload);
	});
}
