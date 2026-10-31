import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { MedalCacheBucketLike } from './lib/medal-cache';
import { medalsGenerateRoute } from './routes/medals-generate';
import { tasksExtractRoute } from './routes/tasks-extract';

export interface CloudflareBindings {
  GEMINI_API_KEY?: string;
  ASSETS?: Fetcher;
  /** 生成済み記念メダル画像をキャッシュ保存・再利用する Cloudflare R2 バケット（オプショナル） */
  MEDAL_CACHE_BUCKET?: R2Bucket | MedalCacheBucketLike;
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
      ...(c.env?.MEDAL_CACHE_BUCKET ? { hasMedalCacheBucket: true as const } : {}),
    });
  })
  .route('/api/tasks', tasksExtractRoute)
  .route('/api/medals', medalsGenerateRoute);

export type AppType = typeof app;
export default app;
