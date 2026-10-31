import React, { useEffect } from 'react';
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

interface ConfettiSpec {
  cx: string;
  cy: string;
  crot: string;
  cdelay: string;
  color: string;
  shape: 'rect' | 'pill' | 'dot';
}

const SSR_CONFETTI_PIECES: ConfettiSpec[] = [
  { cx: '-132px', cy: '-110px', crot: '-280deg', cdelay: '0ms', color: '#FF2E3B', shape: 'rect' },
  { cx: '-96px', cy: '-136px', crot: '240deg', cdelay: '35ms', color: '#FFBE0B', shape: 'pill' },
  { cx: '-52px', cy: '-148px', crot: '-210deg', cdelay: '70ms', color: '#00A8E8', shape: 'rect' },
  { cx: '-14px', cy: '-154px', crot: '300deg', cdelay: '20ms', color: '#10B981', shape: 'dot' },
  { cx: '24px', cy: '-152px', crot: '-260deg', cdelay: '55ms', color: '#EC4899', shape: 'rect' },
  { cx: '64px', cy: '-144px', crot: '220deg', cdelay: '85ms', color: '#A855F7', shape: 'pill' },
  { cx: '102px', cy: '-132px', crot: '-295deg', cdelay: '30ms', color: '#FFBE0B', shape: 'rect' },
  { cx: '136px', cy: '-106px', crot: '265deg', cdelay: '65ms', color: '#00A8E8', shape: 'pill' },
  { cx: '-146px', cy: '-54px', crot: '215deg', cdelay: '95ms', color: '#10B981', shape: 'rect' },
  { cx: '148px', cy: '-48px', crot: '-235deg', cdelay: '110ms', color: '#FF2E3B', shape: 'rect' },
  { cx: '-124px', cy: '-14px', crot: '-190deg', cdelay: '130ms', color: '#A855F7', shape: 'dot' },
  { cx: '126px', cy: '-10px', crot: '195deg', cdelay: '140ms', color: '#EC4899', shape: 'dot' },
  { cx: '-84px', cy: '-88px', crot: '320deg', cdelay: '115ms', color: '#FDE047', shape: 'rect' },
  { cx: '86px', cy: '-86px', crot: '-310deg', cdelay: '125ms', color: '#34D399', shape: 'pill' },
  { cx: '-38px', cy: '-108px', crot: '185deg', cdelay: '150ms', color: '#FF2E3B', shape: 'pill' },
  { cx: '42px', cy: '-112px', crot: '-205deg', cdelay: '160ms', color: '#00A8E8', shape: 'rect' },
];

interface SparkleSpec {
  top: string;
  left: string;
  delay: string;
  sizeClass: string;
}

const SHOWCASE_SPARKLES: SparkleSpec[] = [
  { top: '-10px', left: '12%', delay: '0ms', sizeClass: 'h-4 w-4' },
  { top: '6%', left: '92%', delay: '220ms', sizeClass: 'h-4.5 w-4.5' },
  { top: '34%', left: '-12px', delay: '460ms', sizeClass: 'h-3.5 w-3.5' },
  { top: '42%', left: '98%', delay: '680ms', sizeClass: 'h-4 w-4' },
  { top: '78%', left: '-6px', delay: '310ms', sizeClass: 'h-4 w-4' },
  { top: '84%', left: '90%', delay: '540ms', sizeClass: 'h-3.5 w-3.5' },
  { top: '-14px', left: '54%', delay: '790ms', sizeClass: 'h-3.5 w-3.5' },
  { top: '96%', left: '46%', delay: '150ms', sizeClass: 'h-3.5 w-3.5' },
];

