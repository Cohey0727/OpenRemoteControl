/**
 * Phase 4 crypto round-trip: generate, sign, verify Ed25519.
 */

import { describe, expect, test } from 'bun:test';
import { fingerprint, generateKeypair, signNonce, verifyNonce } from '../src/hub/crypto.ts';

describe('hub/crypto', () => {
  test('generateKeypair returns base64 keys', () => {
    const kp = generateKeypair();
    expect(kp.publicKeyB64.length).toBeGreaterThan(20);
    expect(kp.privateKeyB64.length).toBeGreaterThan(20);
    expect(kp.publicKeyB64).not.toBe(kp.privateKeyB64);
  });

  test('signNonce + verifyNonce round trip', () => {
    const kp = generateKeypair();
    const nonce = 'hello-world-nonce';
    const sig = signNonce(nonce, kp.privateKeyB64);
    expect(sig.length).toBeGreaterThan(20);
    expect(verifyNonce(nonce, sig, kp.publicKeyB64)).toBe(true);
  });

  test('verifyNonce rejects a tampered nonce', () => {
    const kp = generateKeypair();
    const sig = signNonce('original', kp.privateKeyB64);
    expect(verifyNonce('tampered', sig, kp.publicKeyB64)).toBe(false);
  });

  test('verifyNonce rejects a forged signature', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const sig = signNonce('hello', a.privateKeyB64);
    expect(verifyNonce('hello', sig, b.publicKeyB64)).toBe(false);
  });

  test('fingerprint is deterministic and short', () => {
    const kp = generateKeypair();
    const fp1 = fingerprint(kp.publicKeyB64);
    const fp2 = fingerprint(kp.publicKeyB64);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBeLessThanOrEqual(16);
  });
});
