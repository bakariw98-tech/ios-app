/**
 * Runtime config.
 *
 * On Workers there is no `process.env` — bindings arrive per-request in `env`.
 * So config is built from that, not read from module scope, and validation
 * happens on the first request rather than at boot.
 */

export interface Env {
  VAPI_API_KEY: string;
  VAPI_WEBHOOK_SECRET: string;
  VAPI_PHONE_NUMBER: string;
  VAPI_PHONE_NUMBER_ID: string;
  PUBLIC_SERVER_URL: string;
  VAPI_BASE_URL?: string;
  DB: D1Database;
}

export interface Config {
  vapi: {
    apiKey: string;
    webhookSecret: string;
    phoneNumber: string;
    phoneNumberId: string;
    baseUrl: string;
  };
  serverUrl: string;
  webhookUrl: string;
}

const REQUIRED = [
  'VAPI_API_KEY',
  'VAPI_WEBHOOK_SECRET',
  'VAPI_PHONE_NUMBER',
  'VAPI_PHONE_NUMBER_ID',
  'PUBLIC_SERVER_URL',
] as const;

export function buildConfig(env: Env): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. ` +
        'Set them with `wrangler secret put <NAME>` or in the Cloudflare ' +
        'dashboard under Workers → Settings → Variables.',
    );
  }

  const serverUrl = env.PUBLIC_SERVER_URL.replace(/\/+$/, '');

  return {
    vapi: {
      apiKey: env.VAPI_API_KEY,
      webhookSecret: env.VAPI_WEBHOOK_SECRET,
      phoneNumber: env.VAPI_PHONE_NUMBER,
      phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
      baseUrl: env.VAPI_BASE_URL ?? 'https://api.vapi.ai',
    },
    serverUrl,
    webhookUrl: `${serverUrl}/vapi/webhook`,
  };
}
