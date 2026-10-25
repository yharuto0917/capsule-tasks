import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, PENDING_MEDAL_GENERATIONS_STORAGE_KEY } from '../src/client/app';
import { MedalCollectionDrawer } from '../src/client/components/medal-collection-drawer';
import { MedalRevealModal } from '../src/client/components/medal-reveal-modal';
import { generateCommemorativeMedal } from '../src/client/lib/api-client';
import {
  ReplaceTargetNotFoundError,
  clearAllMedals,
  deleteMedalById,
  getMedalWithImage,
  isReplaceTargetNotFoundError,
  listMedals,
  saveMedalWithImage,
} from '../src/client/lib/indexed-db';
import serverApp from '../src/server/index';
import { setGeminiClientFactoryForTests } from '../src/server/lib/gemini-client';
import {
  MEDAL_FRAME_REFERENCES,
  getMedalFrameReference,
  getThinkingLevelForRarity,
} from '../src/server/lib/medal-frames';
import {
  MEDAL_GENERATION_MODEL,
  extractGeneratedImageFromInteraction,
  resolveEngravedText,
} from '../src/server/routes/medals-generate';
import type { MedalGenerateResponse, MedalItem } from '../src/shared/schemas';

beforeEach(async () => {
  window.localStorage.clear();
  await clearAllMedals();
  setGeminiClientFactoryForTests(null);
});

afterEach(() => {
  setGeminiClientFactoryForTests(null);
  vi.restoreAllMocks();
});

describe('1. ベースメダル枠参照データ (src/server/lib/medal-frames.ts)', () => {
  it('N(ブロンズ)/R(シルバー)/SR(ゴールド)/SSR(ホログラム)の参照枠データと thinking_level 対応が定義されている', () => {
    expect(MEDAL_FRAME_REFERENCES.N.frameId).toBe('frame_n_bronze');
    expect(MEDAL_FRAME_REFERENCES.R.frameId).toBe('frame_r_silver');
    expect(MEDAL_FRAME_REFERENCES.SR.frameId).toBe('frame_sr_gold');
    expect(MEDAL_FRAME_REFERENCES.SSR.frameId).toBe('frame_ssr_hologram');

    expect(getThinkingLevelForRarity('N')).toBe('minimal');
    expect(getThinkingLevelForRarity('R')).toBe('minimal');
    expect(getThinkingLevelForRarity('SR')).toBe('medium');
    expect(getThinkingLevelForRarity('SSR')).toBe('medium');

    for (const rarity of ['N', 'R', 'SR', 'SSR'] as const) {
      const ref = getMedalFrameReference(rarity);
      expect(ref.mimeType).toBe('image/png');
      expect(ref.referenceImageBase64.length).toBeGreaterThan(20);
      expect(ref.fallbackSvgDataUrl).toContain('data:image/svg+xml');
    }
  });
});

describe('2. POST /api/medals/generate (gemini-nano-banana-2.1 記念メダル生成 Hono API)', () => {
  it('GEMINI_API_KEY が未設定の場合は 503 を返す', async () => {
    const res = await serverApp.request(
      '/api/medals/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: '企画書ドラフトを提出する',
          medalPrompt: 'Golden medal',
          rarity: 'SSR',
        }),
      },
      { GEMINI_API_KEY: '' },
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('GEMINI_API_KEY');
  });

  it('taskTitle と medalPrompt が両方空、または不正な rarity の場合は 400 Bad Request を返す', async () => {
    const emptyRes = await serverApp.request(
      '/api/medals/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskTitle: '   ', medalPrompt: '' }),
      },
      { GEMINI_API_KEY: 'test-dummy-key' },
    );
    expect(emptyRes.status).toBe(400);

    const invalidRarityRes = await serverApp.request(
      '/api/medals/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: '洗濯物をたたむ',
          rarity: 'UR_INVALID',
        }),
      },
      { GEMINI_API_KEY: 'test-dummy-key' },
    );
    expect(invalidRarityRes.status).toBe(400);
  });

  it('通常レア度（N/R）では thinking_level: minimal、response_format: { type: image, aspect_ratio: 1:1, image_size: 1K }、Multi-image fusion でメダル画像を生成する', async () => {
    const createInteractionMock = vi.fn().mockResolvedValue({
      output_image: {
        type: 'image',
        mime_type: 'image/jpeg',
        data: '/9j/4AAQSkZJRgABAQAAAQABAAD/',
      },
    });

    setGeminiClientFactoryForTests(() => ({
      interactions: {
        create: createInteractionMock as never,
      },
    }));

    const customFetch: typeof fetch = (input, init) =>
      Promise.resolve(serverApp.request(input, init, { GEMINI_API_KEY: 'test-dummy-key' }));

    const result = await generateCommemorativeMedal(
      {
        taskId: 'cap_demo_002',
        taskTitle: '溜まった洗濯物をたたむ',
        medalPrompt:
          "A shining bronze commemorative medal featuring folded clothes, engraved text 'LAUNDRY MASTER' along the rim",
        rarity: 'N',
      },
      customFetch,
    );

    expect(createInteractionMock).toHaveBeenCalledTimes(1);
    const callArgs = createInteractionMock.mock.calls[0][0];
    expect(callArgs.model).toBe(MEDAL_GENERATION_MODEL);
    expect(callArgs.generation_config).toEqual({
      thinking_level: 'minimal',
    });
    expect(callArgs.response_format).toEqual({
      type: 'image',
      mime_type: 'image/jpeg',
      aspect_ratio: '1:1',
      image_size: '1K',
    });

    // Multi-image fusion: 1つ目にブロンズ参照枠画像、2つ目にテキストプロンプト
    expect(callArgs.input).toHaveLength(2);
    expect(callArgs.input[0]).toEqual({
      type: 'image',
      data: MEDAL_FRAME_REFERENCES.N.referenceImageBase64,
      mime_type: 'image/png',
    });
    expect(callArgs.input[1].type).toBe('text');
    expect(callArgs.input[1].text).toContain('LAUNDRY MASTER');

    expect(result.thinkingLevel).toBe('minimal');
    expect(result.medal.rarity).toBe('N');
    expect(result.medal.engravedText).toBe('LAUNDRY MASTER');
    expect(result.medal.modelUsed).toBe('gemini-nano-banana-2.1');
    expect(result.imageDataUrl).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/');
  });

  it('高レア度（SR/SSR）では thinking_level: medium とホログラム/ゴールド参照枠画像を使用し、steps 配列内の画像パートからも抽出できる', async () => {
    const createInteractionMock = vi.fn().mockResolvedValue({
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'image',
              mime_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            },
          ],
        },
      ],
    });

    setGeminiClientFactoryForTests(() => ({
      interactions: {
        create: createInteractionMock as never,
      },
    }));

    const res = await serverApp.request(
      '/api/medals/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'cap_demo_001',
          taskTitle: '企画書ドラフトを提出する',
          medalPrompt: 'A gleaming holographic medal with a glowing document scroll',
          engravedText: 'DRAFT CONQUEROR',
          rarity: 'SSR',
        }),
      },
      { GEMINI_API_KEY: 'test-dummy-key' },
    );

    expect(res.status).toBe(200);
    const callArgs = createInteractionMock.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-nano-banana-2.1');
    expect(callArgs.generation_config).toEqual({
      thinking_level: 'medium',
    });
    expect(callArgs.input[0]).toEqual({
      type: 'image',
      data: MEDAL_FRAME_REFERENCES.SSR.referenceImageBase64,
      mime_type: 'image/png',
    });

    const data = (await res.json()) as MedalGenerateResponse;
    expect(data.thinkingLevel).toBe('medium');
    expect(data.medal.rarity).toBe('SSR');
    expect(data.medal.engravedText).toBe('DRAFT CONQUEROR');
    expect(data.frameReference.frameId).toBe('frame_ssr_hologram');
    expect(data.imageDataUrl).toContain('data:image/png;base64,');
  });

  it('resolveEngravedText と extractGeneratedImageFromInteraction がエッジケースを正しく処理する', () => {
    expect(resolveEngravedText(undefined, "Medal with engraved text 'CODE NINJA'", '実装')).toBe(
      'CODE NINJA',
    );
    expect(resolveEngravedText('  clean master! ', undefined, '掃除')).toBe('CLEAN MASTER!');
    expect(resolveEngravedText(undefined, 'Simple prompt', '部屋の掃除をする', 'R')).toBe(
      'CLEAN SWEEPER',
    );
    expect(extractGeneratedImageFromInteraction(null)).toBeNull();
    expect(extractGeneratedImageFromInteraction({ steps: [] })).toBeNull();
  });
});

