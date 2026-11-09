import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { join } from "node:path";
import { StoreCorruptError, readJson, writeJsonAtomic } from "./store.js";

/**
 * Device identity: one ECDSA P-256 key used both to sign roster events and as
 * the TLS key (Ed25519 TLS fails on DSH Desktop's BoringSSL — findings §2).
 * @typedef {{ memberId: string, publicKeyPem: string, privateKey: import("node:crypto").KeyObject, keyPem: string, certPem: string }} Identity
 */

const CURVE = "prime256v1";
const CERT_YEARS = 20;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

/** @param {import("node:crypto").KeyObject} publicKey */
const idOfKey = (publicKey) => createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 32);

/**
 * Member id = first 32 hex chars of sha256(SPKI DER).
 * @param {string} publicKeyPem
 * @returns {string}
 */
export function memberIdOf(publicKeyPem) {
	return idOfKey(createPublicKey(publicKeyPem));
}

/**
 * Member id of the key in a peer certificate (TLS `getPeerCertificate()` or X509Certificate).
 * @param {{ raw?: Buffer } | null | undefined} cert
 * @returns {string | null}
 */
export function memberIdFromCert(cert) {
	if (!cert?.raw?.length) return null;
	try {
		return idOfKey(new X509Certificate(cert.raw).publicKey);
	} catch {
		return null;
	}
}

/** @param {Identity} identity @param {Buffer} bytes @returns {string} base64 DER ECDSA signature */
export function signBytes(identity, bytes) {
	return sign("sha256", bytes, identity.privateKey).toString("base64");
}

/** @param {string} publicKeyPem @param {Buffer} bytes @param {string} sig @returns {boolean} */
export function verifyBytes(publicKeyPem, bytes, sig) {
	try {
		const key = createPublicKey(publicKeyPem);
		if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== CURVE) return false;
		return verify("sha256", bytes, key, Buffer.from(sig, "base64"));
	} catch {
		return false;
	}
}

/** Self-signed X.509 for the key; CN = memberId. */
async function makeCert(privateKey, publicKey, memberId) {
	await import("reflect-metadata"); // must load before @peculiar/x509 (tsyringe)
	const x509 = await import("@peculiar/x509");
	const subtle = globalThis.crypto.subtle;
	x509.cryptoProvider.set(globalThis.crypto);
	const keys = {
		privateKey: await subtle.importKey("pkcs8", privateKey.export({ type: "pkcs8", format: "der" }), ECDSA, true, ["sign"]),
		publicKey: await subtle.importKey("spki", publicKey.export({ type: "spki", format: "der" }), ECDSA, true, ["verify"]),
	};
	const now = Date.now();
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: randomBytes(8).toString("hex"),
		name: `CN=${memberId}`,
		notBefore: new Date(now - 24 * 3600e3),
		notAfter: new Date(now + CERT_YEARS * 365 * 24 * 3600e3),
		keys,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
	});
	return cert.toString("pem");
}

/** @param {string} keyPem @param {string} certPem @returns {Identity} */
function toIdentity(keyPem, certPem) {
	const privateKey = createPrivateKey(keyPem);
	const publicKey = createPublicKey(privateKey);
	return { memberId: idOfKey(publicKey), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKey, keyPem, certPem };
}

/** A stored identity must hold a P-256 key and a cert for that same key; anything else is corrupt. */
function storedIdentity(path, stored) {
	try {
		const id = toIdentity(stored.keyPem, stored.certPem);
		const certKey = new X509Certificate(stored.certPem).publicKey.export({ type: "spki", format: "pem" });
		if (certKey !== id.publicKeyPem || id.privateKey.asymmetricKeyDetails?.namedCurve !== CURVE) throw new Error("cert does not match key");
		return id;
	} catch (err) {
		throw new StoreCorruptError(path, err);
	}
}

/**
 * A throwaway identity that is never written to disk (used for the control
 * listener's TLS cert when identity.json is corrupt).
 * @returns {Promise<Identity>}
 */
export async function createEphemeralIdentity() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
	const certPem = await makeCert(privateKey, publicKey, idOfKey(publicKey));
	return toIdentity(privateKey.export({ type: "pkcs8", format: "pem" }), certPem);
}

/**
 * Load identity.json, creating a new P-256 identity on first start (or when regenerating).
 * A corrupt file throws StoreCorruptError and is never rebuilt.
 * @param {string} dataDir
 * @param {{ regenerate?: boolean }} [opts]
 * @returns {Promise<Identity>}
 */
export async function loadOrCreateIdentity(dataDir, opts = {}) {
	const path = join(dataDir, "identity.json");
	const stored = opts.regenerate ? undefined : readJson(path, undefined);
	if (stored !== undefined) return storedIdentity(path, stored ?? {});
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
	const certPem = await makeCert(privateKey, publicKey, idOfKey(publicKey));
	const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
	writeJsonAtomic(path, { v: 1, keyPem, certPem }, { secret: true });
	return toIdentity(keyPem, certPem);
}
