import { timingSafeEqual } from "node:crypto";
import { FleetError } from "./fleet.js";

/**
 * Control routes for the CLI. Served only on the loopback control listener
 * and gated by the token in control.json (secret file).
 */

const sameToken = (given, token) => {
	const a = Buffer.from(String(given ?? ""));
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
};

/** FleetError → HTTP response; anything else is rethrown (the server answers 500). */
function toResponse(err) {
	if (!(err instanceof FleetError)) throw err;
	const body = { error: err.code, ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) };
	return { status: err.code === "pin-locked" ? 423 : 400, body };
}

/**
 * @param {{ fleet: import("./fleet.js").FleetService, token: string }} deps
 * @returns {Record<string, import("./transport/server.js").Route>}
 */
export function createLocalRoutes({ fleet, token }) {
	const route = (method, run) => ({
		auth: "local",
		method,
		handler: async ({ headers, body }) => {
			if (!sameToken(headers["x-fleet-token"], token)) return { status: 401, body: { error: "bad-token" } };
			try {
				return { status: 200, body: await run(body ?? {}) };
			} catch (err) {
				return toResponse(err);
			}
		},
	});
	return {
		"/local/status": route("GET", () => fleet.status()),
		"/local/discover": route("GET", async () => ({ fleets: await fleet.discoverFleets(), unjoined: fleet.discoveredUnjoined() })),
		"/local/create": route("POST", (b) => fleet.createFleet({ name: b.name, pin: b.pin, memberName: b.memberName })),
		"/local/join": route("POST", (b) => fleet.join({ address: { host: String(b.host ?? ""), port: Number(b.port) }, pin: b.pin, memberName: b.memberName })),
		"/local/remove": route("POST", (b) => fleet.removeMember({ memberId: b.memberId, pin: b.pin })),
		"/local/pin/change": route("POST", (b) => fleet.changePin({ oldPin: b.oldPin, newPin: b.newPin })),
		"/local/pin/reset": route("POST", (b) => fleet.resetPin({ newPin: b.newPin })),
		"/local/describe": route("POST", (b) => fleet.describe({ name: b.name, description: b.description })),
		"/local/leave": route("POST", () => fleet.leave()),
	};
}
