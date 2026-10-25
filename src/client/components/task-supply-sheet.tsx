import React, { useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Coins,
  Dumbbell,
  Loader2,
  Mail,
  Mic,
  Send,
  Shirt,
  ShoppingBag,
  Sparkles,
  Square,
  Trash2,
  Utensils,
  Wand2,
  X,
} from 'lucide-react';
import {
  DEFAULT_CUSTOM_STAMPS,
  type CapsuleColor,
  type CapsuleTask,
  type ExtractedCapsuleTaskDraft,
  type TaskExtractionResponse,
} from '../../shared/schemas';
import { SUPPLY_BONUS_COINS_PER_CAPSULE } from '../hooks/use-capsule-store';
import { useVoiceRecorder, type UseVoiceRecorderOptions } from '../hooks/use-voice-recorder';
import { extractCapsuleTasks, type TaskExtractRequestPayload } from '../lib/api-client';

export interface TaskSupplySheetProps {
  /** ボトムシートの表示状態 */
  isOpen: boolean;
  /** ボトムシートを閉じるコールバック */
  onClose: () => void;
  /** 常連スタンプ8種の配列（PlayerState.customStamps） */
  stamps?: string[];
  /** ストア側の排他更新中フラグ */
  isUpdating?: boolean;
  /** 常連スタンプ1タップ補充ハンドラ（FR-03, FR-04） */
  onSupplyStamp: (stampTitle: string, color?: CapsuleColor) => Promise<CapsuleTask>;
  /** AI抽出された複数タスクの一括補充ハンドラ（FR-01, FR-04, FR-05） */
  onSupplyCapsules: (
    drafts: ExtractedCapsuleTaskDraft | ExtractedCapsuleTaskDraft[],
  ) => Promise<CapsuleTask[]>;
  /** カプセル補充完了時の効果音・親ステージ通知コールバック */
  onSupplySuccess?: (suppliedTasks: CapsuleTask[]) => void;
  /** 単体テスト等でのタスク抽出API関数差し替え用 */
  extractTasksFn?: (payload: TaskExtractRequestPayload) => Promise<TaskExtractionResponse>;
  /** 単体テスト等での音声レコーダー設定差し替え用 */
  voiceRecorderOptions?: UseVoiceRecorderOptions;
}

function getStampIcon(stampLabel: string) {
  if (stampLabel.includes('掃除') || stampLabel.includes('片付')) return Sparkles;
  if (stampLabel.includes('洗濯')) return Shirt;
  if (stampLabel.includes('買')) return ShoppingBag;
  if (stampLabel.includes('返信') || stampLabel.includes('メール') || stampLabel.includes('連絡'))
    return Mail;
  if (stampLabel.includes('ゴミ')) return Trash2;
  if (stampLabel.includes('勉強') || stampLabel.includes('読書')) return BookOpen;
  if (stampLabel.includes('運動') || stampLabel.includes('筋トレ') || stampLabel.includes('散歩'))
    return Dumbbell;
  if (stampLabel.includes('皿') || stampLabel.includes('料理') || stampLabel.includes('炊事'))
    return Utensils;
  return CheckCircle2;
}

function formatRecordingDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * 画面下部「＋補充」ボタンからスライド表示されるタスク補充ボトムシート（FR-01, FR-03, FR-04, FR-05）
 * - 常連スタンプ8種の1タップ即時補充（＋10コイン）
 * - MediaRecorder による音声ボヤき録音 → `gemini-3.8-flash` 一括抽出補充
 * - 雑な複数行テキストメモ → `gemini-3.8-flash` 一括抽出補充
 */
