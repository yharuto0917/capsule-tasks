import { GoogleGenAI } from '@google/genai';

export interface GeminiInteractionsClientLike {
  interactions: {
    create: GoogleGenAI['interactions']['create'];
  };
}

/**
 * Cloudflare Workers の環境変数 `GEMINI_API_KEY` が未設定の場合にスローされるエラー
 */
export class MissingGeminiApiKeyError extends Error {
  public readonly statusCode = 503;

  constructor(
    message = 'GEMINI_API_KEY が設定されていません。Cloudflare Workers の環境変数を確認してください。',
  ) {
    super(message);
    this.name = 'MissingGeminiApiKeyError';
  }
}

let customClientFactoryForTests: ((apiKey: string) => GeminiInteractionsClientLike) | null = null;

/**
 * 単体テスト用に Gemini クライアント生成ファクトリを差し替える（null で解除）
 */
export function setGeminiClientFactoryForTests(
  factory: ((apiKey: string) => GeminiInteractionsClientLike) | null,
): void {
  customClientFactoryForTests = factory;
}

/**
 * Cloudflare Workers の `c.env.GEMINI_API_KEY` を用いて `@google/genai` クライアントを初期化する。
 * キーが未設定または空文字の場合は `MissingGeminiApiKeyError` をスローする。
 */
export function createGeminiClient(apiKey?: string): GeminiInteractionsClientLike {
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmedKey) {
    throw new MissingGeminiApiKeyError();
  }

  if (customClientFactoryForTests) {
    return customClientFactoryForTests(trimmedKey);
  }

  return new GoogleGenAI({ apiKey: trimmedKey });
}
