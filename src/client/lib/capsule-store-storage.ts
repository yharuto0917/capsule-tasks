import {
  createDefaultPlayerState,
  DEFAULT_CUSTOM_STAMPS,
  DEFAULT_INITIAL_CAPSULE_TASKS,
  isValidCapsuleTask,
  type CapsuleTask,
  type PlayerState,
} from '../../shared/schemas';
import { resolveTodayComboForDate } from './rarity-calculator';

/** v1 は既存データの読み込み専用。更新はキューと残高を一括保存する v2 に移行する。 */
export const CAPSULE_QUEUE_STORAGE_KEY = 'capsule_tasks_queue_v1';
export const PLAYER_STATE_STORAGE_KEY = 'capsule_tasks_player_state_v1';
export const CAPSULE_STORE_STORAGE_KEY = 'capsule_tasks_store_v2';
/** 破損データは、排他区間でv2を置き換える前にこのキーへ退避する。 */
export const CAPSULE_STORE_CORRUPT_BACKUP_KEY = 'capsule_tasks_store_corrupt_backup';
export const CAPSULE_STORE_LOCK_NAME = 'capsule_tasks_store';

export interface CapsuleStoreSnapshot {
  capsules: CapsuleTask[];
  playerState: PlayerState;
}

export interface CorruptStoreEntry {
  key: string;
  rawContent: string;
}

export interface StoreSnapshotReadResult {
  snapshot: CapsuleStoreSnapshot;
  corruptEntries: CorruptStoreEntry[];
}

export function createDefaultStoreSnapshot(todayKey: string): CapsuleStoreSnapshot {
  return {
    capsules: [...DEFAULT_INITIAL_CAPSULE_TASKS],
    playerState: createDefaultPlayerState(todayKey),
  };
}

/** localStorage の取得自体が SecurityError を投げる環境にも対応する。 */
export function getSafeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePlayerState(
  value: unknown,
  todayKey: string,
  fallback: PlayerState,
): PlayerState {
  const parsed = isPlainObject(value) ? (value as Partial<PlayerState>) : {};
  const nonNegativeInteger = (candidate: unknown, defaultValue: number) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.floor(candidate)
      : defaultValue;

  return {
    coins: nonNegativeInteger(parsed.coins, fallback.coins),
    totalCracked: nonNegativeInteger(parsed.totalCracked, fallback.totalCracked),
    todayCombo: resolveTodayComboForDate(
      nonNegativeInteger(parsed.todayCombo, fallback.todayCombo),
      typeof parsed.lastActiveDate === 'string' ? parsed.lastActiveDate : fallback.lastActiveDate,
      todayKey,
    ),
    customStamps:
      Array.isArray(parsed.customStamps) &&
      parsed.customStamps.length > 0 &&
      parsed.customStamps.every((stamp) => typeof stamp === 'string' && stamp.trim().length > 0)
        ? parsed.customStamps
        : fallback.customStamps.length > 0
          ? [...fallback.customStamps]
          : [...DEFAULT_CUSTOM_STAMPS],
    soundEnabled:
      typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : fallback.soundEnabled,
    lastActiveDate: todayKey,
  };
}

/**
 * 初期化・storageイベントでも使用するため、保存データには一切書き込まない。
 * 破損v2は削除せず、保持中の状態を返す。次の更新がロック内で退避・置換する。
 * getItem の例外は呼び出し元へ伝播する。
 */