describe('3. MedalRevealModal & MedalCollectionDrawer コンポーネント単体検証', () => {
  const sampleMedals: MedalItem[] = [
    {
      medalId: 'medal_n_1',
      taskId: 'cap_1',
      taskTitle: 'ゴミ出しをする',
      medalName: '「ゴミ出しをする」達成のブロンズメダル',
      engravedText: 'MORNING CLEANER',
      rarity: 'N',
      imageBlobKey: 'img_medal_n_1',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-24T08:00:00.000Z',
      upgradeLevel: 0,
    },
    {
      medalId: 'medal_ssr_2',
      taskId: 'cap_2',
      taskTitle: '企画書ドラフトを提出する',
      medalName: '「企画書ドラフトを提出する」討伐の虹彩ホログラム勲章',
      engravedText: 'DRAFT CONQUEROR',
      rarity: 'SSR',
      imageBlobKey: 'img_medal_ssr_2',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-25T10:30:00.000Z',
      upgradeLevel: 0,
    },
  ];

  it('MedalRevealModal が生成メダル画像、レア度、刻印テキスト、獲得コインを表示する (FR-13, FR-14)', () => {
    const onClose = vi.fn();
    const onOpenCollection = vi.fn();

    render(
      React.createElement(MedalRevealModal, {
        isOpen: true,
        onClose,
        onOpenCollection,
        taskTitle: '企画書ドラフトを提出する',
        rarity: 'SSR',
        coinsEarned: 30,
        todayCombo: 4,
        medal: sampleMedals[1],
        imageUrl: 'data:image/jpeg;base64,FAKE_SSR_IMAGE',
        isGenerating: false,
      }),
    );

    expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
    expect(screen.getByTestId('reveal-medal-rarity')).toHaveAttribute('data-rarity', 'SSR');
    expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,FAKE_SSR_IMAGE',
    );
    expect(screen.getByTestId('reveal-engraved-text')).toHaveTextContent('DRAFT CONQUEROR');
    expect(screen.getByTestId('reveal-task-title')).toHaveTextContent('企画書ドラフトを提出する');
    expect(screen.getByTestId('reveal-coins-earned')).toHaveTextContent('+30 COIN');
    expect(screen.getByTestId('reveal-combo-badge')).toHaveTextContent('4 COMBO!');

    fireEvent.click(screen.getByTestId('open-collection-from-modal-button'));
    expect(onOpenCollection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('close-reveal-modal-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('MedalCollectionDrawer でメダル一覧の表示・詳細表示・日付順/レア度順ソート・レア度フィルタが動作する', async () => {
    const onChangeSortOrder = vi.fn();
    const onChangeRarityFilter = vi.fn();
    const loadMedalImage = vi.fn().mockImplementation(async (blobKey: string) => ({
      imageBlobKey: blobKey,
      imageData: `data:image/jpeg;base64,IMG_${blobKey}`,
      mimeType: 'image/jpeg',
      updatedAt: '2026-10-25T10:30:00.000Z',
    }));

    render(
      React.createElement(MedalCollectionDrawer, {
        isOpen: true,
        onClose: vi.fn(),
        medals: sampleMedals,
        totalMedalCount: 2,
        totalCracked: 14,
        sortOrder: 'date-desc',
        rarityFilter: 'ALL',
        onChangeSortOrder,
        onChangeRarityFilter,
        loadMedalImage,
      }),
    );

    expect(screen.getByTestId('medal-collection-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('collection-stats-summary')).toHaveTextContent('2');
    expect(screen.getByTestId('collection-medal-card-medal_n_1')).toBeInTheDocument();
    expect(screen.getByTestId('collection-medal-card-medal_ssr_2')).toBeInTheDocument();

    await waitFor(() => {
      expect(loadMedalImage).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('collection-medal-image-medal_ssr_2')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,IMG_img_medal_ssr_2',
      );
    });

    // メダルカードをタップして詳細表示を開く
    fireEvent.click(screen.getByTestId('collection-medal-card-medal_ssr_2'));
    expect(screen.getByTestId('collection-medal-detail')).toBeInTheDocument();
    expect(screen.getByTestId('detail-medal-name')).toHaveTextContent(
      '「企画書ドラフトを提出する」討伐の虹彩ホログラム勲章',
    );
    expect(screen.getByTestId('detail-engraved-text')).toHaveTextContent('DRAFT CONQUEROR');
    expect(screen.getByTestId('detail-task-title')).toHaveTextContent('企画書ドラフトを提出する');

    // レア度順ソートボタンとSSRフィルタボタンの動作確認
    fireEvent.click(screen.getByTestId('collection-sort-rarity'));
    expect(onChangeSortOrder).toHaveBeenCalledWith('rarity-desc');

    fireEvent.click(screen.getByTestId('collection-filter-SSR'));
    expect(onChangeRarityFilter).toHaveBeenCalledWith('SSR');
  });
});

describe('4. App 一気通貫統合テスト (カプセル開封 → レア度抽選 → /api/medals/generate → IndexedDB保存 → モーダル＆図鑑表示)', () => {
  it('カプセルを3回タップして割るとレア度が抽選され、/api/medals/generate の生成メダルがモーダルに表示されて IndexedDB 図鑑に保存される', async () => {
    const createInteractionMock = vi.fn().mockResolvedValue({
      output_image: {
        type: 'image',
        mime_type: 'image/jpeg',
        data: 'GENERATED_MEDAL_BASE64_DATA',
      },
    });

    setGeminiClientFactoryForTests(() => ({
      interactions: {
        create: createInteractionMock as never,
      },
    }));

    const customFetch: typeof fetch = (input, init) =>
      Promise.resolve(serverApp.request(input, init, { GEMINI_API_KEY: 'test-dummy-key' }));

    render(
      React.createElement(App, {
        randomFn: () => 0.001, // SSR が確実に抽選される乱数
        generateMedalFn: (payload) => generateCommemorativeMedal(payload, customFetch),
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    // 開封モーダルが表示され、Hono API で生成されたメダル画像と刻印テキストが描画されるのを待つ
    await waitFor(() => {
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,GENERATED_MEDAL_BASE64_DATA',
      );
    });

    expect(screen.getByTestId('reveal-medal-rarity')).toHaveAttribute('data-rarity', 'SSR');
    expect(screen.getByTestId('reveal-engraved-text')).toHaveTextContent('DRAFT CONQUEROR');
    expect(screen.getByTestId('reveal-coins-earned')).toHaveTextContent('+30 COIN');

    // IndexedDB にメダルメタデータと生成画像が永続化されていることを検証
    const storedMedals = await listMedals('date-desc', 'ALL');
    expect(storedMedals).toHaveLength(1);
    expect(storedMedals[0].rarity).toBe('SSR');
    expect(storedMedals[0].engravedText).toBe('DRAFT CONQUEROR');
    expect(storedMedals[0].taskTitle).toBe('企画書ドラフトを提出する');

    const storedWithImg = await getMedalWithImage(storedMedals[0].medalId);
    expect(storedWithImg?.imageData).toBe('data:image/jpeg;base64,GENERATED_MEDAL_BASE64_DATA');

    // モーダル内の「図鑑で見る」ボタンから図鑑ドロワーを開き、獲得したメダルが詳細表示されていることを確認
    fireEvent.click(screen.getByTestId('open-collection-from-modal-button'));

    await waitFor(() => {
      expect(screen.getByTestId('medal-collection-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('collection-medal-detail')).toBeInTheDocument();
    });

    expect(screen.getByTestId('detail-engraved-text')).toHaveTextContent('DRAFT CONQUEROR');
    expect(screen.getByTestId('detail-task-title')).toHaveTextContent('企画書ドラフトを提出する');
  });

  it('【指摘1回帰】生成成功後にIndexedDB保存が容量超過等で失敗した場合、成功表示にせず生成画像を保持してエラー表示し、再保存ボタンで保存できる', async () => {
    const generatedResponse: MedalGenerateResponse = {
      medal: {
        medalId: 'medal_ssr_generated_quota_1',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: '「企画書ドラフトを提出する」討伐の虹彩ホログラム勲章',
        engravedText: 'DRAFT CONQUEROR',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_generated_quota_1',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:00:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,GENERATED_SURVIVING_IMAGE',
      imageBase64: 'GENERATED_SURVIVING_IMAGE',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    };

    const generateMedalFn = vi.fn().mockResolvedValue(generatedResponse);

    // IndexedDB の put を失敗させて容量超過（QuotaExceededError）を再現
    let failPut = true;
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (failPut) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    });

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    // 保存失敗エラーが表示され、成功メッセージは表示されず、生成に成功した画像が失われずに表示されていること
    await waitFor(() => {
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('reveal-save-error')).toHaveTextContent('保存できませんでした');
    });

    expect(screen.queryByTestId('reveal-status-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,GENERATED_SURVIVING_IMAGE',
    );
    expect(screen.getByTestId('open-collection-from-modal-button')).toBeDisabled();
    expect(screen.getByTestId('retry-save-medal-button')).toBeEnabled();
    expect(generateMedalFn).toHaveBeenCalledTimes(1);

    // モーダルを一度閉じてもメイン画面に未保存アラートが残り、静かに消えないこと
    fireEvent.click(screen.getByTestId('close-reveal-modal-button'));
    expect(screen.getByTestId('unsaved-medal-alert')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reopen-unsaved-medal-button'));
    expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();

    // 空き容量が回復した状態で「図鑑に再保存する」を押すと、APIを再実行せず保持していた生成画像を保存できること
    failPut = false;
    fireEvent.click(screen.getByTestId('retry-save-medal-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('reveal-save-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('reveal-status-note')).toHaveTextContent(
        '記念メダルを図鑑に保存しました',
      );
    });

    expect(generateMedalFn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('open-collection-from-modal-button')).toBeEnabled();

    const storedMedals = await listMedals('date-desc', 'ALL');
    expect(storedMedals).toHaveLength(1);
    expect(storedMedals[0].medalId).toBe('medal_ssr_generated_quota_1');
    const storedWithImg = await getMedalWithImage('medal_ssr_generated_quota_1');
    expect(storedWithImg?.imageData).toBe('data:image/jpeg;base64,GENERATED_SURVIVING_IMAGE');
  });

  it('【指摘1回帰】生成APIが失敗しフォールバック保存も失敗した場合、「図鑑に保存しました」と誤表示せずエラー表示と再保存ができる', async () => {
    const generateMedalFn = vi.fn().mockRejectedValue(new Error('API 502 error'));

    let failPut = true;
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (failPut) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    });

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(screen.getByTestId('reveal-save-error')).toHaveTextContent('保存できませんでした');
    });

    expect(screen.queryByTestId('reveal-status-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-collection-from-modal-button')).toBeDisabled();

    failPut = false;
    fireEvent.click(screen.getByTestId('retry-save-medal-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('reveal-save-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('reveal-status-note')).toHaveTextContent(
        '記念メダルを図鑑に保存しました',
      );
    });

    const storedMedals = await listMedals('date-desc', 'ALL');
    expect(storedMedals).toHaveLength(1);
    expect(storedMedals[0].taskTitle).toBe('企画書ドラフトを提出する');
  });

  it('【指摘2回帰】API呼び出し前に仮メダルと生成待ち状態を永続化し、生成中にページ再読み込み（アンマウント＆再マウント）されても中断分を復元・確定できる', async () => {
    let medalsAtApiCallTime: MedalItem[] = [];
    let pendingStorageAtApiCallTime: string | null = null;

    // 1回目のマウントでは生成APIが応答する前にアンマウント（ページ再読み込み）される状況を再現
    const firstGenerateMedalFn = vi.fn().mockImplementation(async () => {
      medalsAtApiCallTime = await listMedals('date-desc', 'ALL');
      pendingStorageAtApiCallTime = window.localStorage.getItem(
        PENDING_MEDAL_GENERATIONS_STORAGE_KEY,
      );
      return new Promise<MedalGenerateResponse>(() => {
        // 応答前にページが閉じられるため永遠に未解決
      });
    });

    const { unmount } = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: firstGenerateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(firstGenerateMedalFn).toHaveBeenCalledTimes(1);
      expect(medalsAtApiCallTime).toHaveLength(1);
    });

    // API呼び出し時点で、すでに仮メダルがIndexedDBに保存され、生成待ち状態もlocalStorageに永続化されていること
    expect(medalsAtApiCallTime[0].taskTitle).toBe('企画書ドラフトを提出する');
    expect(medalsAtApiCallTime[0].rarity).toBe('SSR');
    const provisionalId = medalsAtApiCallTime[0].medalId;
    expect(pendingStorageAtApiCallTime).toBeTruthy();

    // 生成途中のままアンマウント（ページ再読み込み・タブ終了をシミュレート）
    unmount();

    // 再読み込み後の新しいAppマウントで、中断された生成処理が自動再開され、実メダルへ置き換わること
    const secondGenerateMedalFn = vi.fn().mockResolvedValue({
      medal: {
        medalId: 'medal_ssr_recovered_after_reload',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: '「企画書ドラフトを提出する」討伐の虹彩ホログラム勲章',
        engravedText: 'DRAFT CONQUEROR',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_recovered_after_reload',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:05:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,RECOVERED_AFTER_RELOAD_IMG',
      imageBase64: 'RECOVERED_AFTER_RELOAD_IMG',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    } satisfies MedalGenerateResponse);

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: secondGenerateMedalFn,
      }),
    );

    await waitFor(() => {
      expect(secondGenerateMedalFn).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,RECOVERED_AFTER_RELOAD_IMG',
      );
    });

    // 仮メダルが実メダルへ更新され、重複なく1件のみ保存されており、生成待ちストレージも解消されていること
    const finalMedals = await listMedals('date-desc', 'ALL');
    expect(finalMedals).toHaveLength(1);
    expect(finalMedals[0].medalId).toBe('medal_ssr_recovered_after_reload');
    expect(finalMedals[0].medalId).not.toBe(provisionalId);

    const recoveredImg = await getMedalWithImage('medal_ssr_recovered_after_reload');
    expect(recoveredImg?.imageData).toBe('data:image/jpeg;base64,RECOVERED_AFTER_RELOAD_IMG');
    expect(window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY)).toBeNull();
  });

  it('【指摘3回帰】既存のレア度フィルタが獲得メダルと異なっていても、生成中に「図鑑で見る」を押すとフィルタが調整され、生成完了時にサーバー発行IDへ選択状態が追従して詳細が開く', async () => {
    let resolveGeneration!: (value: MedalGenerateResponse) => void;
    const delayedGenerateMedalFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>((resolve) => {
          resolveGeneration = resolve;
        }),
    );

    render(
      React.createElement(App, {
        randomFn: () => 0.001, // SSR を抽選
        generateMedalFn: delayedGenerateMedalFn,
      }),
    );

    // 事前に図鑑ドロワーを開き、レア度フィルタを「N」に設定して閉じる
    fireEvent.click(screen.getByTestId('open-collection-drawer-button'));
    expect(screen.getByTestId('medal-collection-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('collection-filter-N'));
    expect(screen.getByTestId('collection-filter-N')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('close-collection-drawer-button'));

    // カプセルを開封して SSR メダルを獲得（生成APIはまだ応答待ち）
    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('open-collection-from-modal-button')).toBeEnabled();
    });

    // 生成中に「図鑑で見る」をクリック
    fireEvent.click(screen.getByTestId('open-collection-from-modal-button'));

    // レア度フィルタが「ALL」に自動調整され、仮メダルの詳細が表示されていること
    await waitFor(() => {
      expect(screen.getByTestId('medal-collection-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('collection-filter-ALL')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('collection-medal-detail')).toBeInTheDocument();
    });

    // その後、サーバーから別IDの生成結果が返ってきて保存完了する
    resolveGeneration({
      medal: {
        medalId: 'medal_ssr_server_issued_777',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: '「企画書ドラフトを提出する」サーバー発行の虹彩勲章',
        engravedText: 'SERVER ISSUED RIM',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_server_issued_777',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:10:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,SERVER_ISSUED_IMAGE_777',
      imageBase64: 'SERVER_ISSUED_IMAGE_777',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    });

    // 選択中のメダルIDがサーバー発行IDへ自動追従し、詳細ビューが実メダル情報と生成画像へ更新されること
    await waitFor(() => {
      expect(screen.getByTestId('collection-medal-detail')).toBeInTheDocument();
      expect(screen.getByTestId('detail-medal-name')).toHaveTextContent(
        '「企画書ドラフトを提出する」サーバー発行の虹彩勲章',
      );
      expect(screen.getByTestId('detail-engraved-text')).toHaveTextContent('SERVER ISSUED RIM');
      expect(screen.getByTestId('detail-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,SERVER_ISSUED_IMAGE_777',
      );
    });

    expect(
      screen.getByTestId('collection-medal-card-medal_ssr_server_issued_777'),
    ).toBeInTheDocument();
  });

  it('【再レビュー指摘1回帰】localStorageの読み書きが例外を投げて失敗する環境でも、IndexedDBの仮メダルから生成待ち状態を検出して再読み込み後に自動再開・確定できる', async () => {
    let medalsInDbBeforeReload: MedalItem[] = [];

    // localStorage の getItem / setItem / removeItem がすべて例外を投げる環境を再現
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('SecurityError', 'SecurityError');
    });

    const firstGenerateMedalFn = vi.fn().mockImplementation(async () => {
      medalsInDbBeforeReload = await listMedals('date-desc', 'ALL');
      return new Promise<MedalGenerateResponse>(() => {
        // 応答前にページ再読み込みされる状況を再現
      });
    });

    const { unmount } = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: firstGenerateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(firstGenerateMedalFn).toHaveBeenCalledTimes(1);
      expect(medalsInDbBeforeReload).toHaveLength(1);
    });

    // localStorage が失敗していても、IndexedDB の仮メダル自体に pendingGeneration 情報が保存されていること
    expect(medalsInDbBeforeReload[0].pendingGeneration).toBeDefined();
    expect(medalsInDbBeforeReload[0].pendingGeneration?.coinsEarned).toBe(30);
    const provisionalId = medalsInDbBeforeReload[0].medalId;

    // ページ再読み込み（アンマウント＆再マウント）
    unmount();

    const secondGenerateMedalFn = vi.fn().mockResolvedValue({
      medal: {
        medalId: 'medal_ssr_recovered_from_idb_only',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: '「企画書ドラフトを提出する」IDB正本復元の虹彩勲章',
        engravedText: 'DRAFT CONQUEROR',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_recovered_from_idb_only',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:15:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,RECOVERED_FROM_IDB_ONLY_IMG',
      imageBase64: 'RECOVERED_FROM_IDB_ONLY_IMG',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    } satisfies MedalGenerateResponse);

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: secondGenerateMedalFn,
      }),
    );

    // localStorage が使えなくても IndexedDB の仮メダルから復元され、生成画像がモーダルに表示されること
    await waitFor(() => {
      expect(secondGenerateMedalFn).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,RECOVERED_FROM_IDB_ONLY_IMG',
      );
    });

    const finalMedals = await listMedals('date-desc', 'ALL');
    expect(finalMedals).toHaveLength(1);
    expect(finalMedals[0].medalId).toBe('medal_ssr_recovered_from_idb_only');
    expect(finalMedals[0].medalId).not.toBe(provisionalId);
    expect(finalMedals[0].pendingGeneration).toBeUndefined();
  });

  it('【再レビュー指摘2回帰】同じ生成待ちレコードを2つのタブ（2回の復元処理）が読み取って異なる実メダルIDを生成しても、二重登録されず実メダルが1つだけ残る', async () => {
    const initialGenerateFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>(() => {
          // 応答前にアンマウント
        }),
    );

    const { unmount: unmountInitial } = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: initialGenerateFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(initialGenerateFn).toHaveBeenCalledTimes(1);
    });

    const provisionalMedals = await listMedals('date-desc', 'ALL');
    expect(provisionalMedals).toHaveLength(1);
    expect(provisionalMedals[0].pendingGeneration).toBeDefined();
    unmountInitial();

    // タブ1とタブ2が同時に同じ生成待ちレコードを読み取り、それぞれ異なる実メダルIDを返す状況を再現
    let resolveTab1!: (value: MedalGenerateResponse) => void;
    let resolveTab2!: (value: MedalGenerateResponse) => void;

    const tab1GenerateFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>((resolve) => {
          resolveTab1 = resolve;
        }),
    );
    const tab2GenerateFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>((resolve) => {
          resolveTab2 = resolve;
        }),
    );

    const tab1 = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: tab1GenerateFn,
      }),
    );
    const tab2 = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: tab2GenerateFn,
      }),
    );

    await waitFor(() => {
      expect(tab1GenerateFn).toHaveBeenCalledTimes(1);
      expect(tab2GenerateFn).toHaveBeenCalledTimes(1);
    });

    // タブ1が先に確定し、続いてタブ2が別の実メダルIDで確定を試みる
    resolveTab1({
      medal: {
        medalId: 'medal_ssr_tab_1_winner',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: 'タブ1で確定した勲章',
        engravedText: 'TAB ONE WINNER',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_tab_1_winner',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:20:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,TAB_1_WINNER_IMAGE',
      imageBase64: 'TAB_1_WINNER_IMAGE',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    });

    resolveTab2({
      medal: {
        medalId: 'medal_ssr_tab_2_duplicate',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: 'タブ2の後発重複勲章',
        engravedText: 'TAB TWO DUPLICATE',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_tab_2_duplicate',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:20:01.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,TAB_2_DUPLICATE_IMAGE',
      imageBase64: 'TAB_2_DUPLICATE_IMAGE',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    });

    // 両方のタブで確定処理が完了するのを待つ
    await waitFor(async () => {
      const currentMedals = await listMedals('date-desc', 'ALL');
      expect(currentMedals).toHaveLength(1);
      expect(currentMedals[0].pendingGeneration).toBeUndefined();
    });

    const finalMedals = await listMedals('date-desc', 'ALL');
    expect(finalMedals).toHaveLength(1);
    expect(finalMedals[0].medalId).toBe('medal_ssr_tab_1_winner');

    const duplicateLookup = await getMedalWithImage('medal_ssr_tab_2_duplicate');
    expect(duplicateLookup).toBeNull();

    tab1.unmount();
    tab2.unmount();

    // さらに確定完了後に3つ目のタブが起動しても、すでに確定済みのためAPIは呼ばれないこと
    const tab3GenerateFn = vi.fn();
    const tab3 = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: tab3GenerateFn,
      }),
    );
    expect(tab3GenerateFn).not.toHaveBeenCalled();
    tab3.unmount();
  });

  it('【再レビュー指摘3回帰】メダルAの再保存中にモーダルを閉じて別のカプセルBを開封した場合、Aの完了処理がBのrevealStateや図鑑遷移先を上書きしない', async () => {
    const medalAResponse: MedalGenerateResponse = {
      medal: {
        medalId: 'medal_ssr_capsule_a',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: 'カプセルAの黄金勲章',
        engravedText: 'DRAFT CONQUEROR',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_capsule_a',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:30:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,IMAGE_CAPSULE_A',
      imageBase64: 'IMAGE_CAPSULE_A',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    };

    const medalBResponse: MedalGenerateResponse = {
      medal: {
        medalId: 'medal_ssr_capsule_b',
        taskId: 'cap_demo_002',
        taskTitle: '溜まった洗濯物をたたむ',
        medalName: 'カプセルBのランドリー勲章',
        engravedText: 'LAUNDRY MASTER',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_capsule_b',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:31:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,IMAGE_CAPSULE_B',
      imageBase64: 'IMAGE_CAPSULE_B',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    };

    const generateMedalFn = vi
      .fn()
      .mockResolvedValueOnce(medalAResponse)
      .mockResolvedValueOnce(medalBResponse);

    // 1. カプセルAの初回保存だけ失敗させる
    let failPutForA = true;
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (failPutForA) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    });

    let releaseRetryA!: () => void;
    const retryAGate = new Promise<void>((resolve) => {
      releaseRetryA = resolve;
    });
    let delayNextOpenForRetryA = false;
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(
      (...args: Parameters<typeof globalThis.indexedDB.open>) => {
        if (delayNextOpenForRetryA) {
          delayNextOpenForRetryA = false;
          const delayedReq = {} as IDBOpenDBRequest;
          void retryAGate.then(() => {
            const realReq = originalOpen(...args);
            realReq.onsuccess = (ev) => {
              (delayedReq as { result: IDBDatabase }).result = realReq.result;
              delayedReq.onsuccess?.call(realReq, ev);
            };
            realReq.onerror = (ev) => {
              delayedReq.onerror?.call(realReq, ev);
            };
          });
          return delayedReq;
        }
        return originalOpen(...args);
      },
    );

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn,
      }),
    );

    // カプセルA（「企画書ドラフトを提出する」）を開封
    const capsuleBtnA = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtnA);
    fireEvent.click(capsuleBtnA);
    fireEvent.click(capsuleBtnA);

    await waitFor(() => {
      expect(screen.getByTestId('reveal-save-error')).toHaveTextContent('保存できませんでした');
    });

    // 2. 容量エラーを解除し、メダルAの「図鑑に再保存する」を押すが、完了を一旦保留する
    failPutForA = false;
    delayNextOpenForRetryA = true;

    fireEvent.click(screen.getByTestId('retry-save-medal-button'));

    // 3. メダルAの再保存中にモーダルを閉じ、次のカプセルB（「溜まった洗濯物をたたむ」）を開封する
    fireEvent.click(screen.getByTestId('close-reveal-modal-button'));

    const capsuleBtnB = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtnB);
    fireEvent.click(capsuleBtnB);
    fireEvent.click(capsuleBtnB);

    // カプセルBのメダル生成・保存が完了してモーダルに表示されるのを待つ
    await waitFor(() => {
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('reveal-task-title')).toHaveTextContent('溜まった洗濯物をたたむ');
      expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,IMAGE_CAPSULE_B',
      );
    });

    // 4. ここで保留していたメダルAの再保存を完了させる
    releaseRetryA();

    await waitFor(async () => {
      const stored = await listMedals('date-desc', 'ALL');
      expect(stored).toHaveLength(2);
    });

    // Aの完了処理がBのモーダル表示（タスク名・刻印・画像・ステータスメモ）を上書きしていないことを確認
    expect(screen.getByTestId('reveal-task-title')).toHaveTextContent('溜まった洗濯物をたたむ');
    expect(screen.getByTestId('reveal-engraved-text')).toHaveTextContent('LAUNDRY MASTER');
    expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,IMAGE_CAPSULE_B',
    );
    expect(screen.queryByTestId('reveal-status-note')).not.toBeInTheDocument();

    // 「図鑑で見る」を押した際、メダルAではなく現在表示中のメダルBの詳細が開くことを確認
    fireEvent.click(screen.getByTestId('open-collection-from-modal-button'));

    await waitFor(() => {
      expect(screen.getByTestId('medal-collection-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('collection-medal-detail')).toBeInTheDocument();
    });

    expect(screen.getByTestId('detail-medal-name')).toHaveTextContent('カプセルBのランドリー勲章');
    expect(screen.getByTestId('detail-engraved-text')).toHaveTextContent('LAUNDRY MASTER');
    expect(screen.getByTestId('detail-task-title')).toHaveTextContent('溜まった洗濯物をたたむ');
  });

  it('【再レビュー2回目指摘1回帰】復元時のIndexedDB読み取りが例外を投げた場合、provisionalSavedInDb: true のlocalStorage補助レコードを削除せず保持し、DB読み取り回復時に再試行・自動再開できる', async () => {
    const firstGenerateMedalFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>(() => {
          // 応答前にアンマウント（ページ再読み込み）
        }),
    );

    const { unmount: unmountFirst } = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: firstGenerateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(firstGenerateMedalFn).toHaveBeenCalledTimes(1);
    });

    // provisionalSavedInDb: true の生成待ちレコードが localStorage に保存されるのを待つ
    await waitFor(() => {
      const raw = window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed[0]?.provisionalSavedInDb).toBe(true);
    });

    unmountFirst();

    // 再マウント直後の IndexedDB 読み取り（getAll）が一時的な例外を投げる状況を再現
    let failGetAll = true;
    let failedGetAllCount = 0;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['getAll']>
    ) {
      if (failGetAll) {
        failedGetAllCount += 1;
        throw new DOMException('Transient IDB read failure', 'UnknownError');
      }
      return originalGetAll.apply(this, args);
    });

    const secondGenerateMedalFn = vi.fn().mockResolvedValue({
      medal: {
        medalId: 'medal_ssr_recovered_after_idb_read_error',
        taskId: 'cap_demo_001',
        taskTitle: '企画書ドラフトを提出する',
        medalName: 'DB読み取りエラー回復後の虹彩勲章',
        engravedText: 'DRAFT CONQUEROR',
        rarity: 'SSR',
        imageBlobKey: 'img_medal_ssr_recovered_after_idb_read_error',
        modelUsed: 'gemini-nano-banana-2.1',
        unlockedAt: '2026-10-25T12:40:00.000Z',
        upgradeLevel: 0,
      },
      imageDataUrl: 'data:image/jpeg;base64,RECOVERED_AFTER_IDB_READ_ERROR_IMG',
      imageBase64: 'RECOVERED_AFTER_IDB_READ_ERROR_IMG',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    } satisfies MedalGenerateResponse);

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: secondGenerateMedalFn,
      }),
    );

    // IndexedDB の読み取りが複数回失敗した後も、localStorage の provisionalSavedInDb: true レコードが削除されず保持されていること
    await waitFor(() => {
      expect(failedGetAllCount).toBeGreaterThanOrEqual(2);
    });

    const preservedRaw = window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY);
    expect(preservedRaw).toBeTruthy();
    expect(JSON.parse(preservedRaw!)[0]?.provisionalSavedInDb).toBe(true);

    // 一時的な DB 読み取りエラーが解消されると、再試行によって自動再開・確定されること
    failGetAll = false;

    await waitFor(() => {
      expect(secondGenerateMedalFn).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,RECOVERED_AFTER_IDB_READ_ERROR_IMG',
      );
    });

    const finalMedals = await listMedals('date-desc', 'ALL');
    expect(finalMedals).toHaveLength(1);
    expect(finalMedals[0].medalId).toBe('medal_ssr_recovered_after_idb_read_error');
    expect(window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY)).toBeNull();
  });

  it('【再レビュー2回目指摘2回帰】復元一覧の読み取り後〜API前チェックの間に他タブが仮メダルを確定した場合、モーダルが isGenerating: true のまま残らず先行確定メダルと画像で確定状態へ更新される', async () => {
    const firstGenerateMedalFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>(() => {
          // 応答前にアンマウント
        }),
    );

    const { unmount: unmountFirst } = render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: firstGenerateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(firstGenerateMedalFn).toHaveBeenCalledTimes(1);
    });

    const provisionalMedals = await listMedals('date-desc', 'ALL');
    expect(provisionalMedals).toHaveLength(1);
    const provisionalId = provisionalMedals[0].medalId;

    await waitFor(() => {
      const raw = window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)[0]?.provisionalSavedInDb).toBe(true);
    });

    unmountFirst();

    // 再マウント時：
    // 1回目の復元一覧読み取り（loadPendingRecordsFromDbAndStorage）ではまだ仮メダルが未確定として返り、
    // その直後（executeMedalGenerationFlow の API前チェックの読み取り前）に他タブが仮メダルを確定する競合を再現
    let openCallIndex = 0;
    let otherTabFinalizedPromise: Promise<MedalItem> | null = null;
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(
      (...args: Parameters<typeof globalThis.indexedDB.open>) => {
        openCallIndex += 1;
        // openCallIndex === 1: useMedalStorage 初回 autoLoad
        // openCallIndex === 2: loadPendingRecordsFromDbAndStorage による復元一覧の読み取り
        // openCallIndex === 3: executeMedalGenerationFlow の API前チェックの読み取り
        if (openCallIndex === 3 && !otherTabFinalizedPromise) {
          const delayedReq = {} as IDBOpenDBRequest;
          otherTabFinalizedPromise = saveMedalWithImage({
            medal: {
              medalId: 'medal_ssr_other_tab_pre_api_winner',
              taskId: 'cap_demo_001',
              taskTitle: '企画書ドラフトを提出する',
              medalName: '他タブで先行確定した虹彩勲章',
              engravedText: 'OTHER TAB WINNER',
              rarity: 'SSR',
              imageBlobKey: 'img_medal_ssr_other_tab_pre_api_winner',
              modelUsed: 'gemini-nano-banana-2.1',
              unlockedAt: '2026-10-25T12:45:00.000Z',
              upgradeLevel: 0,
            },
            imageData: 'data:image/jpeg;base64,OTHER_TAB_PRE_API_WINNER_IMG',
            mimeType: 'image/jpeg',
            replaceMedalId: provisionalId,
            requireReplaceTarget: true,
          });
          void otherTabFinalizedPromise.then(() => {
            const realReq = originalOpen(...args);
            realReq.onsuccess = (ev) => {
              (delayedReq as { result: IDBDatabase }).result = realReq.result;
              delayedReq.onsuccess?.call(realReq, ev);
            };
            realReq.onerror = (ev) => {
              delayedReq.onerror?.call(realReq, ev);
            };
          });
          return delayedReq;
        }
        return originalOpen(...args);
      },
    );

    const secondGenerateMedalFn = vi.fn();

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn: secondGenerateMedalFn,
      }),
    );

    // 復元されたモーダルが isGenerating: true のまま残らず、先行確定した他タブのメダル情報と画像へ更新されること
    await waitFor(() => {
      expect(screen.getByTestId('medal-reveal-modal')).toBeInTheDocument();
      expect(screen.queryByTestId('medal-generating-skeleton')).not.toBeInTheDocument();
      expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,OTHER_TAB_PRE_API_WINNER_IMG',
      );
      expect(screen.getByTestId('reveal-engraved-text')).toHaveTextContent('OTHER TAB WINNER');
    });

    expect(secondGenerateMedalFn).not.toHaveBeenCalled();
    expect(screen.getByTestId('open-collection-from-modal-button')).toBeEnabled();
    expect(window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY)).toBeNull();
  });

  it('【再レビュー2回目指摘3回帰】requireReplaceTarget 有効時に置換対象も先行確定メダルも存在しない場合（IndexedDB・メモリ両方）、成功結果にせずエラーとして返し、呼び出し側は未保存情報を保持して hasPersistedInDb を立てない', async () => {
    const sampleMedal: MedalItem = {
      medalId: 'medal_ssr_orphan_final',
      taskId: 'cap_demo_001',
      taskTitle: '企画書ドラフトを提出する',
      medalName: '置換対象不在の勲章',
      engravedText: 'ORPHAN TARGET',
      rarity: 'SSR',
      imageBlobKey: 'img_medal_ssr_orphan_final',
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: '2026-10-25T12:50:00.000Z',
      upgradeLevel: 0,
    };

    // 1. IndexedDB 側：置換対象も先行確定メダルも存在しない場合は ReplaceTargetNotFoundError を投げて保存しないこと
    await expect(
      saveMedalWithImage({
        medal: sampleMedal,
        imageData: 'data:image/jpeg;base64,ORPHAN_IDB_IMG',
        mimeType: 'image/jpeg',
        replaceMedalId: 'non_existent_provisional_idb',
        requireReplaceTarget: true,
      }),
    ).rejects.toThrow(ReplaceTargetNotFoundError);

    expect(await listMedals('date-desc', 'ALL')).toHaveLength(0);

    // 2. インメモリフォールバック側：同じく置換対象も先行確定メダルも存在しない場合は ReplaceTargetNotFoundError を投げて保存しないこと
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    const openSpy = vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('IDB unavailable for memory test', 'SecurityError');
    });

    let memoryCaughtError: unknown = null;
    try {
      await saveMedalWithImage({
        medal: sampleMedal,
        imageData: 'data:image/jpeg;base64,ORPHAN_MEM_IMG',
        mimeType: 'image/jpeg',
        replaceMedalId: 'non_existent_provisional_mem',
        requireReplaceTarget: true,
      });
    } catch (err) {
      memoryCaughtError = err;
    }
    expect(isReplaceTargetNotFoundError(memoryCaughtError)).toBe(true);
    expect(await listMedals('date-desc', 'ALL')).toHaveLength(0);

    openSpy.mockImplementation(originalOpen);

    // 3. App 統合動作：仮メダル保存後（provisionalSavedInDb: true）、最終保存前に仮メダルが先行確定なしで消失していた場合、
    // 保存成功扱い（hasPersistedInDb: true）にせず、生成待ち・未保存情報を保持して保存エラーを表示すること
    let resolveGeneration!: (value: MedalGenerateResponse) => void;
    const generateMedalFn = vi.fn().mockImplementation(
      () =>
        new Promise<MedalGenerateResponse>((resolve) => {
          resolveGeneration = resolve;
        }),
    );

    render(
      React.createElement(App, {
        randomFn: () => 0.001,
        generateMedalFn,
      }),
    );

    const capsuleBtn = screen.getByTestId('active-capsule-button');
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);
    fireEvent.click(capsuleBtn);

    await waitFor(() => {
      expect(generateMedalFn).toHaveBeenCalledTimes(1);
    });

    const provisionalList = await listMedals('date-desc', 'ALL');
    expect(provisionalList).toHaveLength(1);
    const provisionalId = provisionalList[0].medalId;

    // 先行確定メダルを作らずに DB から仮メダルを削除して「対象不在」状態にする
    await deleteMedalById(provisionalId);
    expect(await listMedals('date-desc', 'ALL')).toHaveLength(0);

    // 生成APIが完了して requireReplaceTarget: true で最終保存が試みられる
    resolveGeneration({
      medal: sampleMedal,
      imageDataUrl: 'data:image/jpeg;base64,ORPHAN_APP_IMG',
      imageBase64: 'ORPHAN_APP_IMG',
      mimeType: 'image/jpeg',
      thinkingLevel: 'medium',
      frameReference: {
        rarity: 'SSR',
        frameId: 'frame_ssr_hologram',
        frameNameJa: 'ホログラム枠',
        frameNameEn: 'Hologram Frame',
      },
    });

    // 保存成功と誤認せず、エラー表示になり、「図鑑で見る」は無効（hasPersistedInDb: false）であること
    await waitFor(() => {
      expect(screen.getByTestId('reveal-save-error')).toHaveTextContent('保存できませんでした');
    });

    expect(screen.queryByTestId('reveal-status-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-collection-from-modal-button')).toBeDisabled();
    expect(screen.getByTestId('reveal-medal-image')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,ORPHAN_APP_IMG',
    );

    // 生成待ち・未保存情報が削除されずに保持されていること
    const pendingRaw = window.localStorage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY);
    expect(pendingRaw).toBeTruthy();
    expect(JSON.parse(pendingRaw!)[0]?.pendingSaveTarget?.medal?.medalId).toBe(
      'medal_ssr_orphan_final',
    );

    fireEvent.click(screen.getByTestId('close-reveal-modal-button'));
    expect(screen.getByTestId('unsaved-medal-alert')).toBeInTheDocument();
  });
});
