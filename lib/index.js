/**
 * dsh-fleet — multi-device fleet for DeepSeek Harness.
 *
 * Every device in the fleet runs this plugin. It provides:
 *  - a steward agent session (durable, auto-created/resumed on first message)
 *  - POST /fleet/message  — deliver one message into the local steward's turn,
 *                           optionally waiting for the full reply (A2A entry)
 *  - GET  /fleet/status   — heartbeat: device, uptime, steward state
 *  - GET  /fleet/roster   — this device's view of the fleet (self + peers)
 *  - tools `fleet_send` / `fleet_status` so any local agent can talk to peers
 *  - a heartbeat poller caching peer status for the roster
 *
 * Transport security: peers call each other over the tailnet; every request
 * must carry `Authorization: Bearer <secret>` with the fleet-wide shared secret.
 */
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-fleet";
const VERSION = "0.2.1";
const inject = ["webServer", "tools", "agents", "timer"];

const Config = z.object({
	device: z.string().default("").description("本机设备名，舰队内唯一（如 nas / pc / mac）。可留空并改由 fleet.json 提供"),
	secret: z.string().default("").description("舰队共享密钥，所有设备的 /fleet/* 请求必须携带 Bearer <secret>。可留空并改由 fleet.json 提供"),
	steward: z.object({
		preset: z.string().default("").description("管家使用的 agent preset id，留空用默认 agent"),
		cwd: z.string().default("").description("管家会话的工作目录，留空用默认工作区"),
		provider: z.string().default("deepseek-official").description("管家使用的 LLM provider（headless 会话无人选模型，必须显式给定）"),
		model: z.string().default("deepseek-official").description("管家使用的模型名"),
	}).default({ preset: "", cwd: "", provider: "deepseek-official", model: "deepseek-official" }),
	peers: z.array(z.object({
		device: z.string().required().description("对端设备名"),
		baseUrl: z.string().required().description("对端 dsh web 根地址，如 http://100.64.0.2:43129"),
		role: z.string().default("").description("对端管家的职责描述（给模型看）"),
	})).default([]),
	heartbeatSec: z.number().default(30).description("心跳轮询间隔秒数"),
});

