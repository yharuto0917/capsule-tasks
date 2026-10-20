import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * ブラウザでストレージアクセスが拒否されている場合（SecurityError等）でも
 * `window.localStorage` プロパティ参照自体でクラッシュしないよう try ブロック内で安全に取得する。
 */
function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') {
      return null;
    }
    const storage = window.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function readCapsulesFromStorage(fallback: CapsuleTask[]): CapsuleTask[] {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return [...fallback];
    }
    const raw = storage.getItem(CAPSULE_QUEUE_STORAGE_KEY);
    if (raw === null) {
      return [...fallback];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...fallback];
    }
    return parsed.filter(isValidCapsuleTask).filter((task) => task.status === 'pending');
  } catch {
    return [...fallback];
  }
}

function writeCapsulesToStorage(nextCapsules: CapsuleTask[]): void {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) return;
    storage.setItem(CAPSULE_QUEUE_STORAGE_KEY, JSON.stringify(nextCapsules));
  } catch {
    // ストレージ拒否・容量超過時などはアプリ進行を止めない
  }
}

function readPlayerStateFromStorage(todayKey: string, fallbackBase?: PlayerState): PlayerState {
  const fallback = fallbackBase
    ? {
        ...fallbackBase,
        todayCombo: resolveTodayComboForDate(
          fallbackBase.todayCombo,
          fallbackBase.lastActiveDate,
          todayKey,
        ),
        lastActiveDate: todayKey,
      }
    : createDefaultPlayerState(todayKey);

  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return fallback;
    }
    const raw = storage.getItem(PLAYER_STATE_STORAGE_KEY);
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

function writePlayerStateToStorage(nextPlayerState: PlayerState): void {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) return;
    storage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify(nextPlayerState));
  } catch {
    // ストレージ拒否・容量超過時などはアプリ進行を止めない
  }
}

const defaultGetNow = () => new Date();

