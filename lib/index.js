/**
 * dsh-fleet — multi-device fleet for DeepSeek Harness.
 *
 * Every device in the fleet runs this plugin. It provides:
 *  - a steward agent session (durable, auto-created/resumed on first message)
 *  - POST /fleet/message  — deliver one message into the local steward's turn.
 *      v0.3: async by default — returns a deliveryId immediately; the reply is
 *      pushed back to the sender (callback) and/or kept for pull via
 *      GET /fleet/replies. `wait: true` still long-polls synchronously.
 *  - GET  /fleet/status   — heartbeat: device, uptime, steward state,
 *      conversation activity (any local session events, not just the steward)
 *  - GET  /fleet/roster   — this device's view of the fleet (self + peers)
 *  - POST /fleet/roster   — add/remove a peer at runtime (probe-verified),
 *      persisted back to fleet.json — the open-source friendly management API
 *  - GET  /fleet/replies  — pull undelivered receipts (fallback when the
 *      sender is not reachable for push-back)
 *  - GET  /fleet/panel    — unauthenticated read-only snapshot for the web GUI
 *  - tools: fleet_status / fleet_send / fleet_inbox /
 *      fleet_member_add / fleet_member_remove
 *  - a heartbeat poller caching peer status; also drives receipt push-retries
 *    and long-task progress pings
 *
 * Transport security: peers call each other over the tailnet; every request
 * must carry `Authorization: Bearer <secret>` with the fleet-wide shared secret.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-fleet";
const VERSION = "0.3.0";
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
	advertise: z.object({
		baseUrl: z.string().default("").description("本机对外可达根地址（如 http://100.64.0.1:43129）。留空则异步回执只能由对端主动拉取（pull）——例如桌面版只监听 127.0.0.1 时"),
	}).default({ baseUrl: "" }),
	progressAfterSec: z.number().default(300).description("管家处理单条投递超过该秒数后，向发送方推一条「仍在处理」进度回执"),
});

function apply(ctx, config) {
	// Per-device config file: the profile patch layer's boot-time ordering proved
	// unreliable, so machine identity (device/secret/peers) is read from a dedicated
	// JSON file instead. Schema config stays as defaults; file values win.
	const configFile = process.env.DSH_FLEET_CONFIG
		?? (process.env.DSH_HOME ? `${process.env.DSH_HOME}/fleet.json` : `${process.env.HOME}/.dsh/fleet.json`);
	/** @type {Record<string, any>} */ let fileConfig = {};
	if (process.env.DSH_FLEET_CONFIG || !config.device || !config.secret) {
		try {
			fileConfig = JSON.parse(readFileSync(configFile, "utf8"));
			config = {
				...config,
				...fileConfig,
				steward: { ...(config.steward ?? {}), ...(fileConfig.steward ?? {}) },
				peers: fileConfig.peers ?? config.peers ?? [],
				advertise: { ...(config.advertise ?? {}), ...(fileConfig.advertise ?? {}) },
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
	const selfBaseUrl = config.advertise?.baseUrl || "";

	// ---- persisted stores (outbox / inbox / pending receipts) ----------------
	const dataDir = configFile.replace(/\/[^/]*$/, "");
	const outboxPath = `${dataDir}/fleet-outbox.json`;
	const inboxPath = `${dataDir}/fleet-inbox.json`;
	const repliesPath = `${dataDir}/fleet-replies.json`;
	const loadJson = (path, fallback) => {
		try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
	};
	const saveJson = (path, data) => {
		try { writeFileSync(path, JSON.stringify(data, null, 2)); }
		catch (err) { ctx.logger?.warn?.(`dsh-fleet: cannot write ${path}: ${err?.message ?? err}`); }
	};
	/** sent deliveries (sender side) */ const outbox = loadJson(outboxPath, { deliveries: [] });
	/** received receipts (sender side) */ const inbox = loadJson(inboxPath, { messages: [] });
	/** receipts waiting for the sender (executor side) */ const replies = loadJson(repliesPath, { pending: [] });
	const pushCapped = (arr, item, cap) => { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); };

	/** @type {{ handle: import("@deepseek-ai/dsh-agent").AgentHandle } | null} */
	let live = null;
	let creating = null;
	let waitInflight = false;
	let lastFailure = null;
	const peerCache = new Map(); // device -> { online, lastSeenMs, payload }
	const replyLog = []; // { seq, turn, text } — assistant texts of the steward session
	// deliveryId -> { startSeq, sender:{device,baseUrl}|null, sentAt, progressSent }
	const runningDeliveries = new Map();
	const sessionActivity = new Map(); // sessionId -> lastEventAt (all sessions, incl. GUI)
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

	// ---- event capture -------------------------------------------------------

	ctx.on("session/event", (session, event) => {
		const sid = String(session.id);
		sessionActivity.set(sid, Date.now());
		if (sid !== String(stewardSessionId)) return;
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

	/** Enqueue one message into the steward's turn queue (no waiting). */
	async function enqueueToSteward(text) {
		const handle = await ensureSteward();
		const agent = handle.agent;
		const startSeq = Number(agent.session.seq);
		lastFailure = null;
		agent.followup(createUserMessage({
			content: [{ type: "text", text }],
			source: { kind: "user" },
		}));
		return { agent, startSeq };
	}

	// ---- receipts (executor side) -------------------------------------------

	function recordReceipt(deliveryId, sender, kind, text) {
		pushCapped(replies.pending, {
			deliveryId,
			kind, // "reply" | "progress" | "error"
			toDevice: sender?.device ?? "unknown",
			toBaseUrl: sender?.baseUrl ?? "",
			text,
			at: Date.now(),
			delivered: false,
			attempts: 0,
		}, 200);
		saveJson(repliesPath, replies);
	}

	async function tryPushReceipt(baseUrl, payload) {
		if (!baseUrl) return false;
		try {
			const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/fleet/message`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
				body: JSON.stringify({ ...payload, type: "receipt", device }),
				signal: AbortSignal.timeout(6000),
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	/** Watch an async delivery to completion: record + push/pull the receipt. */
	function watchDelivery(deliveryId, agent, startSeq, sender) {
		const watcherTimeoutMs = 3600 * 1000;
		(async () => {
			const result = await awaitTurnEnd(agent, startSeq, watcherTimeoutMs);
			const entry = runningDeliveries.get(deliveryId);
			runningDeliveries.delete(deliveryId);
			if (!entry) return; // superseded
			let kind = "reply";
			let text;
			if (result.error !== undefined) { kind = "error"; text = `对端管家执行出错: ${result.error}`; }
			else if (result.done === false) { kind = "error"; text = `对端管家 3600s 内未完成该任务（可能仍在处理或已卡住）`; }
			else text = result.replies?.length ? result.replies.join("\n\n") : "(已完成，无文本回复)";
			recordReceipt(deliveryId, sender, kind, text);
			if (sender?.baseUrl) {
				const ok = await tryPushReceipt(sender.baseUrl, { deliveryId, kind, text });
				if (ok) markReceiptPushed(deliveryId, kind);
			}
		})().catch(() => { runningDeliveries.delete(deliveryId); });
	}

	function markReceiptPushed(deliveryId, kind) {
		const r = replies.pending.find((x) => x.deliveryId === deliveryId && x.kind === kind);
		if (r) { r.delivered = true; saveJson(repliesPath, replies); }
	}

	function ingestReceipt(body) {
		pushCapped(inbox.messages, {
			id: `r-${randomUUID().slice(0, 8)}`,
			from: body.device ?? "unknown",
			deliveryId: body.deliveryId ?? "",
			kind: body.kind ?? "reply",
			text: typeof body.text === "string" ? body.text : "",
			at: Date.now(),
			read: false,
		}, 200);
		saveJson(inboxPath, inbox);
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
		const now = Date.now();
		let active = 0;
		let lastEventAt = null;
		for (const [sid, at] of sessionActivity) {
			if (sid === String(stewardSessionId)) continue;
			if (now - at > 5 * 60 * 1000) continue;
			active += 1;
			if (!lastEventAt || at > lastEventAt) lastEventAt = at;
		}
		return {
			device,
			version: VERSION,
			uptimeSec: Math.floor((now - startedAt) / 1000),
			steward: {
				sessionId: String(stewardSessionId),
				live: agent !== null,
				status: agent ? agent.status : "unloaded",
				busy: waitInflight || runningDeliveries.size > 0,
			},
			conversations: { active, lastEventAt },
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

	// ---- roster management (persist back to fleet.json) ------------------------

	function persistPeers() {
		fileConfig.peers = config.peers.map((p) => ({ device: p.device, baseUrl: p.baseUrl, ...(p.role ? { role: p.role } : {}) }));
		saveJson(configFile, fileConfig);
	}

	async function rosterAdd(target) {
		const { device: dev, baseUrl, role = "" } = target;
		if (!dev || !baseUrl) return { ok: false, error: "device 与 baseUrl 必填" };
		if (dev === device) return { ok: false, error: `不能添加本机（${device}）为对端` };
		// probe: the peer must be reachable and answer with a matching identity
		try {
			const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/fleet/status`, {
				headers: { authorization: `Bearer ${config.secret}` },
				signal: AbortSignal.timeout(5000),
			});
			const payload = await resp.json();
			if (!resp.ok || payload.ok === false) return { ok: false, error: `探测失败 HTTP ${resp.status}: ${payload.error ?? ""}` };
			if (payload.device !== dev) return { ok: false, error: `身份不符：${baseUrl} 自称 ${payload.device}，而非 ${dev}` };
		} catch (err) {
			return { ok: false, error: `探测 ${baseUrl} 失败: ${err instanceof Error ? err.message : String(err)}` };
		}
		config.peers = config.peers.filter((p) => p.device !== dev);
		config.peers.push({ device: dev, baseUrl, role });
		persistPeers();
		pollPeer(config.peers[config.peers.length - 1]);
		return { ok: true, added: dev, peers: config.peers.map((p) => p.device) };
	}

	function rosterRemove(dev) {
		const before = config.peers.length;
		config.peers = config.peers.filter((p) => p.device !== dev);
		if (config.peers.length === before) return { ok: false, error: `名册中没有 ${dev}` };
		persistPeers();
		return { ok: true, removed: dev, peers: config.peers.map((p) => p.device) };
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
			if (req.method === "POST") {
				let body;
				try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "invalid JSON body" }); }
				const result = body.op === "add"
					? await rosterAdd(body)
					: body.op === "remove" ? rosterRemove(String(body.device ?? "")) : { ok: false, error: "op 必须是 add 或 remove" };
				return sendJson(res, result.ok ? 200 : 400, result);
			}
			sendJson(res, 200, { ok: true, self: localStatus(), peers: rosterPeers() });
		},
	});

	// Undelivered receipts (pull path for senders that can't receive pushes).
	ctx.webServer.register({
		kind: "exact",
		path: "/fleet/replies",
		handler: async (req, res) => {
			if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
			const undelivered = replies.pending.filter((r) => !r.delivered);
			for (const r of undelivered) r.delivered = true;
			if (undelivered.length) saveJson(repliesPath, replies);
			sendJson(res, 200, { ok: true, receipts: undelivered });
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
			// inbound receipt push from a peer executor
			if (body.type === "receipt") {
				if (typeof body.text !== "string" || !body.deliveryId) return sendJson(res, 400, { ok: false, error: "receipt 需要 deliveryId 与 text" });
				ingestReceipt(body);
				return sendJson(res, 200, { ok: true, received: true });
			}
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (!text) return sendJson(res, 400, { ok: false, error: "missing non-empty text field" });
			const wait = body.wait === true;
			const timeoutMs = Math.min(Math.max(Number(body.timeoutSec) || 300, 5), 3600) * 1000;
			const sender = body.callback && typeof body.callback.baseUrl === "string"
				? { device: String(body.callback.device ?? "unknown"), baseUrl: body.callback.baseUrl }
				: null;
			const deliveryId = typeof body.deliveryId === "string" && body.deliveryId ? body.deliveryId : `d-${randomUUID().slice(0, 8)}`;
			try {
				const { agent, startSeq } = await enqueueToSteward(text);
				if (!wait) {
					runningDeliveries.set(deliveryId, { startSeq, sender, sentAt: Date.now(), progressSent: false });
					sendJson(res, 200, { ok: true, async: true, deliveryId, sessionId: String(stewardSessionId) });
					watchDelivery(deliveryId, agent, startSeq, sender);
					return;
				}
				if (waitInflight) return sendJson(res, 409, { ok: false, error: "steward busy with another waiting caller" });
				waitInflight = true;
				try {
					const result = await awaitTurnEnd(agent, startSeq, timeoutMs);
					let kind = "reply";
					let reply = null;
					if (result.error !== undefined) { kind = "error"; reply = null; }
					else reply = result.replies?.length ? result.replies.join("\n\n") : null;
					if (sender) {
						const receiptText = kind === "error" ? `对端管家执行出错: ${result.error}` : (reply ?? "(已完成，无文本回复)");
						recordReceipt(deliveryId, sender, kind, receiptText);
						if (await tryPushReceipt(sender.baseUrl, { deliveryId, kind, text: receiptText })) markReceiptPushed(deliveryId, kind);
					}
					if (kind === "error") return sendJson(res, 200, { ok: false, error: `steward error: ${result.error}`, deliveryId, sessionId: String(stewardSessionId) });
					sendJson(res, 200, { ok: true, done: result.done, reply, deliveryId, sessionId: String(stewardSessionId) });
				} finally {
					waitInflight = false;
				}
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

	const summarizeOutbox = () => outbox.deliveries.slice(-12).map((d) => ({
		deliveryId: d.id, to: d.to, state: d.state, sentAt: new Date(d.sentAt).toISOString(),
		...(d.replyText ? { replyPreview: String(d.replyText).slice(0, 120) } : {}),
	}));

	ctx.tools.register(defineTool({
		name: "fleet_status",
		description: "查看设备舰队状态：本机管家状态 + 各对端设备心跳（在线/离线、管家是否忙碌、会话活跃度）。不消耗任何对端资源。",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{ type: "text", text: result }],
		},
		execute() {
			const peers = config.peers.map((p) => {
				const c = peerCache.get(p.device);
				return { device: p.device, role: p.role || undefined, online: c?.online ?? false, lastSeen: c?.lastSeenMs ? new Date(c.lastSeenMs).toISOString() : null, steward: c?.payload?.steward ?? null, conversations: c?.payload?.conversations ?? null };
			});
			return Promise.resolve(JSON.stringify({ self: localStatus(), peers, outbox: summarizeOutbox() }, null, 2));
		},
	}));

	ctx.tools.register(defineTool({
		name: "fleet_send",
		description: `向舰队里另一台设备的管家 agent 发一条消息（A2A 指挥），默认异步：立即返回 deliveryId，对端干完后把回执推进本机收件箱（不可推送时保留在对端，用 fleet_inbox 拉取）。给完任务可以设个提醒，到点用 fleet_inbox 收结果。当前舰队成员：\n${rosterText()}\n用法：device 填对端设备名；text 写清任务要求（对端管家看不到你们的上下文，需自包含）；短任务可 wait=true 顺带等回复（≤timeoutSec）。禁止发给本机（device=${device}）。`,
		parameters: {
			device: { type: "string", description: "目标设备名（舰队成员之一）" },
			text: { type: "string", description: "自包含的任务消息" },
			wait: { type: "boolean", description: "是否同步等待完整回复，默认 false（异步+回执）" },
			timeoutSec: { type: "number", description: "wait=true 时的等待上限秒数，默认 300，最大 3600" },
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
				return Promise.resolve(`错误：未知设备 "${args.device}"。舰队成员：${[device, ...config.peers.map((p) => p.device)].join(", ")}。如需添加新成员用 fleet_member_add。`);
			}
			const wait = args.wait === true;
			const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 300, 5), 3600);
			const deliveryId = `d-${randomUUID().slice(0, 8)}`;
			const callback = selfBaseUrl ? { device, baseUrl: selfBaseUrl } : undefined;
			const body = JSON.stringify({ text: args.text, wait, timeoutSec, deliveryId, ...(callback ? { callback } : {}) });
			const signal = wait ? (exec?.signal ?? AbortSignal.timeout((timeoutSec + 15) * 1000)) : AbortSignal.timeout(30000);
			pushOutbox({ id: deliveryId, to: args.device, state: "sending", sentAt: Date.now(), replyText: "" });
			return fetch(`${peer.baseUrl.replace(/\/$/, "")}/fleet/message`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
				body,
				signal,
			}).then(async (resp) => {
				const payload = await resp.json().catch(() => ({}));
				if (!resp.ok || payload.ok === false) {
					setOutboxState(deliveryId, "failed", String(payload.error ?? `HTTP ${resp.status}`));
					return `对端 ${args.device} 返回错误 (HTTP ${resp.status}): ${payload.error ?? JSON.stringify(payload)}`;
				}
				if (wait) {
					if (payload.done === false) { setOutboxState(deliveryId, "timeout", payload.reply ?? ""); return `${args.device} 处理超时，部分回复：\n${payload.reply ?? "(无)"}`; }
					setOutboxState(deliveryId, "replied", payload.reply ?? "");
					return payload.reply ?? `(${args.device} 已完成，无文本回复)`;
				}
				setOutboxState(deliveryId, "running");
				const how = selfBaseUrl ? "回执将自动推送到本机收件箱" : "本机未配置 advertise.baseUrl，回执保留在对端（稍后用 fleet_inbox 拉取）";
				return `已投递给 ${args.device}（异步）。deliveryId=${deliveryId}。${how}。`;
			}).catch((err) => {
				setOutboxState(deliveryId, "failed", String(err?.message ?? err));
				if (exec?.signal?.aborted) return `等待 ${args.device} 回复被取消: ${err?.message ?? err}`;
				return `联系 ${args.device}（${peer.baseUrl}）失败: ${err instanceof Error ? err.message : String(err)}`;
			});
		},
	}));

	function pushOutbox(entry) {
		pushCapped(outbox.deliveries, entry, 100);
		saveJson(outboxPath, outbox);
	}

	function setOutboxState(deliveryId, state, replyText) {
		const entry = outbox.deliveries.find((d) => d.id === deliveryId);
		if (entry) {
			entry.state = state;
			if (replyText !== undefined) entry.replyText = replyText;
			saveJson(outboxPath, outbox);
		}
	}

	ctx.tools.register(defineTool({
		name: "fleet_inbox",
		description: "收舰队回执：列出本机收件箱里未读的对端管家回执（任务结果/进度/错误）。若指定 device 则先向该设备拉取它保留的未送达回执（pull 模式，本机不可被推送时用）。建议在 fleet_send 异步派活后、或提醒到点时调用。",
		parameters: {
			device: { type: "string", description: "可选：从该设备拉取未送达回执（如 nas）" },
			keepUnread: { type: "boolean", description: "查看后是否保持未读状态，默认 false（取出即标记已读）" },
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{ type: "text", text: result }],
		},
		execute(args) {
			const steps = [];
			if (args.device && args.device !== device) {
				const peer = config.peers.find((p) => p.device === args.device);
				if (!peer) return Promise.resolve(`错误：未知设备 "${args.device}"`);
				steps.push(
					fetch(`${peer.baseUrl.replace(/\/$/, "")}/fleet/replies`, {
						headers: { authorization: `Bearer ${config.secret}` },
						signal: AbortSignal.timeout(10000),
					}).then(async (resp) => {
						const payload = await resp.json().catch(() => ({}));
						for (const r of payload.receipts ?? []) {
							ingestReceipt({ device: args.device, deliveryId: r.deliveryId, kind: r.kind, text: r.text });
						}
						return `从 ${args.device} 拉取了 ${payload.receipts?.length ?? 0} 条回执`;
					}).catch((err) => `拉取 ${args.device} 回执失败: ${err instanceof Error ? err.message : String(err)}`),
				);
			}
			return Promise.all(steps).then((pullLogs) => {
				const unread = inbox.messages.filter((m) => !m.read);
				for (const m of unread) if (args.keepUnread !== true) m.read = true;
				if (unread.length && args.keepUnread !== true) saveJson(inboxPath, inbox);
				if (!unread.length) {
					return JSON.stringify({ pull: pullLogs, inbox: "无未读回执", outbox: summarizeOutbox() }, null, 2);
				}
				return JSON.stringify({
					pull: pullLogs,
					receipts: unread.map((m) => ({ from: m.from, deliveryId: m.deliveryId, kind: m.kind, at: new Date(m.at).toISOString(), text: m.text })),
					outbox: summarizeOutbox(),
				}, null, 2);
			});
		},
	}));

	ctx.tools.register(defineTool({
		name: "fleet_member_add",
		description: `向舰队添加一台新设备（运行着 dsh-fleet 的对端）。会先探测对端 /fleet/status 验证身份（设备名必须匹配、密钥必须相同），通过后写入本机名册并持久化到 fleet.json。新成员入网流程：① 在新设备上装好 dsh-fleet 并写好 fleet.json（device/secret/steward，peers 先指向舰队里任一现有成员）② 在本机执行本工具（或对端管家执行并带 announce=true 反向注册）。当前名册：\n${rosterText()}`,
		parameters: {
			device: { type: "string", description: "新成员设备名（须与其 fleet.json 的 device 一致）" },
			baseUrl: { type: "string", description: "新成员根地址，如 http://100.64.0.3:43129" },
			role: { type: "string", description: "职责描述（给模型看），如「NAS 管家·内网大管家」" },
			announce: { type: "boolean", description: "是否同时让对端把本机加进它的名册（双向互通；本机需已配置 advertise.baseUrl）" },
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{ type: "text", text: result }],
		},
		execute(args) {
			return rosterAdd({ device: args.device, baseUrl: args.baseUrl, role: args.role ?? "" }).then(async (result) => {
				if (!result.ok) return JSON.stringify(result, null, 2);
				let announceLog = "";
				if (args.announce === true) {
					if (!selfBaseUrl) {
						announceLog = `（announce 跳过：本机未配置 advertise.baseUrl，对端无法探测到本机；请在双向都需要时配置）`;
					} else {
						try {
							const resp = await fetch(`${args.baseUrl.replace(/\/$/, "")}/fleet/roster`, {
								method: "POST",
								headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
								body: JSON.stringify({ op: "add", device, baseUrl: selfBaseUrl, role: "fleet member" }),
								signal: AbortSignal.timeout(10000),
							});
							const payload = await resp.json().catch(() => ({}));
							announceLog = payload.ok ? `（已通知对端反向注册本机）` : `（对端反向注册失败: ${payload.error ?? resp.status}）`;
						} catch (err) {
							announceLog = `（对端反向注册失败: ${err instanceof Error ? err.message : String(err)}）`;
						}
					}
				}
				return JSON.stringify({ ...result, announceLog: announceLog || undefined, note: "已持久化到 fleet.json" }, null, 2);
			});
		},
	}));

	ctx.tools.register(defineTool({
		name: "fleet_member_remove",
		description: "把一台设备从本机舰队名册移除（并持久化到 fleet.json）。只影响本机视图；对端名册需另行移除。",
		parameters: {
			device: { type: "string", description: "要移除的设备名" },
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{ type: "text", text: result }],
		},
		execute(args) {
			return Promise.resolve(JSON.stringify(rosterRemove(args.device), null, 2));
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

	// retry push for receipts the sender couldn't receive yet
	async function retryReceiptPushes() {
		for (const r of replies.pending) {
			if (r.delivered || !r.toBaseUrl || r.attempts >= 3) continue;
			r.attempts += 1;
			if (await tryPushReceipt(r.toBaseUrl, { deliveryId: r.deliveryId, kind: r.kind, text: r.text })) {
				r.delivered = true;
			}
		}
		saveJson(repliesPath, replies);
	}

	// long-task progress pings
	function sendProgressPings() {
		const now = Date.now();
		const thresholdMs = Math.max(30, config.progressAfterSec ?? 300) * 1000;
		for (const [deliveryId, entry] of runningDeliveries) {
			if (entry.progressSent || now - entry.sentAt < thresholdMs) continue;
			entry.progressSent = true;
			const text = `仍在处理中：任务 ${deliveryId} 已运行 ${Math.round((now - entry.sentAt) / 1000)}s（对端管家未完成，完成后会再发正式回执）`;
			recordReceipt(deliveryId, entry.sender, "progress", text);
			if (entry.sender?.baseUrl) {
				tryPushReceipt(entry.sender.baseUrl, { deliveryId, kind: "progress", text }).then((ok) => { if (ok) markReceiptPushed(deliveryId, "progress"); });
			}
		}
	}

	ctx.setInterval(() => {
		if (heartbeatBusy) return;
		heartbeatBusy = true;
		const jobs = [retryReceiptPushes(), ...config.peers.map(pollPeer)];
		Promise.allSettled(jobs).finally(() => { heartbeatBusy = false; });
		sendProgressPings();
		// prune stale conversation activity
		const cutoff = Date.now() - 60 * 60 * 1000;
		for (const [sid, at] of sessionActivity) if (at < cutoff) sessionActivity.delete(sid);
	}, Math.max(5, config.heartbeatSec) * 1000);
	// one immediate poll so the roster is warm without waiting an interval
	Promise.allSettled(config.peers.map(pollPeer));

	ctx.logger?.info?.(`dsh-fleet ${VERSION} ready: device=${device} steward=${String(stewardSessionId)} peers=${config.peers.map((p) => p.device).join(",") || "none"} advertise=${selfBaseUrl || "(pull-only)"}`);
}

export { name, inject, Config, apply, VERSION };
