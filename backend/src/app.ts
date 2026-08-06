import { Hono } from 'hono';

import { type Config, type Env, buildConfig } from './lib/config.js';
import { D1Store, type Store } from './lib/store.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerWebhookRoutes } from './routes/webhook.js';

export interface AppBindings {
  Bindings: Env;
  Variables: {
    config: Config;
    store: Store;
  };
}

export interface AppOptions {
  /** Injected by tests. Production builds a D1Store from the request bindings. */
  store?: Store;
  config?: Config;
}

export function buildApp(options: AppOptions = {}) {
  const app = new Hono<AppBindings>();

  // Config and store are per-request on Workers: bindings arrive in `env`, not
  // module scope. Tests inject both and never touch D1.
  app.use('*', async (c, next) => {
    try {
      c.set('config', options.config ?? buildConfig(c.env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Configuration error:', error);

      // Safe to return, not just log: buildConfig's messages name only which
      // secret is missing or malformed, never the value — that guarantee is
      // asserted in test/config.test.ts ("never echoes the secret value
      // itself"). The secret *names* are already public (wrangler.toml and
      // docs/SETUP.md are committed), so nothing here is new information to
      // an attacker. What it removes is a round trip through dashboard log
      // tailing every time setup goes wrong.
      return c.json({ error: 'server misconfigured', detail: message }, 500);
    }
    c.set('store', options.store ?? new D1Store(c.env.DB));
    await next();
  });

  registerWebhookRoutes(app);
  registerSessionRoutes(app);

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