const SUNBURST_CONIC_BY_RARITY: Record<MedalRarity, string | null> = {
  N: null,
  R: 'conic-gradient(from 0deg, rgba(226,232,240,0.05) 0deg, rgba(255,255,255,0.55) 20deg, rgba(148,163,184,0.08) 45deg, rgba(255,255,255,0.5) 75deg, rgba(226,232,240,0.05) 105deg, rgba(255,255,255,0.55) 140deg, rgba(148,163,184,0.08) 180deg, rgba(255,255,255,0.5) 215deg, rgba(226,232,240,0.05) 250deg, rgba(255,255,255,0.55) 295deg, rgba(148,163,184,0.08) 330deg, rgba(226,232,240,0.05) 360deg)',
  SR: 'conic-gradient(from 0deg, rgba(255,190,11,0.08) 0deg, rgba(254,240,138,0.85) 18deg, rgba(255,190,11,0.08) 36deg, rgba(254,240,138,0.8) 54deg, rgba(255,190,11,0.08) 72deg, rgba(254,240,138,0.85) 90deg, rgba(255,190,11,0.08) 108deg, rgba(254,240,138,0.8) 126deg, rgba(255,190,11,0.08) 144deg, rgba(254,240,138,0.85) 162deg, rgba(255,190,11,0.08) 180deg, rgba(254,240,138,0.85) 198deg, rgba(255,190,11,0.08) 216deg, rgba(254,240,138,0.8) 234deg, rgba(255,190,11,0.08) 252deg, rgba(254,240,138,0.85) 270deg, rgba(255,190,11,0.08) 288deg, rgba(254,240,138,0.8) 306deg, rgba(255,190,11,0.08) 324deg, rgba(254,240,138,0.85) 342deg, rgba(255,190,11,0.08) 360deg)',
  SSR: 'conic-gradient(from 0deg, rgba(244,114,182,0.82) 0deg, rgba(250,204,21,0.88) 45deg, rgba(52,211,153,0.82) 95deg, rgba(56,189,248,0.88) 150deg, rgba(168,85,247,0.85) 210deg, rgba(244,114,182,0.85) 265deg, rgba(254,240,138,0.92) 315deg, rgba(244,114,182,0.82) 360deg)',
};

