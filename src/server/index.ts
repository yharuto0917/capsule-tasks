import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface CloudflareBindings {
  GEMINI_API_KEY?: string;
  ASSETS?: Fetcher;
}

const app = new Hono<{ Bindings: CloudflareBindings }>()
  .use('/api/*', cors())
  .get('/api/health', (c) => {
    return c.json({
      status: 'ok' as const,
      service: 'capsule-tasks-api',
      models: {
        taskExtraction: 'gemini-3.8-flash',
        medalGeneration: 'gemini-nano-banana-2.1',
      },
      hasApiKey: Boolean(c.env?.GEMINI_API_KEY),
    });
  });

export type AppType = typeof app;
export default app;
