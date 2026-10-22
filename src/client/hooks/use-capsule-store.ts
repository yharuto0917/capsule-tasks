import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CAPSULE_COLOR_RARITY_BOOST,
  isValidCapsuleColor,
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

import {
  CAPSULE_QUEUE_STORAGE_KEY,
  PLAYER_STATE_STORAGE_KEY,
  CAPSULE_STORE_STORAGE_KEY,
  CAPSULE_STORE_CORRUPT_BACKUP_KEY,
  CAPSULE_STORE_LOCK_NAME,
  createDefaultStoreSnapshot,
  getSafeLocalStorage,
  readStoreSnapshot,
  writeStoreSnapshot,
  type CapsuleStoreSnapshot,
  type CorruptStoreEntry,
} from '../lib/capsule-store-storage';

export {
  CAPSULE_QUEUE_STORAGE_KEY,
  PLAYER_STATE_STORAGE_KEY,
  CAPSULE_STORE_STORAGE_KEY,
  CAPSULE_STORE_CORRUPT_BACKUP_KEY,
};

const UNSAVED_CHANGES_MESSAGE =
  '変更を保存できません。この画面では続けられますが、再読み込みや終了で今回の変更は失われます。';

type StoreUpdate<T> = {
  nextCapsules?: CapsuleTask[];
  nextPlayerState?: PlayerState;
  result: T;
};

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
  ) => Promise<CapsuleTask[]>;
  /** 常連スタンプから1タップでカプセルを補充する（FR-03, FR-04） */
  supplyStampCapsule: (stampTitle: string, color?: CapsuleColor) => Promise<CapsuleTask>;
  /** 先頭カプセルを先送り（skipCount + 1 してキュー末尾へ再配置）する（FR-07） */
  passActiveCapsule: (expectedTaskId?: string) => Promise<CapsuleTask | null>;
  /** 先頭カプセルをリサイクル破棄し、+5 コインを付与する（FR-09） */
  recycleActiveCapsule: (expectedTaskId?: string) => Promise<CapsuleTask | null>;
  /** 先頭カプセルを開封完了し、コンボ加算・コイン付与・レア度抽選を行う（FR-10, FR-16） */
  crackActiveCapsule: (expectedTaskId?: string) => Promise<CrackCapsuleResult | null>;
  /** サウンド ON/OFF を切り替える */
  toggleSound: () => Promise<void>;
  /** 常連スタンプ一覧を更新する */
  updateCustomStamps: (stamps: string[]) => Promise<void>;
  /** コインを消費する（メダル進化等の100コイン消費用、残高不足時は false） */
  spendCoins: (amount: number) => Promise<boolean>;
  /** 日付変更チェックを手動実行し、日付が変わっていればペナルティなしで todayCombo のみ 0 にリセットする */
  syncDateComboState: () => Promise<void>;
  /** 保存できない場合の通知。以後はこの画面のメモリ状態を保持する。 */
  storageError: string | null;
  /** ロック取得待ちを含む更新処理中。 */
  isUpdating: boolean;
}

function createUniqueTaskId(nowMs: number, index: number): string {
  const uuidPart =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 8);
  return `cap_${nowMs}_${index}_${uuidPart}`;
}

function buildDefaultMedalPrompt(title: string, color: CapsuleColor): string {
  const materialByColor: Record<CapsuleColor, string> = {
    blue: 'shining bronze and sky-blue enamel',
    red: 'polished silver and crimson enamel',
    gold: 'gleaming golden and holographic',
  };
  return `A ${materialByColor[color]} commemorative medal celebrating the completion of "${title}", 3D metallic relief, studio lighting, clean square icon`;
}

const defaultGetNow = () => new Date();

