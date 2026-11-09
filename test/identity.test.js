import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, memberIdFromCert, memberIdOf, signBytes, verifyBytes } from "../lib/identity.js";
import { StoreCorruptError } from "../lib/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "fleet-id-"));

test("creates once and reloads the same memberId", async () => {
	const dir = tmp();
	const a = await loadOrCreateIdentity(dir);
	const b = await loadOrCreateIdentity(dir);
	assert.equal(b.memberId, a.memberId);
	assert.equal(b.certPem, a.certPem);
});

test("memberId is 32 lowercase hex chars and equals memberIdOf(publicKeyPem)", async () => {
	const id = await loadOrCreateIdentity(tmp());
	assert.match(id.memberId, /^[0-9a-f]{32}$/);
	assert.equal(memberIdOf(id.publicKeyPem), id.memberId);
});

test("memberIdFromCert(new X509Certificate(certPem)) === memberId", async () => {
	const id = await loadOrCreateIdentity(tmp());
	assert.equal(memberIdFromCert(new X509Certificate(id.certPem)), id.memberId);
	assert.equal(memberIdFromCert(null), null);
	assert.equal(memberIdFromCert({ raw: Buffer.alloc(0) }), null);
});

test("sign/verify roundtrip; verify fails for a flipped byte", async () => {
	const id = await loadOrCreateIdentity(tmp());
	const bytes = Buffer.from("roster event hash");
	const sig = signBytes(id, bytes);
	assert.equal(verifyBytes(id.publicKeyPem, bytes, sig), true);
	const flipped = Buffer.from(bytes);
	flipped[0] ^= 1;
	assert.equal(verifyBytes(id.publicKeyPem, flipped, sig), false);
	assert.equal(verifyBytes(id.publicKeyPem, bytes, "not-base64-sig"), false);
});

test("regenerate: true yields a different memberId", async () => {
	const dir = tmp();
	const a = await loadOrCreateIdentity(dir);
	const b = await loadOrCreateIdentity(dir, { regenerate: true });
	assert.notEqual(b.memberId, a.memberId);
	assert.equal((await loadOrCreateIdentity(dir)).memberId, b.memberId);
});

test("corrupt identity.json throws StoreCorruptError", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "identity.json"), "{oops");
	await assert.rejects(loadOrCreateIdentity(dir), StoreCorruptError);
});

test("key is EC prime256v1 and the cert's public key equals the identity key", async () => {
	const id = await loadOrCreateIdentity(tmp());
	const cert = new X509Certificate(id.certPem);
	assert.equal(cert.publicKey.asymmetricKeyType, "ec");
	assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
	assert.equal(cert.publicKey.export({ type: "spki", format: "pem" }), id.publicKeyPem);
	assert.equal(cert.subject, `CN=${id.memberId}`);
	assert.ok(cert.verify(cert.publicKey), "self-signed by the identity key");
});

test("verifyBytes returns false for an Ed25519 public key", () => {
	const { publicKey } = generateKeyPairSync("ed25519");
	const pem = publicKey.export({ type: "spki", format: "pem" });
	assert.equal(verifyBytes(pem, Buffer.from("x"), Buffer.alloc(64).toString("base64")), false);
});
