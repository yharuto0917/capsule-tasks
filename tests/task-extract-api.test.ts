import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/app';
import { TaskSupplySheet } from '../src/client/components/task-supply-sheet';
import {
  blobToBase64,
  detectSupportedAudioMimeType,
  normalizeRecorderMimeType,
  useVoiceRecorder,
} from '../src/client/hooks/use-voice-recorder';
import { extractCapsuleTasks } from '../src/client/lib/api-client';
import serverApp from '../src/server/index';
import {
  createGeminiClient,
  MissingGeminiApiKeyError,
  setGeminiClientFactoryForTests,
} from '../src/server/lib/gemini-client';
import {
  TASK_EXTRACTION_MODEL,
  normalizeExtractAudioMimeType,
  stripDataUrlPrefix,
} from '../src/server/routes/tasks-extract';
import {
  DEFAULT_CUSTOM_STAMPS,
  TASK_EXTRACTION_JSON_SCHEMA,
  type ExtractedCapsuleTaskDraft,
} from '../src/shared/schemas';

beforeEach(() => {
  window.localStorage.clear();
  setGeminiClientFactoryForTests(null);
});

afterEach(() => {
  setGeminiClientFactoryForTests(null);
  vi.restoreAllMocks();
});

describe('gemini-client & POST /api/tasks/extract (Hono Gemini API プロキシ)', () => {
  it('GEMINI_API_KEY が未設定または空文字のとき MissingGeminiApiKeyError (503) を返す', async () => {
    expect(() => createGeminiClient('')).toThrowError(MissingGeminiApiKeyError);
    expect(() => createGeminiClient(undefined)).toThrowError(MissingGeminiApiKeyError);

    const res = await serverApp.request(
      '/api/tasks/extract',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '牛乳を買う' }),
      },
      { GEMINI_API_KEY: '' },
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('GEMINI_API_KEY');
  });

  it('テキストも音声データも空のリクエストに対して 400 Bad Request を返す', async () => {
    const res = await serverApp.request(
      '/api/tasks/extract',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      },
      { GEMINI_API_KEY: 'test-dummy-key' },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('テキストまたは音声データ');
  });

  it('複数行の雑なテキストを gemini-3.8-flash (thinking_level: low, response_format) で複数タスクへ構造化抽出する (FR-01, FR-05)', async () => {
    const createInteractionMock = vi.fn().mockResolvedValue({
      output_text: JSON.stringify({
        tasks: [
          {
            title: '帰りに牛乳を買う',
            capsuleColor: 'blue',
            rarityBoost: 1.0,
            medalPrompt:
              "A bronze commemorative medal featuring a milk carton in high relief, engraved text 'MILK RUNNER'",
            engravedText: 'MILK RUNNER',
          },
          {
            title: '金曜日の企画書ドラフトを提出する',
            capsuleColor: 'gold',
            rarityBoost: 2.0,
            medalPrompt:
              "A golden commemorative medal with a glowing document scroll, engraved text 'DRAFT CONQUEROR'",
            engravedText: 'DRAFT CONQUEROR',
          },
          {
            title: '経費精算の領収書を登録する',
            capsuleColor: 'red',
            rarityBoost: 1.5,
            medalPrompt:
              "A silver commemorative medal with a receipt and calculator, engraved text 'RECEIPT HUNTER'",
            engravedText: 'RECEIPT HUNTER',
          },
        ],
      }),
    });

    setGeminiClientFactoryForTests(() => ({
      interactions: {
        create: createInteractionMock as never,
      },
    }));

    const customFetch: typeof fetch = (input, init) =>
      Promise.resolve(serverApp.request(input, init, { GEMINI_API_KEY: 'test-dummy-key' }));

    const result = await extractCapsuleTasks(
      {
        text: 'あーえっと、帰りに牛乳買って、あと金曜の企画書ドラフト提出しなきゃ。経費精算の領収書もやる',
      },
      customFetch,
    );

    expect(createInteractionMock).toHaveBeenCalledTimes(1);
    const callArgs = createInteractionMock.mock.calls[0][0];
    expect(callArgs.model).toBe(TASK_EXTRACTION_MODEL);
    expect(callArgs.generation_config).toEqual({ thinking_level: 'low' });
    expect(callArgs.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: TASK_EXTRACTION_JSON_SCHEMA,
    });
    expect(callArgs.input).toEqual([
      {
        type: 'text',
        text: 'あーえっと、帰りに牛乳買って、あと金曜の企画書ドラフト提出しなきゃ。経費精算の領収書もやる',
      },
    ]);

    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0]).toMatchObject({
      title: '帰りに牛乳を買う',
      capsuleColor: 'blue',
      rarityBoost: 1.0,
    });
    expect(result.tasks[1]).toMatchObject({
      title: '金曜日の企画書ドラフトを提出する',
      capsuleColor: 'gold',
      rarityBoost: 2.0,
    });
    expect(result.tasks[2]).toMatchObject({
      title: '経費精算の領収書を登録する',
      capsuleColor: 'red',
      rarityBoost: 1.5,
    });
  });

  it('Base64音声データとMIMEタイプ（audio/webm, audio/mp4）を正規化して gemini-3.8-flash へ送信する', async () => {
    expect(stripDataUrlPrefix('data:audio/webm;codecs=opus;base64,UklGRg==')).toBe('UklGRg==');
    expect(normalizeExtractAudioMimeType('audio/mp4;codecs=mp4a.40.2')).toBe('audio/mp4');
    expect(normalizeExtractAudioMimeType('audio/webm;codecs=opus')).toBe('audio/webm');

    const createInteractionMock = vi.fn().mockResolvedValue({
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tasks: [
                  {
                    title: '洗濯物をたたむ',
                    capsuleColor: 'blue',
                    rarityBoost: 1.0,
                    medalPrompt: 'A bronze medal with folded clothes',
                  },
                ],
              }),
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
      '/api/tasks/extract',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: 'data:audio/mp4;codecs=mp4a.40.2;base64,AAAAHGZ0eXBNNEE=',
          mimeType: 'audio/mp4;codecs=mp4a.40.2',
        }),
      },
      { GEMINI_API_KEY: 'test-dummy-key' },
    );

    expect(res.status).toBe(200);
    const callArgs = createInteractionMock.mock.calls[0][0];
    expect(callArgs.input[0]).toEqual({
      type: 'audio',
      data: 'AAAAHGZ0eXBNNEE=',
      mime_type: 'audio/mp4',
    });

    const data = (await res.json()) as { tasks: ExtractedCapsuleTaskDraft[] };
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].title).toBe('洗濯物をたたむ');
  });
});