export function readStoreSnapshot(
  storage: Storage | null,
  todayKey: string,
  fallback: CapsuleStoreSnapshot,
): StoreSnapshotReadResult {
  const corruptEntries: CorruptStoreEntry[] = [];
  let capsules: CapsuleTask[] = fallback.capsules;
  let playerState: unknown = fallback.playerState;

  if (storage) {
    const rawSnapshot = storage.getItem(CAPSULE_STORE_STORAGE_KEY);
    if (rawSnapshot !== null) {
      let parsed: Record<string, unknown> | null = null;
      let isValidV2Structure = false;
      try {
        const rawParsed: unknown = JSON.parse(rawSnapshot);
        if (
          isPlainObject(rawParsed) &&
          rawParsed.version === 2 &&
          Array.isArray(rawParsed.capsules)
        ) {
          parsed = rawParsed;
          isValidV2Structure = true;
        }
      } catch {
        isValidV2Structure = false;
      }

      if (isValidV2Structure && parsed && Array.isArray(parsed.capsules)) {
        const validTasks = parsed.capsules.filter(isValidCapsuleTask);
        const hasInvalidTask = validTasks.length !== parsed.capsules.length;
        const hasValidPlayerState = isPlainObject(parsed.playerState);

        if (hasInvalidTask || !hasValidPlayerState) {
          corruptEntries.push({ key: CAPSULE_STORE_STORAGE_KEY, rawContent: rawSnapshot });
        }

        if (parsed.capsules.length === 0 || validTasks.length > 0) {
          capsules = validTasks.filter((task) => task.status === 'pending');
        }
        if (hasValidPlayerState) {
          playerState = parsed.playerState;
        }
      } else {
        corruptEntries.push({ key: CAPSULE_STORE_STORAGE_KEY, rawContent: rawSnapshot });
      }
    } else {
      const rawCapsules = storage.getItem(CAPSULE_QUEUE_STORAGE_KEY);
      if (rawCapsules !== null) {
        try {
          const parsedCapsules: unknown = JSON.parse(rawCapsules);
          if (Array.isArray(parsedCapsules)) {
            const validTasks = parsedCapsules.filter(isValidCapsuleTask);
            if (validTasks.length !== parsedCapsules.length) {
              corruptEntries.push({ key: CAPSULE_QUEUE_STORAGE_KEY, rawContent: rawCapsules });
            }
            if (parsedCapsules.length === 0 || validTasks.length > 0) {
              capsules = validTasks.filter((task) => task.status === 'pending');
            }
          } else {
            corruptEntries.push({ key: CAPSULE_QUEUE_STORAGE_KEY, rawContent: rawCapsules });
          }
        } catch {
          corruptEntries.push({ key: CAPSULE_QUEUE_STORAGE_KEY, rawContent: rawCapsules });
        }
      }

      const rawPlayerState = storage.getItem(PLAYER_STATE_STORAGE_KEY);
      if (rawPlayerState !== null) {
        try {
          const parsedPlayer: unknown = JSON.parse(rawPlayerState);
          if (isPlainObject(parsedPlayer)) {
            playerState = parsedPlayer;
          } else {
            corruptEntries.push({ key: PLAYER_STATE_STORAGE_KEY, rawContent: rawPlayerState });
          }
        } catch {
          corruptEntries.push({ key: PLAYER_STATE_STORAGE_KEY, rawContent: rawPlayerState });
        }
      }
    }
  }

  return {
    snapshot: {
      capsules: capsules.filter(isValidCapsuleTask).filter((task) => task.status === 'pending'),
      playerState: normalizePlayerState(playerState, todayKey, fallback.playerState),
    },
    corruptEntries,
  };
}

/** 呼び出し元がWeb Locksを取得した状態でのみ実行する。 */
export function writeStoreSnapshot(
  storage: Storage,
  snapshot: CapsuleStoreSnapshot,
  corruptEntries: CorruptStoreEntry[] = [],
): void {
  if (corruptEntries.length > 0) {
    // 退避に失敗した場合は例外を伝播し、元データを削除・上書きしない。
    storage.setItem(
      CAPSULE_STORE_CORRUPT_BACKUP_KEY,
      JSON.stringify({ entries: corruptEntries, quarantinedAt: new Date().toISOString() }),
    );
  }
  // 破損v2も削除せず一括置換する。v2が存在しない隙間を作ると旧v1へ巻き戻ってしまう。
  storage.setItem(CAPSULE_STORE_STORAGE_KEY, JSON.stringify({ version: 2, ...snapshot }));
}
