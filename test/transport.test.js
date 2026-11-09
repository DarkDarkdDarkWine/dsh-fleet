import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { localAddresses } from "../lib/addresses.js";
import { UnreachableError, requestMember } from "../lib/transport/client.js";
import { startFleetServer } from "../lib/transport/server.js";
import { makeIdentities } from "./helpers/roster.js";
import { rawRequest } from "./helpers/tls.js";

let A, B, X, server, seen;
const quiet = { warn() {}, info() {} };

before(async () => {
	[A, B, X] = await makeIdentities(3);
	seen = [];
	server = await startFleetServer({
		identity: A,
		host: "0.0.0.0",
		port: 0,
		bodyLimitBytes: 1024,
		isMember: (id) => id === B.memberId,
		logger: quiet,
		routes: {
			"/v1/ping": { auth: "member", method: "POST", handler: async (ctx) => { seen.push(ctx); return { status: 200, body: { pong: ctx.body.n, from: ctx.memberId } }; } },
			"/v1/hello": { auth: "open", method: "GET", handler: async (ctx) => ({ status: 200, body: { hello: true, memberId: ctx.memberId } }) },
			"/v1/echo": { auth: "open", method: "POST", handler: async (ctx) => ({ status: 200, body: ctx.body }) },
			"/local/status": { auth: "local", method: "GET", handler: async () => ({ status: 200, body: { ok: true } }) },
		},
	});
});
after(() => server.close());

const at = (port = server.port, host = "127.0.0.1") => [{ host, port }];

test("member route accepts B and passes memberId to the handler", async () => {
	const r = await requestMember({ identity: B, addresses: at(), expectMemberId: A.memberId, method: "POST", path: "/v1/ping", body: { n: 7 } });
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { pong: 7, from: B.memberId });
	assert.deepEqual(r.address, at()[0]);
	assert.equal(r.peerMemberId, A.memberId);
	assert.equal(seen.at(-1).memberId, B.memberId);
});

test("member route rejects X with 401 not-a-member", async () => {
	const r = await requestMember({ identity: X, addresses: at(), expectMemberId: A.memberId, method: "POST", path: "/v1/ping", body: { n: 1 } });
	assert.equal(r.status, 401);
	assert.deepEqual(r.body, { error: "not-a-member" });
});

test("open route works without a client cert", async () => {
	const r = await requestMember({ identity: null, addresses: at(), expectMemberId: null, method: "GET", path: "/v1/hello" });
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { hello: true, memberId: null });
});

test("unknown path is 404, wrong method 405, invalid JSON 400", async () => {
	assert.equal((await requestMember({ identity: B, addresses: at(), expectMemberId: null, method: "GET", path: "/nope" })).status, 404);
	assert.equal((await requestMember({ identity: B, addresses: at(), expectMemberId: null, method: "GET", path: "/v1/echo" })).status, 405);
	assert.equal((await rawRequest({ port: server.port, path: "/v1/echo", body: "{bad", identity: B })).status, 400);
});

test("body of bodyLimitBytes + 1 gets 413", async () => {
	assert.equal((await rawRequest({ port: server.port, path: "/v1/echo", body: "x".repeat(1025), identity: B })).status, 413);
});

test("11th open request within a minute from one IP gets 429", async () => {
	const statuses = [];
	for (let i = 0; i < 11; i++) statuses.push((await requestMember({ identity: null, addresses: at(), expectMemberId: null, method: "POST", path: "/v1/echo", body: { i } })).status);
	// earlier tests in this file already spent some of the budget on 127.0.0.1
	assert.equal(statuses.at(-1), 429);
	assert.ok(statuses.includes(429));
});

test("local route rejects a non-loopback source with 403", async (t) => {
	const lan = localAddresses(server.port)[0];
	if (!lan) return t.skip("no non-loopback IPv4 on this machine");
	assert.equal((await requestMember({ identity: B, addresses: at(server.port, lan.host), expectMemberId: null, method: "GET", path: "/local/status" })).status, 403);
	assert.equal((await requestMember({ identity: B, addresses: at(), expectMemberId: null, method: "GET", path: "/local/status" })).status, 200);
});

test("client skips an unreachable first address and succeeds on the second", async () => {
	const closed = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
	const r = await requestMember({ identity: B, addresses: [{ host: "127.0.0.1", port: closed }, ...at()], expectMemberId: A.memberId, method: "POST", path: "/v1/ping", body: { n: 2 } });
	assert.equal(r.status, 200);
	assert.equal(r.address.port, server.port);
});

test("client throws when the server's memberId differs from expectMemberId", async () => {
	const before = seen.length;
	await assert.rejects(
		requestMember({ identity: B, addresses: at(), expectMemberId: X.memberId, method: "POST", path: "/v1/ping", body: { n: 3 } }),
		(err) => err instanceof UnreachableError && err.attempts[0].reason === "identity-mismatch",
	);
	assert.equal(seen.length, before, "the request body must not reach a server with the wrong identity");
});

test("a dead address costs at most timeoutMs", async () => {
	const sockets = [];
	const blackhole = net.createServer((s) => sockets.push(s)); // accepts TCP, never speaks TLS
	await new Promise((r) => blackhole.listen(0, "127.0.0.1", r));
	const started = Date.now();
	await assert.rejects(requestMember({ identity: B, addresses: [{ host: "127.0.0.1", port: blackhole.address().port }], expectMemberId: A.memberId, method: "POST", path: "/v1/ping", body: {}, timeoutMs: 3000 }), UnreachableError);
	assert.ok(Date.now() - started < 3500, `took ${Date.now() - started} ms`);
	for (const s of sockets) s.destroy();
	blackhole.close();
});

test("the default timeout tolerates a slow relayed path (answer after 3.5 s)", { timeout: 20_000 }, async () => {
	const slow = await startFleetServer({ identity: A, host: "127.0.0.1", port: 0, bodyLimitBytes: 1024, isMember: () => true, logger: quiet, routes: {
		"/v1/slow": { auth: "member", method: "POST", handler: async () => { await new Promise((r) => setTimeout(r, 3500)); return { status: 200, body: { ok: true } }; } },
	} });
	try {
		const r = await requestMember({ identity: B, addresses: at(slow.port), expectMemberId: A.memberId, method: "POST", path: "/v1/slow", body: {} });
		assert.equal(r.status, 200);
	} finally { await slow.close(); }
});

