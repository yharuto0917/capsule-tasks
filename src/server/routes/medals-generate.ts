import { Hono } from 'hono';
import {
  isValidMedalRarity,
  type MedalGenerateRequestPayload,
  type MedalGenerateResponse,
  type MedalItem,
  type MedalRarity,
} from '../../shared/schemas';
import type { CloudflareBindings } from '../index';
import { createGeminiClient, MissingGeminiApiKeyError } from '../lib/gemini-client';
import { getMedalFrameReference, getThinkingLevelForRarity } from '../lib/medal-frames';
import { stripDataUrlPrefix } from './tasks-extract';

export const MEDAL_GENERATION_MODEL = 'gemini-nano-banana-2.1' as const;

export type MedalGenerateRequestBody = MedalGenerateRequestPayload;

export const MEDAL_GENERATION_SYSTEM_INSTRUCTION = [
  'You are the master medal artisan for the capsule-toy game app "Capsule Tasks".',
  'Using the provided reference frame image (Multi-image fusion), render a single 1:1 square commemorative medal icon.',
  'Maintain consistent border proportions and collection aesthetics with the reference frame while sculpting a vivid 3D central relief symbolizing the completed task.',
  'Render the requested uppercase engravedText clearly and legibly along the rim using enhanced text rendering.',
].join('\n');

const STAMP_ENGRAVED_FALLBACKS: Array<{ keyword: string; engraved: string }> = [
  { keyword: '企画書', engraved: 'DRAFT CONQUEROR' },
  { keyword: '洗濯', engraved: 'LAUNDRY MASTER' },
  { keyword: '領収書', engraved: 'RECEIPT HUNTER' },
  { keyword: '経費', engraved: 'RECEIPT HUNTER' },
  { keyword: '掃除', engraved: 'CLEAN SWEEPER' },
  { keyword: '買', engraved: 'SHOPPING HERO' },
  { keyword: '返信', engraved: 'QUICK RESPONDER' },
  { keyword: 'メール', engraved: 'INBOX ZERO' },
  { keyword: 'ゴミ', engraved: 'MORNING CLEANER' },
  { keyword: '勉強', engraved: 'KNOWLEDGE SEEKER' },
  { keyword: '読書', engraved: 'PAGE TURNER' },
  { keyword: '運動', engraved: 'ACTIVE STRIKER' },
  { keyword: '皿洗', engraved: 'DISHWASHER PRO' },
];

const RARITY_DEFAULT_ENGRAVED: Record<MedalRarity, string> = {
  N: 'TASK FINISHER',
  R: 'SILVER STRIKER',
  SR: 'GOLD CONQUEROR',
  SSR: 'GRAND CHAMPION',
};

const RARITY_MEDAL_SUFFIX_JA: Record<MedalRarity, string> = {
  N: '達成のブロンズメダル',
  R: '攻略のシルバーメダル',
  SR: '制覇の黄金勲章',
  SSR: '討伐の虹彩ホログラム勲章',
};

/**
 * 刻印テキスト（engravedText）を決定・正規化する（FR-14）
 * 1. リクエストで明示指定されていれば大文字化して採用
 * 2. medalPrompt 内に `engraved text 'XXXX'` が含まれていれば抽出
 * 3. タスク名のキーワードまたはレア度に応じた英語称号へフォールバック
 */
export function resolveEngravedText(
  explicitEngravedText?: string,
  medalPrompt?: string,
  taskTitle?: string,
  rarity: MedalRarity = 'N',
): string {
  if (typeof explicitEngravedText === 'string' && explicitEngravedText.trim().length > 0) {
    return (
      explicitEngravedText
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9 !&'-]/g, '')
        .trim()
        .slice(0, 24) || RARITY_DEFAULT_ENGRAVED[rarity]
    );
  }

  if (typeof medalPrompt === 'string' && medalPrompt.trim().length > 0) {
    const match = /engraved text\s+['"]([^'"]+)['"]/i.exec(medalPrompt);
    if (match && match[1]?.trim()) {
      return match[1].trim().toUpperCase().slice(0, 24);
    }
  }

  if (typeof taskTitle === 'string' && taskTitle.trim().length > 0) {
    for (const entry of STAMP_ENGRAVED_FALLBACKS) {
      if (taskTitle.includes(entry.keyword)) {
        return entry.engraved;
      }
    }
  }

  return RARITY_DEFAULT_ENGRAVED[rarity];
}

