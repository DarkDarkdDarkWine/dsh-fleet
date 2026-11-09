import { test } from "node:test";
import assert from "node:assert/strict";
import { PIN_PATTERN, PinFormatError, PinGuard, checkPin, createVerifier } from "../lib/pin.js";

test("createVerifier/checkPin roundtrip; \"12345\", \"1234567\", \"12a456\" throw PinFormatError", async () => {
	const v = await createVerifier("123456");
	assert.match(v, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
	assert.equal(await checkPin(v, "123456"), true);
	assert.equal(await checkPin(v, "654321"), false);
	assert.notEqual(await createVerifier("123456"), v, "salted");
	for (const bad of ["12345", "1234567", "12a456"]) {
		await assert.rejects(createVerifier(bad), PinFormatError);
		await assert.rejects(checkPin(v, bad), PinFormatError);
	}
	assert.equal(PIN_PATTERN.test("000000"), true);
});

test("checkPin returns false for a malformed verifier", async () => {
	assert.equal(await checkPin("bcrypt$whatever", "123456"), false);
});

function guard(clock, store = { saved: {} }) {
	return { g: new PinGuard({ load: () => store.saved, save: (obj) => { store.saved = obj; }, now: () => clock.t }), store };
}

test("5 failures lock for 300000 ms; correct-PIN path still sees locked", () => {
	const clock = { t: 0 };
	const { g } = guard(clock);
	for (let i = 0; i < 4; i++) g.fail("join");
	assert.equal(g.status("join").locked, false);
	g.fail("join");
	assert.deepEqual(g.status("join"), { locked: true, retryAfterMs: 300000 });
	clock.t = 299999;
	assert.equal(g.status("join").locked, true, "a caller with the right PIN must still be refused");
	clock.t = 300000;
	assert.deepEqual(g.status("join"), { locked: false, retryAfterMs: 0 });
	assert.equal(g.status("critical").locked, false, "keys are independent");
});

test("next lock is 600000 ms; never exceeds 3600000 ms", () => {
	const clock = { t: 0 };
	const { g } = guard(clock);
	const lockOnce = () => { for (let i = 0; i < 5; i++) g.fail("k"); const s = g.status("k"); clock.t += s.retryAfterMs; return s.retryAfterMs; };
	assert.equal(lockOnce(), 300000);
	assert.equal(lockOnce(), 600000);
	assert.equal(lockOnce(), 1200000);
	assert.equal(lockOnce(), 2400000);
	assert.equal(lockOnce(), 3600000);
	assert.equal(lockOnce(), 3600000);
});

test("succeed resets the counter", () => {
	const clock = { t: 0 };
	const { g } = guard(clock);
	for (let i = 0; i < 4; i++) g.fail("k");
	g.succeed("k");
	for (let i = 0; i < 4; i++) g.fail("k");
	assert.equal(g.status("k").locked, false);
});

test("lock survives a new PinGuard over the same saved state", () => {
	const clock = { t: 1000 };
	const { g, store } = guard(clock);
	for (let i = 0; i < 5; i++) g.fail("join");
	const { g: g2 } = guard(clock, store);
	assert.deepEqual(g2.status("join"), { locked: true, retryAfterMs: 300000 });
});

test("failures while locked do not extend the lock", () => {
	const clock = { t: 0 };
	const { g } = guard(clock);
	for (let i = 0; i < 5; i++) g.fail("k");
	g.fail("k");
	assert.equal(g.status("k").retryAfterMs, 300000);
});
