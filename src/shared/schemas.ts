/**
 * フロントエンド（Vite + React）とバックエンド（Hono on Cloudflare Workers）で共有する
 * データモデル型定義、デフォルト初期値、および `gemini-3.8-flash` (Interactions API) 用の
 * Structured Outputs JSON Schema 定義。
 */

export type CapsuleColor = 'blue' | 'red' | 'gold';

export type CapsuleStatus = 'pending' | 'completed' | 'recycled';

export type MedalRarity = 'N' | 'R' | 'SR' | 'SSR';

/**
 * 7.1 カプセル（タスク）データ：`CapsuleTask`
 */
export interface CapsuleTask {
  id: string;
  title: string;
  capsuleColor: CapsuleColor;
  rarityBoost: number;
  medalPrompt: string;
  createdAt: string;
  skipCount: number;
  status: CapsuleStatus;
}

/**
 * 7.2 メダルコレクション図鑑データ：`MedalItem`（IndexedDB 保存形式）
 */
export interface MedalItem {
  medalId: string;
  taskId: string;
  taskTitle: string;
  medalName: string;
  engravedText: string;
  rarity: MedalRarity;
  imageBlobKey: string;
  modelUsed: string;
  unlockedAt: string;
  upgradeLevel: number;
}

/**
 * 7.3 プレイヤーステータス：`PlayerState`（localStorage 保存形式）
 */
export interface PlayerState {
  coins: number;
  totalCracked: number;
  todayCombo: number;
  customStamps: string[];
  soundEnabled: boolean;
  /**
   * 当日コンボ（todayCombo）の日付境界判定用（YYYY-MM-DD, ローカル日付）。
   * 1日サボってもコインやメダルに対するペナルティは一切なく、当日コンボ数のみ0から再スタートする（FR-16）。
   */
  lastActiveDate?: string;
}

/**
 * カプセル色ごとの標準レア度倍率（rarityBoost）
 */
export const CAPSULE_COLOR_RARITY_BOOST: Record<CapsuleColor, number> = {
  blue: 1.0,
  red: 1.5,
  gold: 2.0,
};

/**
 * 常連スタンプ（8種）の初期デフォルト定義（FR-03, 7.3）
 */
export const DEFAULT_CUSTOM_STAMPS: string[] = [
  '掃除',
  '洗濯',
  '買い物',
  '返信',
  'ゴミ出し',
  '勉強',
  '運動',
  '皿洗い',
];

/**
 * 初回起動時（localStorage 未保存時）のデモ用初期カプセルキュー
 */
export const DEFAULT_INITIAL_CAPSULE_TASKS: CapsuleTask[] = [
  {
    id: 'cap_demo_001',
    title: '企画書ドラフトを提出する',
    capsuleColor: 'gold',
    rarityBoost: 2.0,
    medalPrompt:
      "A gleaming golden commemorative medal with an embossed quill pen and glowing document scroll in the center, engraved text 'DRAFT CONQUEROR' along the rim, clean composition, 3D metallic render, dark velvet background",
    createdAt: '2026-10-20T00:49:30+09:00',
    skipCount: 0,
    status: 'pending',
  },
  {
    id: 'cap_demo_002',
    title: '溜まった洗濯物をたたむ',
    capsuleColor: 'blue',
    rarityBoost: 1.0,
    medalPrompt:
      "A shining bronze commemorative medal featuring a neatly folded stack of clothes and sparkling bubbles in high relief, engraved text 'LAUNDRY MASTER' along the rim, 3D metallic render",
    createdAt: '2026-10-20T00:50:00+09:00',
    skipCount: 0,
    status: 'pending',
  },
  {
    id: 'cap_demo_003',
    title: '経費精算の領収書をアップロード',
    capsuleColor: 'red',
    rarityBoost: 1.5,
    medalPrompt:
      "A polished silver commemorative medal with an embossed calculator and receipt icon in the center, engraved text 'RECEIPT HUNTER' along the rim, clean 3D metallic render",
    createdAt: '2026-10-20T00:51:00+09:00',
    skipCount: 0,
    status: 'pending',
  },
];

/**
 * 初期プレイヤーステータスを生成する
 */
export function createDefaultPlayerState(todayDateStr?: string): PlayerState {
  return {
    coins: 150,
    totalCracked: 12,
    todayCombo: 3,
    customStamps: [...DEFAULT_CUSTOM_STAMPS],
    soundEnabled: true,
    ...(todayDateStr ? { lastActiveDate: todayDateStr } : {}),
  };
}

/**
 * `gemini-3.8-flash` がタスク抽出時に返す1件分の構造化データ型
 */
