#!/usr/bin/env node
/**
 * dsh-fleet CLI — manage a fleet member from the command line.
 *
 * Talks to the fleet HTTP API (Bearer fleet secret) of any reachable member;
 * never loads the plugin itself. Defaults come from the local fleet.json
 * ($DSH_FLEET_CONFIG, $DSH_HOME/fleet.json, ~/.dsh/fleet.json) when present.
 *
 * Commands:
 *   status                     show one member's heartbeat (default)
 *   roster                     list this member's view of the fleet
 *   add <device> <baseUrl>     probe-verified add, persisted to fleet.json
 *        [--role TEXT] [--announce --my-url URL]
 *   remove <device>            remove from roster
 *   send <device> <text>       async message to the peer's steward
 *        [--wait] [--timeout SEC]
 *   inbox [device]             pull undelivered receipts held by a peer
 *
 * Global flags:
 *   --api URL       fleet member base (default $DSH_FLEET_API or
 *                   advertise.baseUrl or http://127.0.0.1:43129)
 *   --secret TEXT   fleet shared secret (default from local fleet.json)
 *   --json          raw JSON output
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `dsh-fleet — 多设备舰队管理 CLI

用法: dsh-fleet [status|roster|add|remove|send|inbox] [参数]

  status                          查看某成员心跳（默认命令）
  roster                          该成员视角的舰队名册
  add <device> <baseUrl>          添加成员（先探测身份，防冒名）
      --role TEXT                 职责描述
      --announce                  同时让对方把本机加入它的名册（双向互注）
      --my-url URL                announce 时本机对外的 baseUrl（默认读本地 fleet.json 的 advertise.baseUrl）
  remove <device>                 移除成员
  send <device> <text>            给对方管家派活（默认异步，返回 deliveryId）
      --wait                      同步等待回复
      --timeout SEC               --wait 的上限（默认 300）
  inbox <device>                拉取该成员替你保留的未送达回执

全局:
  --api URL     目标成员地址（默认 $DSH_FLEET_API 或本地 fleet.json advertise.baseUrl 或 http://127.0.0.1:43129）
  --secret TEXT 舰队密钥（默认读本地 fleet.json）
  --json        原始 JSON 输出
  --version     版本
`;

function loadLocalConfig() {
	const candidates = [];
	if (process.env.DSH_FLEET_CONFIG) candidates.push(process.env.DSH_FLEET_CONFIG);
	const home = process.env.DSH_HOME ?? "";
	if (home) candidates.push(join(home, "fleet.json"));
	candidates.push(join(homedir(), ".dsh", "fleet.json"));
	for (const p of candidates) {
		try { return { path: p, config: JSON.parse(readFileSync(p, "utf8")) }; } catch { /* keep trying */ }
	}
	return null;
}

function parseArgs(argv) {
	const out = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json" || a === "--wait" || a === "--announce" || a === "--keep-unread") { out.flags[a.slice(2)] = true; continue; }
		if (a === "--api" || a === "--secret" || a === "--role" || a === "--timeout" || a === "--my-url") {
			out.flags[a.slice(2)] = argv[++i] ?? "";
			continue;
		}
		if (a === "--version" || a === "-v") { out.flags.version = true; continue; }
		if (a === "--help" || a === "-h") { out.flags.help = true; continue; }
		out._.push(a);
	}
	return out;
}

function die(msg, code = 1) {
	console.error(String(msg));
	process.exit(code);
}

async function call(api, secret, path, init = {}) {
	let resp;
	try {
		resp = await fetch(`${api.replace(/\/$/, "")}${path}`, {
			...init,
			headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(Number(init.timeoutMs ?? 8000)),
		});
	} catch (err) {
		die(`连接 ${api} 失败: ${err instanceof Error ? err.message : String(err)}\n（目标成员没启动？或用 --api 指定地址）`);
	}
	let payload;
	try { payload = await resp.json(); } catch { payload = { ok: false, error: `HTTP ${resp.status} (non-JSON)` }; }
	return { status: resp.status, payload };
}

function mustOk({ status, payload }, api) {
	if (!payload || payload.ok === false) {
		die(`[${status}] ${payload?.error ?? "unknown error"}${api ? ` — from ${api}` : ""}`);
	}
	return payload;
}

function fmtAgo(ms) {
	if (!ms) return "从未";
	const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	return d < 60 ? `${d}s 前` : d < 3600 ? `${Math.floor(d / 60)}m 前` : `${Math.floor(d / 3600)}h 前`;
}

