import type { MedalRarity } from '../../shared/schemas';

export const MEDAL_CACHE_KEY_VERSION = 'v1' as const;

export interface MedalCacheObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly httpMetadata?: {
    contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface MedalCachePutOptionsLike {
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
}

/**
 * Cloudflare Workers の `R2Bucket` と構造的に互換性を持つ最小インターフェース。
 * 本番・ステージングの `R2Bucket` を型キャストなしでそのまま受け入れつつ、
 * 単体テストでのインメモリ実装も容易にする。
 */
export interface MedalCacheBucketLike {
  get(key: string): Promise<MedalCacheObjectBodyLike | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: MedalCachePutOptionsLike,
  ): Promise<unknown>;
}

export interface MedalCacheKeyInput {
  model: string;
  rarity: MedalRarity;
  /** リクエストで明示指定されたタスク名（未指定・空文字の場合は rawMedalPrompt をキーに使用） */
  rawTaskTitle: string;
  /** リクエストで指定されたメダルプロンプト（rawTaskTitle が空の場合のフォールバックキー） */
  rawMedalPrompt: string;
  /** 正規化済みの刻印テキスト */
  engravedText: string;
}

export interface CachedMedalImageEntry {
  imageBase64: string;
  mimeType: string;
  imageDataUrl: string;
  modelUsed: string;
}

interface InFlightResolution {
  entry: CachedMedalImageEntry;
  fromR2Cache: boolean;
}

const MAX_METADATA_TASK_TITLE_CODE_POINTS = 36;
const MAX_METADATA_ENGRAVED_CODE_POINTS = 24;
const CANONICAL_SINGLE_PAD_PENULTIMATE = 'AEIMQUYcgkosw048';
const CANONICAL_DOUBLE_PAD_ANTEPENULTIMATE = 'AQgw';

/**
 * Cloudflare Workers の同一 isolate 内で `c.env.MEDAL_CACHE_BUCKET` のラッパー参照が
 * リクエストごとに異なっても確実に同時リクエストを合流（Single-Flight）できるよう、
 * オブジェクトキー単位で処理中 Promise を管理する。
 */
const inFlightByObjectKey = new Map<string, Promise<InFlightResolution>>();

export function resetMedalCacheInFlightForTests(): void {
  inFlightByObjectKey.clear();
}

/**
 * タスク名やプロンプトの表記揺れ（全角英数・連続空白・前後空白・大文字小文字）を正規化する純粋関数
 */
export function normalizeCacheTextSegment(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * キャッシュ判定用の正規化シード文字列を構築する。
 * - `rawTaskTitle` がある場合: `レア度 + 正規化タスク名 + 刻印テキスト` で同一性を判定し、
 *   AIタスク抽出時の英語プロンプト表現の微妙な揺れに左右されず再利用できるようにする。
 * - `rawTaskTitle` が空の場合: `レア度 + 正規化プロンプト + 刻印テキスト` で判定する。
 * - 区切り文字（`|` 等）の混入による衝突を防ぐため `JSON.stringify` で構造化シリアライズする。
 */
export function buildMedalCacheSeed(input: MedalCacheKeyInput): string {
  const normalizedModel = normalizeCacheTextSegment(input.model);
  const normalizedEngraved = normalizeCacheTextSegment(input.engravedText);
  const normalizedTitle = normalizeCacheTextSegment(input.rawTaskTitle);

  const subjectSegment =
    normalizedTitle.length > 0
      ? `title:${normalizedTitle}`
      : `prompt:${normalizeCacheTextSegment(input.rawMedalPrompt)}`;

  return JSON.stringify([
    MEDAL_CACHE_KEY_VERSION,
    normalizedModel,
    input.rarity,
    subjectSegment,
    `engraved:${normalizedEngraved}`,
  ]);
}

async function computeSha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digestBuffer);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * R2 バケット上のオブジェクトキー（`medals/v1/{rarity}/{sha256Hex}`）を生成する
 */
