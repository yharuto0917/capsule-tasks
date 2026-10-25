import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/app';
import { TaskSupplySheet } from '../src/client/components/task-supply-sheet';
import {
  blobToBase64,
  detectSupportedAudioMimeType,
  normalizeRecorderMimeType,
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
    expect(callArgs.response_format).toEqual(TASK_EXTRACTION_JSON_SCHEMA);
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
