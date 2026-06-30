/**
 * Push notifier — delivers a notification payload to every subscription.
 *
 * Subscriptions that 404 or 410 are removed from the store.
 */

import type { PushStore, PushSubscriptionRecord } from './store.ts';
import { webpush } from './vapid.ts';

export interface NotifyOptions {
  title: string;
  body: string;
  /** Optional URL to focus when the notification is clicked. */
  url?: string;
  /** Restrict to subscribers for this session (null = any). */
  sessionId?: string;
  /** Time-to-live in seconds (0 = drop if device offline). */
  ttl?: number;
}

export interface NotifyResult {
  delivered: number;
  removed: number;
  errors: number;
}

interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export async function notify(store: PushStore, opts: NotifyOptions): Promise<NotifyResult> {
  const subs = store.listSubscriptions(
    opts.sessionId !== undefined ? { sessionId: opts.sessionId } : undefined,
  );
  const payload: PushPayload = {
    title: opts.title,
    body: opts.body,
    ...(opts.url ? { url: opts.url } : {}),
  };
  const json = JSON.stringify(payload);

  let delivered = 0;
  let removed = 0;
  let errors = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          json,
          {
            TTL: opts.ttl ?? 60,
            contentEncoding: 'aes128gcm',
          },
        );
        delivered++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          store.removeSubscriptionByEndpoint(sub.endpoint);
          removed++;
        } else {
          errors++;
        }
      }
    }),
  );

  return { delivered, removed, errors };
}

export type { PushSubscriptionRecord };