export function useCapsuleStore(options: UseCapsuleStoreOptions = {}): UseCapsuleStoreReturn {
  const getNow = options.now ?? defaultGetNow;
  const randomFn = options.randomFn ?? Math.random;

  const [capsules, setCapsules] = useState<CapsuleTask[]>(() => {
    const initial = readCapsulesFromStorage(DEFAULT_INITIAL_CAPSULE_TASKS);
    writeCapsulesToStorage(initial);
    return initial;
  });

  const [playerState, setPlayerState] = useState<PlayerState>(() => {
    const todayKey = formatLocalDateKey(getNow());
    const initial = readPlayerStateFromStorage(todayKey);
    writePlayerStateToStorage(initial);
    return initial;
  });

  const capsulesRef = useRef<CapsuleTask[]>(capsules);
  const playerStateRef = useRef<PlayerState>(playerState);

  useEffect(() => {
    capsulesRef.current = capsules;
  }, [capsules]);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  /**
   * タブ間での更新競合・上書き消失を防ぐため、更新直前に必ず localStorage から最新状態を読み直して
   * ミューテーションを直列適用し、即座に localStorage と React ステートの双方へ反映する。
   */
  const commitStoreTransaction = useCallback(
    (
      mutator: (
        latestCapsules: CapsuleTask[],
        latestPlayerState: PlayerState,
        todayKey: string,
      ) => {
        nextCapsules?: CapsuleTask[];
        nextPlayerState?: PlayerState;
      },
    ) => {
      const todayKey = formatLocalDateKey(getNow());
      const latestCapsules = readCapsulesFromStorage(capsulesRef.current);
      const latestPlayerState = readPlayerStateFromStorage(todayKey, playerStateRef.current);

      const { nextCapsules, nextPlayerState } = mutator(
        latestCapsules,
        latestPlayerState,
        todayKey,
      );

      if (nextCapsules !== undefined) {
        capsulesRef.current = nextCapsules;
        writeCapsulesToStorage(nextCapsules);
        setCapsules(nextCapsules);
      } else {
        capsulesRef.current = latestCapsules;
        setCapsules(latestCapsules);
      }

      if (nextPlayerState !== undefined) {
        playerStateRef.current = nextPlayerState;
        writePlayerStateToStorage(nextPlayerState);
        setPlayerState(nextPlayerState);
      } else {
        playerStateRef.current = latestPlayerState;
        setPlayerState(latestPlayerState);
      }
    },
    [getNow],
  );

  // 別タブで localStorage が更新された際に、アクティブタブ側の表示も即時同期する
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return;
      }
      const handleStorage = (event: StorageEvent) => {
        const todayKey = formatLocalDateKey(getNow());
        if (event.key === null || event.key === CAPSULE_QUEUE_STORAGE_KEY) {
          const syncedCapsules = readCapsulesFromStorage(DEFAULT_INITIAL_CAPSULE_TASKS);
          capsulesRef.current = syncedCapsules;
          setCapsules(syncedCapsules);
        }
        if (event.key === null || event.key === PLAYER_STATE_STORAGE_KEY) {
          const syncedPlayer = readPlayerStateFromStorage(todayKey);
          playerStateRef.current = syncedPlayer;
          setPlayerState(syncedPlayer);
        }
      };
      window.addEventListener('storage', handleStorage);
      return () => {
        window.removeEventListener('storage', handleStorage);
      };
    } catch {
      return;
    }
  }, [getNow]);

  const syncDateComboState = useCallback(() => {
    commitStoreTransaction((_latestCapsules, latestPlayerState, todayKey) => {
      const nextCombo = resolveTodayComboForDate(
        latestPlayerState.todayCombo,
        latestPlayerState.lastActiveDate,
        todayKey,
      );
      return {
        nextPlayerState: {
          ...latestPlayerState,
          todayCombo: nextCombo,
          lastActiveDate: todayKey,
        },
      };
    });
  }, [commitStoreTransaction]);

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

      commitStoreTransaction((latestCapsules, latestPlayerState, todayKey) => ({
        nextCapsules: [...latestCapsules, ...createdTasks],
        nextPlayerState: {
          ...latestPlayerState,
          coins: latestPlayerState.coins + bonusCoins,
          todayCombo: resolveTodayComboForDate(
            latestPlayerState.todayCombo,
            latestPlayerState.lastActiveDate,
            todayKey,
          ),
          lastActiveDate: todayKey,
        },
      }));

      return createdTasks;
    },
    [commitStoreTransaction, getNow],
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
    let passedResult: CapsuleTask | null = null;

    commitStoreTransaction((latestCapsules) => {
      if (latestCapsules.length === 0) {
        return {};
      }
      const head: CapsuleTask = {
        ...latestCapsules[0],
        skipCount: latestCapsules[0].skipCount + 1,
      };
      passedResult = head;
      const nextCapsules =
        latestCapsules.length === 1 ? [head] : [...latestCapsules.slice(1), head];
      return { nextCapsules };
    });

    return passedResult;
  }, [commitStoreTransaction]);

  const recycleActiveCapsule = useCallback((): CapsuleTask | null => {
    let recycledResult: CapsuleTask | null = null;

    commitStoreTransaction((latestCapsules, latestPlayerState, todayKey) => {
      if (latestCapsules.length === 0) {
        return {};
      }
      recycledResult = {
        ...latestCapsules[0],
        status: 'recycled',
      };
      return {
        nextCapsules: latestCapsules.slice(1),
        nextPlayerState: {
          ...latestPlayerState,
          coins: latestPlayerState.coins + RECYCLE_BONUS_COINS,
          todayCombo: resolveTodayComboForDate(
            latestPlayerState.todayCombo,
            latestPlayerState.lastActiveDate,
            todayKey,
          ),
          lastActiveDate: todayKey,
        },
      };
    });

    return recycledResult;
  }, [commitStoreTransaction]);

  const crackActiveCapsule = useCallback((): CrackCapsuleResult | null => {
    let crackOutcome: CrackCapsuleResult | null = null;

    commitStoreTransaction((latestCapsules, latestPlayerState, todayKey) => {
      if (latestCapsules.length === 0) {
        return {};
      }
      const target = latestCapsules[0];

      // 日付変更を考慮した現在のコンボ数を取得し、今回の開封で +1 する
      const baseCombo = resolveTodayComboForDate(
        latestPlayerState.todayCombo,
        latestPlayerState.lastActiveDate,
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

      crackOutcome = {
        crackedTask,
        awardedRarity,
        coinsEarned,
        updatedCombo,
      };

      return {
        nextCapsules: latestCapsules.slice(1),
        nextPlayerState: {
          ...latestPlayerState,
          coins: latestPlayerState.coins + coinsEarned,
          totalCracked: latestPlayerState.totalCracked + 1,
          todayCombo: updatedCombo,
          lastActiveDate: todayKey,
        },
      };
    });

    return crackOutcome;
  }, [commitStoreTransaction, randomFn]);

  const toggleSound = useCallback(() => {
    commitStoreTransaction((_latestCapsules, latestPlayerState) => ({
      nextPlayerState: {
        ...latestPlayerState,
        soundEnabled: !latestPlayerState.soundEnabled,
      },
    }));
  }, [commitStoreTransaction]);

  const updateCustomStamps = useCallback(
    (stamps: string[]) => {
      const cleaned = stamps.map((s) => s.trim()).filter((s) => s.length > 0);
      if (cleaned.length === 0) return;
      commitStoreTransaction((_latestCapsules, latestPlayerState) => ({
        nextPlayerState: {
          ...latestPlayerState,
          customStamps: cleaned,
        },
      }));
    },
    [commitStoreTransaction],
  );

  const spendCoins = useCallback(
    (amount: number): boolean => {
      const safeAmount = Math.floor(amount);
      if (!Number.isFinite(safeAmount) || safeAmount <= 0) return false;

      let spent = false;
      commitStoreTransaction((_latestCapsules, latestPlayerState) => {
        if (latestPlayerState.coins < safeAmount) {
          return {};
        }
        spent = true;
        return {
          nextPlayerState: {
            ...latestPlayerState,
            coins: latestPlayerState.coins - safeAmount,
          },
        };
      });
      return spent;
    },
    [commitStoreTransaction],
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
