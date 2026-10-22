import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CAPSULE_STORE_STORAGE_KEY, useCapsuleStore } from '../src/client/hooks/use-capsule-store';
import { useMedalStorage } from '../src/client/hooks/use-medal-storage';
import { clearAllMedals } from '../src/client/lib/indexed-db';
import {
  BASE_RARITY_PROBABILITIES,
  calculateComboMultiplier,
  calculateRarityProbabilities,
  resolveTodayComboForDate,
  rollMedalRarity,
} from '../src/client/lib/rarity-calculator';
import {
  CAPSULE_TASK_DRAFT_JSON_SCHEMA,
  isValidCapsuleTask,
  MINI_TASK_SPLIT_JSON_SCHEMA,
  TASK_EXTRACTION_JSON_SCHEMA,
  type MedalItem,
} from '../src/shared/schemas';

beforeEach(async () => {
  window.localStorage.clear();
  await clearAllMedals();
});

describe('1. 共通スキーマ定義と Structured Outputs JSON Schema (src/shared/schemas.ts)', () => {
  it('gemini-3.8-flash 用の TASK_EXTRACTION_JSON_SCHEMA と MINI_TASK_SPLIT_JSON_SCHEMA が必須プロパティを網羅している', () => {
    expect(TASK_EXTRACTION_JSON_SCHEMA.type).toBe('object');
    expect(TASK_EXTRACTION_JSON_SCHEMA.required).toContain('tasks');
    expect(CAPSULE_TASK_DRAFT_JSON_SCHEMA.properties.capsuleColor.enum).toEqual([
      'blue',
      'red',
      'gold',
    ]);
    expect(CAPSULE_TASK_DRAFT_JSON_SCHEMA.required).toEqual([
      'title',
      'capsuleColor',
      'rarityBoost',
      'medalPrompt',
    ]);
    expect(MINI_TASK_SPLIT_JSON_SCHEMA.required).toEqual(['task', 'encouragementMessage']);
  });

  it('isValidCapsuleTask が正常データと不正データを正しく判別する', () => {
    expect(
      isValidCapsuleTask({
        id: 'cap_001',
        title: '牛乳を買う',
        capsuleColor: 'blue',
        rarityBoost: 1.0,
        medalPrompt: 'Bronze medal with milk carton',
        createdAt: '2026-10-20T10:00:00Z',
        skipCount: 0,
        status: 'pending',
      }),
    ).toBe(true);

    expect(
      isValidCapsuleTask({
        id: 'cap_bad',
        title: '',
        capsuleColor: 'purple',
        rarityBoost: -1,
      }),
    ).toBe(false);
  });
});

describe('2. レア度抽選・コンボ補正ロジック (src/client/lib/rarity-calculator.ts)', () => {
  it('todayCombo=0, rarityBoost=1.0 のとき基準確率と一致し、確率合計が 1.0 になる', () => {
    const probs = calculateRarityProbabilities({ todayCombo: 0, rarityBoost: 1.0 });
    expect(probs.SSR).toBeCloseTo(BASE_RARITY_PROBABILITIES.SSR, 4);
    expect(probs.SR).toBeCloseTo(BASE_RARITY_PROBABILITIES.SR, 4);
    expect(probs.R).toBeCloseTo(BASE_RARITY_PROBABILITIES.R, 4);
    expect(probs.N).toBeCloseTo(BASE_RARITY_PROBABILITIES.N, 4);
    expect(probs.N + probs.R + probs.SR + probs.SSR).toBeCloseTo(1.0, 4);
  });

  it('todayCombo や rarityBoost が上昇すると SSR / SR の出現確率が単調増加する', () => {
    const baseProbs = calculateRarityProbabilities({ todayCombo: 0, rarityBoost: 1.0 });
    const comboProbs = calculateRarityProbabilities({ todayCombo: 5, rarityBoost: 1.0 });
    const goldComboProbs = calculateRarityProbabilities({ todayCombo: 5, rarityBoost: 2.0 });

    expect(calculateComboMultiplier(5)).toBeGreaterThan(1.0);
    expect(comboProbs.SSR).toBeGreaterThan(baseProbs.SSR);
    expect(comboProbs.SR).toBeGreaterThan(baseProbs.SR);

    expect(goldComboProbs.SSR).toBeGreaterThan(comboProbs.SSR);
    expect(goldComboProbs.SR).toBeGreaterThan(comboProbs.SR);
    expect(
      goldComboProbs.N + goldComboProbs.R + goldComboProbs.SR + goldComboProbs.SSR,
    ).toBeCloseTo(1.0, 3);
  });

  it('rollMedalRarity が乱数シードに応じて SSR / SR / R / N を正しく抽選する', () => {
    const input = { todayCombo: 2, rarityBoost: 1.5 };
    const probs = calculateRarityProbabilities(input);

    // 乱数が SSR 閾値未満なら SSR
    expect(rollMedalRarity(input, () => probs.SSR * 0.5)).toBe('SSR');
    // SSR 以上かつ SSR+SR 未満なら SR
    expect(rollMedalRarity(input, () => probs.SSR + probs.SR * 0.5)).toBe('SR');
    // SSR+SR 以上かつ SSR+SR+R 未満なら R
    expect(rollMedalRarity(input, () => probs.SSR + probs.SR + probs.R * 0.5)).toBe('R');
    // それ以上なら N
    expect(rollMedalRarity(input, () => 0.99)).toBe('N');
  });

  it('FR-16: 日付が変わった場合は todayCombo を 0 にリセットし、同一日は維持する', () => {
    expect(resolveTodayComboForDate(4, '2026-10-20', '2026-10-20')).toBe(4);
    expect(resolveTodayComboForDate(4, '2026-10-19', '2026-10-20')).toBe(0);
    expect(resolveTodayComboForDate(7, '2026-10-01', '2026-10-20')).toBe(0);
  });
});

