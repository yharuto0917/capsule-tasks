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
  });
});
