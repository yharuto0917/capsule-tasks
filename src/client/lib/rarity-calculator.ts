import type { MedalRarity } from '../../shared/schemas';

export interface RarityProbabilityTable {
  N: number;
  R: number;
  SR: number;
  SSR: number;
}

export interface RarityCalculationInput {
  /** 当日連続開封コンボ数（0以上） */
  todayCombo: number;
  /** カプセルのレア度倍率（blue: 1.0, red: 1.5, gold: 2.0） */
  rarityBoost: number;
}

/**
 * 基準となるメダル出現確率（todayCombo = 0, rarityBoost = 1.0 の場合）
 * 合計 = 1.0 (N: 55%, R: 30%, SR: 12%, SSR: 3%)
 */
export const BASE_RARITY_PROBABILITIES: RarityProbabilityTable = {
  N: 0.55,
  R: 0.3,
  SR: 0.12,
  SSR: 0.03,
};

/**
 * メダルレア度の優先順位重み（図鑑のレア度順ソート等で使用）
 */
export const MEDAL_RARITY_ORDER_WEIGHT: Record<MedalRarity, number> = {
  SSR: 4,
  SR: 3,
  R: 2,
  N: 1,
};

/**
 * ローカルタイムゾーン基準の YYYY-MM-DD 日付文字列を返す
 */
export function formatLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * FR-16: ストリーク（連続開封コンボ）の日付境界チェック
 * - 同一日の場合は現在の `todayCombo` を維持する
 * - 日付が変わっている場合（1日以上空いた場合を含む）は `todayCombo` を `0` にリセットするのみで、
 *   コイン減少やデータ消失などのペナルティは一切与えない。
 */
export function resolveTodayComboForDate(
  currentTodayCombo: number,
  lastActiveDate: string | undefined,
  nowDateKey: string = formatLocalDateKey(),
): number {
  const safeCombo = Math.max(
    0,
    Math.floor(Number.isFinite(currentTodayCombo) ? currentTodayCombo : 0),
  );
  if (!lastActiveDate) {
    return safeCombo;
  }
  return lastActiveDate === nowDateKey ? safeCombo : 0;
}

/**
 * 当日コンボ数（`todayCombo`）に応じたコンボ補正倍率を算出する（FR-16）
 * 1日に複数個完了するほど倍率が上昇し、最大 +150%（2.5倍）まで上昇する。
 */
export function calculateComboMultiplier(todayCombo: number): number {
  const safeCombo = Math.max(0, Math.floor(Number.isFinite(todayCombo) ? todayCombo : 0));
  // 1コンボごとに +15% ボーナス（上限 +150% = 2.5倍）
  const bonus = Math.min(safeCombo * 0.15, 1.5);
  return Number((1.0 + bonus).toFixed(4));
}

/**
 * `todayCombo` と `rarityBoost` に基づいて N / R / SR / SSR の各出現確率（合計 1.0）を計算する。
 * コンボ数とカプセルの `rarityBoost` が高いほど SR / SSR / R の出現確率が上昇し、N の比率が下がる。
 */
export function calculateRarityProbabilities({
  todayCombo,
  rarityBoost,
}: RarityCalculationInput): RarityProbabilityTable {
  const safeBoost =
    Number.isFinite(rarityBoost) && rarityBoost > 0
      ? Math.min(Math.max(rarityBoost, 0.5), 5.0)
      : 1.0;
  const comboMultiplier = calculateComboMultiplier(todayCombo);
  const effectiveFactor = safeBoost * comboMultiplier;

  // 高レア枠ほど倍率の恩恵を強く受けるようスケーリング（上限キャップ付き）
  const rawSSR = Math.min(BASE_RARITY_PROBABILITIES.SSR * Math.pow(effectiveFactor, 1.35), 0.3);
  const rawSR = Math.min(BASE_RARITY_PROBABILITIES.SR * Math.pow(effectiveFactor, 1.15), 0.42);
  const rawR = Math.min(BASE_RARITY_PROBABILITIES.R * Math.pow(effectiveFactor, 0.5), 0.45);

  const highTierSum = rawSSR + rawSR + rawR;
  if (highTierSum >= 0.95) {
    // 合計が95%を超える場合はNを最低5%残して正規化
    const scale = 0.95 / highTierSum;
    const ssr = Number((rawSSR * scale).toFixed(4));
    const sr = Number((rawSR * scale).toFixed(4));
    const r = Number((rawR * scale).toFixed(4));
    const n = Number(Math.max(0, 1 - (ssr + sr + r)).toFixed(4));
    return { N: n, R: r, SR: sr, SSR: ssr };
  }

  const ssr = Number(rawSSR.toFixed(4));
  const sr = Number(rawSR.toFixed(4));
  const r = Number(rawR.toFixed(4));
  const n = Number(Math.max(0, 1 - (ssr + sr + r)).toFixed(4));

  return {
    N: n,
    R: r,
    SR: sr,
    SSR: ssr,
  };
}

/**
 * `todayCombo` と `rarityBoost`、および乱数生成器（デフォルト `Math.random`）を用いて
 * メダルレア度（`"N" | "R" | "SR" | "SSR"`）を抽選する。
 *
 * 乱数 `randomValue`（0.0 以上 1.0 未満）に対し、高レア度順（SSR → SR → R → N）の閾値判定を行う。
 */
export function rollMedalRarity(
  input: RarityCalculationInput,
  randomFn: () => number = Math.random,
): MedalRarity {
  const probabilities = calculateRarityProbabilities(input);
  const rawRoll = randomFn();
  const roll = Math.min(Math.max(Number.isFinite(rawRoll) ? rawRoll : 0.9999, 0), 0.999999);

  if (roll < probabilities.SSR) {
    return 'SSR';
  }
  if (roll < probabilities.SSR + probabilities.SR) {
    return 'SR';
  }
  if (roll < probabilities.SSR + probabilities.SR + probabilities.R) {
    return 'R';
  }
  return 'N';
}
