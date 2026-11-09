import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "../lib/paths.js";
import { StoreCorruptError, readJson, writeJsonAtomic } from "../lib/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "fleet-store-"));

test("resolveDataDir prefers DSH_FLEET_DIR, then DSH_HOME/fleet, then ~/.dsh/fleet", () => {
	assert.equal(resolveDataDir({ DSH_FLEET_DIR: "/a/b", DSH_HOME: "/h" }), "/a/b");
	assert.equal(resolveDataDir({ DSH_HOME: "/h" }), join("/h", "fleet"));
	assert.equal(resolveDataDir({}), join(homedir(), ".dsh", "fleet"));
});

test("readJson returns fallback for a missing file", () => {
	assert.deepEqual(readJson(join(tmp(), "nope.json"), { a: 1 }), { a: 1 });
});

test("readJson throws StoreCorruptError on invalid JSON and leaves the file untouched", () => {
	const path = join(tmp(), "bad.json");
	writeFileSync(path, "{not json");
	assert.throws(() => readJson(path, {}), (err) => err instanceof StoreCorruptError && err.path === path);
	assert.equal(readFileSync(path, "utf8"), "{not json");
});

test("writeJsonAtomic leaves no tmp file and secret files are 0600", () => {
	const dir = tmp();
	const path = join(dir, "secret.json");
	writeJsonAtomic(path, { k: "v" }, { secret: true });
	assert.deepEqual(readJson(path, null), { k: "v" });
	assert.deepEqual(readdirSync(dir), ["secret.json"]);
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeJsonAtomic creates missing parent directories", () => {
	const path = join(tmp(), "nested", "deeper", "x.json");
	writeJsonAtomic(path, [1, 2]);
	assert.deepEqual(readJson(path, null), [1, 2]);
});
