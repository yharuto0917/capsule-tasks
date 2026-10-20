import { useCallback, useEffect, useState } from 'react';
import {
  CAPSULE_COLOR_RARITY_BOOST,
  createDefaultPlayerState,
  DEFAULT_CUSTOM_STAMPS,
  DEFAULT_INITIAL_CAPSULE_TASKS,
  isValidCapsuleColor,
  isValidCapsuleTask,
  type CapsuleColor,
  type CapsuleTask,
  type ExtractedCapsuleTaskDraft,
  type MedalRarity,
  type PlayerState,
} from '../../shared/schemas';
import {
  formatLocalDateKey,
  resolveTodayComboForDate,
  rollMedalRarity,
} from '../lib/rarity-calculator';

export const CAPSULE_QUEUE_STORAGE_KEY = 'capsule_tasks_queue_v1';
export const PLAYER_STATE_STORAGE_KEY = 'capsule_tasks_player_state_v1';

/** カプセル1個補充時のボーナスコイン（FR-04） */
export const SUPPLY_BONUS_COINS_PER_CAPSULE = 10;
/** カプセル破棄（リサイクル）時の獲得コイン（FR-09） */
export const RECYCLE_BONUS_COINS = 5;
/** カプセル開封（完了）時の基本獲得コイン */
export const CRACK_BASE_COINS = 30;

export interface CrackCapsuleResult {
  crackedTask: CapsuleTask;
  awardedRarity: MedalRarity;
  coinsEarned: number;
  updatedCombo: number;
}

export interface UseCapsuleStoreOptions {
  /** 現在日時取得関数（単体テストでの日付変更シミュレーション用） */
  now?: () => Date;
  /** レア度抽選用の乱数関数（単体テスト用） */
  randomFn?: () => number;
}

export interface UseCapsuleStoreReturn {
  /** 未完了（status === 'pending'）のカプセルキュー */
  capsules: CapsuleTask[];
  /** ステージ中央に表示される先頭カプセル（空の場合は null） */
  activeCapsule: CapsuleTask | null;
  /** プレイヤーステータス */
  playerState: PlayerState;
  /** 1個以上のカプセルを補充し、1個につき +10 コインを即時付与する（FR-04） */
  supplyCapsules: (
    drafts: ExtractedCapsuleTaskDraft | ExtractedCapsuleTaskDraft[],
  ) => CapsuleTask[];
  /** 常連スタンプから1タップでカプセルを補充する（FR-03, FR-04） */
  supplyStampCapsule: (stampTitle: string, color?: CapsuleColor) => CapsuleTask;
  /** 先頭カプセルを先送り（skipCount + 1 してキュー末尾へ再配置）する（FR-07） */
  passActiveCapsule: () => CapsuleTask | null;
  /** 先頭カプセルをリサイクル破棄し、+5 コインを付与する（FR-09） */
  recycleActiveCapsule: () => CapsuleTask | null;
  /** 先頭カプセルを開封完了し、コンボ加算・コイン付与・レア度抽選を行う（FR-10, FR-16） */
  crackActiveCapsule: () => CrackCapsuleResult | null;
  /** サウンド ON/OFF を切り替える */
  toggleSound: () => void;
  /** 常連スタンプ一覧を更新する */
  updateCustomStamps: (stamps: string[]) => void;
  /** コインを消費する（メダル進化等の100コイン消費用、残高不足時は false） */
  spendCoins: (amount: number) => boolean;
  /** 日付変更チェックを手動実行し、日付が変わっていればペナルティなしで todayCombo のみ 0 にリセットする */
  syncDateComboState: () => void;
}

function createUniqueTaskId(nowMs: number, index: number): string {
  const randSuffix = Math.random().toString(36).slice(2, 6);
  return `cap_${nowMs}_${index}_${randSuffix}`;
}

function buildDefaultMedalPrompt(title: string, color: CapsuleColor): string {
  const materialByColor: Record<CapsuleColor, string> = {
    blue: 'shining bronze and sky-blue enamel',
    red: 'polished silver and crimson enamel',
    gold: 'gleaming golden and holographic',
  };
  return `A ${materialByColor[color]} commemorative medal celebrating the completion of "${title}", 3D metallic relief, studio lighting, clean square icon`;
}

function loadInitialCapsulesFromStorage(): CapsuleTask[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [...DEFAULT_INITIAL_CAPSULE_TASKS];
  }
  try {
    const raw = window.localStorage.getItem(CAPSULE_QUEUE_STORAGE_KEY);
    if (raw === null) {
      return [...DEFAULT_INITIAL_CAPSULE_TASKS];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_INITIAL_CAPSULE_TASKS];
    }
    return parsed.filter(isValidCapsuleTask).filter((task) => task.status === 'pending');
  } catch {
    return [...DEFAULT_INITIAL_CAPSULE_TASKS];
  }
}

