/**
 * Ed25519 device identity for hub mode.
 *
 * - `generateKeypair()` creates a new Ed25519 keypair (pub/priv raw bytes).
 * - `serialize/parsePublicKey` for storage as base64.
 * - `signNonce` returns a base64 signature over a UTF-8 message.
 *
 * Uses Node's `crypto` since Bun ships with the same APIs.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export interface DeviceKeypair {
  /** Raw 32-byte private key seed, encoded as base64. */
  readonly privateKeyB64: string;
  /** Raw 32-byte public key, encoded as base64. */
  readonly publicKeyB64: string;
}

export function generateKeypair(): DeviceKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' });
  // PKCS8 for Ed25519 is 48 bytes: 16-byte header + 32-byte seed.
  const seed = privRaw.subarray(privRaw.length - 32);
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' });
  // SPKI for Ed25519 is 44 bytes: 12-byte header + 32-byte public key.
  const pub = pubRaw.subarray(pubRaw.length - 32);
  return {
    privateKeyB64: Buffer.from(seed).toString('base64'),
    publicKeyB64: Buffer.from(pub).toString('base64'),
  };
}

/** Sign a UTF-8 message; returns base64 signature. */
export function signNonce(message: string, privateKeyB64: string): string {
  const seed = Buffer.from(privateKeyB64, 'base64');
  const privKey = createPrivateKey({
    key: Buffer.concat([pkcs8Ed25519Header(seed.length), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = sign(null, Buffer.from(message, 'utf8'), privKey);
  return sig.toString('base64');
}

/** Verify a base64 signature against a base64 public key. */
export function verifyNonce(message: string, signatureB64: string, publicKeyB64: string): boolean {
  const pub = Buffer.from(publicKeyB64, 'base64');
  const pubKey = createPublicKey({
    key: Buffer.concat([spkiEd25519Header(pub.length), pub]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, Buffer.from(message, 'utf8'), pubKey, Buffer.from(signatureB64, 'base64'));
}

/** Short, human-friendly fingerprint (first 8 bytes of SHA-256 of pubkey, hex). */
export function fingerprint(publicKeyB64: string): string {
  const pub = Buffer.from(publicKeyB64, 'base64');
  return createHash('sha256').update(pub).digest('hex').slice(0, 16);
}

/* ----- PKCS8 / SPKI header builders (RFC 8410) --------------------- */

function pkcs8Ed25519Header(seedLen: number): Buffer {
  // 48-byte PKCS8 prefix for Ed25519 (algorithm = -ED25519 = 1.3.101.112).
  // Hard-coded to keep this file dependency-free.
  // prettier-ignore
  const prefix = Buffer.from([
    0x30,
    0x2e, // SEQUENCE (46 bytes)
    0x02,
    0x01,
    0x00, // INTEGER 0 (version)
    0x30,
    0x05, // SEQUENCE (algorithm)
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70, // OID 1.3.101.112 (Ed25519)
    0x04,
    0x22, // OCTET STRING (34 bytes — 32 seed + 2 padding)
    0x04,
    0x20, // OCTET STRING (32 bytes — the seed itself)
  ]);
  if (seedLen !== 32) {
    throw new Error(`unexpected ed25519 seed length: ${seedLen}`);
  }
  return prefix;
}

function spkiEd25519Header(pubLen: number): Buffer {
  // 12-byte SPKI prefix for Ed25519.
  // prettier-ignore
  const prefix = Buffer.from([
    0x30,
    0x2a, // SEQUENCE (42 bytes)
    0x30,
    0x05, // SEQUENCE (algorithm)
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70, // OID 1.3.101.112
    0x03,
    0x21,
    0x00, // BIT STRING (33 bytes, 0 unused)
  ]);
  if (pubLen !== 32) {
    throw new Error(`unexpected ed25519 pubkey length: ${pubLen}`);
  }
  return prefix;
}
