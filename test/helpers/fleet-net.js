/**
 * Test harness: boots several dsh-fleet instances in one process, each behind
 * a real HTTP server on 127.0.0.1, with a fake agents service whose steward
 * "answers" every followup with `done: <text>`.
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../lib/index.js";

export const SECRET = "test-secret";

const SCHEMA_DEFAULTS = {
	device: "",
	secret: "",
	steward: { preset: "", cwd: "", provider: "p", model: "m" },
	peers: [],
	heartbeatSec: 30,
	advertise: { baseUrl: "" },
	progressAfterSec: 300,
};

function textOf(message) {
	return (message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
}

function fakeAgents(listeners, followups) {
	const agents = new Map();
	let nextId = 0;
	const make = (sessionId) => {
		const agent = {
			id: `agent-${++nextId}`,
			status: "idle",
			session: { id: sessionId, seq: 0 },
			followup(message) {
				const text = textOf(message);
				followups.push(text);
				agent.session.seq += 1;
				const seq = agent.session.seq;
				queueMicrotask(() => {
					for (const fn of listeners.get("session/event") ?? []) {
						fn({ id: sessionId }, { type: "assistant/message", seq, data: { turn: seq, message: { content: [{ type: "text", text: `done: ${text}` }] } } });
					}
				});
			},
			whenIdle() { return new Promise((resolve) => setTimeout(resolve, 5)); },
		};
		agents.set(agent.id, agent);
		return { agent };
	};
	return {
		get: (id) => agents.get(id),
		resume: async ({ resumeSessionId }) => make(resumeSessionId),
		create: async ({ sessionId }) => make(sessionId),
	};
}

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/**
 * @param {{ device: string, advertise?: boolean }[]} specs
 */
export async function startFleet(specs) {
	const nodes = {};
	for (const spec of specs) {
		const routes = new Map();
		const server = http.createServer((req, res) => {
			const handler = routes.get(new URL(req.url ?? "/", "http://x").pathname);
			if (!handler) { res.writeHead(404); res.end("{}"); return; }
			Promise.resolve(handler(req, res)).catch((err) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(err) })); });
		});
		const port = await listen(server);
		nodes[spec.device] = { spec, server, routes, url: `http://127.0.0.1:${port}`, tools: new Map(), followups: [] };
	}
	for (const node of Object.values(nodes)) {
		const dir = mkdtempSync(join(tmpdir(), `fleet-${node.spec.device}-`));
		node.cfgPath = join(dir, "fleet.json");
		node.dir = dir;
		const fileConfig = {
			device: node.spec.device,
			secret: SECRET,
			steward: { provider: "p", model: "m" },
			peers: Object.values(nodes).filter((n) => n !== node).map((n) => ({ device: n.spec.device, baseUrl: n.url })),
			advertise: { baseUrl: node.spec.advertise ? node.url : "" },
		};
		writeFileSync(node.cfgPath, JSON.stringify(fileConfig, null, 2));
		const listeners = new Map();
		const ctx = {
			logger: { info() {}, warn() {} },
			webServer: { register: (route) => node.routes.set(route.path, route.handler) },
			tools: { register: (tool) => node.tools.set(tool.name, tool) },
			agents: fakeAgents(listeners, node.followups),
			on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
			get: () => undefined,
			setInterval: () => 0,
		};
		process.env.DSH_FLEET_CONFIG = node.cfgPath;
		apply(ctx, SCHEMA_DEFAULTS);
	}
	delete process.env.DSH_FLEET_CONFIG;
	return {
		nodes,
		close: () => Promise.all(Object.values(nodes).map((n) => new Promise((r) => n.server.close(r)))),
	};
}

export function tool(node, name, args) {
	return node.tools.get(name).execute(args, {});
}

export async function api(node, path, { method = "GET", body, secret = SECRET } = {}) {
	const resp = await fetch(`${node.url}${path}`, {
		method,
		headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: resp.status, payload: await resp.json() };
}

/** Read a plugin ledger file; a not-yet-written ledger reads as empty. */
export function readJson(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch (err) {
		if (err?.code === "ENOENT") return { pending: [], messages: [], deliveries: [] };
		throw err;
	}
}

export async function until(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) throw new Error("until(): condition not met in time");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}