describe('3. localStorage 永続化＆タスクキュー管理フック (useCapsuleStore)', () => {
  it('カプセル補充（+10コイン）、先送り（skipCount加算＆再配置）、リサイクル（+5コイン）、開封完了が動作し、リロード（再マウント）後も localStorage から完全復元される', async () => {
    const fixedDate = new Date('2026-10-20T12:00:00+09:00');
    const { result, unmount } = renderHook(() =>
      useCapsuleStore({
        now: () => fixedDate,
        randomFn: () => 0.001, // 確実に SSR が出る乱数
      }),
    );

    // 初期状態（3件、150コイン、3コンボ）
    expect(result.current.capsules).toHaveLength(3);
    expect(result.current.playerState.coins).toBe(150);
    expect(result.current.playerState.todayCombo).toBe(3);

    const firstId = result.current.activeCapsule?.id;
    expect(firstId).toBe('cap_demo_001');

    // 1. 先送り（skipCount が +1 され、キュー末尾へ回る）
    await act(async () => {
      await result.current.passActiveCapsule();
    });
    expect(result.current.activeCapsule?.id).toBe('cap_demo_002');
    expect(result.current.capsules[2].id).toBe('cap_demo_001');
    expect(result.current.capsules[2].skipCount).toBe(1);

    // 2. カプセル2件補充（1件につき +10コイン = +20コイン）
    await act(async () => {
      await result.current.supplyCapsules([
        {
          title: '牛乳と卵を買う',
          capsuleColor: 'blue',
          rarityBoost: 1.0,
          medalPrompt: 'Medal with milk and egg',
        },
        {
          title: '確定申告の書類をまとめる',
          capsuleColor: 'gold',
          rarityBoost: 2.0,
          medalPrompt: 'Golden tax conqueror medal',
        },
      ]);
    });
    expect(result.current.capsules).toHaveLength(5);
    expect(result.current.playerState.coins).toBe(170);

    // 3. リサイクル破棄（先頭カプセルを破棄し +5コイン）
    await act(async () => {
      await result.current.recycleActiveCapsule();
    });
    expect(result.current.capsules).toHaveLength(4);
    expect(result.current.playerState.coins).toBe(175);

    // 4. 開封完了（+30コイン、todayCombo +1、totalCracked +1、SSR抽選）
    let awardedRarity: string | undefined;
    await act(async () => {
      const outcome = await result.current.crackActiveCapsule();
      awardedRarity = outcome?.awardedRarity;
    });
    expect(awardedRarity).toBe('SSR');
    expect(result.current.capsules).toHaveLength(3);
    expect(result.current.playerState.coins).toBe(205);
    expect(result.current.playerState.todayCombo).toBe(4);
    expect(result.current.playerState.totalCracked).toBe(13);

    // アンマウントしてページリロードをシミュレート
    unmount();

    const { result: reloadedResult } = renderHook(() =>
      useCapsuleStore({
        now: () => fixedDate,
      }),
    );

    // リロード後もキューと PlayerState が完全に復元されていること
    expect(reloadedResult.current.capsules).toHaveLength(3);
    expect(reloadedResult.current.capsules[0].id).toBe('cap_demo_001');
    expect(reloadedResult.current.capsules[0].skipCount).toBe(1);
    expect(reloadedResult.current.playerState.coins).toBe(205);
    expect(reloadedResult.current.playerState.todayCombo).toBe(4);
    expect(reloadedResult.current.playerState.totalCracked).toBe(13);

    // localStorage にもJSONとして保存されていること
    const persisted = JSON.parse(window.localStorage.getItem(CAPSULE_STORE_STORAGE_KEY)!);
    expect(persisted.capsules).toHaveLength(3);
    expect(persisted.playerState.coins).toBe(205);
  });

  it('FR-16: 数日サボって別日にアプリを開いても、所持コインや累計開封数・キューは一切減らず todayCombo のみ 0 にリセットされる', async () => {
    const day1 = new Date('2026-10-20T15:00:00+09:00');
    const { result, unmount } = renderHook(() =>
      useCapsuleStore({
        now: () => day1,
      }),
    );

    await act(async () => {
      await result.current.supplyStampCapsule('掃除', 'blue');
    });
    expect(result.current.playerState.coins).toBe(160);
    expect(result.current.playerState.todayCombo).toBe(3);
    unmount();

    // 3日後に起動
    const day4 = new Date('2026-10-23T09:00:00+09:00');
    const { result: afterSkipDays } = renderHook(() =>
      useCapsuleStore({
        now: () => day4,
      }),
    );

    // ペナルティなし（コイン160枚、累計開封12個、カプセル4個は完全維持）、当日コンボのみ0
    expect(afterSkipDays.current.playerState.coins).toBe(160);
    expect(afterSkipDays.current.playerState.totalCracked).toBe(12);
    expect(afterSkipDays.current.capsules).toHaveLength(4);
    expect(afterSkipDays.current.playerState.todayCombo).toBe(0);
  });

  it('古い状態の別タブで操作しても、localStorage の最新状態を読み直して直列更新し、他タブのタスク・コインを消失させない', async () => {
    const fixedDate = new Date('2026-10-20T12:00:00+09:00');
    const { result: tabA } = renderHook(() => useCapsuleStore({ now: () => fixedDate }));
    const { result: tabB } = renderHook(() => useCapsuleStore({ now: () => fixedDate }));

    // タブBでタスクを補充（+10コイン -> 160コイン、カプセル4件）
    await act(async () => {
      await tabB.current.supplyStampCapsule('買い物', 'blue');
    });
    expect(tabB.current.capsules).toHaveLength(4);
    expect(tabB.current.playerState.coins).toBe(160);

    // StorageEvent が発火する前（または古い状態のまま）のタブAでさらにタスクを補充
    await act(async () => {
      await tabA.current.supplyStampCapsule('運動', 'red');
    });

    // タブBで追加したタスクとコインが上書き消失せず、合算（カプセル5件、170コイン）されていること
    expect(tabA.current.capsules).toHaveLength(5);
    expect(tabA.current.playerState.coins).toBe(170);
    expect(tabA.current.capsules.map((c) => c.title)).toContain('買い物');
    expect(tabA.current.capsules.map((c) => c.title)).toContain('運動');
  });

  it('window.localStorage の取得自体が SecurityError 等で例外を投げる環境でもクラッシュせず動作する', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });

    try {
      const { result } = renderHook(() => useCapsuleStore());
      expect(result.current.capsules).toHaveLength(3);
      expect(result.current.playerState.coins).toBe(150);

      await act(async () => {
        await result.current.supplyStampCapsule('掃除', 'blue');
      });
      expect(result.current.capsules).toHaveLength(4);
      expect(result.current.playerState.coins).toBe(160);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, 'localStorage', originalDescriptor);
      }
    }
  });
});

