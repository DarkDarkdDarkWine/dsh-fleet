/** Raw HTTPS request for transport tests that need malformed or oversized bodies. */
import https from "node:https";

export function rawRequest({ port, method = "POST", path, body = "", identity = null }) {
	return new Promise((resolve, reject) => {
		const req = https.request({ host: "127.0.0.1", port, method, path, rejectUnauthorized: false, agent: false, ...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}), headers: { "content-type": "application/json" } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode, text }));
		});
		req.on("error", reject);
		req.end(body);
	});
}