function loadInitialPlayerStateFromStorage(todayKey: string): PlayerState {
  const fallback = createDefaultPlayerState(todayKey);
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(PLAYER_STATE_STORAGE_KEY);
    if (raw === null) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<PlayerState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return fallback;
    }

    const coins =
      typeof parsed.coins === 'number' && Number.isFinite(parsed.coins) && parsed.coins >= 0
        ? Math.floor(parsed.coins)
        : fallback.coins;
    const totalCracked =
      typeof parsed.totalCracked === 'number' &&
      Number.isFinite(parsed.totalCracked) &&
      parsed.totalCracked >= 0
        ? Math.floor(parsed.totalCracked)
        : fallback.totalCracked;
    const rawCombo =
      typeof parsed.todayCombo === 'number' &&
      Number.isFinite(parsed.todayCombo) &&
      parsed.todayCombo >= 0
        ? Math.floor(parsed.todayCombo)
        : fallback.todayCombo;
    const customStamps =
      Array.isArray(parsed.customStamps) &&
      parsed.customStamps.every((s) => typeof s === 'string' && s.trim().length > 0) &&
      parsed.customStamps.length > 0
        ? parsed.customStamps
        : [...DEFAULT_CUSTOM_STAMPS];
    const soundEnabled =
      typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : fallback.soundEnabled;
    const lastActiveDate =
      typeof parsed.lastActiveDate === 'string' ? parsed.lastActiveDate : undefined;

    // FR-16: 日付が変わっていたらペナルティなしで todayCombo だけ 0 にリセットする
    const resolvedCombo = resolveTodayComboForDate(rawCombo, lastActiveDate, todayKey);

    return {
      coins,
      totalCracked,
      todayCombo: resolvedCombo,
      customStamps,
      soundEnabled,
      lastActiveDate: todayKey,
    };
  } catch {
    return fallback;
  }
}

const defaultGetNow = () => new Date();

