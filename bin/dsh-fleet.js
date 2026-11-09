#!/usr/bin/env node
/**
 * dsh-fleet CLI (v1). Talks to the running plugin through its loopback
 * control listener (port + token in <dataDir>/control.json).
 * PINs are only ever read interactively, never from arguments.
 */
import { parseArgs } from "node:util";
import { createInput } from "../lib/cli-input.js";
import { LocalUnavailableError, callLocal } from "../lib/local-client.js";
import { resolveDataDir } from "../lib/paths.js";

const PIN_RE = /^\d{6}$/;
const USAGE = `用法：dsh-fleet [命令] [--dir <数据目录>] [--json]

  status                         查看舰队状态（默认）
  discover                       查找局域网和 Tailscale 上的舰队
  create <舰队名> [--name 本机名]  新建舰队
  join [--address host:port] [--fleet XXXX-XXXX] [--name 本机名]
                                 加入舰队
  members                        列出成员
  remove <成员编码前缀>            移除成员
  pin change | pin reset         修改 / 重置 PIN
  describe [--name N] [--description D]
                                 修改本机的名字和身份描述
  leave                          离开舰队并换一个新身份
`;

const MESSAGES = {
	"bad-pin": "PIN 错误",
	"pin-format": "PIN 必须是 6 位数字",
	"already-joined": "本机已经在舰队里了（要换舰队，先运行 dsh-fleet leave）",
	"not-joined": "本机还没有加入舰队",
	"key-mismatch": "身份校验失败：公钥和 TLS 证书不一致",
	unreachable: "连不上对方",
	"roster-corrupt": "roster.json 已损坏，舰队已停用；请修复或删除该文件后重启 DSH",
	"state-corrupt": "state.json 已损坏，舰队已停用；请修复或删除该文件后重启 DSH",
	"identity-corrupt": "identity.json 已损坏，舰队已停用；请从备份恢复该文件后重启 DSH（删除它会得到新身份，需要重新入网）",
	removed: "本机这个身份已被移出舰队；要重新加入，先运行 dsh-fleet leave 换一个新身份",
	"rate-limited": "请求太频繁，请稍后再试",
	"self-remove": "不能移除本机自己",
	"unknown-member": "舰队里没有这个成员",
	"join-failed": "入网失败",
	"bad-token": "控制令牌不匹配（control.json 和正在运行的插件对不上，请重启 DSH）",
};