function apply(ctx, config) {
	// Per-device config file: the profile patch layer's boot-time ordering proved
	// unreliable, so machine identity (device/secret/peers) is read from a dedicated
	// JSON file instead. Schema config stays as defaults; file values win.
	const configFile = process.env.DSH_FLEET_CONFIG
		?? (process.env.DSH_HOME ? `${process.env.DSH_HOME}/fleet.json` : `${process.env.HOME}/.dsh/fleet.json`);
	if (process.env.DSH_FLEET_CONFIG || !config.device || !config.secret) {
		try {
			const file = JSON.parse(readFileSync(configFile, "utf8"));
			config = {
				...config,
				...file,
				steward: { ...(config.steward ?? {}), ...(file.steward ?? {}) },
				peers: file.peers ?? config.peers ?? [],
			};
			ctx.logger?.info?.(`dsh-fleet: per-device config merged from ${configFile}`);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-fleet: cannot read ${configFile}: ${err?.message ?? err}`);
		}
	}
	if (!config.device || !config.secret) {
		ctx.logger?.warn?.("dsh-fleet: device/secret unset — /fleet/* stays disabled until configured");
		ctx.webServer.register({ kind: "exact", path: "/fleet/status", handler: (_q, res) => {
			res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: "dsh-fleet not configured: set device/secret (profile config or fleet.json)" }));
		} });
		return;
	}
	const startedAt = Date.now();
	const device = config.device;
	const stewardSessionId = brandString(`fleet-steward-${device}`);

	/** @type {{ handle: import("@deepseek-ai/dsh-agent").AgentHandle } | null} */
	let live = null;
	let creating = null;
	let inflight = false;
	let lastFailure = null;
	const peerCache = new Map(); // device -> { online, lastSeenMs, payload }
	const replyLog = []; // { seq, turn, text } — assistant texts of the steward session
	let heartbeatBusy = false;

	// ---- steward session lifecycle -----------------------------------------

	async function ensureSteward() {
		if (live && ctx.agents.get(live.handle.agent.id) === live.handle.agent) return live.handle;
		if (!creating) {
			creating = (async () => {
				const meta = {};
				if (config.steward?.cwd) meta.cwd = config.steward.cwd;
				if (config.steward?.preset) meta.agentPreset = config.steward.preset;
				// The steward is headless: no GUI ever picks a model for it, so the
				// fleet config must supply the route (default: the official account).
				const agentOptions = {
					provider: config.steward?.provider || "deepseek-official",
					model: config.steward?.model || "deepseek-official",
				};
				// meta.agentPreset only RECORDS the id; the tool surface (bash/read/…)
				// arrives via agentPresets.mount() in a per-agent setup callback —
				// exactly what the GUI session controller does (composeAgent).
				const presets = ctx.get("agentPresets");
				const presetId = config.steward?.preset || undefined;
				// setup's return value gets `.commit()` called on it — must return void.
				const setup = presets ? async (agentCtx) => { await presets.mount(agentCtx, presetId); } : undefined;
				let handle;
				try {
					handle = await ctx.agents.resume({ resumeSessionId: stewardSessionId, agentOptions, setup });
				} catch {
					handle = await ctx.agents.create({ sessionId: stewardSessionId, meta, agentOptions, setup });
				}
				live = { handle };
				return handle;
			})().finally(() => { creating = null; });
		}
		return creating;
	}

	// ---- steward event capture ----------------------------------------------

	ctx.on("session/event", (session, event) => {
		if (String(session.id) !== String(stewardSessionId)) return;
		if (event.type === "assistant/message") {
			const blocks = event.data?.message?.content ?? [];
			const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
			if (text) {
				replyLog.push({ seq: event.seq, turn: event.data.turn, text });
				if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
			}
		}
	});
	ctx.on("agent/error", ({ agent, error }) => {
		if (live && agent === live.handle.agent) lastFailure = { error, atOffset: agent.session.seq };
	});

	async function awaitTurnEnd(agent, startSeq, timeoutMs) {
		const subagents = ctx.get?.("subagents");
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			await agent.whenIdle();
			const idleSeq = agent.session.seq;
			const children = await subagents?.waitForChildren(agent);
			if (!children && agent.status === "idle" && agent.session.seq === idleSeq) {
				if (lastFailure && Number(lastFailure.atOffset) > startSeq) {
					const err = lastFailure.error;
					lastFailure = null;
					return { done: true, error: err instanceof Error ? err.message : String(err) };
				}
				return { done: true, replies: replyLog.filter((r) => r.seq > startSeq).map((r) => r.text) };
			}
			if (Date.now() > deadline) {
				return { done: false, replies: replyLog.filter((r) => r.seq > startSeq).map((r) => r.text) };
			}
		}
	}

	/** Deliver one message into the steward turn. Caller must have checked inflight. */
	async function deliverToSteward(text, wait, timeoutMs) {
		const handle = await ensureSteward();
		const agent = handle.agent;
		const startSeq = Number(agent.session.seq);
		lastFailure = null;
		agent.followup(createUserMessage({
			content: [{ type: "text", text }],
			source: { kind: "user" },
		}));
		if (!wait) return { ok: true, queued: true, sessionId: String(stewardSessionId) };
		inflight = true;
		try {
			const result = await awaitTurnEnd(agent, startSeq, timeoutMs);
			if (result.error !== undefined) return { ok: false, error: `steward error: ${result.error}`, sessionId: String(stewardSessionId) };
			const reply = result.replies?.length ? result.replies.join("\n\n") : null;
			return { ok: true, done: result.done, reply, sessionId: String(stewardSessionId) };
		} finally {
			inflight = false;
		}
	}

	// ---- HTTP helpers ---------------------------------------------------------

	function authorized(req) {
		if (!config.secret) return false;
		const h = req.headers.authorization ?? "";
		const token = h.startsWith("Bearer ") ? h.slice(7) : "";
		const a = Buffer.from(token);
		const b = Buffer.from(config.secret);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	function sendJson(res, code, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
		res.end(body);
	}

	function readBody(req, limit = 2 * 1024 * 1024) {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks = [];
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > limit) {
					reject(new Error("body too large"));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});
	}

	function localStatus() {
		const agent = live && ctx.agents.get(live.handle.agent.id) === live.handle.agent ? live.handle.agent : null;
		return {
			device,
			version: VERSION,
			uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
			steward: {
				sessionId: String(stewardSessionId),
				live: agent !== null,
				status: agent ? agent.status : "unloaded",
				busy: inflight,
			},
		};
	}

	function rosterPeers() {
		return config.peers.map((p) => {
			const cached = peerCache.get(p.device);
			return {
				device: p.device,
				role: p.role || undefined,
				baseUrl: p.baseUrl,
				online: cached?.online ?? false,
				lastSeenMs: cached?.lastSeenMs ?? null,
				...(cached?.payload ?? {}),
			};
		});
	}

	// ---- HTTP routes ------------------------------------------------------------

	ctx.webServer.register({
		kind: "exact",
		path: "/fleet/status",
		handler: async (req, res) => {
			if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
			sendJson(res, 200, { ok: true, ...localStatus() });
		},
	});

	ctx.webServer.register({
		kind: "exact",
		path: "/fleet/roster",
		handler: async (req, res) => {
			if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
			sendJson(res, 200, { ok: true, self: localStatus(), peers: rosterPeers() });
		},
	});

	// Unauthenticated, read-only snapshot for the web GUI panel. Same trust
	// model as dsh-message-gateway's /gateway/list: the GUI user already owns
	// this host; the fleet Bearer secret stays out of the browser.
	ctx.webServer.register({
		kind: "exact",
		path: "/fleet/panel",
		handler: async (_req, res) => {
			sendJson(res, 200, { ok: true, self: localStatus(), peers: rosterPeers(), fetchedAt: Date.now() });
		},
	});

	ctx.webServer.register({
		kind: "exact",
		path: "/fleet/message",
		handler: async (req, res) => {
			if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
			if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
			let body;
			try {
				body = JSON.parse(await readBody(req) || "{}");
			} catch {
				return sendJson(res, 400, { ok: false, error: "invalid JSON body" });
			}
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (!text) return sendJson(res, 400, { ok: false, error: "missing non-empty text field" });
			const wait = body.wait !== false;
			const timeoutMs = Math.min(Math.max(Number(body.timeoutSec) || 300, 5), 3600) * 1000;
			if (inflight) return sendJson(res, 409, { ok: false, error: "steward busy with another message" });
			try {
				const result = await deliverToSteward(text, wait, timeoutMs);
				sendJson(res, 200, result);
			} catch (err) {
				sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		},
	});

	// ---- tools ----------------------------------------------------------------

	const rosterText = () => {
		const lines = [`- ${device}（本机）: 你自己`];
		for (const p of config.peers) {
			const cached = peerCache.get(p.device);
			const state = cached?.online ? "在线" : "离线/未知";
			lines.push(`- ${p.device}: ${p.role || "无职责描述"} [${state}]`);
		}
		return lines.join("\n");
	};

	ctx.tools.register(defineTool({
		name: "fleet_status",
		description: "查看设备舰队状态：本机管家状态 + 各对端设备心跳（在线/离线、管家是否忙碌）。不消耗任何对端资源。",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{ type: "text", text: result }],
		},
		execute() {
			const peers = config.peers.map((p) => {
				const c = peerCache.get(p.device);
				return { device: p.device, role: p.role || undefined, online: c?.online ?? false, lastSeen: c?.lastSeenMs ? new Date(c.lastSeenMs).toISOString() : null, steward: c?.payload?.steward ?? null };
			});
			return Promise.resolve(JSON.stringify({ self: localStatus(), peers }, null, 2));
		},
	}));

	ctx.tools.register(defineTool({
		name: "fleet_send",
		description: `向舰队里另一台设备的管家 agent 发一条消息并取回回复（A2A 指挥）。当前舰队成员：\n${rosterText()}\n用法：device 填对端设备名；text 写清任务要求（对端管家看不到你们的上下文，需自包含）；wait=true 等完整回复，长任务可 wait=false 只投递。禁止发给本机（device=${device}）——本机的事你自己干。`,
		parameters: {
			device: { type: "string", description: "目标设备名（舰队成员之一）" },
			text: { type: "string", description: "自包含的任务消息" },
			wait: { type: "boolean", description: "是否等待对端管家完成并取回回复，默认 true" },
			timeoutSec: { type: "number", description: "等待上限秒数，默认 300，最大 3600" },
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{ type: "text", text: result }],
		},
		execute(args, exec) {
			if (args.device === device) {
				return Promise.resolve(`错误：不能向本机（${device}）发 fleet 消息——你就是本机管家，直接执行任务即可。`);
			}
			const peer = config.peers.find((p) => p.device === args.device);
			if (!peer) {
				return Promise.resolve(`错误：未知设备 "${args.device}"。舰队成员：${[device, ...config.peers.map((p) => p.device)].join(", ")}`);
			}
			const wait = args.wait !== false;
			const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 300, 5), 3600);
			const body = JSON.stringify({ text: args.text, wait, timeoutSec });
			const signal = exec?.signal ?? AbortSignal.timeout((timeoutSec + 15) * 1000);
			return fetch(`${peer.baseUrl.replace(/\/$/, "")}/fleet/message`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
				body,
				signal,
			}).then(async (resp) => {
				const payload = await resp.json().catch(() => ({}));
				if (!resp.ok || payload.ok === false) {
					return `对端 ${args.device} 返回错误 (HTTP ${resp.status}): ${payload.error ?? JSON.stringify(payload)}`;
				}
				if (payload.queued) return `已投递给 ${args.device}（异步，未等回复）。sessionId=${payload.sessionId ?? ""}`;
				if (payload.done === false) return `${args.device} 处理超时，部分回复：\n${payload.reply ?? "(无)"}`;
				return payload.reply ?? `(${args.device} 已完成，无文本回复)`;
			}).catch((err) => {
				if (exec?.signal?.aborted) return `等待 ${args.device} 回复被取消: ${err?.message ?? err}`;
				return `联系 ${args.device}（${peer.baseUrl}）失败: ${err instanceof Error ? err.message : String(err)}`;
			});
		},
	}));

	// ---- heartbeat ---------------------------------------------------------------

	async function pollPeer(peer) {
		try {
			const resp = await fetch(`${peer.baseUrl.replace(/\/$/, "")}/fleet/status`, {
				headers: { authorization: `Bearer ${config.secret}` },
				signal: AbortSignal.timeout(4000),
			});
			const payload = await resp.json();
			peerCache.set(peer.device, { online: resp.ok && payload.ok !== false, lastSeenMs: Date.now(), payload });
		} catch {
			const prev = peerCache.get(peer.device);
			peerCache.set(peer.device, { online: false, lastSeenMs: prev?.lastSeenMs ?? null, payload: prev?.payload ?? null });
		}
	}

	ctx.setInterval(() => {
		if (heartbeatBusy || config.peers.length === 0) return;
		heartbeatBusy = true;
		Promise.allSettled(config.peers.map(pollPeer)).finally(() => { heartbeatBusy = false; });
	}, Math.max(5, config.heartbeatSec) * 1000);
	// one immediate poll so the roster is warm without waiting an interval
	Promise.allSettled(config.peers.map(pollPeer));

	ctx.logger?.info?.(`dsh-fleet ${VERSION} ready: device=${device} steward=${String(stewardSessionId)} peers=${config.peers.map((p) => p.device).join(",") || "none"}`);
}

export { name, inject, Config, apply, VERSION };