/**
 * メダル日本語名称（medalName）を決定する
 */
export function resolveMedalName(
  explicitMedalName?: string,
  taskTitle?: string,
  rarity: MedalRarity = 'N',
): string {
  if (typeof explicitMedalName === 'string' && explicitMedalName.trim().length > 0) {
    return explicitMedalName.trim();
  }
  const cleanTitle =
    typeof taskTitle === 'string' && taskTitle.trim().length > 0
      ? taskTitle.trim().slice(0, 18)
      : 'カプセルタスク';
  return `「${cleanTitle}」${RARITY_MEDAL_SUFFIX_JA[rarity]}`;
}

/**
 * `gemini-nano-banana-2.1` へ渡す最終プロンプトを構築する（FR-13, FR-14）
 */
export function buildMedalGenerationPrompt(params: {
  medalPrompt: string;
  engravedText: string;
  taskTitle: string;
  rarity: MedalRarity;
}): string {
  const frameRef = getMedalFrameReference(params.rarity);
  const basePrompt =
    params.medalPrompt.trim().length > 0
      ? params.medalPrompt.trim()
      : `A 3D metallic commemorative medal celebrating the completion of "${params.taskTitle}"`;

  return [
    `Reference Frame Tier: [${params.rarity}] ${frameRef.frameNameEn}.`,
    `Frame & Material Specification: ${frameRef.frameStylePrompt}`,
    `Central Relief & Subject: ${basePrompt}`,
    `Engraved Rim Text (CRITICAL): Engrave the exact uppercase text "${params.engravedText}" clearly along the medal rim.`,
    'Composition: Centered 1:1 square commemorative medal icon, studio rim lighting, sharp metallic relief details.',
  ].join('\n');
}

function createMedalId(rarity: MedalRarity, nowMs: number = Date.now()): string {
  const randomSuffix =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 8);
  return `medal_${rarity.toLowerCase()}_${nowMs}_${randomSuffix}`;
}

function parseImagePart(part: unknown): {
  imageBase64: string;
  mimeType: string;
  imageDataUrl: string;
} | null {
  if (typeof part !== 'object' || part === null) return null;
  const record = part as Record<string, unknown>;
  if (record.type !== 'image') return null;

  const rawData = typeof record.data === 'string' ? record.data.trim() : '';
  const rawMimeType =
    typeof record.mime_type === 'string' && record.mime_type.trim().startsWith('image/')
      ? record.mime_type.trim()
      : 'image/jpeg';

  if (rawData.length > 0) {
    let detectedMime = rawMimeType;
    if (rawData.startsWith('data:image/')) {
      const mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/i.exec(rawData);
      if (mimeMatch && mimeMatch[1]) {
        detectedMime = mimeMatch[1].toLowerCase();
      }
    }
    const cleanBase64 = stripDataUrlPrefix(rawData);
    if (!cleanBase64) return null;
    return {
      imageBase64: cleanBase64,
      mimeType: detectedMime,
      imageDataUrl: `data:${detectedMime};base64,${cleanBase64}`,
    };
  }

  return null;
}

/**
 * Interactions API のレスポンスから生成された画像データを抽出する
 * - `interaction.output_image`（`@google/genai` SDK 正規化プロパティ）
 * - `interaction.steps`（`model_output` ステップ内の `type: "image"` パート）
 * - `interaction.outputs`（互換フォールバック）
 */
export function extractGeneratedImageFromInteraction(interaction: unknown): {
  imageBase64: string;
  mimeType: string;
  imageDataUrl: string;
} | null {
  if (typeof interaction !== 'object' || interaction === null) {
    return null;
  }
  const record = interaction as Record<string, unknown>;

  if (record.output_image) {
    const parsedOutputImage = parseImagePart(record.output_image);
    if (parsedOutputImage) {
      return parsedOutputImage;
    }
  }

  if (Array.isArray(record.steps)) {
    for (let i = record.steps.length - 1; i >= 0; i--) {
      const step = record.steps[i];
      if (typeof step !== 'object' || step === null) continue;
      const stepRecord = step as Record<string, unknown>;
      if (stepRecord.type === 'model_output' && Array.isArray(stepRecord.content)) {
        for (let j = stepRecord.content.length - 1; j >= 0; j--) {
          const parsedPart = parseImagePart(stepRecord.content[j]);
          if (parsedPart) {
            return parsedPart;
          }
        }
      }
    }
  }

  if (Array.isArray(record.outputs)) {
    for (let i = record.outputs.length - 1; i >= 0; i--) {
      const parsedOutput = parseImagePart(record.outputs[i]);
      if (parsedOutput) {
        return parsedOutput;
      }
    }
  }

  return null;
}