class CliError extends Error {
	constructor(message, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

const out = (text) => process.stdout.write(`${text}\n`);

function describeError(body, context) {
	if (body?.error === "pin-locked") return `PIN 输错次数太多，已锁定，请 ${Math.ceil((body.retryAfterMs ?? 0) / 60000)} 分钟后再试`;
	if (body?.error === "not-joined" && context === "join") return "对方设备还没有加入舰队";
	return MESSAGES[body?.error] ?? `失败：${body?.error ?? "未知错误"}`;
}

async function call(ctx, method, path, body, context) {
	let r;
	try {
		r = await callLocal({ dataDir: ctx.dir, method, path, body });
	} catch (err) {
		if (err instanceof LocalUnavailableError) throw new CliError(`dsh-fleet 插件没有在运行（${err.reason}）。请确认 DSH 已启动并装了 dsh-fleet，或用 --dir 指定数据目录。`, 2);
		throw err;
	}
	if (r.status !== 200) throw new CliError(describeError(r.body, context));
	return r.body;
}

async function askPin(ctx, prompt) {
	const pin = await ctx.input.ask(prompt, { hidden: true });
	if (!PIN_RE.test(pin)) throw new CliError(MESSAGES["pin-format"]);
	return pin;
}

async function askNewPin(ctx) {
	const a = await askPin(ctx, "新 PIN（6 位数字）：");
	const b = await askPin(ctx, "再输一次：");
	if (a !== b) throw new CliError("两次输入的 PIN 不一致");
	return a;
}

const short = (id) => id.slice(0, 8);

function printStatus(s) {
	out(s.joined ? `舰队：${s.fleet.name}（${s.fleet.short}）` : "舰队：未加入");
	out(`本机：${s.self.name}  ${short(s.self.memberId)}${s.self.rejected ? "  ⚠ 已被移出舰队" : ""}`);
	if (s.listening?.port) out(`端口：${s.listening.port}`);
	else out(`端口：${s.listening?.error === "EADDRINUSE" ? "端口被占用（EADDRINUSE），其他设备连不上本机" : `未监听（${s.listening?.error}）`}`);
	if (s.discovery) out(`发现：mDNS ${s.discovery.mdns}，Tailscale ${s.discovery.tailscale}`);
	if (s.error) out(`错误：${MESSAGES[s.error] ?? s.error}`);
	if (s.pinConflict) out("⚠ PIN 冲突：有成员同时修改了 PIN，当前生效的是最后一次；建议再改一次 PIN");
	if (s.joined) printMembers(s);
}

function printMembers(s) {
	out(`成员（${s.members.length}）：`);
	for (const m of s.members) {
		const state = m.isSelf ? "本机" : m.online ? "在线" : "离线";
		const addr = m.addresses?.[0] ? `${m.addresses[0].host}:${m.addresses[0].port}` : "-";
		out(`  ${m.online ? "●" : "○"} ${m.name}  ${state}  ${short(m.memberId)}  ${addr}${m.description ? `  — ${m.description}` : ""}`);
	}
}

function parseAddress(text) {
	const m = /^(.+):(\d{1,5})$/.exec(text ?? "");
	if (!m) throw new CliError("地址格式应为 host:port，例如 100.85.254.124:43190", 2);
	return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

async function pickFleetAddress(ctx) {
	const { fleets } = await call(ctx, "GET", "/local/discover");
	const wanted = ctx.values.fleet?.toUpperCase();
	const matches = wanted ? fleets.filter((f) => f.short === wanted) : fleets;
	if (matches.length === 1) {
		const f = matches[0];
		process.stderr.write(`加入舰队：${f.fleetName ?? "?"}（${f.short}），经由 ${f.via.host}:${f.via.port}\n`);
		return { host: f.via.host, port: f.via.port };
	}
	if (!matches.length) throw new CliError(wanted ? `没有发现舰队 ${wanted}` : "没有发现任何舰队；可以用 --address host:port 手动指定");
	throw new CliError(`发现多个舰队，请用 --fleet 指定：${matches.map((f) => `${f.short}（${f.fleetName ?? "?"}）`).join("、")}`);
}

const COMMANDS = {
	async status(ctx) {
		const s = await call(ctx, "GET", "/local/status");
		if (ctx.values.json) out(JSON.stringify(s, null, 2)); else printStatus(s);
	},
	async discover(ctx) {
		const d = await call(ctx, "GET", "/local/discover");
		if (ctx.values.json) return out(JSON.stringify(d, null, 2));
		if (!d.fleets.length) out("没有发现舰队");
		for (const f of d.fleets) out(`${f.short}  ${f.fleetName ?? "?"}  经由 ${f.via.host}:${f.via.port}（${f.via.source}）`);
		if (d.unjoined.length) out(`未入网的设备：${d.unjoined.map((u) => `${u.name}（${u.host}）`).join("、")}`);
	},
	async create(ctx) {
		const [name] = ctx.args;
		if (!name) throw new CliError("请给舰队起个名字：dsh-fleet create <舰队名>", 2);
		const pin = await askNewPin(ctx);
		const s = await call(ctx, "POST", "/local/create", { name, pin, memberName: ctx.values.name });
		out(`已创建舰队 ${s.fleet.name}（${s.fleet.short}）。PIN 请自己保管，丢了只能在成员设备上用 dsh-fleet pin reset 重置。`);
	},
	async join(ctx) {
		const address = ctx.values.address ? parseAddress(ctx.values.address) : await pickFleetAddress(ctx);
		const pin = await askPin(ctx, "舰队 PIN：");
		const s = await call(ctx, "POST", "/local/join", { ...address, pin, memberName: ctx.values.name }, "join");
		out(`已加入舰队 ${s.fleet.name}（${s.fleet.short}），共 ${s.members.length} 台成员`);
	},
	async members(ctx) {
		const s = await call(ctx, "GET", "/local/status");
		if (ctx.values.json) return out(JSON.stringify(s.members, null, 2));
		if (!s.joined) throw new CliError(MESSAGES["not-joined"]);
		printMembers(s);
	},
	async remove(ctx) {
		const [prefix] = ctx.args;
		if (!prefix || prefix.length < 4) throw new CliError("请给出成员编码的前缀（至少 4 位），可以用 dsh-fleet members 查看", 2);
		const s = await call(ctx, "GET", "/local/status");
		const hits = s.members.filter((m) => m.memberId.startsWith(prefix.toLowerCase()));
		if (hits.length !== 1) throw new CliError(hits.length ? `前缀 ${prefix} 对应多个成员，请多给几位` : MESSAGES["unknown-member"]);
		const pin = await askPin(ctx, `移除 ${hits[0].name}（${short(hits[0].memberId)}），输入舰队 PIN：`);
		await call(ctx, "POST", "/local/remove", { memberId: hits[0].memberId, pin });
		out(`已移除 ${hits[0].name}。建议修改 PIN（dsh-fleet pin change）`);
	},
	async pin(ctx) {
		const [sub] = ctx.args;
		if (sub === "change") {
			const oldPin = await askPin(ctx, "当前 PIN：");
			const newPin = await askNewPin(ctx);
			await call(ctx, "POST", "/local/pin/change", { oldPin, newPin });
			return out("PIN 已修改，会同步到全舰队");
		}
		if (sub === "reset") {
			const newPin = await askNewPin(ctx);
			await call(ctx, "POST", "/local/pin/reset", { newPin });
			return out("PIN 已重置，会同步到全舰队");
		}
		throw new CliError("用法：dsh-fleet pin change | pin reset", 2);
	},
	async describe(ctx) {
		const { name, description } = ctx.values;
		if (name === undefined && description === undefined) throw new CliError("用法：dsh-fleet describe [--name N] [--description D]", 2);
		const s = await call(ctx, "POST", "/local/describe", { name, description });
		out(`已更新：${s.self.name}`);
	},
	async leave(ctx) {
		const answer = await ctx.input.ask("离开舰队会清空本机的舰队数据并换一个新身份。确认请输入 yes：");
		if (answer !== "yes") throw new CliError("已取消");
		await call(ctx, "POST", "/local/leave");
		out("已离开舰队，本机换了新身份");
	},
};

function parse(argv) {
	if (argv.some((a) => a === "--pin" || a.startsWith("--pin="))) throw new CliError("PIN 只能交互输入，不能写在命令行参数里", 2);
	try {
		return parseArgs({
			args: argv,
			allowPositionals: true,
			options: { dir: { type: "string" }, json: { type: "boolean" }, name: { type: "string" }, description: { type: "string" }, address: { type: "string" }, fleet: { type: "string" }, help: { type: "boolean", short: "h" } },
		});
	} catch (err) {
		throw new CliError(`${err.message}\n\n${USAGE}`, 2);
	}
}

async function main(argv) {
	const { values, positionals } = parse(argv);
	if (values.help) return out(USAGE);
	const [command = "status", ...args] = positionals;
	const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
	if (!run) throw new CliError(`未知命令：${command}\n\n${USAGE}`, 2);
	const input = createInput();
	try {
		await run({ dir: values.dir ?? resolveDataDir(), values, args, input });
	} finally {
		input.close();
	}
}

main(process.argv.slice(2)).then(
	() => process.exit(0),
	(err) => {
		process.stderr.write(`${err instanceof CliError ? err.message : `出错了：${err?.stack ?? err}`}\n`);
		process.exit(err instanceof CliError ? err.exitCode : 1);
	},
);