describe('4. IndexedDB メダル図鑑・画像データ永続化フック (useMedalStorage)', () => {
  it('MedalItem メタデータと画像（Base64 / Blob）を保存・取得し、レア度順および日付順でソートできる', async () => {
    const { result } = renderHook(() => useMedalStorage({ autoLoad: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const medalN: MedalItem = {
      medalId: 'medal_n_001',
      taskId: 'cap_001',
      taskTitle: 'ゴミ出しをする',
      medalName: '早朝クリーン勲章',
      engravedText: 'MORNING CLEANER',
      rarity: 'N',
      imageBlobKey: 'img_medal_n_001',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-20T08:00:00+09:00',
      upgradeLevel: 0,
    };

    const medalSSR: MedalItem = {
      medalId: 'medal_ssr_002',
      taskId: 'cap_002',
      taskTitle: '企画書ドラフトを提出する',
      medalName: 'ドラフト討伐の黄金勲章',
      engravedText: 'DRAFT CONQUEROR',
      rarity: 'SSR',
      imageBlobKey: 'img_medal_ssr_002',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-20T09:30:00+09:00',
      upgradeLevel: 0,
    };

    const medalSR: MedalItem = {
      medalId: 'medal_sr_003',
      taskId: 'cap_003',
      taskTitle: '30分ランニングする',
      medalName: '疾風のランナー勲章',
      engravedText: 'SONIC RUNNER',
      rarity: 'SR',
      imageBlobKey: 'img_medal_sr_003',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-20T11:00:00+09:00',
      upgradeLevel: 1,
    };

    const sampleBase64Image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const sampleBlob = new Blob(['fake-binary-png-data'], { type: 'image/png' });

    await act(async () => {
      await result.current.saveMedal({ medal: medalN, imageData: sampleBase64Image });
      await result.current.saveMedal({ medal: medalSSR, imageData: sampleBlob });
      await result.current.saveMedal({ medal: medalSR, imageData: sampleBase64Image });
    });

    expect(result.current.totalMedalCount).toBe(3);

    // デフォルトは日付の新しい順（date-desc: SR -> SSR -> N）
    expect(result.current.medals.map((m) => m.medalId)).toEqual([
      'medal_sr_003',
      'medal_ssr_002',
      'medal_n_001',
    ]);

    // レア度順（rarity-desc: SSR -> SR -> N）へ切り替え
    act(() => {
      result.current.setSortOrder('rarity-desc');
    });
    expect(result.current.medals.map((m) => m.rarity)).toEqual(['SSR', 'SR', 'N']);

    // レア度フィルタ（SSR のみ）
    act(() => {
      result.current.setRarityFilter('SSR');
    });
    expect(result.current.medals).toHaveLength(1);
    expect(result.current.medals[0].medalId).toBe('medal_ssr_002');

    // 画像データとメタデータの詳細取得検証
    const ssrDetail = await result.current.loadMedalDetail('medal_ssr_002');
    expect(ssrDetail).not.toBeNull();
    expect(ssrDetail?.medal.engravedText).toBe('DRAFT CONQUEROR');
    expect(ssrDetail?.imageData).toBeTruthy();
    expect(typeof ssrDetail?.imageData).not.toBe('string');
    expect(ssrDetail?.mimeType).toBe('image/png');

    const nDetail = await result.current.loadMedalDetail('medal_n_001');
    expect(nDetail?.imageData).toBe(sampleBase64Image);

    // 既存メダルを新しい imageBlobKey で更新した際、古い画像レコードが自動削除されること
    const upgradedMedalN: MedalItem = {
      ...medalN,
      rarity: 'SR',
      upgradeLevel: 1,
      imageBlobKey: 'img_medal_n_001_upgraded',
    };
    await act(async () => {
      await result.current.saveMedal({
        medal: upgradedMedalN,
        imageData: 'data:image/png;base64,UPGRADED',
      });
    });

    const oldImg = await result.current.loadMedalImage('img_medal_n_001');
    expect(oldImg).toBeNull();
    const newImg = await result.current.loadMedalImage('img_medal_n_001_upgraded');
    expect(newImg?.imageData).toBe('data:image/png;base64,UPGRADED');

    // imageData 未指定で imageBlobKey だけ変更した場合も、既存画像が新キーへ引き継がれて消失しないこと
    const keyRenamedMedalN: MedalItem = {
      ...upgradedMedalN,
      imageBlobKey: 'img_medal_n_001_renamed',
    };
    await act(async () => {
      await result.current.saveMedal({ medal: keyRenamedMedalN });
    });

    const prevKeyImg = await result.current.loadMedalImage('img_medal_n_001_upgraded');
    expect(prevKeyImg).toBeNull();
    const renamedImg = await result.current.loadMedalImage('img_medal_n_001_renamed');
    expect(renamedImg?.imageData).toBe('data:image/png;base64,UPGRADED');
  });

  it('indexedDB.open が SecurityError で失敗する環境でもインメモリフォールバックで保存・取得できる', async () => {
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    globalThis.indexedDB.open = (() => {
      throw new DOMException('IndexedDB is disabled in private mode', 'SecurityError');
    }) as typeof globalThis.indexedDB.open;

    try {
      const { result } = renderHook(() => useMedalStorage({ autoLoad: true }));
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const fallbackMedal: MedalItem = {
        medalId: 'medal_mem_001',
        taskId: 'cap_mem_001',
        taskTitle: 'プライベートモードのタスク',
        medalName: 'メモリフォールバック勲章',
        engravedText: 'MEMORY GUARD',
        rarity: 'R',
        imageBlobKey: 'img_medal_mem_001',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-20T12:00:00+09:00',
        upgradeLevel: 0,
      };

      await act(async () => {
        await result.current.saveMedal({
          medal: fallbackMedal,
          imageData: 'data:image/png;base64,MEM_FALLBACK',
        });
      });

      expect(result.current.error).toBeNull();
      expect(result.current.medals).toHaveLength(1);
      const detail = await result.current.loadMedalDetail('medal_mem_001');
      expect(detail?.imageData).toBe('data:image/png;base64,MEM_FALLBACK');
    } finally {
      globalThis.indexedDB.open = originalOpen;
    }
  });

  it('一時的な indexedDB.open 失敗時にメモリへ保存されたメダルと画像が、次の open 成功時に IndexedDB へ自動移行されて取得できる', async () => {
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    const { result } = renderHook(() => useMedalStorage({ autoLoad: true }));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // 1件目は正常な IndexedDB に保存
    const firstMedal: MedalItem = {
      medalId: 'medal_idb_001',
      taskId: 'cap_idb_001',
      taskTitle: '通常のタスク',
      medalName: '通常保存勲章',
      engravedText: 'NORMAL SAVE',
      rarity: 'N',
      imageBlobKey: 'img_medal_idb_001',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-20T10:00:00+09:00',
      upgradeLevel: 0,
    };
    await act(async () => {
      await result.current.saveMedal({
        medal: firstMedal,
        imageData: 'data:image/png;base64,FIRST_IDB',
      });
    });

    // 2件目の保存時のみ indexedDB.open が一時的に失敗する状況を再現
    let failCount = 0;
    globalThis.indexedDB.open = ((...args: Parameters<typeof globalThis.indexedDB.open>) => {
      if (failCount < 1) {
        failCount += 1;
        throw new DOMException('Temporary blocked error', 'InvalidStateError');
      }
      return originalOpen(...args);
    }) as typeof globalThis.indexedDB.open;

    try {
      const transientMedal: MedalItem = {
        medalId: 'medal_transient_002',
        taskId: 'cap_transient_002',
        taskTitle: '一時エラー中のタスク',
        medalName: '一時メモリ退避勲章',
        engravedText: 'TRANSIENT RECOVERY',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_transient_002',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-20T11:00:00+09:00',
        upgradeLevel: 0,
      };

      await act(async () => {
        await result.current.saveMedal({
          medal: transientMedal,
          imageData: 'data:image/png;base64,TRANSIENT_IMG',
        });
      });

      // open 回復後、1件目（IndexedDB）と2件目（メモリから自動移行）の両方が取得できること
      expect(result.current.medals.map((m) => m.medalId)).toEqual([
        'medal_transient_002',
        'medal_idb_001',
      ]);
      const migratedDetail = await result.current.loadMedalDetail('medal_transient_002');
      expect(migratedDetail?.medal.medalName).toBe('一時メモリ退避勲章');
      expect(migratedDetail?.imageData).toBe('data:image/png;base64,TRANSIENT_IMG');
    } finally {
      globalThis.indexedDB.open = originalOpen;
    }
  });

  it('DB利用不能中にメダルを削除し、同じIDで画像なし保存した場合、DB復旧後に古い画像が復活しない', async () => {
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    const { result } = renderHook(() => useMedalStorage({ autoLoad: true }));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const initialMedal: MedalItem = {
      medalId: 'medal_reused_001',
      taskId: 'cap_reused_001',
      taskTitle: '最初のタスク',
      medalName: '初期画像付き勲章',
      engravedText: 'INITIAL IMAGE',
      rarity: 'R',
      imageBlobKey: 'img_medal_reused_001',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-20T10:00:00+09:00',
      upgradeLevel: 0,
    };

    // 1. 正常な IndexedDB に画像付きで保存
    await act(async () => {
      await result.current.saveMedal({
        medal: initialMedal,
        imageData: 'data:image/png;base64,OLD_RESURRECT_IMAGE',
      });
    });

    // 2. IndexedDB が一時利用不能になった状態で、削除 → 同じIDで画像なし保存を実行
    let dbUnavailable = true;
    globalThis.indexedDB.open = ((...args: Parameters<typeof globalThis.indexedDB.open>) => {
      if (dbUnavailable) {
        throw new DOMException('Temporary unavailable', 'InvalidStateError');
      }
      return originalOpen(...args);
    }) as typeof globalThis.indexedDB.open;

    try {
      await act(async () => {
        await result.current.removeMedal('medal_reused_001');
        await result.current.saveMedal({
          medal: {
            ...initialMedal,
            medalName: '画像なし再作成勲章',
          },
        });
      });

      // 3. IndexedDB 復旧後に詳細と画像を取得し、削除したはずの古い画像が復活していないことを検証
      dbUnavailable = false;
      await act(async () => {
        await result.current.refreshMedals();
      });

      expect(result.current.medals).toHaveLength(1);
      expect(result.current.medals[0].medalName).toBe('画像なし再作成勲章');

      const detail = await result.current.loadMedalDetail('medal_reused_001');
      expect(detail?.medal.medalName).toBe('画像なし再作成勲章');
      expect(detail?.imageData).toBeNull();
      expect(await result.current.loadMedalImage('img_medal_reused_001')).toBeNull();
    } finally {
      globalThis.indexedDB.open = originalOpen;
    }
  });

  it('復旧移行トランザクションの途中で再度 clearMedals が呼ばれた場合、新しい世代の全件削除が取り消されずメダルが復活しない', async () => {
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    const { result } = renderHook(() => useMedalStorage({ autoLoad: true }));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const medalA: MedalItem = {
      medalId: 'medal_clear_race_001',
      taskId: 'cap_clear_race_001',
      taskTitle: 'クリア競合テスト',
      medalName: '消えるべき勲章',
      engravedText: 'MUST NOT RESURRECT',
      rarity: 'SR',
      imageBlobKey: 'img_medal_clear_race_001',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-20T10:00:00+09:00',
      upgradeLevel: 0,
    };

    // 1. DB利用不能中に全件削除（世代1）とメダル保存を行う
    let dbUnavailable = true;
    globalThis.indexedDB.open = ((...args: Parameters<typeof globalThis.indexedDB.open>) => {
      if (dbUnavailable) {
        throw new DOMException('Temporary unavailable', 'InvalidStateError');
      }
      return originalOpen(...args);
    }) as typeof globalThis.indexedDB.open;

    try {
      await act(async () => {
        await result.current.clearMedals();
        await result.current.saveMedal({
          medal: medalA,
          imageData: 'data:image/png;base64,RACE_IMG',
        });
      });

      // 2. 次の open 成功時に移行トランザクションが走る最中に、再度 DB利用不能状態で clearMedals（世代2）を発火させる
      let hookedOpen = false;
      let triggeredConcurrentClear = false;
      globalThis.indexedDB.open = ((...args: Parameters<typeof globalThis.indexedDB.open>) => {
        if (dbUnavailable) {
          throw new DOMException('Temporary unavailable', 'InvalidStateError');
        }
        const req = originalOpen(...args);
        if (!hookedOpen) {
          hookedOpen = true;
          req.addEventListener('success', () => {
            const db = req.result;
            const origTx = db.transaction.bind(db);
            db.transaction = ((...txArgs: Parameters<typeof db.transaction>) => {
              const tx = origTx(...txArgs);
              if (!triggeredConcurrentClear) {
                triggeredConcurrentClear = true;
                // 移行トランザクション開始直後（完了前）に別操作として再度 clearMedals（世代2）を実行
                dbUnavailable = true;
                void result.current.clearMedals().finally(() => {
                  dbUnavailable = false;
                });
              }
              return tx;
            }) as typeof db.transaction;
          });
        }
        return req;
      }) as typeof globalThis.indexedDB.open;

      dbUnavailable = false;
      await act(async () => {
        await result.current.refreshMedals();
        await result.current.refreshMedals();
      });

      expect(result.current.medals).toHaveLength(0);
      expect(await result.current.loadMedalDetail('medal_clear_race_001')).toBeNull();
    } finally {
      globalThis.indexedDB.open = originalOpen;
    }
  });
});