describe('useVoiceRecorder ユーティリティ (MIME自動判定・Base64化)', () => {
  it('audio/webm と audio/mp4 のサポート状況を自動判定して正規化する', () => {
    const safariDetector = (mime: string) => mime.startsWith('audio/mp4');
    expect(detectSupportedAudioMimeType(safariDetector)).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(normalizeRecorderMimeType(detectSupportedAudioMimeType(safariDetector))).toBe(
      'audio/mp4',
    );

    const chromeDetector = (mime: string) => mime.startsWith('audio/webm');
    expect(detectSupportedAudioMimeType(chromeDetector)).toBe('audio/webm;codecs=opus');
    expect(normalizeRecorderMimeType(detectSupportedAudioMimeType(chromeDetector))).toBe(
      'audio/webm',
    );
  });

  it('音声 Blob を Base64 文字列へ正しく変換する', async () => {
    const blob = new Blob([new Uint8Array([104, 101, 108, 108, 111])], { type: 'audio/webm' });
    const base64 = await blobToBase64(blob);
    expect(base64).toBe('aGVsbG8=');
  });

  it('マイク準備中にキャンセルすると、権限許可後も録音を開始せず取得ストリームを停止する', async () => {
    let resolveUserMedia: (stream: unknown) => void = () => {};
    const getUserMedia = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveUserMedia = resolve;
        }),
    );
    const trackStop = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: trackStop }] };
    const recorderStart = vi.fn();

    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      mimeType = 'audio/webm';
      state = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start = recorderStart;
      stop = vi.fn();
    }

    const { result } = renderHook(() =>
      useVoiceRecorder({
        getUserMedia: getUserMedia as never,
        MediaRecorderClass: FakeMediaRecorder as never,
      }),
    );

    let startPromise: Promise<boolean> | undefined;
    act(() => {
      startPromise = result.current.startRecording();
    });
    expect(result.current.isPreparing).toBe(true);

    // 権限ダイアログ表示中にシートが閉じられる（cancelRecording が呼ばれる）ケース
    act(() => {
      result.current.cancelRecording();
    });

    await act(async () => {
      resolveUserMedia(fakeStream);
    });

    await expect(startPromise).resolves.toBe(false);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorderStart).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it('キャンセル直後に再録音した際、旧レコーダーの遅延 dataavailable / onstop が後から発火しても新録音に混入・干渉しない', async () => {
    const instances: FakeDelayedMediaRecorder[] = [];
    const trackStops: Array<ReturnType<typeof vi.fn>> = [];

    const getUserMedia = vi.fn(async () => {
      const stop = vi.fn();
      trackStops.push(stop);
      return { getTracks: () => [{ stop }] };
    });

    class FakeDelayedMediaRecorder {
      static isTypeSupported = () => true;
      mimeType = 'audio/webm';
      state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor() {
        instances.push(this);
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        // ブラウザの MediaRecorder 同様、stop() 時点では即座に dataavailable / onstop を発火せず、
        // 非同期（後続のタイミング）で遅延発火するケースを再現する
        this.state = 'inactive';
      }
    }

    const { result } = renderHook(() =>
      useVoiceRecorder({
        getUserMedia: getUserMedia as never,
        MediaRecorderClass: FakeDelayedMediaRecorder as never,
      }),
    );

    // 1. 録音Aを開始し、録音中チャンクを1つ受け取る
    await act(async () => {
      await expect(result.current.startRecording()).resolves.toBe(true);
    });
    expect(instances).toHaveLength(1);
    const recorderA = instances[0];

    act(() => {
      const oldInitialChunk = new Blob([new Uint8Array([99, 99])], { type: 'audio/webm' });
      recorderA.ondataavailable?.({ data: oldInitialChunk } as BlobEvent);
    });

    // 2. 録音Aをキャンセル（recorderA.stop() が呼ばれるが、dataavailable はまだ遅延中）
    act(() => {
      result.current.cancelRecording();
    });
    expect(result.current.isRecording).toBe(false);
    expect(trackStops[0]).toHaveBeenCalledTimes(1);

    // 3. 直後に録音Bを開始
    await act(async () => {
      await expect(result.current.startRecording()).resolves.toBe(true);
    });
    expect(instances).toHaveLength(2);
    const recorderB = instances[1];
    expect(result.current.isRecording).toBe(true);

    // 4. ここで録音Aの遅延 dataavailable と onstop が発火する
    act(() => {
      const staleChunk = new Blob([new Uint8Array([111, 108, 100])], { type: 'audio/webm' }); // "old"
      recorderA.ondataavailable?.({ data: staleChunk } as BlobEvent);
      recorderA.onstop?.();
    });

    // 録音Bの状態やストリームが壊れていないこと
    expect(result.current.isRecording).toBe(true);
    expect(trackStops[1]).not.toHaveBeenCalled();

    // 5. 録音Bのチャンクを発火して停止し、録音Bのデータ（"new" = btoa("new") = "bmV3"）のみが含まれることを検証
    let recordingResult: Awaited<ReturnType<typeof result.current.stopRecording>> = null;
    await act(async () => {
      const stopPromise = result.current.stopRecording();
      const freshChunk = new Blob([new Uint8Array([110, 101, 119])], { type: 'audio/webm' }); // "new"
      recorderB.ondataavailable?.({ data: freshChunk } as BlobEvent);
      recorderB.onstop?.();
      recordingResult = await stopPromise;
    });

    expect(recordingResult).not.toBeNull();
    expect(recordingResult!.base64Data).toBe(btoa('new'));
    expect(trackStops[1]).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(false);
  });
});