/**
 * カプセル開封・AI記念メダル獲得モーダル（3. ③ / FR-13, FR-14）
 * - `gemini-nano-banana-2.1` が動的生成した `1:1` 記念メダル画像、抽選レア度（N/R/SR/SSR）、
 *   刻印テキスト（`engravedText`）、獲得コインを表示する。
 * - Task 1.7: 開封閃光からの3D回転ポップアップ登場、およびレア度別の祝祭演出（N/R/SR/SSR）を搭載。
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
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const rarityStyle = MEDAL_RARITY_STYLE_MAP[rarity] ?? MEDAL_RARITY_STYLE_MAP.N;
  const displayEngravedText = medal?.engravedText || 'TASK CONQUEROR';
  const displayMedalName = medal?.medalName || `「${taskTitle}」記念メダル`;
  const sunburstConic = SUNBURST_CONIC_BY_RARITY[rarity];
  const isSsr = rarity === 'SSR';
  const isSr = rarity === 'SR';
  const isRare = rarity === 'R';
  const visibleSparkles =
    isSsr || isSr ? SHOWCASE_SPARKLES : isRare ? SHOWCASE_SPARKLES.slice(0, 5) : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="記念メダル獲得モーダル"
      data-testid="medal-reveal-modal"
      data-rarity={rarity}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 px-3.5 py-4 backdrop-blur-[3px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {/* カプセル開封から繋がる初期ホワイトゴールド閃光フラッシュ */}
      <div
        aria-hidden="true"
        data-testid="reveal-opening-flash"
        className="animate-stage-burst-flash pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_50%_42%,#FFFFFF_0%,#FEF08A_35%,rgba(255,190,11,0)_72%)]"
      />

      <div className="animate-modal-spring-in toy-cream-panel relative z-10 flex max-h-[92%] w-full flex-col items-center overflow-x-hidden overflow-y-auto rounded-[32px] border-4 border-[#1E1B18] bg-[#FFF8EC] px-4 pt-3.5 pb-4 shadow-[0_10px_0_#1E1B18,0_20px_40px_rgba(0,0,0,0.45)]">
        {/* SSR / SR 専用の上部祝祭アクセントトリム */}
        {(isSsr || isSr) && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-6 top-0 h-1.5 rounded-b-full ${
              isSsr
                ? 'bg-gradient-to-r from-[#EC4899] via-[#FACC15] via-[#34D399] to-[#38BDF8]'
                : 'bg-gradient-to-r from-[#F59E0B] via-[#FEF08A] to-[#D97706]'
            }`}
          />
        )}

        {/* SSR 専用：カラフルな紙吹雪バースト演出 */}
        {isSsr && (
          <div
            aria-hidden="true"
            data-testid="celebration-confetti"
            className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center overflow-hidden"
          >
            {SSR_CONFETTI_PIECES.map((piece, idx) => (
              <span
                key={idx}
                style={
                  {
                    '--cx': piece.cx,
                    '--cy': piece.cy,
                    '--crot': piece.crot,
                    '--cdelay': piece.cdelay,
                    backgroundColor: piece.color,
                  } as React.CSSProperties
                }
                className={`animate-confetti-piece absolute border border-[#1E1B18]/75 shadow-[0_1px_0_rgba(30,27,24,0.45)] ${
                  piece.shape === 'pill'
                    ? 'h-2 w-4 rounded-full'
                    : piece.shape === 'dot'
                      ? 'h-2.5 w-2.5 rounded-full'
                      : 'h-2.5 w-3.5 rounded-[3px]'
                }`}
              />
            ))}
          </div>
        )}

        {/* 上部：レア度バッジ＆閉じるボタン */}
        <div className="relative z-10 flex w-full items-center justify-between gap-2">
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
            className="toy-push-btn flex h-9 w-9 items-center justify-center rounded-xl bg-[#FFE2DE] text-[#1E1B18] cursor-pointer"
          >
            <X className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
          </button>
        </div>

        {/* タイトル見出し */}
        <div className="relative z-10 mt-2 text-center">
          <p
            className={`font-display text-[11px] font-black tracking-wider uppercase ${
              isSsr ? 'text-[#9333EA]' : 'text-[#D97706]'
            }`}
          >
            {isSsr
              ? 'RAINBOW JACKPOT! SSR MEDAL UNLOCKED'
              : isSr
                ? 'GOLDEN HIT! SR MEDAL UNLOCKED'
                : 'CAPSULE CRACKED! NEW MEDAL UNLOCKED'}
          </p>
          <h2
            data-testid="reveal-medal-name"
            className="font-toy mt-0.5 text-sm sm:text-base font-bold text-[#1E1B18] leading-snug"
          >
            {displayMedalName}
          </h2>
        </div>

        {/* 中央：1:1 正方形 記念メダル画像ショーケース（レア度別オーラ＋3D回転ポップアップ） */}
        <div className="relative my-3 flex items-center justify-center">
          {/* ベース背面グロウ */}
          <div
            aria-hidden="true"
            style={{ background: rarityStyle.glowBgStyle }}
            className="pointer-events-none absolute -inset-5 rounded-full blur-md"
          />

          {/* R / SR / SSR 回転サンバーストハロー */}
          {sunburstConic && (
            <div
              aria-hidden="true"
              data-testid="reveal-rarity-sunburst"
              style={{ background: sunburstConic }}
              className={`pointer-events-none absolute -inset-6 rounded-full opacity-85 [mask-image:radial-gradient(circle,black_38%,transparent_72%)] ${
                isSsr || isSr ? 'animate-halo-rotate-fast' : 'animate-halo-rotate'
              }`}
            />
          )}

          {/* メダルショーケース本体（3D Y軸回転ポップアップ登場） */}
          <div
            data-testid="reveal-medal-showcase"
            data-rarity={rarity}
            className={`animate-medal-3d-pop relative z-10 flex h-44 w-44 sm:h-48 sm:w-48 flex-col items-center justify-center overflow-hidden rounded-[28px] border-4 border-[#1E1B18] p-2 shadow-[inset_0_3px_8px_rgba(255,255,255,0.35),0_6px_0_#1E1B18] ${rarityStyle.frameBorderClass}`}
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
                decoding="async"
                data-testid="reveal-medal-image"
                className="h-full w-full rounded-2xl object-cover"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-1 text-[#FFF8EC]">
                <Award className="h-12 w-12 text-[#FFBE0B]" aria-hidden="true" />
                <span className="text-xs font-bold">{rarity} MEDAL</span>
              </div>
            )}

            {/* SSR 専用：虹色プリズム・ホログラム光沢スイープオーバーレイ */}
            {isSsr ? (
              <div
                aria-hidden="true"
                data-testid="ssr-hologram-shimmer"
                className="pointer-events-none absolute inset-0 overflow-hidden rounded-[24px]"
              >
                <div
                  className="animate-ssr-hologram-sweep absolute -inset-[65%] opacity-50 mix-blend-screen"
                  style={{
                    background:
                      'linear-gradient(115deg, transparent 22%, rgba(244,114,182,0.75) 36%, rgba(254,240,138,0.9) 46%, rgba(52,211,153,0.8) 54%, rgba(56,189,248,0.85) 62%, rgba(168,85,247,0.75) 70%, transparent 82%)',
                  }}
                />
              </div>
            ) : (
              /* N / R / SR：金属光沢の斜めグレアスイープ */
              <div
                aria-hidden="true"
                data-testid="medal-metallic-sheen"
                className="pointer-events-none absolute inset-0 overflow-hidden rounded-[24px]"
              >
                <div
                  className={`animate-medal-sheen absolute inset-y-0 -left-1/4 w-1/2 bg-gradient-to-r from-transparent via-white to-transparent ${
                    isSr ? 'opacity-55' : isRare ? 'opacity-45' : 'opacity-30'
                  }`}
                />
              </div>
            )}

            {isGenerating && imageUrl && (
              <div
                data-testid="reveal-medal-generating-badge"
                className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-full border border-[#1E1B18] bg-[#1E1B18]/85 px-2 py-0.5 text-[10px] font-bold text-[#FFBE0B]"
              >
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                <span>AI刻印中</span>
              </div>
            )}
          </div>

          {/* R / SR / SSR 外周のきらめきスパークル粒子 */}
          {visibleSparkles.length > 0 && (
            <div
              aria-hidden="true"
              data-testid={
                isSsr ? 'ssr-prism-sparkles' : isSr ? 'sr-gold-sparkles' : 'r-silver-sparkles'
              }
              className="pointer-events-none absolute inset-0 z-20"
            >
              {visibleSparkles.map((sp, idx) => (
                <Sparkles
                  key={idx}
                  style={
                    {
                      top: sp.top,
                      left: sp.left,
                      '--sdelay': sp.delay,
                    } as React.CSSProperties
                  }
                  className={`animate-sparkle-twinkle absolute ${sp.sizeClass} ${
                    isSsr
                      ? idx % 2 === 0
                        ? 'fill-[#FDE047] text-[#EC4899]'
                        : 'fill-[#A5F3FC] text-[#A855F7]'
                      : isSr
                        ? 'fill-[#FEF08A] text-[#D97706]'
                        : 'fill-white text-[#64748B]'
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        {/* 刻印テキストプレート（FR-14: High-precision engravedText） */}
        <div className="relative z-10 w-full max-w-[260px] rounded-xl border-2 border-[#1E1B18] bg-[#1E1B18] px-3 py-1.5 text-center shadow-[0_3px_0_#78350F]">
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
        <div className="relative z-10 mt-2.5 w-full space-y-2 rounded-2xl border-2 border-[#1E1B18] bg-white px-3 py-2 text-center shadow-[inset_0_2px_0_#FFF8EC]">
          <p className="text-[11px] font-bold text-[#57534E]">
            達成タスク:{' '}
            <span data-testid="reveal-task-title" className="font-black text-[#1E1B18]">
              {taskTitle}
            </span>
          </p>

          <div className="flex items-center justify-center gap-2">
            <span
              data-testid="reveal-coins-earned"
              className="animate-coin-badge-pop inline-flex items-center gap-1 rounded-xl border-2 border-[#1E1B18] bg-[#FFF0B3] px-2.5 py-1 font-display text-xs font-black text-[#1E1B18]"
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
                  className="toy-push-btn inline-flex min-h-[38px] items-center justify-center gap-1 rounded-xl bg-[#EF3E36] px-3 py-1 text-xs font-black text-white disabled:opacity-50 cursor-pointer"
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
        <div className="relative z-10 mt-3 grid w-full grid-cols-5 gap-2">
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
