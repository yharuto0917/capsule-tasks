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
/** 破損していた JSON や不正フォーマットの退避先キー（自力復旧を可能にするため退避後に元キーを削除する） */
export const CAPSULE_STORE_CORRUPT_BACKUP_KEY = 'capsule_tasks_store_corrupt_backup';
export const CAPSULE_STORE_LOCK_NAME = 'capsule_tasks_store';

export interface CapsuleStoreSnapshot {
  capsules: CapsuleTask[];
  playerState: PlayerState;
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

function normalizePlayerState(
  value: unknown,
  todayKey: string,
  fallback: PlayerState,
): PlayerState {
  const parsed = typeof value === 'object' && value !== null ? (value as Partial<PlayerState>) : {};
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
        : [...DEFAULT_CUSTOM_STAMPS],
    soundEnabled:
      typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : fallback.soundEnabled,
    lastActiveDate: todayKey,
  };
}

/**
 * 破損した保存データを退避用キーにバックアップしたうえで問題のキーを削除し、
 * 以降の保存やリロードで毎回エラーに陥らず復旧できるようにする。
 */
function quarantineCorruptKey(storage: Storage, key: string, rawContent: string): void {
  try {
    storage.setItem(
      CAPSULE_STORE_CORRUPT_BACKUP_KEY,
      JSON.stringify({
        key,
        rawContent,
        quarantinedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // 退避書き込み自体が容量超過等で失敗しても、破損キーの削除は試みる
  }
  try {
    storage.removeItem(key);
  } catch {
    // 削除不能な場合は無視
  }
}

/**
 * ストレージから最新のストア状態を読み込む。
 * - `getItem` 自体が SecurityError 等を投げる場合は呼び出し元へ例外を伝播する。
 * - 保存されている文字列が壊れた JSON または不正な v2 構造だった場合は、
 *   `CAPSULE_STORE_CORRUPT_BACKUP_KEY` に退避して該当キーを削除し、`fallback` で復旧する。
 */
export function readStoreSnapshot(
  storage: Storage | null,
  todayKey: string,
  fallback: CapsuleStoreSnapshot,
): CapsuleStoreSnapshot {
  let capsules: unknown = fallback.capsules;
  let playerState: unknown = fallback.playerState;

  if (storage) {
    const rawSnapshot = storage.getItem(CAPSULE_STORE_STORAGE_KEY);
    if (rawSnapshot !== null) {
      let parsed: Record<string, unknown> | null = null;
      let isValidV2: boolean;
      try {
        parsed = JSON.parse(rawSnapshot) as Record<string, unknown> | null;
        isValidV2 = Boolean(parsed && parsed.version === 2 && Array.isArray(parsed.capsules));
      } catch {
        isValidV2 = false;
      }

      if (isValidV2 && parsed) {
        capsules = parsed.capsules;
        playerState = parsed.playerState;
      } else {
        quarantineCorruptKey(storage, CAPSULE_STORE_STORAGE_KEY, rawSnapshot);
      }
    } else {
      const rawCapsules = storage.getItem(CAPSULE_QUEUE_STORAGE_KEY);
      if (rawCapsules !== null) {
        try {
          const parsedCapsules: unknown = JSON.parse(rawCapsules);
          if (Array.isArray(parsedCapsules)) {
            capsules = parsedCapsules;
          } else {
            quarantineCorruptKey(storage, CAPSULE_QUEUE_STORAGE_KEY, rawCapsules);
          }
        } catch {
          quarantineCorruptKey(storage, CAPSULE_QUEUE_STORAGE_KEY, rawCapsules);
        }
      }

      const rawPlayerState = storage.getItem(PLAYER_STATE_STORAGE_KEY);
      if (rawPlayerState !== null) {
        try {
          const parsedPlayer: unknown = JSON.parse(rawPlayerState);
          if (
            typeof parsedPlayer === 'object' &&
            parsedPlayer !== null &&
            !Array.isArray(parsedPlayer)
          ) {
            playerState = parsedPlayer;
          } else {
            quarantineCorruptKey(storage, PLAYER_STATE_STORAGE_KEY, rawPlayerState);
          }
        } catch {
          quarantineCorruptKey(storage, PLAYER_STATE_STORAGE_KEY, rawPlayerState);
        }
      }
    }
  }

  return {
    capsules: Array.isArray(capsules)
      ? capsules.filter(isValidCapsuleTask).filter((task) => task.status === 'pending')
      : fallback.capsules,
    playerState: normalizePlayerState(playerState, todayKey, fallback.playerState),
  };
}

export function writeStoreSnapshot(storage: Storage, snapshot: CapsuleStoreSnapshot): void {
  // setItem 一回で保存するため、キューだけ成功し残高が失敗する状態を作らない。
  storage.setItem(CAPSULE_STORE_STORAGE_KEY, JSON.stringify({ version: 2, ...snapshot }));
}
