import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCapsuleStore } from '../src/client/hooks/use-capsule-store';
import {
  CAPSULE_QUEUE_STORAGE_KEY,
  PLAYER_STATE_STORAGE_KEY,
  CAPSULE_STORE_STORAGE_KEY,
  CAPSULE_STORE_CORRUPT_BACKUP_KEY,
  CAPSULE_STORE_LOCK_NAME,
} from '../src/client/lib/capsule-store-storage';
import { createDefaultPlayerState, DEFAULT_INITIAL_CAPSULE_TASKS } from '../src/shared/schemas';

const now = () => new Date('2026-10-22T12:00:00+09:00');

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('カプセル更新の排他制御と保存失敗', () => {
  it('既存の v1 データを読み込み、キューと残高を一つの v2 データへ保存する', async () => {
    const legacyCapsules = DEFAULT_INITIAL_CAPSULE_TASKS.slice(1);
    const legacyPlayer = { ...createDefaultPlayerState('2026-10-21'), coins: 77 };
    localStorage.setItem(CAPSULE_QUEUE_STORAGE_KEY, JSON.stringify(legacyCapsules));
    localStorage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify(legacyPlayer));
    const { result } = renderHook(() => useCapsuleStore({ now }));
    expect(result.current.capsules).toEqual(legacyCapsules);
    expect(result.current.playerState.coins).toBe(77);
    expect(result.current.playerState.todayCombo).toBe(0);
    // 初期化中には書かず、更新時のロック内で移行する。
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBeNull();

    await act(async () => {
      await result.current.supplyStampCapsule('新しいタスク');
    });
    const saved = JSON.parse(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!);
    expect(saved.version).toBe(2);
    expect(saved.capsules).toHaveLength(3);
    expect(saved.playerState.coins).toBe(87);
    expect(JSON.parse(localStorage.getItem(CAPSULE_QUEUE_STORAGE_KEY)!)).toEqual(legacyCapsules);
  });

  it('別タブのロック解放を待ち、同時補充のタスクとコインをすべて保存する', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldLock = navigator.locks.request(
      CAPSULE_STORE_LOCK_NAME,
      { mode: 'exclusive' },
      () => gate,
    );
    const { result: tabA } = renderHook(() => useCapsuleStore({ now }));
    const { result: tabB } = renderHook(() => useCapsuleStore({ now }));
    let operationA!: Promise<unknown>;
    let operationB!: Promise<unknown>;
    await act(async () => {
      operationA = tabA.current.supplyStampCapsule('タブA');
      operationB = tabB.current.supplyStampCapsule('タブB');
    });
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBeNull();
    expect(tabA.current.isUpdating).toBe(true);
    expect(tabB.current.isUpdating).toBe(true);

    await act(async () => {
      release();
      await heldLock;
      await Promise.all([operationA, operationB]);
    });
    const saved = JSON.parse(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!);
    expect(saved.capsules).toHaveLength(5);
    expect(saved.capsules.map((task: { title: string }) => task.title)).toEqual(
      expect.arrayContaining(['タブA', 'タブB']),
    );
    expect(saved.playerState.coins).toBe(170);
    expect(tabA.current.isUpdating).toBe(false);
    expect(tabB.current.isUpdating).toBe(false);
  });

  it('保存失敗後はメモリ状態を維持し、他タブの保存値も上書きしない', async () => {
    const { result: tabA } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await tabA.current.toggleSound();
    });
    const beforeFailure = localStorage.getItem(CAPSULE_STORE_STORAGE_KEY);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    await act(async () => {
      await tabA.current.supplyStampCapsule('未保存タスク');
    });
    expect(tabA.current.capsules).toHaveLength(4);
    expect(tabA.current.playerState.coins).toBe(160);
    expect(tabA.current.storageError).toContain('再読み込み');
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe(beforeFailure);

    await act(async () => {
      await tabA.current.toggleSound();
      await tabA.current.passActiveCapsule();
    });
    expect(tabA.current.capsules).toHaveLength(4);
    expect(tabA.current.playerState.coins).toBe(160);
    // 失敗した保存一回以降は、再保存で別タブのデータを壊さない。
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();

    const { result: tabB } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await tabB.current.supplyStampCapsule('他タブのタスク');
    });
    const otherTabSaved = localStorage.getItem(CAPSULE_STORE_STORAGE_KEY);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: CAPSULE_STORE_STORAGE_KEY, storageArea: localStorage }),
      );
    });
    await act(async () => {
      await tabA.current.supplyStampCapsule('未保存の追加');
    });
    expect(tabA.current.capsules.map((task) => task.title)).toEqual(
      expect.arrayContaining(['未保存タスク', '未保存の追加']),
    );
    expect(tabA.current.capsules).toHaveLength(5);
    expect(tabA.current.playerState.coins).toBe(170);
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe(otherTabSaved);
  });

  it('ロック非対応環境では共有ストレージを書き換えず、警告を表示してメモリで継続する', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const { result } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await result.current.supplyStampCapsule('掃除');
      await result.current.toggleSound();
    });
    expect(result.current.capsules).toHaveLength(4);
    expect(result.current.playerState.coins).toBe(160);
    expect(result.current.storageError).toContain('再読み込み');
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBeNull();
  });

  it('v2 または v1 の保存JSONが破損している場合、退避キーにバックアップして自動復旧し、その後の保存も正常に行える', async () => {
    localStorage.setItem(CAPSULE_STORE_STORAGE_KEY, '{broken-json-v2');
    const { result } = renderHook(() => useCapsuleStore({ now }));

    // 初期化は読み込みのみ。破損キーの削除やロック外での退避は行わない。
    expect(result.current.storageError).toBeNull();
    expect(result.current.capsules).toHaveLength(3);
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe('{broken-json-v2');
    expect(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)).toBeNull();

    // 次の更新の排他区間で、原文を退避してから v2 を置き換える。
    await act(async () => {
      await result.current.supplyStampCapsule('復旧後のタスク');
    });
    expect(result.current.storageError).toBeNull();
    const saved = JSON.parse(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!);
    expect(saved.capsules).toHaveLength(4);
    expect(saved.playerState.coins).toBe(160);
    const backup = JSON.parse(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)!);
    expect(backup.entries).toEqual([
      { key: CAPSULE_STORE_STORAGE_KEY, rawContent: '{broken-json-v2' },
    ]);
  });

  it('ロック取得が拒否された場合も共有データを更新せず、操作順とメモリ状態を保つ', async () => {
    localStorage.setItem(CAPSULE_STORE_STORAGE_KEY, '{broken-json-v2');
    vi.spyOn(navigator.locks, 'request').mockRejectedValue(
      new DOMException('Denied', 'SecurityError'),
    );
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await result.current.supplyStampCapsule('未保存タスク');
      await result.current.toggleSound();
    });
    expect(result.current.capsules).toHaveLength(4);
    expect(result.current.playerState.coins).toBe(160);
    expect(result.current.storageError).toContain('再読み込み');
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe('{broken-json-v2');
  });

  it('破損v2の復旧後も完了済みタスクと残高を古いv1へ巻き戻さない', async () => {
    localStorage.setItem(CAPSULE_QUEUE_STORAGE_KEY, JSON.stringify(DEFAULT_INITIAL_CAPSULE_TASKS));
    localStorage.setItem(
      PLAYER_STATE_STORAGE_KEY,
      JSON.stringify(createDefaultPlayerState('2026-10-22')),
    );
    const { result, unmount } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await result.current.crackActiveCapsule();
    });
    expect(result.current.capsules).toHaveLength(2);
    expect(result.current.playerState.coins).toBe(180);

    localStorage.setItem(CAPSULE_STORE_STORAGE_KEY, '{broken-json-v2');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: CAPSULE_STORE_STORAGE_KEY,
          storageArea: localStorage,
        }),
      );
    });
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe('{broken-json-v2');
    expect(result.current.capsules).toHaveLength(2);
    expect(result.current.playerState.coins).toBe(180);

    await act(async () => {
      await result.current.toggleSound();
    });
    expect(remove).not.toHaveBeenCalled();
    expect(result.current.capsules.map((task) => task.id)).not.toContain('cap_demo_001');
    expect(result.current.playerState.coins).toBe(180);
    unmount();
    const { result: reloaded } = renderHook(() => useCapsuleStore({ now }));
    expect(reloaded.current.capsules).toHaveLength(2);
    expect(reloaded.current.playerState.coins).toBe(180);
  });

  it('破損を検知した後でも、ロック待ち中に別タブが復旧した最新データを優先する', async () => {
    localStorage.setItem(CAPSULE_STORE_STORAGE_KEY, '{broken-json-v2');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldLock = navigator.locks.request(
      CAPSULE_STORE_LOCK_NAME,
      { mode: 'exclusive' },
      async () => {
        await gate;
        localStorage.setItem(
          CAPSULE_STORE_STORAGE_KEY,
          JSON.stringify({
            version: 2,
            capsules: [],
            playerState: { ...createDefaultPlayerState('2026-10-22'), coins: 999 },
          }),
        );
      },
    );
    const { result } = renderHook(() => useCapsuleStore({ now }));
    let operation!: Promise<unknown>;
    await act(async () => {
      operation = result.current.supplyStampCapsule('復旧後の追加');
    });
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe('{broken-json-v2');
    expect(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)).toBeNull();
    await act(async () => {
      release();
      await heldLock;
      await operation;
    });
    expect(result.current.capsules).toHaveLength(1);
    expect(result.current.playerState.coins).toBe(1009);
    expect(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)).toBeNull();
  });

  it('破損原文の退避に失敗した場合は元データを残し、以後の変更をメモリに保持する', async () => {
    localStorage.setItem(CAPSULE_STORE_STORAGE_KEY, '{broken-json-v2');
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await result.current.supplyStampCapsule('未保存タスク');
      await result.current.toggleSound();
    });
    expect(result.current.capsules).toHaveLength(4);
    expect(result.current.playerState.coins).toBe(160);
    expect(result.current.storageError).toContain('再読み込み');
    expect(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)).toBe('{broken-json-v2');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(CAPSULE_STORE_CORRUPT_BACKUP_KEY);
  });

  it('v1の両キーが破損している場合も、原文をまとめて退避してv2へ移行する', async () => {
    localStorage.setItem(CAPSULE_QUEUE_STORAGE_KEY, '{broken-queue');
    localStorage.setItem(PLAYER_STATE_STORAGE_KEY, '{broken-player');
    const { result } = renderHook(() => useCapsuleStore({ now }));
    expect(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)).toBeNull();
    await act(async () => {
      await result.current.supplyStampCapsule('復旧後の追加');
    });
    const backup = JSON.parse(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)!);
    expect(backup.entries).toEqual([
      { key: CAPSULE_QUEUE_STORAGE_KEY, rawContent: '{broken-queue' },
      { key: PLAYER_STATE_STORAGE_KEY, rawContent: '{broken-player' },
    ]);
    expect(result.current.capsules).toHaveLength(4);
    expect(JSON.parse(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!).playerState.coins).toBe(
      160,
    );
  });

  it('古い表示の開封操作で、別タブの更新後の次タスクを誤って開封しない', async () => {
    const { result: tabA } = renderHook(() => useCapsuleStore({ now }));
    const { result: tabB } = renderHook(() => useCapsuleStore({ now }));
    const displayedId = tabA.current.activeCapsule!.id;
    await act(async () => {
      await tabB.current.recycleActiveCapsule(displayedId);
    });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    await act(async () => {
      expect(await tabA.current.crackActiveCapsule(displayedId)).toBeNull();
    });
    expect(write).not.toHaveBeenCalled();
    expect(tabA.current.capsules).toHaveLength(2);
    expect(tabA.current.playerState.coins).toBe(155);
    expect(tabA.current.playerState.totalCracked).toBe(12);
  });

  it('syncDateComboState は同一日ならストレージ書き込みを行わず、日付変更時のみ todayCombo を 0 に更新する', async () => {
    let currentNow = new Date('2026-10-22T12:00:00+09:00');
    const { result } = renderHook(() => useCapsuleStore({ now: () => currentNow }));
    const write = vi.spyOn(Storage.prototype, 'setItem');

    await act(async () => {
      await result.current.syncDateComboState();
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.current.playerState.todayCombo).toBe(3);

    currentNow = new Date('2026-10-23T08:00:00+09:00');
    await act(async () => {
      await result.current.syncDateComboState();
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.current.playerState.todayCombo).toBe(0);
  });

  it('v2 の capsules 内に不正要素が含まれる場合や playerState が不正な場合も退避バックアップを作成し、カスタムスタンプを維持する', async () => {
    const { result } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await result.current.updateCustomStamps(['筋トレ', '読書']);
    });
    expect(result.current.playerState.customStamps).toEqual(['筋トレ', '読書']);

    // v2 に不正なタスク要素と壊れた playerState を混入させる
    localStorage.setItem(
      CAPSULE_STORE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        capsules: [DEFAULT_INITIAL_CAPSULE_TASKS[0], { brokenTask: true }],
        playerState: null,
      }),
    );

    await act(async () => {
      await result.current.toggleSound();
    });

    const backup = JSON.parse(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)!);
    expect(backup.entries).toHaveLength(1);
    expect(backup.entries[0].key).toBe(CAPSULE_STORE_STORAGE_KEY);
    expect(result.current.capsules).toHaveLength(1);
    expect(result.current.playerState.customStamps).toEqual(['筋トレ', '読書']);
  });
});
