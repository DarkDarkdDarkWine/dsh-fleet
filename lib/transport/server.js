import https from "node:https";
import { memberIdFromCert } from "../identity.js";

/**
 * The fleet's own HTTPS port. Every client presents a self-signed cert; the
 * member id is derived from its public key and checked against the roster.
 * @typedef {{ memberId: string | null, remoteAddress: string, body: any, headers: import("node:http").IncomingHttpHeaders }} RouteCtx
 * @typedef {{ auth: "member" | "open" | "local", method: "GET" | "POST", handler(ctx: RouteCtx): Promise<{ status: number, body: object }> }} Route
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const OPEN_LIMIT = 10;
const OPEN_WINDOW_MS = 60_000;

function send(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

/** Read the body up to `limit` bytes. Resolves { tooLarge } or { text }. */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) { resolve({ tooLarge: true }); req.resume(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8") }));
		req.on("error", reject);
	});
}

/** Sliding-window limiter per source IP for open routes. */
function rateLimiter(now = Date.now) {
	const hits = new Map();
	return (ip) => {
		const t = now();
		const recent = (hits.get(ip) ?? []).filter((x) => t - x < OPEN_WINDOW_MS);
		const allowed = recent.length < OPEN_LIMIT;
		hits.set(ip, allowed ? [...recent, t] : recent);
		return allowed;
	};
}

/** Authorize by route kind; returns an error response or null. */
function authorize(route, memberId, remote, isMember, allowOpen) {
	if (route.auth === "member" && !(memberId && isMember(memberId))) return [401, { error: "not-a-member" }];
	if (route.auth === "open" && !allowOpen(remote)) return [429, { error: "rate-limited" }];
	if (route.auth === "local" && !LOOPBACK.has(remote)) return [403, { error: "local-only" }];
	return null;
}

function makeHandler({ routes, isMember, bodyLimitBytes, logger }) {
	const allowOpen = rateLimiter();
	return async (req, res) => {
		try {
			const path = new URL(req.url ?? "/", "https://x").pathname;
			const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
			if (!route) return send(res, 404, { error: "not-found" });
			if (req.method !== route.method) return send(res, 405, { error: "method-not-allowed" });
			const remote = req.socket.remoteAddress ?? "";
			const memberId = memberIdFromCert(req.socket.getPeerCertificate());
			const denied = authorize(route, memberId, remote, isMember, allowOpen);
			if (denied) return send(res, ...denied);
			const { tooLarge, text } = await readBody(req, bodyLimitBytes);
			if (tooLarge) return send(res, 413, { error: "body-too-large" });
			let body = null;
			if (route.method === "POST") {
				try { body = text ? JSON.parse(text) : {}; } catch { return send(res, 400, { error: "bad-json" }); }
			}
			const out = await route.handler({ memberId, remoteAddress: remote, body, headers: req.headers });
			send(res, out.status, out.body);
		} catch (err) {
			logger?.warn?.(`dsh-fleet: request ${req.url} failed: ${err?.stack ?? err}`);
			if (!res.headersSent) send(res, 500, { error: "internal" });
		}
	};
}

/**
 * @param {{ identity: import("../identity.js").Identity, host: string, port: number, bodyLimitBytes: number, isMember(memberId: string): boolean, routes: Record<string, Route>, logger?: { warn(msg: string): void } }} opts
 * @returns {Promise<{ port: number, close(): Promise<void> }>}
 */
export function startFleetServer({ identity, host, port, bodyLimitBytes, isMember, routes, logger }) {
	const server = https.createServer({ key: identity.keyPem, cert: identity.certPem, requestCert: true, rejectUnauthorized: false }, makeHandler({ routes, isMember, bodyLimitBytes, logger }));
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			server.on("error", (err) => logger?.warn?.(`dsh-fleet: server error: ${err?.message ?? err}`));
			resolve({
				port: server.address().port,
				close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
			});
		});
	});
}
