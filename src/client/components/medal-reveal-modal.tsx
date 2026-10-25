import React from 'react';
import { Award, Coins, Flame, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { MEDAL_RARITY_STYLE_MAP } from '../../server/lib/medal-frames';
import type { MedalItem, MedalRarity } from '../../shared/schemas';

export interface MedalRevealModalProps {
  /** モーダルの表示状態 */
  isOpen: boolean;
  /** モーダルを閉じて次のカプセルへ進むコールバック */
  onClose: () => void;
  /** 図鑑ドロワーを開いて獲得したメダルを確認するコールバック */
  onOpenCollection?: () => void;
  /** 図鑑を開ける状態かどうか（未保存エラー時は無効化） */
  canOpenCollection?: boolean;
  /** 達成したカプセルタスク名 */
  taskTitle: string;
  /** 抽選されたメダルレア度（N / R / SR / SSR） */
  rarity: MedalRarity;
  /** 開封によって獲得したコイン数 */
  coinsEarned: number;
  /** 更新後の当日連続コンボ数 */
  todayCombo?: number;
  /** 生成されたメダルアイテム（生成完了前でも仮情報を渡せる） */
  medal: MedalItem | null;
  /** 生成されたメダル画像の Data URL */
  imageUrl: string | null;
  /** AIメダル生成リクエスト中かどうか */
  isGenerating?: boolean;
  /** フォールバックや補足ステータスメッセージ */
  statusNote?: string | null;
  /** IndexedDB 保存失敗時のエラーメッセージ */
  saveError?: string | null;
  /** 再保存処理中フラグ */
  isSaving?: boolean;
  /** 保存失敗時に生成済みメダルを図鑑へ再保存するコールバック */
  onRetrySave?: () => void;
}

/**
 * カプセル開封・AI記念メダル獲得モーダル（3. ③ / FR-13, FR-14）
 * - `gemini-nano-banana-2.1` が動的生成した `1:1` 記念メダル画像、抽選レア度（N/R/SR/SSR）、
 *   刻印テキスト（`engravedText`）、獲得コインを表示する。
 */
export const MedalRevealModal: React.FC<MedalRevealModalProps> = ({
  isOpen,
  onClose,
  onOpenCollection,
  canOpenCollection = true,
  taskTitle,
  rarity,
  coinsEarned,
  todayCombo,
  medal,
  imageUrl,
  isGenerating = false,
  statusNote = null,
  saveError = null,
  isSaving = false,
  onRetrySave,
}) => {
  if (!isOpen) {
    return null;
  }

  const rarityStyle = MEDAL_RARITY_STYLE_MAP[rarity] ?? MEDAL_RARITY_STYLE_MAP.N;
  const displayEngravedText = medal?.engravedText || 'TASK CONQUEROR';
  const displayMedalName = medal?.medalName || `「${taskTitle}」記念メダル`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="記念メダル獲得モーダル"
      data-testid="medal-reveal-modal"
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 px-3.5 py-4 backdrop-blur-[3px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="toy-cream-panel relative flex max-h-[92%] w-full flex-col items-center overflow-y-auto rounded-[32px] border-4 border-[#1E1B18] bg-[#FFF8EC] px-4 pt-3.5 pb-4 shadow-[0_10px_0_#1E1B18,0_20px_40px_rgba(0,0,0,0.45)]">
        {/* 上部：レア度バッジ＆閉じるボタン */}
        <div className="flex w-full items-center justify-between gap-2">
          <span
            data-testid="reveal-medal-rarity"
            data-rarity={rarity}
            className={`inline-flex items-center gap-1.5 rounded-full border-2 border-[#1E1B18] px-3 py-1 font-display text-xs font-black tracking-wide shadow-[0_2px_0_#1E1B18] ${rarityStyle.badgeBgClass}`}
          >
            <Sparkles className="h-3.5 w-3.5 stroke-[2.75]" aria-hidden="true" />
            <span>{rarityStyle.badgeLabel}</span>
            <span className="text-[10px] font-bold opacity-90">({rarityStyle.tierLabelJa})</span>
          </span>

          <button
            type="button"
            onClick={onClose}
            aria-label="メダル獲得モーダルを閉じる"
            data-testid="close-reveal-modal-icon-button"
            className="toy-push-btn flex h-8 w-8 items-center justify-center rounded-xl bg-[#FFE2DE] text-[#1E1B18] cursor-pointer"
          >
            <X className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
          </button>
        </div>

        {/* タイトル見出し */}
        <div className="mt-2 text-center">
          <p className="font-display text-[11px] font-black tracking-wider text-[#D97706] uppercase">
            CAPSULE CRACKED! NEW MEDAL UNLOCKED
          </p>
          <h2
            data-testid="reveal-medal-name"
            className="font-toy mt-0.5 text-sm sm:text-base font-bold text-[#1E1B18] leading-snug"
          >
            {displayMedalName}
          </h2>
        </div>

        {/* 中央：1:1 正方形 記念メダル画像ショーケース */}
        <div className="relative my-2.5 flex items-center justify-center">
          <div
            aria-hidden="true"
            style={{ background: rarityStyle.glowBgStyle }}
            className="pointer-events-none absolute -inset-4 rounded-full blur-md"
          />

          <div
            className={`relative flex h-44 w-44 sm:h-48 sm:w-48 flex-col items-center justify-center overflow-hidden rounded-[28px] border-4 border-[#1E1B18] p-2 shadow-[inset_0_3px_8px_rgba(255,255,255,0.35),0_6px_0_#1E1B18] ${rarityStyle.frameBorderClass}`}
          >
            {isGenerating && !imageUrl ? (
              <div
                data-testid="reveal-medal-loading"
                className="flex flex-col items-center justify-center gap-2 px-3 text-center text-[#FFF8EC]"
              >
                <Loader2
                  className="h-8 w-8 animate-spin text-[#FFBE0B] stroke-[2.75]"
                  aria-hidden="true"
                />
                <span className="text-xs font-black leading-tight">
                  gemini-nano-banana-2.1 で記念メダルを刻印中...
                </span>
              </div>
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt={`${displayMedalName} (${displayEngravedText})`}
                data-testid="reveal-medal-image"
                className="h-full w-full rounded-2xl object-cover"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-1 text-[#FFF8EC]">
                <Award className="h-12 w-12 text-[#FFBE0B]" aria-hidden="true" />
                <span className="text-xs font-bold">{rarity} MEDAL</span>
              </div>
            )}

            {isGenerating && imageUrl && (
              <div
                data-testid="reveal-medal-generating-badge"
                className="absolute top-2 right-2 flex items-center gap-1 rounded-full border border-[#1E1B18] bg-[#1E1B18]/85 px-2 py-0.5 text-[10px] font-bold text-[#FFBE0B]"
              >
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                <span>AI刻印中</span>
              </div>
            )}
          </div>
        </div>

        {/* 刻印テキストプレート（FR-14: High-precision engravedText） */}
        <div className="w-full max-w-[260px] rounded-xl border-2 border-[#1E1B18] bg-[#1E1B18] px-3 py-1.5 text-center shadow-[0_3px_0_#78350F]">
          <span className="block text-[9px] font-bold tracking-widest text-[#FFBE0B] uppercase">
            ENGRAVED RIM TITLE
          </span>
          <span
            data-testid="reveal-engraved-text"
            className="font-display block text-xs sm:text-sm font-black tracking-wider text-[#FFF8EC]"
          >
            {displayEngravedText}
          </span>
        </div>

        {/* 達成タスク名＆獲得報酬バッジ */}
        <div className="mt-2.5 w-full space-y-2 rounded-2xl border-2 border-[#1E1B18] bg-white px-3 py-2 text-center shadow-[inset_0_2px_0_#FFF8EC]">
          <p className="text-[11px] font-bold text-[#57534E]">
            達成タスク:{' '}
            <span data-testid="reveal-task-title" className="font-black text-[#1E1B18]">
              {taskTitle}
            </span>
          </p>

          <div className="flex items-center justify-center gap-2">
            <span
              data-testid="reveal-coins-earned"
              className="inline-flex items-center gap-1 rounded-xl border-2 border-[#1E1B18] bg-[#FFF0B3] px-2.5 py-1 font-display text-xs font-black text-[#1E1B18]"
            >
              <Coins className="h-3.5 w-3.5 text-[#D97706] stroke-[2.75]" aria-hidden="true" />
              <span>+{coinsEarned} COIN</span>
            </span>

            {typeof todayCombo === 'number' && (
              <span
                data-testid="reveal-combo-badge"
                className="inline-flex items-center gap-1 rounded-xl border-2 border-[#1E1B18] bg-[#FFE2DE] px-2.5 py-1 font-display text-xs font-black text-[#991B1B]"
              >
                <Flame className="h-3.5 w-3.5 fill-current text-[#EF3E36]" aria-hidden="true" />
                <span>{todayCombo} COMBO!</span>
              </span>
            )}
          </div>

          {saveError ? (
            <div
              role="alert"
              data-testid="reveal-save-error"
              className="space-y-1.5 rounded-xl border-2 border-[#991B1B] bg-[#FFE2DE] px-2.5 py-2 text-center"
            >
              <p className="text-[11px] font-black text-[#991B1B]">{saveError}</p>
              {onRetrySave && (
                <button
                  type="button"
                  onClick={onRetrySave}
                  disabled={isSaving}
                  data-testid="retry-save-medal-button"
                  className="toy-push-btn inline-flex min-h-[34px] items-center justify-center gap-1 rounded-xl bg-[#EF3E36] px-3 py-1 text-xs font-black text-white disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 stroke-[2.75] ${isSaving ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>{isSaving ? '再保存中...' : '図鑑に再保存する'}</span>
                </button>
              )}
            </div>
          ) : (
            statusNote && (
              <p data-testid="reveal-status-note" className="text-[10px] font-bold text-[#78350F]">
                {statusNote}
              </p>
            )
          )}
        </div>

        {/* 下部アクションボタン（親指操作エリア） */}
        <div className="mt-3 grid w-full grid-cols-5 gap-2">
          {onOpenCollection && (
            <button
              type="button"
              onClick={onOpenCollection}
              disabled={!canOpenCollection || Boolean(saveError) || isSaving}
              data-testid="open-collection-from-modal-button"
              className="toy-push-btn col-span-2 flex min-h-[44px] items-center justify-center gap-1 rounded-2xl bg-[#2563EB] px-2.5 py-2 text-xs font-black text-white disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer"
            >
              <Award className="h-4 w-4 text-[#FFBE0B] shrink-0" aria-hidden="true" />
              <span>図鑑で見る</span>
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            data-testid="close-reveal-modal-button"
            className={`toy-push-btn ${
              onOpenCollection ? 'col-span-3' : 'col-span-5'
            } flex min-h-[44px] items-center justify-center gap-1.5 rounded-2xl bg-[#FFBE0B] px-3 py-2 text-xs sm:text-sm font-black text-[#1E1B18] cursor-pointer`}
          >
            <span>閉じて次のカプセルへ</span>
          </button>
        </div>
      </div>
    </div>
  );
};
