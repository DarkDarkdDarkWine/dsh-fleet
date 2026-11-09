import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Fleet PIN: exactly six digits (spec §5.5). Never logged or stored in clear. */
export const PIN_PATTERN = /^\d{6}$/;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const LOCK_AFTER = 5;
const BASE_LOCK_MS = 5 * 60_000;
const MAX_LOCK_MS = 60 * 60_000;

export class PinFormatError extends Error {
	constructor() {
		super("PIN must be exactly 6 digits");
		this.name = "PinFormatError";
	}
}

/** @param {unknown} pin */
function assertFormat(pin) {
	if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) throw new PinFormatError();
}

const derive = (pin, salt, n, r, p) =>
	new Promise((resolve, reject) => scrypt(pin, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));

/**
 * @param {string} pin
 * @returns {Promise<string>} `scrypt$N$r$p$<salt b64>$<hash b64>`
 */
export async function createVerifier(pin) {
	assertFormat(pin);
	const salt = randomBytes(16);
	const hash = await derive(pin, salt, N, R, P);
	return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

/**
 * @param {string} verifier
 * @param {string} pin
 * @returns {Promise<boolean>}
 */
export async function checkPin(verifier, pin) {
	assertFormat(pin);
	const parts = String(verifier).split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [n, r, p] = parts.slice(1, 4).map(Number);
	const expected = Buffer.from(parts[5], "base64");
	if (![n, r, p].every(Number.isInteger) || expected.length !== KEYLEN) return false;
	const actual = await derive(pin, Buffer.from(parts[4], "base64"), n, r, p);
	return timingSafeEqual(actual, expected);
}

/**
 * Per-key PIN attempt lockout: 5 consecutive failures lock for 5 min, each
 * later lock doubles, capped at 60 min; success clears the key. State is
 * persisted through `save` on every change so it survives restarts.
 */
export class PinGuard {
	/** @param {{ load(): object, save(obj: object): void, now(): number }} io */
	constructor({ load, save, now }) {
		this.saveState = save;
		this.now = now;
		this.state = { ...(load() ?? {}) };
	}

	/** @param {string} key @returns {{ locked: boolean, retryAfterMs: number }} */
	status(key) {
		const left = (this.state[key]?.lockedUntil ?? 0) - this.now();
		return left > 0 ? { locked: true, retryAfterMs: left } : { locked: false, retryAfterMs: 0 };
	}

	/** @param {string} key */
	fail(key) {
		if (this.status(key).locked) return;
		const prev = this.state[key] ?? { fails: 0, locks: 0, lockedUntil: 0 };
		const fails = prev.fails + 1;
		const entry = fails < LOCK_AFTER
			? { ...prev, fails }
			: { fails: 0, locks: prev.locks + 1, lockedUntil: this.now() + Math.min(BASE_LOCK_MS * 2 ** prev.locks, MAX_LOCK_MS) };
		this.write({ ...this.state, [key]: entry });
	}

	/** @param {string} key */
	succeed(key) {
		if (!(key in this.state)) return;
		const { [key]: _gone, ...rest } = this.state;
		this.write(rest);
	}

	/** @param {object} next */
	write(next) {
		this.state = next;
		this.saveState(next);
	}
}
