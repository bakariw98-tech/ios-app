/**
 * Cloudflare Worker entry point.
 *
 * The app is built per-request rather than at module scope so that config
 * validation errors surface as a 500 with a useful message instead of killing
 * the isolate at startup.
 */

import { buildApp } from './app.js';
import type { Env } from './lib/config.js';
import { CallRelay } from './relay/CallRelay.js';

const app = buildApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};

// Durable Object classes must be exported from the main module for
// wrangler.toml's [[durable_objects.bindings]] to find them.
export { CallRelay };
