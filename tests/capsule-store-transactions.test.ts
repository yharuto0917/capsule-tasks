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

  it('ロック非対応環境（HTTP LAN実機や古いiOS等）でも警告を出さず、ロックなしで読み直し→書き込みを継続する', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const { result } = renderHook(() => useCapsuleStore({ now }));
    await act(async () => {
      await result.current.supplyStampCapsule('掃除');
      await result.current.toggleSound();
    });
    expect(result.current.capsules).toHaveLength(4);
    expect(result.current.playerState.coins).toBe(160);
    expect(result.current.storageError).toBeNull();
    const saved = JSON.parse(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!);
    expect(saved.version).toBe(2);
    expect(saved.capsules).toHaveLength(4);
    expect(saved.playerState.coins).toBe(160);
  });

  it('v2 または v1 の保存JSONが破損している場合、退避キーにバックアップして自動復旧し、その後の保存も正常に行える', async () => {
    localStorage.setItem(CAPSULE_STORE_STORAGE_KEY, '{broken-json-v2');
    const { result } = renderHook(() => useCapsuleStore({ now }));

    // 破損データは退避キーへ移され、初期データで復旧していること
    expect(result.current.storageError).toBeNull();
    expect(result.current.capsules).toHaveLength(3);
    const backup = JSON.parse(localStorage.getItem(CAPSULE_STORE_CORRUPT_BACKUP_KEY)!);
    expect(backup.key).toBe(CAPSULE_STORE_STORAGE_KEY);
    expect(backup.rawContent).toBe('{broken-json-v2');

    // 続けて操作した際にエラーにならず正常に v2 保存できること
    await act(async () => {
      await result.current.supplyStampCapsule('復旧後のタスク');
    });
    expect(result.current.storageError).toBeNull();
    const saved = JSON.parse(localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!);
    expect(saved.capsules).toHaveLength(4);
    expect(saved.playerState.coins).toBe(160);
  });

  it('古い表示の開封操作で、別タブの更新後の次タスクを誤って開封しない', async () => {
    const { result: tabA } = renderHook(() => useCapsuleStore({ now }));
    const { result: tabB } = renderHook(() => useCapsuleStore({ now }));
    const displayedId = tabA.current.activeCapsule!.id;
    await act(async () => {
      await tabB.current.recycleActiveCapsule(displayedId);
    });
    await act(async () => {
      expect(await tabA.current.crackActiveCapsule(displayedId)).toBeNull();
    });
    expect(tabA.current.capsules).toHaveLength(2);
    expect(tabA.current.playerState.coins).toBe(155);
    expect(tabA.current.playerState.totalCracked).toBe(12);
  });
});