describe('TaskSupplySheet & App 統合検証 (FR-01, FR-03, FR-04, FR-05)', () => {
  it('常連スタンプ8種のいずれかを1タップするだけで文字入力なしに即座にカプセルが生成され、+10コインが付与される (FR-03, FR-04)', async () => {
    render(React.createElement(App));

    expect(screen.getByTestId('status-coins')).toHaveTextContent('150');
    expect(screen.getByTestId('status-remaining-capsules')).toHaveTextContent('3');

    // 下部「＋カプセル補充」ボタンからボトムシートを開く
    fireEvent.click(screen.getByTestId('open-supply-sheet-button'));
    expect(screen.getByTestId('task-supply-sheet')).toBeInTheDocument();

    // 常連スタンプ8種がすべて表示されていること
    for (let i = 0; i < DEFAULT_CUSTOM_STAMPS.length; i++) {
      expect(screen.getByTestId(`supply-stamp-button-${i}`)).toHaveAttribute(
        'data-stamp-title',
        DEFAULT_CUSTOM_STAMPS[i],
      );
    }

    // スタンプを1タップで即補充
    fireEvent.click(screen.getByTestId('supply-stamp-button-0'));

    await waitFor(() => {
      expect(screen.getByTestId('status-coins')).toHaveTextContent('160');
      expect(screen.getByTestId('status-remaining-capsules')).toHaveTextContent('4');
    });
    expect(screen.getByTestId('supply-sheet-feedback')).toHaveTextContent('＋10コイン獲得');
  });

  it('雑な複数行テキストを送信すると複数のCapsuleTaskに分割して一括補充され、個数×10コインが付与される (FR-01, FR-04, FR-05)', async () => {
    const onSupplyStamp = vi.fn();
    const onSupplyCapsules = vi.fn().mockImplementation(async (drafts) => {
      const list = Array.isArray(drafts) ? drafts : [drafts];
      return list.map((d: ExtractedCapsuleTaskDraft, idx: number) => ({
        id: `cap_extracted_${idx}`,
        title: d.title,
        capsuleColor: d.capsuleColor,
        rarityBoost: d.rarityBoost,
        medalPrompt: d.medalPrompt,
        createdAt: '2026-10-25T00:00:00Z',
        skipCount: 0,
        status: 'pending' as const,
      }));
    });
    const onSupplySuccess = vi.fn();
    const extractTasksFn = vi.fn().mockResolvedValue({
      tasks: [
        {
          title: '牛乳を買う',
          capsuleColor: 'blue',
          rarityBoost: 1.0,
          medalPrompt: 'Milk medal prompt',
        },
        {
          title: '企画書を提出する',
          capsuleColor: 'gold',
          rarityBoost: 2.0,
          medalPrompt: 'Draft medal prompt',
        },
      ],
    });

    render(
      React.createElement(TaskSupplySheet, {
        isOpen: true,
        onClose: vi.fn(),
        onSupplyStamp,
        onSupplyCapsules,
        onSupplySuccess,
        extractTasksFn,
      }),
    );

    const textarea = screen.getByTestId('supply-text-input');
    fireEvent.change(textarea, {
      target: { value: '牛乳買って、あと企画書も提出しなきゃ' },
    });

    fireEvent.click(screen.getByTestId('supply-text-submit-button'));

    await waitFor(() => {
      expect(extractTasksFn).toHaveBeenCalledWith({
        text: '牛乳買って、あと企画書も提出しなきゃ',
      });
      expect(onSupplyCapsules).toHaveBeenCalledTimes(1);
      expect(onSupplySuccess).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId('supply-sheet-feedback')).toHaveTextContent(
      '2個のカプセルを一括補充！＋20コイン獲得',
    );
  });

  it('音声ボヤき録音から停止すると Base64 Audio が /api/tasks/extract へ送信され一括補充される (FR-01, FR-05)', async () => {
    class MockMediaRecorder {
      static isTypeSupported(mime: string) {
        return mime.startsWith('audio/webm');
      }
      public state: RecordingState = 'inactive';
      public mimeType = 'audio/webm;codecs=opus';
      public ondataavailable: ((event: BlobEvent) => void) | null = null;
      public onstop: (() => void) | null = null;

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        const chunk = new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType });
        this.ondataavailable?.({ data: chunk } as BlobEvent);
        this.onstop?.();
      }
    }

    const mockStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    const extractTasksFn = vi.fn().mockResolvedValue({
      tasks: [
        {
          title: '部屋の掃除機をかける',
          capsuleColor: 'red',
          rarityBoost: 1.5,
          medalPrompt: 'Vacuum cleaner silver medal',
        },
      ],
    });

    const onSupplyCapsules = vi.fn().mockResolvedValue([
      {
        id: 'cap_voice_1',
        title: '部屋の掃除機をかける',
        capsuleColor: 'red',
        rarityBoost: 1.5,
        medalPrompt: 'Vacuum cleaner silver medal',
        createdAt: '2026-10-25T00:00:00Z',
        skipCount: 0,
        status: 'pending',
      },
    ]);

    render(
      React.createElement(TaskSupplySheet, {
        isOpen: true,
        onClose: vi.fn(),
        onSupplyStamp: vi.fn(),
        onSupplyCapsules,
        extractTasksFn,
        voiceRecorderOptions: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
          MediaRecorderClass: MockMediaRecorder as unknown as typeof MediaRecorder,
        },
      }),
    );

    const recordBtn = screen.getByTestId('voice-record-button');

    // 1回目タップ: 録音開始
    fireEvent.click(recordBtn);
    await waitFor(() => {
      expect(recordBtn).toHaveAttribute('data-recording', 'true');
      expect(screen.getByTestId('voice-recording-indicator')).toBeInTheDocument();
    });

    // 2回目タップ: 録音停止 -> AI抽出 -> 補充
    fireEvent.click(recordBtn);
    await waitFor(() => {
      expect(extractTasksFn).toHaveBeenCalledWith({
        audioBase64: 'AQIDBA==',
        mimeType: 'audio/webm',
      });
      expect(onSupplyCapsules).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId('supply-sheet-feedback')).toHaveTextContent(
      '1個のカプセルを一括補充！＋10コイン獲得',
    );
  });

  it('マイク準備中（getUserMedia 待ち）に補充シートを閉じた場合、権限許可後に非表示で録音が始まらずストリームが停止される', async () => {
    let resolveUserMedia: (stream: unknown) => void = () => {};
    const getUserMedia = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveUserMedia = resolve;
        }),
    );
    const trackStop = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: trackStop }] };
    const recorderStart = vi.fn();

    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      mimeType = 'audio/webm';
      state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start = recorderStart;
      stop = vi.fn();
    }

    const onClose = vi.fn();
    const { rerender } = render(
      React.createElement(TaskSupplySheet, {
        isOpen: true,
        onClose,
        onSupplyStamp: vi.fn(),
        onSupplyCapsules: vi.fn(),
        voiceRecorderOptions: {
          getUserMedia: getUserMedia as never,
          MediaRecorderClass: FakeMediaRecorder as unknown as typeof MediaRecorder,
        },
      }),
    );

    // 録音開始ボタンをタップして getUserMedia 待ち（isPreparing）に入る
    fireEvent.click(screen.getByTestId('voice-record-button'));
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // 権限ダイアログ待ちの間に閉じるボタンをタップし、シートを非表示（isOpen=false）にする
    fireEvent.click(screen.getByTestId('close-supply-sheet-button'));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      React.createElement(TaskSupplySheet, {
        isOpen: false,
        onClose,
        onSupplyStamp: vi.fn(),
        onSupplyCapsules: vi.fn(),
        voiceRecorderOptions: {
          getUserMedia: getUserMedia as never,
          MediaRecorderClass: FakeMediaRecorder as unknown as typeof MediaRecorder,
        },
      }),
    );

    // 非表示になった後に getUserMedia が解決される
    await act(async () => {
      resolveUserMedia(fakeStream);
    });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorderStart).not.toHaveBeenCalled();
  });

  it('フロントエンドのソースおよびビルドバンドルに GEMINI_API_KEY が露出しないこと', () => {
    const clientDir = path.resolve(process.cwd(), 'src/client');
    const collectFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        return entry.isDirectory() ? collectFiles(fullPath) : [fullPath];
      });
    };

    const clientFiles = collectFiles(clientDir);
    expect(clientFiles.length).toBeGreaterThan(0);

    for (const filePath of clientFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain('GEMINI_API_KEY');
      expect(content).not.toContain('@google/genai');
    }
  });
});
