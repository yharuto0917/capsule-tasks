import { hc, type ClientRequestOptions } from 'hono/client';
import type { AppType } from '../../server/index';
import type { TaskExtractionResponse } from '../../shared/schemas';

export interface TaskExtractRequestPayload {
  /** 雑な複数行テキストまたはボヤきテキスト */
  text?: string;
  /** MediaRecorder で録音した音声データの Base64 文字列 */
  audioBase64?: string;
  /** 音声の MIME タイプ（例: 'audio/webm', 'audio/mp4'） */
  mimeType?: string;
}

/**
 * Hono RPC (`hc<AppType>`) クライアントを生成する
 */
export function createApiClient(baseUrl = '/', options?: ClientRequestOptions) {
  return hc<AppType>(baseUrl, options);
}

/**
 * デフォルトの Hono RPC クライアントインスタンス
 */
export const apiClient = createApiClient('/');

/**
 * `POST /api/tasks/extract` を呼び出し、音声またはテキストから複数のカプセルタスクを抽出する
 */
export async function extractCapsuleTasks(
  payload: TaskExtractRequestPayload,
  customFetch?: typeof fetch,
): Promise<TaskExtractionResponse> {
  const client = customFetch ? createApiClient('/', { fetch: customFetch }) : apiClient;

  const response = await client.api.tasks.extract.$post({
    json: payload,
  });

  const data = (await response.json().catch(() => null)) as
    TaskExtractionResponse | { error?: string } | null;

  if (!response.ok) {
    const errorMessage =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `タスク抽出リクエストに失敗しました (HTTP ${response.status})`;
    throw new Error(errorMessage);
  }

  if (!data || !('tasks' in data) || !Array.isArray(data.tasks)) {
    throw new Error('サーバーから有効なタスク抽出結果が返されませんでした。');
  }

  return data;
}
