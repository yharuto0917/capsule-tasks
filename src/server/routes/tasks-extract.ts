import { Hono } from 'hono';
import {
  CAPSULE_COLOR_RARITY_BOOST,
  TASK_EXTRACTION_JSON_SCHEMA,
  isValidCapsuleColor,
  type CapsuleColor,
  type ExtractedCapsuleTaskDraft,
  type TaskExtractionResponse,
} from '../../shared/schemas';
import type { CloudflareBindings } from '../index';
import { createGeminiClient, MissingGeminiApiKeyError } from '../lib/gemini-client';

export const TASK_EXTRACTION_MODEL = 'gemini-3.8-flash' as const;

export interface TaskExtractRequestBody {
  /** 雑な複数行テキストまたはボヤきテキスト */
  text?: string;
  /** MediaRecorder で録音した音声の Base64 文字列（data URL プレフィックス有無どちらも可） */
  audioBase64?: string;
  /** audioBase64 の別名互換フィールド */
  audio?: string;
  /** 音声の MIME タイプ（例: 'audio/webm', 'audio/mp4'） */
  mimeType?: string;
  /** mimeType の別名互換フィールド */
  audioMimeType?: string;
}

export const TASK_EXTRACTION_SYSTEM_INSTRUCTION = [
  'あなたはカプセルトイ型タスク攻略アプリ『カプセルタスク』のAIアシスタントです。',
  'ユーザーの雑な音声ボヤきや複数行のテキストメモから、以下のルールに従って実行可能なタスク群（tasks）を抽出してください。',
  '1. フィラー除去: 「えーっと」「あー」「なんか」「とりあえず」「しなきゃな〜」などの話し言葉のフィラーや愚痴の前置きを取り除き、簡潔で具体的な日本語のタスク名（title）に整形すること。',
  '2. 複数タスクへの自動分割: 1つの発話や文章に複数の用事が含まれている場合は、必ず1つずつの独立した実行可能タスクに分割すること。',
  '3. カプセル色（負荷・難易度）とレア度倍率の自動判定 (FR-05):',
  '   - "blue" (rarityBoost: 1.0): 5〜15分程度で終わる軽作業・日常の家事・連絡（例: 牛乳を買う、メール返信、机を拭く）',
  '   - "red" (rarityBoost: 1.5): 15〜45分程度の中作業・少し腰を据える用事（例: 経費精算、部屋の掃除機がけ、資料確認）',
  '   - "gold" (rarityBoost: 2.0): 高負荷・重要・心理的ハードルが高い大玉タスク（例: 企画書ドラフト提出、重要プレゼン準備）',
  '4. 記念メダル生成用英語プロンプト (medalPrompt): タスク達成時に gemini-nano-banana-2.1 が3Dメタリックな記念メダル画像を生成するための英語プロンプトを作成すること。タスクを象徴する中央のレリーフモチーフと、リムに刻印する短い英語大文字タイトル（engravedText, 最大20文字）を含めること。',
].join('\n');

/**
 * 音声 MIME タイプから `;codecs=...` などのパラメータを除去して正規化する
 */
export function normalizeExtractAudioMimeType(rawMimeType?: string): string {
  if (typeof rawMimeType !== 'string' || rawMimeType.trim().length === 0) {
    return 'audio/webm';
  }
  const baseMime = rawMimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!baseMime.startsWith('audio/')) {
    return 'audio/webm';
  }
  return baseMime;
}

/**
 * Base64 文字列から `data:audio/...;base64,` プレフィックスを除去する
 */
export function stripDataUrlPrefix(rawBase64: string): string {
  const trimmed = rawBase64.trim();
  const commaIndex = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIndex !== -1) {
    return trimmed.slice(commaIndex + 1).trim();
  }
  return trimmed;
}

function buildFallbackMedalPrompt(
  title: string,
  color: CapsuleColor,
  engravedText?: string,
): string {
  const finishByColor: Record<CapsuleColor, string> = {
    blue: 'shining bronze and sky-blue enamel',
    red: 'polished silver and crimson enamel',
    gold: 'gleaming golden and holographic',
  };
  const rimText =
    engravedText && engravedText.trim().length > 0 ? engravedText.trim() : 'TASK MASTER';
  return `A ${finishByColor[color]} commemorative medal celebrating "${title}" in high relief, engraved text '${rimText}' along the rim, 3D metallic render, studio lighting`;
}

/**
 * Interactions API のレスポンスから JSON テキストを取り出す
 */
function extractJsonTextFromInteraction(interaction: unknown): string {
  if (typeof interaction !== 'object' || interaction === null) {
    return '';
  }
  const record = interaction as Record<string, unknown>;

  if (typeof record.output_text === 'string' && record.output_text.trim().length > 0) {
    return record.output_text.trim();
  }

  // steps 配列（ModelOutputStep）からの抽出フォールバック
  if (Array.isArray(record.steps)) {
    const texts: string[] = [];
    for (const step of record.steps) {
      if (typeof step !== 'object' || step === null) continue;
      const stepRecord = step as Record<string, unknown>;
      if (stepRecord.type === 'model_output' && Array.isArray(stepRecord.content)) {
        for (const part of stepRecord.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            (part as Record<string, unknown>).type === 'text' &&
            typeof (part as Record<string, unknown>).text === 'string'
          ) {
            texts.push((part as { text: string }).text);
          }
        }
      }
    }
    if (texts.length > 0) {
      return texts.join('\n').trim();
    }
  }

  // outputs 配列の互換フォールバック
  if (Array.isArray(record.outputs)) {
    const texts: string[] = [];
    for (const output of record.outputs) {
      if (
        typeof output === 'object' &&
        output !== null &&
        typeof (output as Record<string, unknown>).text === 'string'
      ) {
        texts.push((output as { text: string }).text);
      }
    }
    if (texts.length > 0) {
      return texts.join('\n').trim();
    }
  }

  return '';
}

function cleanJsonFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * AI出力のタスク配列を検証・正規化する
 */
export function normalizeExtractedTaskDrafts(rawTasks: unknown): ExtractedCapsuleTaskDraft[] {
  if (!Array.isArray(rawTasks)) {
    return [];
  }

  const normalized: ExtractedCapsuleTaskDraft[] = [];
  for (const item of rawTasks) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    if (!title) continue;

    const capsuleColor: CapsuleColor = isValidCapsuleColor(candidate.capsuleColor)
      ? candidate.capsuleColor
      : 'blue';
    const rarityBoost = CAPSULE_COLOR_RARITY_BOOST[capsuleColor];

    const engravedText =
      typeof candidate.engravedText === 'string' && candidate.engravedText.trim().length > 0
        ? candidate.engravedText.trim().toUpperCase().slice(0, 24)
        : undefined;

    const medalName =
      typeof candidate.medalName === 'string' && candidate.medalName.trim().length > 0
        ? candidate.medalName.trim()
        : undefined;

    const medalPrompt =
      typeof candidate.medalPrompt === 'string' && candidate.medalPrompt.trim().length > 0
        ? candidate.medalPrompt.trim()
        : buildFallbackMedalPrompt(title, capsuleColor, engravedText);

    normalized.push({
      title,
      capsuleColor,
      rarityBoost,
      medalPrompt,
      ...(engravedText ? { engravedText } : {}),
      ...(medalName ? { medalName } : {}),
    });
  }

  return normalized;
}

export const tasksExtractRoute = new Hono<{ Bindings: CloudflareBindings }>().post(
  '/extract',
  async (c) => {
    let body: TaskExtractRequestBody;
    try {
      body = await c.req.json<TaskExtractRequestBody>();
    } catch {
      return c.json({ error: 'リクエストボディのJSON形式が不正です。' }, 400);
    }

    const trimmedText = typeof body?.text === 'string' ? body.text.trim() : '';
    const rawAudio =
      typeof body?.audioBase64 === 'string' && body.audioBase64.trim().length > 0
        ? body.audioBase64
        : typeof body?.audio === 'string' && body.audio.trim().length > 0
          ? body.audio
          : '';
    const cleanAudioBase64 = rawAudio ? stripDataUrlPrefix(rawAudio) : '';
    const normalizedMimeType = normalizeExtractAudioMimeType(body?.mimeType ?? body?.audioMimeType);

    if (!trimmedText && !cleanAudioBase64) {
      return c.json(
        { error: 'テキストまたは音声データ（audioBase64）のいずれかを指定してください。' },
        400,
      );
    }

    let client;
    try {
      client = createGeminiClient(c.env?.GEMINI_API_KEY);
    } catch (error) {
      if (error instanceof MissingGeminiApiKeyError) {
        return c.json({ error: error.message }, error.statusCode);
      }
      return c.json({ error: 'Gemini クライアントの初期化に失敗しました。' }, 500);
    }

    const inputParts: Array<
      { type: 'audio'; data: string; mime_type: string } | { type: 'text'; text: string }
    > = [];

    if (cleanAudioBase64) {
      inputParts.push({
        type: 'audio',
        data: cleanAudioBase64,
        mime_type: normalizedMimeType,
      });
    }

    if (trimmedText) {
      inputParts.push({
        type: 'text',
        text: trimmedText,
      });
    } else {
      inputParts.push({
        type: 'text',
        text: 'この音声ボヤきからフィラーを除去し、実行可能な複数のカプセルタスクへ分割して抽出してください。',
      });
    }

    try {
      const interaction = await client.interactions.create({
        model: TASK_EXTRACTION_MODEL,
        system_instruction: TASK_EXTRACTION_SYSTEM_INSTRUCTION,
        generation_config: {
          thinking_level: 'low',
        },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: TASK_EXTRACTION_JSON_SCHEMA,
        },
        input: inputParts,
      });

      const rawJsonText = extractJsonTextFromInteraction(interaction);
      if (!rawJsonText) {
        return c.json({ error: 'AIモデルから有効な応答テキストが得られませんでした。' }, 502);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleanJsonFence(rawJsonText));
      } catch {
        return c.json({ error: 'AIモデルのJSON出力の解析に失敗しました。' }, 502);
      }

      const rawTasks =
        typeof parsed === 'object' && parsed !== null && 'tasks' in parsed
          ? (parsed as { tasks: unknown }).tasks
          : Array.isArray(parsed)
            ? parsed
            : [];

      const tasks = normalizeExtractedTaskDrafts(rawTasks);
      const responsePayload: TaskExtractionResponse = { tasks };

      return c.json(responsePayload, 200);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? `タスク抽出APIエラー: ${error.message}`
          : 'タスク抽出中に予期せぬエラーが発生しました。';
      return c.json({ error: message }, 502);
    }
  },
);
