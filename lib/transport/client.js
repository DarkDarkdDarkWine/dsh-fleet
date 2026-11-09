import https from "node:https";
import { memberIdFromCert } from "../identity.js";

/** @typedef {{ host: string, port: number }} Address */

/**
 * Per-address timeout. Device testing measured 1.3–2.2 s for one request over
 * a relayed (DERP) Tailscale path (~0.4 s RTT × handshake round trips).
 */
export const DEFAULT_TIMEOUT_MS = 6000;

/** No address of the member answered (or each answered with the wrong identity). */
export class UnreachableError extends Error {
	/** @param {{ address: Address, reason: string }[]} attempts */
	constructor(attempts) {
		super(`unreachable: ${attempts.map((a) => `${a.address.host}:${a.address.port} ${a.reason}`).join("; ") || "no addresses"}`);
		this.name = "UnreachableError";
		this.attempts = attempts;
	}
}

/**
 * One HTTPS request to one address. The server's identity is checked after
 * the TLS handshake and before the body is written (self-signed certs fail
 * normal verification, so checkServerIdentity is never invoked by Node).
 */
function attempt({ identity, address, expectMemberId, method, path, payload, timeoutMs }) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let peerMemberId = null;
		const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
		const req = https.request({
			host: address.host, port: address.port, method, path, agent: false, rejectUnauthorized: false,
			...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}),
			headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) },
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => {
				let body = {};
				try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
				finish(resolve, { status: res.statusCode, body, address, peerMemberId });
			});
			res.on("error", (err) => finish(reject, err));
		});
		const timer = setTimeout(() => { req.destroy(); finish(reject, Object.assign(new Error("timeout"), { code: "timeout" })); }, timeoutMs);
		req.on("error", (err) => finish(reject, err));
		req.on("socket", (socket) => socket.once("secureConnect", () => {
			const got = memberIdFromCert(socket.getPeerCertificate());
			peerMemberId = got;
			if (expectMemberId && got !== expectMemberId) {
				req.destroy();
				finish(reject, Object.assign(new Error("identity-mismatch"), { code: "identity-mismatch" }));
				return;
			}
			req.end(payload);
		}));
	});
}

/**
 * Request a member, trying each address in order.
 * @param {{ identity: import("../identity.js").Identity | null, addresses: Address[], expectMemberId: string | null, method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number }} opts
 * @returns {Promise<{ status: number, body: any, address: Address, peerMemberId: string | null }>}
 * @throws {UnreachableError}
 */
export async function requestMember({ identity, addresses, expectMemberId, method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const attempts = [];
	for (const address of addresses) {
		try {
			return await attempt({ identity, address, expectMemberId, method, path, payload, timeoutMs });
		} catch (err) {
			attempts.push({ address, reason: err?.code ?? err?.message ?? String(err) });
		}
	}
	throw new UnreachableError(attempts);
}
