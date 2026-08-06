import { buildApp } from '../src/app.js';
import type { Config } from '../src/lib/config.js';
import { MemoryStore } from '../src/lib/store.js';

export const SECRET = 'test-secret';
export const CALL_ID = 'call_test_123';
export const CONTROL_URL = 'https://control.vapi.test/call_test_123';

export const testConfig: Config = {
  vapi: {
    apiKey: 'test-key',
    webhookSecret: SECRET,
    phoneNumber: '+15551234567',
    phoneNumberId: 'test-phone-id',
    baseUrl: 'https://api.vapi.test',
    webhookUrl: 'https://example.test/vapi/webhook',
  },
};

export function makeApp(store: MemoryStore) {
  return buildApp({ store, config: testConfig });
}

/** Env bindings are unused when store and config are injected. */
export const NO_ENV = {} as never;