export async function buildMedalCacheObjectKey(input: MedalCacheKeyInput): Promise<string> {
  const seed = buildMedalCacheSeed(input);
  const hashHex = await computeSha256Hex(seed);
  return `medals/${MEDAL_CACHE_KEY_VERSION}/${input.rarity}/${hashHex}`;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(cleaned, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = globalThis.atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return globalThis.btoa(chunks.join(''));
}

/**
 * 巨大画像の二重デコード・再エンコード比較を行わず O(1) 追加メモリで
 * 標準 Base64 バイナリとして欠損なくデコード・再構築可能かを判定する。
 * 事前に空白（RFC 2045 の改行コード等）を除去済みの文字列を受け取る。
 */
function isCanonicalCleanedBase64(cleaned: string): boolean {
  const len = cleaned.length;
  if (len === 0 || len % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return false;
  }
  if (cleaned.endsWith('==')) {
    return CANONICAL_DOUBLE_PAD_ANTEPENULTIMATE.includes(cleaned[len - 3] ?? '');
  }
  if (cleaned.endsWith('=')) {
    return CANONICAL_SINGLE_PAD_PENULTIMATE.includes(cleaned[len - 2] ?? '');
  }
  return true;
}

/**
 * サロゲートペア（絵文字等）の途中分断や孤立サロゲートによる `encodeURIComponent` の `URIError` を防ぎ、
 * Cloudflare R2 の `customMetadata` サイズ上限（合計 2,048 bytes）内に収まるよう安全にエンコードする。
 */
export function encodeSafeMetadataText(
  text: string,
  maxCodePoints: number = MAX_METADATA_TASK_TITLE_CODE_POINTS,
): string {
  const truncated = Array.from(text).slice(0, maxCodePoints).join('');
  const wellFormed = truncated.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
  return encodeURIComponent(wellFormed);
}

function normalizeImageMimeType(candidate?: string): string {
  if (typeof candidate === 'string' && candidate.trim().startsWith('image/')) {
    return candidate.trim().toLowerCase();
  }
  return 'image/jpeg';
}

/**
 * R2 バケットから生成済みメダル画像を取得する。
 * バケット未設定時・キャッシュ未存在時・R2 読み取りエラー時は `null` を返し、生成フローへフォールバックさせる。
 */
export async function getCachedMedalImage(
  bucket: MedalCacheBucketLike | undefined,
  objectKey: string,
): Promise<CachedMedalImageEntry | null> {
  if (!bucket) {
    return null;
  }

  try {
    const object = await bucket.get(objectKey);
    if (!object) {
      return null;
    }

    const buffer = await object.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength === 0) {
      return null;
    }

    const encoding = object.customMetadata?.encoding ?? 'binary';
    const imageBase64 =
      encoding === 'base64-text' ? new TextDecoder().decode(bytes) : uint8ArrayToBase64(bytes);

    if (!imageBase64) {
      return null;
    }

    const mimeType = normalizeImageMimeType(
      object.httpMetadata?.contentType ?? object.customMetadata?.mimeType,
    );
    const modelUsed =
      typeof object.customMetadata?.modelUsed === 'string' &&
      object.customMetadata.modelUsed.trim().length > 0
        ? object.customMetadata.modelUsed.trim()
        : 'gemini-nano-banana-2.1';

    return {
      imageBase64,
      mimeType,
      imageDataUrl: `data:${mimeType};base64,${imageBase64}`,
      modelUsed,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[medal-cache] R2 キャッシュ読み取りに失敗したため新規生成へフォールバックします (key=${objectKey}): ${reason}`,
    );
    return null;
  }
}

/**
 * 新規生成されたメダル画像を R2 バケットへ保存する。
 * R2 書き込み失敗時もエラーログを残した上で例外はスローせず、生成済みレスポンスの返却を優先する。
 */
export async function putCachedMedalImage(
  bucket: MedalCacheBucketLike | undefined,
  objectKey: string,
  entry: CachedMedalImageEntry,
  metadata: {
    rarity: MedalRarity;
    engravedText: string;
    taskTitle: string;
  },
): Promise<boolean> {
  if (!bucket) {
    return false;
  }

  try {
    const cleanedBase64 = entry.imageBase64.replace(/\s+/g, '');
    const useBinary = isCanonicalCleanedBase64(cleanedBase64);
    const payloadBytes = useBinary
      ? base64ToUint8Array(cleanedBase64)
      : new TextEncoder().encode(entry.imageBase64);

    await bucket.put(objectKey, payloadBytes, {
      httpMetadata: {
        contentType: entry.mimeType,
      },
      customMetadata: {
        encoding: useBinary ? 'binary' : 'base64-text',
        mimeType: entry.mimeType,
        modelUsed: entry.modelUsed,
        rarity: metadata.rarity,
        engravedText: encodeSafeMetadataText(
          metadata.engravedText,
          MAX_METADATA_ENGRAVED_CODE_POINTS,
        ),
        taskTitle: encodeSafeMetadataText(metadata.taskTitle, MAX_METADATA_TASK_TITLE_CODE_POINTS),
        cachedAt: new Date().toISOString(),
      },
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[medal-cache] R2 キャッシュ書き込みに失敗しましたが生成結果は返却します (key=${objectKey}): ${reason}`,
    );
    return false;
  }
}

/**
 * R2 キャッシュの Read-Through および同一キー同時リクエストの完全合流（Single-Flight Coalescing）を行う。
 * - R2 読み取り前に `inFlightByObjectKey` を確認するため、同時到着時の冗長な R2 GET や二重生成の競合窓を排除する。
 * - R2 に既存エントリがある場合は `cached: true` で即座に返す。
 * - 既に処理中の同一キーリクエストがある場合はその完了を待って `cached: true` で再利用する。
 * - 未生成の場合は `generateFn` を実行して R2 に保存し、先行リクエストは `cached: false` で返す。
 */
export async function resolveOrGenerateMedalImage(params: {
  bucket: MedalCacheBucketLike | undefined;
  objectKey: string;
  metadata: {
    rarity: MedalRarity;
    engravedText: string;
    taskTitle: string;
  };
  generateFn: () => Promise<CachedMedalImageEntry>;
}): Promise<{ entry: CachedMedalImageEntry; cached: boolean }> {
  const { bucket, objectKey, metadata, generateFn } = params;

  if (!bucket) {
    const generated = await generateFn();
    return { entry: generated, cached: false };
  }

  const existingPromise = inFlightByObjectKey.get(objectKey);
  if (existingPromise) {
    const shared = await existingPromise;
    return { entry: shared.entry, cached: true };
  }

  const singleFlightPromise = (async (): Promise<InFlightResolution> => {
    const cachedEntry = await getCachedMedalImage(bucket, objectKey);
    if (cachedEntry) {
      return { entry: cachedEntry, fromR2Cache: true };
    }

    const generated = await generateFn();
    await putCachedMedalImage(bucket, objectKey, generated, metadata);
    return { entry: generated, fromR2Cache: false };
  })();

  inFlightByObjectKey.set(objectKey, singleFlightPromise);
  try {
    const resolved = await singleFlightPromise;
    return { entry: resolved.entry, cached: resolved.fromR2Cache };
  } finally {
    if (inFlightByObjectKey.get(objectKey) === singleFlightPromise) {
      inFlightByObjectKey.delete(objectKey);
    }
  }
}
