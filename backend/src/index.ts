import Fastify from 'fastify';

import { config } from './lib/config.js';
import { sessionRoutes } from './routes/session.js';
import { webhookRoutes } from './routes/webhook.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Conversation content is sensitive by definition here — this product
    // exists because people are saying things they find hard to say. Never log
    // request bodies.
    redact: ['req.headers["x-vapi-secret"]', 'req.headers.authorization'],
  },
});

await app.register(webhookRoutes);
await app.register(sessionRoutes);

app.get('/health', async () => ({ ok: true }));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