export const medalsGenerateRoute = new Hono<{ Bindings: CloudflareBindings }>().post(
  '/generate',
  async (c) => {
    let body: MedalGenerateRequestBody;
    try {
      body = await c.req.json<MedalGenerateRequestBody>();
    } catch {
      return c.json({ error: 'リクエストボディのJSON形式が不正です。' }, 400);
    }

    if (body?.rarity !== undefined && !isValidMedalRarity(body.rarity)) {
      return c.json(
        { error: 'レア度（rarity）には N / R / SR / SSR のいずれかを指定してください。' },
        400,
      );
    }

    const rarity: MedalRarity = isValidMedalRarity(body?.rarity) ? body.rarity : 'N';
    const rawTaskTitle =
      typeof body?.taskTitle === 'string' && body.taskTitle.trim().length > 0
        ? body.taskTitle.trim()
        : typeof body?.title === 'string' && body.title.trim().length > 0
          ? body.title.trim()
          : '';
    const rawMedalPrompt = typeof body?.medalPrompt === 'string' ? body.medalPrompt.trim() : '';

    if (!rawTaskTitle && !rawMedalPrompt) {
      return c.json(
        { error: 'メダル生成には taskTitle または medalPrompt のいずれかが必須です。' },
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

    const resolvedTaskTitle = rawTaskTitle || 'カプセルタスク達成';
    const resolvedTaskId =
      typeof body?.taskId === 'string' && body.taskId.trim().length > 0
        ? body.taskId.trim()
        : `cap_${Date.now()}`;
    const engravedText = resolveEngravedText(
      body?.engravedText,
      rawMedalPrompt,
      resolvedTaskTitle,
      rarity,
    );
    const medalName = resolveMedalName(body?.medalName, resolvedTaskTitle, rarity);
    const frameRef = getMedalFrameReference(rarity);
    const thinkingLevel = getThinkingLevelForRarity(rarity);
    const composedPrompt = buildMedalGenerationPrompt({
      medalPrompt: rawMedalPrompt,
      engravedText,
      taskTitle: resolvedTaskTitle,
      rarity,
    });

    try {
      const interaction = await client.interactions.create({
        model: MEDAL_GENERATION_MODEL,
        system_instruction: MEDAL_GENERATION_SYSTEM_INSTRUCTION,
        generation_config: {
          thinking_level: thinkingLevel,
        },
        response_format: {
          type: 'image',
          mime_type: 'image/jpeg',
          aspect_ratio: '1:1',
          image_size: '1K',
        },
        input: [
          {
            type: 'image',
            data: frameRef.referenceImageBase64,
            mime_type: frameRef.mimeType,
          },
          {
            type: 'text',
            text: composedPrompt,
          },
        ],
      });

      const extractedImage = extractGeneratedImageFromInteraction(interaction);
      if (!extractedImage) {
        return c.json({ error: 'AIモデルから有効なメダル画像データが得られませんでした。' }, 502);
      }

      const nowMs = Date.now();
      const medalId = createMedalId(rarity, nowMs);
      const medal: MedalItem = {
        medalId,
        taskId: resolvedTaskId,
        taskTitle: resolvedTaskTitle,
        medalName,
        engravedText,
        rarity,
        imageBlobKey: `img_${medalId}`,
        modelUsed: MEDAL_GENERATION_MODEL,
        unlockedAt: new Date(nowMs).toISOString(),
        upgradeLevel: 0,
      };

      const responsePayload: MedalGenerateResponse = {
        medal,
        imageDataUrl: extractedImage.imageDataUrl,
        imageBase64: extractedImage.imageBase64,
        mimeType: extractedImage.mimeType,
        thinkingLevel,
        frameReference: {
          rarity: frameRef.rarity,
          frameId: frameRef.frameId,
          frameNameJa: frameRef.frameNameJa,
          frameNameEn: frameRef.frameNameEn,
        },
      };

      return c.json(responsePayload, 200);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? `メダル生成APIエラー: ${error.message}`
          : '記念メダル生成中に予期せぬエラーが発生しました。';
      return c.json({ error: message }, 502);
    }
  },
);