export function useCapsuleStore(options: UseCapsuleStoreOptions = {}): UseCapsuleStoreReturn {
  const initialNowFn = options.now ?? defaultGetNow;
  const getNowRef = useRef<() => Date>(initialNowFn);
  const randomFnRef = useRef<() => number>(options.randomFn ?? Math.random);

  useEffect(() => {
    getNowRef.current = options.now ?? defaultGetNow;
    randomFnRef.current = options.randomFn ?? Math.random;
  }, [options.now, options.randomFn]);

  const [snapshot, setSnapshot] = useState<CapsuleStoreSnapshot>(() => {
    const todayKey = formatLocalDateKey(initialNowFn());
    const fallback = createDefaultStoreSnapshot(todayKey);
    try {
      return readStoreSnapshot(getSafeLocalStorage(), todayKey, fallback).snapshot;
    } catch {
      return fallback;
    }
  });
  const snapshotRef = useRef(snapshot);
  const memoryOnlyRef = useRef(false);
  const transactionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [storageError, setStorageError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const enterMemoryOnly = useCallback(() => {
    memoryOnlyRef.current = true;
    setStorageError(UNSAVED_CHANGES_MESSAGE);
  }, []);

  const commitStoreTransaction = useCallback(
    <T>(
      mutator: (
        latestCapsules: CapsuleTask[],
        latestPlayerState: PlayerState,
        todayKey: string,
      ) => StoreUpdate<T>,
    ): Promise<T> => {
      setPendingCount((count) => count + 1);
      const operation = transactionQueueRef.current.then(async () => {
        const applyUpdate = (storage: Storage | null): T => {
          const todayKey = formatLocalDateKey(getNowRef.current());
          let latest = readStoreSnapshot(null, todayKey, snapshotRef.current).snapshot;
          let corruptEntries: CorruptStoreEntry[] = [];
          if (!memoryOnlyRef.current && storage) {
            try {
              const stored = readStoreSnapshot(storage, todayKey, latest);
              latest = stored.snapshot;
              corruptEntries = stored.corruptEntries;
            } catch {
              enterMemoryOnly();
            }
          }

          const update = mutator(latest.capsules, latest.playerState, todayKey);
          const next = {
            capsules: update.nextCapsules ?? latest.capsules,
            playerState: update.nextPlayerState ?? latest.playerState,
          };
          const hasStateMutation =
            update.nextCapsules !== undefined ||
            update.nextPlayerState !== undefined ||
            corruptEntries.length > 0;
          if (hasStateMutation && storage && !memoryOnlyRef.current) {
            try {
              writeStoreSnapshot(storage, next, corruptEntries);
            } catch {
              // 未保存状態は古い保存値で置き換えず、この画面で保持する。
              enterMemoryOnly();
            }
          }
          snapshotRef.current = next;
          setSnapshot(next);
          return update.result;
        };

        if (memoryOnlyRef.current) return applyUpdate(null);
        const storage = getSafeLocalStorage();
        if (!storage) {
          enterMemoryOnly();
          return applyUpdate(null);
        }

        let locks: LockManager | undefined;
        try {
          locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
        } catch {
          // ストレージと同様、ロック機能の取得拒否にも対応する。
        }

        // 排他制御できない環境では、共有データを上書きせずこの画面で変更を保持する。
        if (!locks || typeof locks.request !== 'function') {
          enterMemoryOnly();
          return applyUpdate(null);
        }

        let lockAcquired = false;
        try {
          return await locks.request(CAPSULE_STORE_LOCK_NAME, { mode: 'exclusive' }, () => {
            lockAcquired = true;
            return applyUpdate(storage);
          });
        } catch (error) {
          if (lockAcquired) throw error;
          enterMemoryOnly();
          return applyUpdate(null);
        }
      });
      // ロック非対応・保存失敗時も、同じ画面内の操作順は維持する。
      transactionQueueRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation.finally(() => setPendingCount((count) => count - 1));
    },
    [enterMemoryOnly],
  );

  useEffect(() => {
    const storage = getSafeLocalStorage();
    if (typeof window === 'undefined' || !storage) return;
    const handleStorage = (event: StorageEvent) => {
      if (memoryOnlyRef.current || (event.storageArea && event.storageArea !== storage)) return;
      if (
        event.key !== null &&
        event.key !== CAPSULE_STORE_STORAGE_KEY &&
        event.key !== CAPSULE_QUEUE_STORAGE_KEY &&
        event.key !== PLAYER_STATE_STORAGE_KEY
      )
        return;
      const todayKey = formatLocalDateKey(getNowRef.current());
      try {
        const synced = readStoreSnapshot(storage, todayKey, snapshotRef.current).snapshot;
        snapshotRef.current = synced;
        setSnapshot(synced);
      } catch {
        enterMemoryOnly();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [enterMemoryOnly]);

  const syncDateComboState = useCallback(async (): Promise<void> => {
    const todayKey = formatLocalDateKey(getNowRef.current());
    if (snapshotRef.current.playerState.lastActiveDate === todayKey) {
      return;
    }
    await commitStoreTransaction((_capsules, playerState) => ({
      nextPlayerState: playerState,
      result: undefined,
    }));
  }, [commitStoreTransaction]);

  const supplyCapsules = useCallback(
    async (
      draftInput: ExtractedCapsuleTaskDraft | ExtractedCapsuleTaskDraft[],
    ): Promise<CapsuleTask[]> => {
      const draftList = Array.isArray(draftInput) ? draftInput : [draftInput];
      const validDrafts = draftList.filter(
        (d) => typeof d.title === 'string' && d.title.trim().length > 0,
      );
      if (validDrafts.length === 0) return [];

      const nowDate = getNowRef.current();
      const nowIso = nowDate.toISOString();
      const nowMs = nowDate.getTime();

      const createdTasks: CapsuleTask[] = validDrafts.map((draft, idx) => {
        const color: CapsuleColor = isValidCapsuleColor(draft.capsuleColor)
          ? draft.capsuleColor
          : 'blue';
        // LLM が色と異なる数値を返しても不整合が起きないよう、カプセル色に対応する標準倍率を採用する
        const rarityBoost = CAPSULE_COLOR_RARITY_BOOST[color];
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

      return commitStoreTransaction((latestCapsules, latestPlayerState, todayKey) => ({
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
        result: createdTasks,
      }));
    },
    [commitStoreTransaction],
  );

  const supplyStampCapsule = useCallback(
    async (stampTitle: string, color: CapsuleColor = 'blue'): Promise<CapsuleTask> => {
      const cleanTitle = stampTitle.trim() || '常連タスク';
      const [created] = await supplyCapsules({
        title: cleanTitle,
        capsuleColor: color,
        rarityBoost: CAPSULE_COLOR_RARITY_BOOST[color],
        medalPrompt: buildDefaultMedalPrompt(cleanTitle, color),
      });
      return created;
    },
    [supplyCapsules],
  );

  const passActiveCapsule = useCallback(
    (expectedTaskId?: string) =>
      commitStoreTransaction((latestCapsules): StoreUpdate<CapsuleTask | null> => {
        if (
          latestCapsules.length === 0 ||
          (expectedTaskId && latestCapsules[0].id !== expectedTaskId)
        )
          return { result: null };
        const head = { ...latestCapsules[0], skipCount: latestCapsules[0].skipCount + 1 };
        return {
          nextCapsules: [...latestCapsules.slice(1), head],
          result: head,
        };
      }),
    [commitStoreTransaction],
  );

  const recycleActiveCapsule = useCallback(
    (expectedTaskId?: string) =>
      commitStoreTransaction(
        (latestCapsules, latestPlayerState): StoreUpdate<CapsuleTask | null> => {
          if (
            latestCapsules.length === 0 ||
            (expectedTaskId && latestCapsules[0].id !== expectedTaskId)
          )
            return { result: null };
          return {
            nextCapsules: latestCapsules.slice(1),
            nextPlayerState: {
              ...latestPlayerState,
              coins: latestPlayerState.coins + RECYCLE_BONUS_COINS,
            },
            result: { ...latestCapsules[0], status: 'recycled' },
          };
        },
      ),
    [commitStoreTransaction],
  );

  const crackActiveCapsule = useCallback(
    (expectedTaskId?: string) =>
      commitStoreTransaction(
        (latestCapsules, latestPlayerState): StoreUpdate<CrackCapsuleResult | null> => {
          if (
            latestCapsules.length === 0 ||
            (expectedTaskId && latestCapsules[0].id !== expectedTaskId)
          )
            return { result: null };
          const target = latestCapsules[0];
          const updatedCombo = latestPlayerState.todayCombo + 1;
          return {
            nextCapsules: latestCapsules.slice(1),
            nextPlayerState: {
              ...latestPlayerState,
              coins: latestPlayerState.coins + CRACK_BASE_COINS,
              totalCracked: latestPlayerState.totalCracked + 1,
              todayCombo: updatedCombo,
            },
            result: {
              crackedTask: { ...target, status: 'completed' },
              awardedRarity: rollMedalRarity(
                { todayCombo: updatedCombo, rarityBoost: target.rarityBoost },
                randomFnRef.current,
              ),
              coinsEarned: CRACK_BASE_COINS,
              updatedCombo,
            },
          };
        },
      ),
    [commitStoreTransaction],
  );

  const toggleSound = useCallback(
    () =>
      commitStoreTransaction((_capsules, playerState) => ({
        nextPlayerState: { ...playerState, soundEnabled: !playerState.soundEnabled },
        result: undefined,
      })),
    [commitStoreTransaction],
  );

  const updateCustomStamps = useCallback(
    async (stamps: string[]): Promise<void> => {
      const cleaned = stamps.map((stamp) => stamp.trim()).filter(Boolean);
      if (cleaned.length === 0) return;
      await commitStoreTransaction((_capsules, playerState) => ({
        nextPlayerState: { ...playerState, customStamps: cleaned },
        result: undefined,
      }));
    },
    [commitStoreTransaction],
  );

  const spendCoins = useCallback(
    async (amount: number): Promise<boolean> => {
      const safeAmount = Math.floor(amount);
      if (!Number.isFinite(safeAmount) || safeAmount <= 0) return false;
      return commitStoreTransaction((_capsules, playerState) => {
        if (playerState.coins < safeAmount) return { result: false };
        return {
          nextPlayerState: { ...playerState, coins: playerState.coins - safeAmount },
          result: true,
        };
      });
    },
    [commitStoreTransaction],
  );

  return {
    capsules: snapshot.capsules,
    activeCapsule: snapshot.capsules[0] ?? null,
    playerState: snapshot.playerState,
    storageError,
    isUpdating: pendingCount > 0,
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