export function useCapsuleStore(options: UseCapsuleStoreOptions = {}): UseCapsuleStoreReturn {
  const getNow = options.now ?? defaultGetNow;
  const randomFn = options.randomFn ?? Math.random;

  const [capsules, setCapsules] = useState<CapsuleTask[]>(() => loadInitialCapsulesFromStorage());
  const [playerState, setPlayerState] = useState<PlayerState>(() =>
    loadInitialPlayerStateFromStorage(formatLocalDateKey(getNow())),
  );

  // localStorage への同期保存（カプセルキュー）
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(CAPSULE_QUEUE_STORAGE_KEY, JSON.stringify(capsules));
    } catch {
      // ストレージ容量超過時などはアプリ進行を止めない
    }
  }, [capsules]);

  // localStorage への同期保存（PlayerState）
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify(playerState));
    } catch {
      // ストレージ容量超過時などはアプリ進行を止めない
    }
  }, [playerState]);

  const syncDateComboState = useCallback(() => {
    const todayKey = formatLocalDateKey(getNow());
    setPlayerState((prev) => {
      const nextCombo = resolveTodayComboForDate(prev.todayCombo, prev.lastActiveDate, todayKey);
      if (prev.todayCombo === nextCombo && prev.lastActiveDate === todayKey) {
        return prev;
      }
      return {
        ...prev,
        todayCombo: nextCombo,
        lastActiveDate: todayKey,
      };
    });
  }, [getNow]);

  const supplyCapsules = useCallback(
    (draftInput: ExtractedCapsuleTaskDraft | ExtractedCapsuleTaskDraft[]): CapsuleTask[] => {
      const draftList = Array.isArray(draftInput) ? draftInput : [draftInput];
      const validDrafts = draftList.filter(
        (d) => typeof d.title === 'string' && d.title.trim().length > 0,
      );
      if (validDrafts.length === 0) return [];

      const nowDate = getNow();
      const nowIso = nowDate.toISOString();
      const nowMs = nowDate.getTime();
      const todayKey = formatLocalDateKey(nowDate);

      const createdTasks: CapsuleTask[] = validDrafts.map((draft, idx) => {
        const color: CapsuleColor = isValidCapsuleColor(draft.capsuleColor)
          ? draft.capsuleColor
          : 'blue';
        const rarityBoost =
          typeof draft.rarityBoost === 'number' &&
          Number.isFinite(draft.rarityBoost) &&
          draft.rarityBoost > 0
            ? draft.rarityBoost
            : CAPSULE_COLOR_RARITY_BOOST[color];
        const cleanTitle = draft.title.trim();
        const medalPrompt =
          typeof draft.medalPrompt === 'string' && draft.medalPrompt.trim().length > 0
            ? draft.medalPrompt.trim()
            : buildDefaultMedalPrompt(cleanTitle, color);

        return {
          id: createUniqueTaskId(nowMs, idx),
          title: cleanTitle,
          capsuleColor: color,
          rarityBoost,
          medalPrompt,
          createdAt: nowIso,
          skipCount: 0,
          status: 'pending',
        };
      });

      const bonusCoins = createdTasks.length * SUPPLY_BONUS_COINS_PER_CAPSULE;

      setCapsules((prev) => [...prev, ...createdTasks]);
      setPlayerState((prev) => ({
        ...prev,
        coins: prev.coins + bonusCoins,
        todayCombo: resolveTodayComboForDate(prev.todayCombo, prev.lastActiveDate, todayKey),
        lastActiveDate: todayKey,
      }));

      return createdTasks;
    },
    [getNow],
  );

  const supplyStampCapsule = useCallback(
    (stampTitle: string, color: CapsuleColor = 'blue'): CapsuleTask => {
      const cleanTitle = stampTitle.trim() || '常連タスク';
      const [created] = supplyCapsules({
        title: cleanTitle,
        capsuleColor: color,
        rarityBoost: CAPSULE_COLOR_RARITY_BOOST[color],
        medalPrompt: buildDefaultMedalPrompt(cleanTitle, color),
      });
      return created;
    },
    [supplyCapsules],
  );

  const passActiveCapsule = useCallback((): CapsuleTask | null => {
    if (capsules.length === 0) return null;
    const current = capsules[0];
    const updatedCurrent: CapsuleTask = {
      ...current,
      skipCount: current.skipCount + 1,
    };

    setCapsules((prev) => {
      if (prev.length === 0) return prev;
      const head = { ...prev[0], skipCount: prev[0].skipCount + 1 };
      if (prev.length === 1) {
        return [head];
      }
      return [...prev.slice(1), head];
    });

    return updatedCurrent;
  }, [capsules]);

  const recycleActiveCapsule = useCallback((): CapsuleTask | null => {
    if (capsules.length === 0) return null;
    const recycled: CapsuleTask = {
      ...capsules[0],
      status: 'recycled',
    };
    const todayKey = formatLocalDateKey(getNow());

    setCapsules((prev) => prev.slice(1));
    setPlayerState((prev) => ({
      ...prev,
      coins: prev.coins + RECYCLE_BONUS_COINS,
      todayCombo: resolveTodayComboForDate(prev.todayCombo, prev.lastActiveDate, todayKey),
      lastActiveDate: todayKey,
    }));

    return recycled;
  }, [capsules, getNow]);

  const crackActiveCapsule = useCallback((): CrackCapsuleResult | null => {
    if (capsules.length === 0) return null;
    const target = capsules[0];
    const todayKey = formatLocalDateKey(getNow());

    // 日付変更を考慮した現在のコンボ数を取得し、今回の開封で +1 する
    const baseCombo = resolveTodayComboForDate(
      playerState.todayCombo,
      playerState.lastActiveDate,
      todayKey,
    );
    const updatedCombo = baseCombo + 1;

    // todayCombo とカプセルの rarityBoost に基づいてメダルレア度を抽選
    const awardedRarity = rollMedalRarity(
      {
        todayCombo: updatedCombo,
        rarityBoost: target.rarityBoost,
      },
      randomFn,
    );

    const coinsEarned = CRACK_BASE_COINS;
    const crackedTask: CapsuleTask = {
      ...target,
      status: 'completed',
    };

    setCapsules((prev) => prev.slice(1));
    setPlayerState((prev) => ({
      ...prev,
      coins: prev.coins + coinsEarned,
      totalCracked: prev.totalCracked + 1,
      todayCombo: updatedCombo,
      lastActiveDate: todayKey,
    }));

    return {
      crackedTask,
      awardedRarity,
      coinsEarned,
      updatedCombo,
    };
  }, [capsules, getNow, playerState.lastActiveDate, playerState.todayCombo, randomFn]);

  const toggleSound = useCallback(() => {
    setPlayerState((prev) => ({
      ...prev,
      soundEnabled: !prev.soundEnabled,
    }));
  }, []);

  const updateCustomStamps = useCallback((stamps: string[]) => {
    const cleaned = stamps.map((s) => s.trim()).filter((s) => s.length > 0);
    if (cleaned.length === 0) return;
    setPlayerState((prev) => ({
      ...prev,
      customStamps: cleaned,
    }));
  }, []);

  const spendCoins = useCallback(
    (amount: number): boolean => {
      const safeAmount = Math.floor(amount);
      if (!Number.isFinite(safeAmount) || safeAmount <= 0) return false;
      if (playerState.coins < safeAmount) return false;

      setPlayerState((prev) => {
        if (prev.coins < safeAmount) return prev;
        return {
          ...prev,
          coins: prev.coins - safeAmount,
        };
      });
      return true;
    },
    [playerState.coins],
  );

  const activeCapsule = capsules[0] ?? null;

  return {
    capsules,
    activeCapsule,
    playerState,
    supplyCapsules,
    supplyStampCapsule,
    passActiveCapsule,
    recycleActiveCapsule,
    crackActiveCapsule,
    toggleSound,
    updateCustomStamps,
    spendCoins,
    syncDateComboState,
  };
}
