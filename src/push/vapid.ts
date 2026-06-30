/**
 * VAPID key management + push-send wrapper.
 *
 * We persist a single VAPID keypair per serve instance. If the file is
 * missing, we generate one on startup so the same subscription can be
 * reused across restarts (changing keys invalidates all subscriptions).
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import webpush from 'web-push';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** Where the keys were loaded from (for diagnostics). */
  source: 'disk' | 'generated';
}

export async function loadOrCreateVapidKeys(path: string): Promise<VapidKeys> {
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed = JSON.parse(await file.text()) as {
        publicKey?: string;
        privateKey?: string;
      };
      if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          source: 'disk',
        };
      }
    } catch {
      // fall through and regenerate
    }
  }
  const generated = webpush.generateVAPIDKeys();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(generated));
  return {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    source: 'generated',
  };
}

/**
 * Configure the underlying web-push library with our VAPID details.
 * Idempotent.
 */
let configured = false;
export function configureWebPush(keys: VapidKeys, subject: string): void {
  if (configured) return;
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  configured = true;
}

export { webpush };
