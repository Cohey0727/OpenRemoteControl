// Minimal ambient declarations for `web-push`.
// We only use a few entry points so a hand-rolled module shim is small
// enough to be cleaner than pulling in @types/web-push.

declare module 'web-push' {
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export interface PushSubscriptionInput {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  export interface SendOptions {
    TTL?: number;
    contentEncoding?: 'aes128gcm' | 'aesgcm';
  }

  export function generateVAPIDKeys(): VapidKeys;

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  export function sendNotification(
    subscription: PushSubscriptionInput,
    payload: string,
    options?: SendOptions,
  ): Promise<string>;

  const _default: {
    generateVAPIDKeys: typeof generateVAPIDKeys;
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
  };
  export default _default;
}