export interface ExtractedCapsuleTaskDraft {
  title: string;
  capsuleColor: CapsuleColor;
  rarityBoost: number;
  medalPrompt: string;
  engravedText?: string;
  medalName?: string;
}

/**
 * `gemini-3.8-flash` マルチモーダルタスク抽出レスポンス型
 */
export interface TaskExtractionResponse {
  tasks: ExtractedCapsuleTaskDraft[];
}

/**
 * `gemini-3.8-flash` (Interactions API `response_format`) 用の単一カプセルタスク JSON Schema
 */
export const CAPSULE_TASK_DRAFT_JSON_SCHEMA = {
  type: 'object',
  description:
    'A single actionable capsule task extracted from user input, with estimated difficulty color, rarity boost, and an English prompt for generating a commemorative medal image.',
  properties: {
    title: {
      type: 'string',
      description:
        '簡潔で実行可能なタスク名（日本語、フィラーや不要な前置きを除去した短いフレーズ）',
    },
    capsuleColor: {
      type: 'string',
      enum: ['blue', 'red', 'gold'],
      description:
        'タスクの負荷に応じたカプセル色（blue: 軽作業, red: 中作業, gold: 高負荷タスク）',
    },
    rarityBoost: {
      type: 'number',
      description: 'カプセル色に応じたレア度倍率（blue: 1.0, red: 1.5, gold: 2.0）',
    },
    medalPrompt: {
      type: 'string',
      description:
        'English prompt for gemini-nano-banana-2.1 to render a 3D metallic commemorative medal with a central relief motif symbolizing the task and uppercase engraved text along the rim.',
    },
    engravedText: {
      type: 'string',
      description:
        'Short uppercase English title (max 20 chars) to be engraved on the medal rim (e.g., "LAUNDRY MASTER", "DRAFT CONQUEROR").',
    },
    medalName: {
      type: 'string',
      description: '達成時に授与される記念メダルの日本語名称（例：「ドラフト討伐の黄金勲章」）',
    },
  },
  required: ['title', 'capsuleColor', 'rarityBoost', 'medalPrompt'],
} as const;

/**
 * `gemini-3.8-flash` マルチモーダル一括タスク抽出（`POST /api/tasks/extract`）用 JSON Schema
 * Interactions API の `response_format` にそのまま渡せるスキーマ定義
 */
export const TASK_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  description: 'Structured output containing one or more extracted capsule tasks.',
  properties: {
    tasks: {
      type: 'array',
      description: 'ユーザーの音声ボヤき・画像メモ・テキストから分割抽出されたカプセルタスク配列',
      items: CAPSULE_TASK_DRAFT_JSON_SCHEMA,
    },
  },
  required: ['tasks'],
} as const;

/**
 * `gemini-3.8-flash` 5分ミニカプセル分裂（`POST /api/tasks/split`）用 JSON Schema
 */
export const MINI_TASK_SPLIT_JSON_SCHEMA = {
  type: 'object',
  description:
    'A 5-minute starter mini-capsule task broken down from a heavy or repeatedly skipped task.',
  properties: {
    task: CAPSULE_TASK_DRAFT_JSON_SCHEMA,
    encouragementMessage: {
      type: 'string',
      description: '着手ハードルを下げる短いポジティブな応援メッセージ（日本語）',
    },
  },
  required: ['task', 'encouragementMessage'],
} as const;

/**
 * 任意の値が有効な `CapsuleColor` かどうかを判定する型ガード
 */
export function isValidCapsuleColor(value: unknown): value is CapsuleColor {
  return value === 'blue' || value === 'red' || value === 'gold';
}

/**
 * 任意の値が有効な `MedalRarity` かどうかを判定する型ガード
 */
export function isValidMedalRarity(value: unknown): value is MedalRarity {
  return value === 'N' || value === 'R' || value === 'SR' || value === 'SSR';
}

/**
 * 任意の値が有効な `CapsuleTask` かどうかを検証する型ガード
 */
export function isValidCapsuleTask(value: unknown): value is CapsuleTask {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.title === 'string' &&
    candidate.title.trim().length > 0 &&
    isValidCapsuleColor(candidate.capsuleColor) &&
    typeof candidate.rarityBoost === 'number' &&
    Number.isFinite(candidate.rarityBoost) &&
    candidate.rarityBoost > 0 &&
    typeof candidate.medalPrompt === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.skipCount === 'number' &&
    Number.isFinite(candidate.skipCount) &&
    candidate.skipCount >= 0 &&
    (candidate.status === 'pending' ||
      candidate.status === 'completed' ||
      candidate.status === 'recycled')
  );
}
