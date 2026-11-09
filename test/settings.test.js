import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SettingsError, loadSettings } from "../lib/settings.js";

const dirWith = (settings) => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
	if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	return dir;
};

test("loadSettings returns the defaults when settings.json is missing", () => {
	const s = loadSettings(dirWith());
	assert.deepEqual(s, DEFAULT_SETTINGS);
	assert.equal(s.port, 43190);
	assert.equal(s.host, "0.0.0.0");
	assert.equal(s.heartbeatSec, 30);
	assert.equal(s.offlineAfterMisses, 3);
	assert.equal(s.concurrency, 2);
	assert.equal(s.archiveDays, 7);
	assert.equal(s.deliveryTtlHours, 24);
	assert.equal(s.bodyLimitBytes, 2097152);
	assert.deepEqual(s.agent, { provider: "", model: "", preset: "", cwd: "" });
	assert.deepEqual(s.tailscale, { enabled: "auto", scanSec: 60, cli: "" });
});

test("loadSettings merges nested agent defaults", () => {
	const s = loadSettings(dirWith({ agent: { model: "m1" }, heartbeatSec: 10 }));
	assert.deepEqual(s.agent, { provider: "", model: "m1", preset: "", cwd: "" });
	assert.equal(s.heartbeatSec, 10);
	assert.equal(s.port, 43190);
});

test("loadSettings rejects port 70000 with field \"port\"", () => {
	assert.throws(() => loadSettings(dirWith({ port: 70000 })), (err) => err instanceof SettingsError && err.field === "port");
});

test("loadSettings rejects heartbeatSec below 5, concurrency below 1 and a bad tailscale.enabled", () => {
	assert.throws(() => loadSettings(dirWith({ heartbeatSec: 4 })), (err) => err.field === "heartbeatSec");
	assert.throws(() => loadSettings(dirWith({ concurrency: 0 })), (err) => err.field === "concurrency");
	assert.throws(() => loadSettings(dirWith({ tailscale: { enabled: "yes" } })), (err) => err.field === "tailscale.enabled");
});

test("loadSettings does not mutate DEFAULT_SETTINGS", () => {
	loadSettings(dirWith({ agent: { model: "x" } }));
	assert.equal(DEFAULT_SETTINGS.agent.model, "");
});
