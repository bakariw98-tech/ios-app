import Fastify, { type FastifyInstance } from 'fastify';

import { sessionRoutes } from './routes/session.js';
import { webhookRoutes } from './routes/webhook.js';

export interface BuildOptions {
  /** Quiet in tests; the compliance logs are asserted directly instead. */
  logger?: boolean;
}

export async function buildApp(
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          // Conversation content is sensitive by definition here — this product
          // exists because people are saying things they find hard to say.
          // Never log request bodies.
          redact: [
            'req.headers["x-vapi-secret"]',
            'req.headers.authorization',
          ],
        },
  });

  await app.register(webhookRoutes);
  await app.register(sessionRoutes);

  app.get('/health', async () => ({ ok: true }));

  return app;
}