function printStatus(payload, json) {
	if (json) { console.log(JSON.stringify(payload, null, 2)); return; }
	console.log(`设备: ${payload.device}  版本: ${payload.version ?? "?"}  运行: ${payload.uptimeSec ?? "?"}s`);
	const st = payload.steward ?? {};
	console.log(`管家: ${st.live ? (st.busy ? "忙碌" : (st.status || "idle")) : "休眠(未唤醒)"}`);
	const conv = payload.conversations;
	if (conv) console.log(`会话: ${conv.active > 0 ? `${conv.active} 个活跃` : "静默"}${conv.lastEventAt ? ` · 最近 ${fmtAgo(conv.lastEventAt)}` : ""}`);
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	const flags = parsed.flags;
	if (flags.version) { console.log("dsh-fleet CLI 0.3.1"); return; }
	if (flags.help || (parsed._[0] !== "status" && parsed._[0] !== "roster" && parsed._[0] !== "add" && parsed._[0] !== "remove" && parsed._[0] !== "send" && parsed._[0] !== "inbox" && parsed._.length > 0)) {
		console.log(USAGE);
		if (!flags.help && parsed._.length > 0) die(`未知命令: ${parsed._[0]}`);
		return;
	}
	const cmd = parsed._[0] ?? "status";

	const local = loadLocalConfig();
	const localCfg = local?.config ?? {};
	const secret = flags.secret || process.env.DSH_FLEET_SECRET || localCfg.secret || die("缺少舰队密钥：用 --secret 或在本地 fleet.json / $DSH_FLEET_SECRET 提供");
	const api = flags.api || process.env.DSH_FLEET_API || localCfg.advertise?.baseUrl || "http://127.0.0.1:43129";

	if (cmd === "status") {
		const payload = mustOk(await call(api, secret, "/fleet/status"), api);
		printStatus(payload, flags.json);
		return;
	}

	if (cmd === "roster") {
		const payload = mustOk(await call(api, secret, "/fleet/roster"), api);
		if (flags.json) { console.log(JSON.stringify(payload, null, 2)); return; }
		printStatus({ ...payload.self }, false);
		console.log(`\n对端 (${(payload.peers ?? []).length}):`);
		for (const p of payload.peers ?? []) {
			console.log(`  ${p.online ? "●" : "○"} ${p.device.padEnd(10)} ${p.baseUrl}  ${p.role || ""}  心跳 ${fmtAgo(p.lastSeenMs)}`);
		}
		if (!(payload.peers ?? []).length) console.log("  （空）");
		return;
	}

	if (cmd === "add") {
		const [dev, baseUrl] = parsed._.slice(1);
		if (!dev || !baseUrl) die("用法: dsh-fleet add <device> <baseUrl> [--role TEXT] [--announce --my-url URL]");
		const result = mustOk(await call(api, secret, "/fleet/roster", { method: "POST", body: JSON.stringify({ op: "add", device: dev, baseUrl, role: flags.role ?? "" }) }), api);
		console.log(`✓ 已添加 ${dev}（名册: ${result.peers.join(", ")}）`);
		if (flags.announce) {
			// reverse-registration: make the new member add THIS device back.
			// Needs this device's externally reachable URL.
			const myUrl = flags["my-url"] || (localCfg.advertise?.baseUrl ?? "");
			const selfName = localCfg.device ?? "";
			if (!myUrl || !selfName) die("--announce 还需要 --my-url URL（以及本地 fleet.json 的 device）");
			const back = mustOk(await call(baseUrl, secret, "/fleet/roster", { method: "POST", body: JSON.stringify({ op: "add", device: selfName, baseUrl: myUrl }) }), baseUrl);
			console.log(`✓ 对端 ${dev} 已反向注册本机 ${selfName}（其名册: ${back.peers.join(", ")}）`);
		}
		return;
	}

	if (cmd === "remove") {
		const dev = parsed._[1];
		if (!dev) die("用法: dsh-fleet remove <device>");
		const result = mustOk(await call(api, secret, "/fleet/roster", { method: "POST", body: JSON.stringify({ op: "remove", device: dev }) }), api);
		console.log(`✓ 已移除 ${dev}（名册: ${result.peers.join(", ") || "空"}）`);
		return;
	}

	if (cmd === "send") {
		const [dev, ...rest] = parsed._.slice(1);
		const text = rest.join(" ");
		if (!dev || !text) die("用法: dsh-fleet send <device> <text> [--wait] [--timeout SEC]");
		const wait = !!flags.wait;
		const timeoutSec = Math.min(Number(flags.timeout ?? 300) || 300, 3600);
		const payload = mustOk(await call(api, secret, "/fleet/message", {
			method: "POST",
			body: JSON.stringify({ device: dev, text, wait, timeoutSec, callback: localCfg.advertise?.baseUrl ? { device: localCfg.device, baseUrl: localCfg.advertise.baseUrl } : undefined }),
			timeoutMs: wait ? (timeoutSec * 1000 + 8000) : 8000,
		}), api);
		if (flags.json) { console.log(JSON.stringify(payload, null, 2)); return; }
		if (payload.async) {
			console.log(`已投递 ${dev}（异步）deliveryId=${payload.deliveryId}`);
			console.log(`回执: ${localCfg.advertise?.baseUrl ? "完成后自动推送回本机收件箱" : `稍后用 dsh-fleet inbox ${dev} 拉取`}`);
		} else {
			console.log(payload.reply ?? `（${dev} 无回复文本）`);
		}
		return;
	}

	if (cmd === "inbox") {
		const dev = parsed._[1];
		if (!dev) die("用法: dsh-fleet inbox <device>   （拉取该成员替本机保留的回执）");
		// find the peer's baseUrl: prefer local config, else ask our API's roster
		let baseUrl = (localCfg.peers ?? []).find((p) => p.device === dev)?.baseUrl;
		if (!baseUrl) {
			const roster = mustOk(await call(api, secret, "/fleet/roster"), api);
			baseUrl = (roster.peers ?? []).find((p) => p.device === dev)?.baseUrl;
		}
		if (!baseUrl) die(`名册里没有 ${dev}；先 dsh-fleet add ${dev} <baseUrl>`);
		const payload = mustOk(await call(baseUrl, secret, "/fleet/replies"), baseUrl);
		if (flags.json) { console.log(JSON.stringify(payload, null, 2)); return; }
		const rs = payload.receipts ?? [];
		if (!rs.length) { console.log(`（${dev} 上没有未送达回执）`); return; }
		for (const r of rs) console.log(`[${r.kind}] ${r.deliveryId}: ${r.text}`);
		return;
	}
}

main().catch((err) => die(err));
