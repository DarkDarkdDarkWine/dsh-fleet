#!/usr/bin/env node
// Run the test suite on DSH Desktop's bundled runtime (Electron, BoringSSL),
// which differs from official Node in TLS support. Skips when not installed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BIN = {
	darwin: "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop",
	win32: join(process.env.LOCALAPPDATA ?? "", "Programs", "DSH Desktop", "DSH Desktop.exe"),
	linux: "/opt/DSH Desktop/dsh-desktop",
};

const bin = process.env.DSH_DESKTOP_BIN || DEFAULT_BIN[process.platform];
if (!bin || !existsSync(bin)) {
	process.stdout.write(`跳过：未找到 DSH Desktop（${bin ?? "unknown platform"}），可用 DSH_DESKTOP_BIN 指定\n`);
	process.exit(0);
}

const files = readdirSync("test").filter((f) => f.endsWith(".test.js")).map((f) => join("test", f));
const result = spawnSync(bin, ["--test", ...files], {
	stdio: "inherit",
	env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(result.status ?? 1);