export const TaskSupplySheet: React.FC<TaskSupplySheetProps> = ({
  isOpen,
  onClose,
  stamps = DEFAULT_CUSTOM_STAMPS,
  isUpdating = false,
  onSupplyStamp,
  onSupplyCapsules,
  onSupplySuccess,
  extractTasksFn = extractCapsuleTasks,
  voiceRecorderOptions,
}) => {
  const [textInput, setTextInput] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const {
    isRecording,
    isPreparing,
    durationSeconds,
    mimeType,
    error: recorderError,
    startRecording,
    stopRecording,
    cancelRecording,
    clearError: clearRecorderError,
  } = useVoiceRecorder(voiceRecorderOptions);

  if (!isOpen) {
    return null;
  }

  const displayStamps = (stamps.length > 0 ? stamps : DEFAULT_CUSTOM_STAMPS).slice(0, 8);
  const isBusy = isUpdating || isExtracting || isPreparing;
  const activeError = localError ?? recorderError;

  const handleClose = () => {
    if (isRecording) {
      cancelRecording();
    }
    setLocalError(null);
    clearRecorderError();
    onClose();
  };

  const handleStampTap = async (stampTitle: string) => {
    if (isBusy || isRecording) return;
    setLocalError(null);
    clearRecorderError();
    try {
      const created = await onSupplyStamp(stampTitle, 'blue');
      onSupplySuccess?.([created]);
      setFeedbackMessage(
        `「${created.title}」を補充しました！＋${SUPPLY_BONUS_COINS_PER_CAPSULE}コイン獲得`,
      );
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : 'スタンプの補充中にエラーが発生しました。',
      );
    }
  };

  const handleExtractAndSupply = async (payload: TaskExtractRequestPayload) => {
    setIsExtracting(true);
    setLocalError(null);
    clearRecorderError();
    try {
      const response = await extractTasksFn(payload);
      if (!response.tasks || response.tasks.length === 0) {
        setLocalError('タスクを抽出できませんでした。もう少し具体的に話すか入力してください。');
        return false;
      }

      const createdTasks = await onSupplyCapsules(response.tasks);
      if (createdTasks.length === 0) {
        setLocalError('有効なタスクが見つかりませんでした。');
        return false;
      }

      onSupplySuccess?.(createdTasks);
      const earnedCoins = createdTasks.length * SUPPLY_BONUS_COINS_PER_CAPSULE;
      setFeedbackMessage(
        `${createdTasks.length}個のカプセルを一括補充！＋${earnedCoins}コイン獲得`,
      );
      return true;
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : 'AIタスク抽出に失敗しました。通信環境を確認してください。',
      );
      return false;
    } finally {
      setIsExtracting(false);
    }
  };

  const handleVoiceToggle = async () => {
    if (isBusy) return;
    setLocalError(null);
    clearRecorderError();

    if (!isRecording) {
      await startRecording();
      return;
    }

    const recorded = await stopRecording();
    if (!recorded || !recorded.base64Data) {
      return;
    }

    const optionalText = textInput.trim();
    const ok = await handleExtractAndSupply({
      audioBase64: recorded.base64Data,
      mimeType: recorded.mimeType,
      ...(optionalText ? { text: optionalText } : {}),
    });
    if (ok && optionalText) {
      setTextInput('');
    }
  };

  const handleTextSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = textInput.trim();
    if (!trimmed || isBusy || isRecording) return;

    const ok = await handleExtractAndSupply({ text: trimmed });
    if (ok) {
      setTextInput('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="タスク補充シート"
      data-testid="task-supply-sheet"
      className="absolute inset-0 z-40 flex flex-col justify-end bg-black/50 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isBusy) {
          handleClose();
        }
      }}
    >
      <div className="toy-cream-panel relative flex max-h-[88%] w-full flex-col overflow-hidden rounded-t-[32px] border-t-4 border-[#1E1B18] bg-[#FFF8EC] px-3.5 pt-3 pb-4 shadow-[0_-8px_24px_rgba(0,0,0,0.3)]">
        {/* 上部ドラッグハンドル装飾＆ヘッダー */}
        <div className="mx-auto mb-2 h-1.5 w-12 shrink-0 rounded-full bg-[#1E1B18]/25" />

        <div className="flex shrink-0 items-center justify-between gap-2 pb-2.5 border-b-2 border-[#1E1B18]/15">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border-2 border-[#1E1B18] bg-[#FFBE0B] text-[#1E1B18] shadow-[0_2px_0_#1E1B18]">
              <Coins className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-toy text-sm sm:text-base font-bold text-[#1E1B18] leading-tight">
                カプセル補充ポット
              </h2>
              <p className="text-[11px] font-bold text-[#78350F]">
                1個補充するごとに即時 ＋{SUPPLY_BONUS_COINS_PER_CAPSULE} コイン獲得！
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            disabled={isExtracting}
            aria-label="補充シートを閉じる"
            data-testid="close-supply-sheet-button"
            className="toy-push-btn flex h-9 w-9 items-center justify-center rounded-xl bg-[#FFE2DE] text-[#1E1B18] disabled:opacity-45 cursor-pointer"
          >
            <X className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
          </button>
        </div>

        {/* スクロール可能なメインコンテンツ領域（375pxモバイル幅対応） */}
        <div className="mt-2.5 flex-1 space-y-3 overflow-y-auto pr-0.5">
          {/* 補充成功フィードバックバナー */}
          {feedbackMessage && (
            <div
              role="status"
              aria-live="polite"
              data-testid="supply-sheet-feedback"
              className="flex items-center gap-1.5 rounded-xl border-2 border-[#1E1B18] bg-gradient-to-r from-[#FEF08A] to-[#FFBE0B] px-3 py-2 text-xs font-black text-[#1E1B18] shadow-[0_3px_0_#1E1B18]"
            >
              <Sparkles className="h-4 w-4 shrink-0 stroke-[2.75]" aria-hidden="true" />
              <span>{feedbackMessage}</span>
            </div>
          )}

          {/* エラーアラート */}
          {activeError && (
            <div
              role="alert"
              data-testid="supply-error-message"
              className=" rounded-xl border-2 border-[#1E1B18] bg-[#FFE2DE] px-3 py-2 text-xs font-black text-[#991B1B] shadow-[0_3px_0_#1E1B18]"
            >
              {activeError}
            </div>
          )}

          {/* 1. 常連スタンプ8種 1タップ補充セクション（FR-03, FR-04） */}
          <section aria-label="常連スタンプ1タップ補充" className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black text-[#1E1B18]">
                常連スタンプ（1タップ即補充）
              </span>
              <span className="rounded-full border border-[#1E1B18] bg-[#FFF0B3] px-2 py-0.5 font-display text-[10px] font-bold text-[#78350F]">
                文字入力ゼロ・即+10 COIN
              </span>
            </div>

            <div data-testid="supply-stamp-grid" className="grid grid-cols-4 gap-1.5">
              {displayStamps.map((stamp, idx) => {
                const IconComponent = getStampIcon(stamp);
                return (
                  <button
                    key={`${stamp}-${idx}`}
                    type="button"
                    disabled={isBusy || isRecording}
                    onClick={() => void handleStampTap(stamp)}
                    data-testid={`supply-stamp-button-${idx}`}
                    data-stamp-title={stamp}
                    aria-label={`${stamp}を補充 (+10コイン)`}
                    className="toy-push-btn flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-white px-1.5 py-1.5 text-[#1E1B18] hover:bg-[#FFFBEB] disabled:opacity-45 cursor-pointer"
                  >
                    <div className="flex items-center gap-1">
                      <IconComponent
                        className="h-3.5 w-3.5 stroke-[2.5] text-[#0284C7] shrink-0"
                        aria-hidden="true"
                      />
                      <span className="rounded-full bg-[#FFBE0B] px-1 font-display text-[9px] font-bold text-[#1E1B18]">
                        +10
                      </span>
                    </div>
                    <span className="w-full truncate text-center text-[11px] font-black leading-tight">
                      {stamp}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 2. AIマルチモーダル音声ボヤき召喚セクション（FR-01, FR-05） */}
          <section
            aria-label="AI音声ボヤき召喚"
            className="rounded-2xl border-2 border-[#1E1B18] bg-[#E0F4FF] p-2.5 shadow-[inset_0_2px_0_rgba(255,255,255,0.8)] space-y-2"
          >
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1.5">
                <Mic className="h-4 w-4 stroke-[2.75] text-[#0284C7]" aria-hidden="true" />
                <span className="text-xs font-black text-[#1E1B18]">AI音声ボヤき一括召喚</span>
              </div>
              <span className="rounded-full border border-[#1E1B18] bg-[#0284C7] px-2 py-0.5 font-display text-[10px] font-bold text-white">
                gemini-3.8-flash
              </span>
            </div>

            <p className="text-[11px] font-bold text-[#0C4A6E] leading-snug">
              「明日牛乳買って、金曜の企画書も出さなきゃ…」と喋るだけで、フィラーを除去して複数カプセルへ自動分割＆難易度判定します。
            </p>

            {isRecording && (
              <div
                data-testid="voice-recording-indicator"
                className="flex items-center justify-between rounded-xl border-2 border-[#1E1B18] bg-[#FFE2DE] px-2.5 py-1.5 text-xs font-black text-[#991B1B]"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#EF3E36] animate-ping" />
                  <span>録音中... {formatRecordingDuration(durationSeconds)}</span>
                </div>
                <span className="font-display text-[10px] uppercase text-[#7F1D1D]">
                  {mimeType}
                </span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleVoiceToggle()}
                disabled={isBusy}
                data-testid="voice-record-button"
                data-recording={isRecording ? 'true' : 'false'}
                className={`toy-push-btn flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-xs font-black cursor-pointer disabled:opacity-45 ${
                  isRecording ? 'bg-[#EF3E36] text-white' : 'bg-[#38BDF8] text-[#1E1B18]'
                }`}
              >
                {isExtracting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin stroke-[2.75]" aria-hidden="true" />
                    <span>AIがカプセルへ分解中...</span>
                  </>
                ) : isRecording ? (
                  <>
                    <Square className="h-4 w-4 fill-current" aria-hidden="true" />
                    <span>録音完了してAIカプセル化</span>
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
                    <span>マイクでボヤいて一括補充</span>
                  </>
                )}
              </button>

              {isRecording && (
                <button
                  type="button"
                  onClick={cancelRecording}
                  data-testid="voice-cancel-button"
                  className="toy-push-btn flex min-h-[46px] items-center justify-center rounded-2xl bg-white px-3 py-2 text-xs font-black text-[#1E1B18] cursor-pointer"
                >
                  キャンセル
                </button>
              )}
            </div>
          </section>

          {/* 3. 雑なテキスト・複数行メモからのAI一括補充セクション（FR-01, FR-05） */}
          <form onSubmit={(e) => void handleTextSubmit(e)} className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="supply-text-textarea"
                className="flex items-center gap-1 text-xs font-black text-[#1E1B18]"
              >
                <Wand2 className="h-3.5 w-3.5 stroke-[2.75] text-[#D97706]" aria-hidden="true" />
                <span>雑なメモ・複数行テキストから一括補充</span>
              </label>
              <span className="text-[10px] font-bold text-[#57534E]">色・レア度自動判定</span>
            </div>

            <textarea
              id="supply-text-textarea"
              rows={3}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={isBusy || isRecording}
              data-testid="supply-text-input"
              placeholder={
                '例：あー明日までに牛乳買って、金曜の企画書ドラフトも提出しなきゃ、あと部屋の掃除機かける'
              }
              className="w-full resize-none rounded-2xl border-2 border-[#1E1B18] bg-white px-3 py-2 text-xs font-bold text-[#1E1B18] placeholder:text-[#A8A29E] focus:outline-none focus:ring-2 focus:ring-[#FFBE0B] select-text"
            />

            <button
              type="submit"
              disabled={isBusy || isRecording || textInput.trim().length === 0}
              data-testid="supply-text-submit-button"
              className="toy-push-btn flex min-h-[46px] w-full items-center justify-center gap-2 rounded-2xl bg-[#FFBE0B] px-3 py-2.5 text-xs font-black text-[#1E1B18] disabled:opacity-45 cursor-pointer"
            >
              {isExtracting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin stroke-[2.75]" aria-hidden="true" />
                  <span>gemini-3.8-flash でカプセル化中...</span>
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
                  <span>AIで複数カプセルに分解して補充 (+10/個)</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
