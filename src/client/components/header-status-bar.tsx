import React from 'react';
import { Coins, Flame, Volume2, VolumeX } from 'lucide-react';

export interface HeaderStatusBarProps {
  coins: number;
  todayCombo: number;
  remainingCapsules: number;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
}

const MINI_CAPSULE_TOP_COLORS = ['bg-[#00A8E8]', 'bg-[#FF2E3B]', 'bg-[#FFBE0B]', 'bg-[#10B981]'];

export const HeaderStatusBar: React.FC<HeaderStatusBarProps> = ({
  coins,
  todayCombo,
  remainingCapsules,
  soundEnabled = true,
  onToggleSound,
}) => {
  const previewDotCount = Math.min(Math.max(remainingCapsules, 0), 4);

  return (
    <header
      aria-label="プレイヤーステータスバー"
      data-testid="header-status-bar"
      className="w-full px-3 pt-2.5 pb-1.5 shrink-0 z-20"
    >
      <div className="toy-cream-panel relative flex items-center justify-between gap-1.5 rounded-2xl px-2.5 py-2">
        {/* 所持コインカウンター */}
        <div
          data-testid="status-coins"
          aria-label={`所持コイン ${coins}枚`}
          className="flex items-center gap-1.5 rounded-xl bg-[#FFF0B3] border-2 border-[#1E1B18] px-2 py-1 shadow-[inset_0_2px_0_rgba(255,255,255,0.75)]"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#FFBE0B] border-2 border-[#1E1B18] text-[#1E1B18] shrink-0">
            <Coins className="h-3 w-3 stroke-[2.75]" aria-hidden="true" />
          </span>
          <div className="flex items-baseline gap-1">
            <span className="font-display text-sm font-bold tracking-tight text-[#1E1B18] tabular-nums">
              {coins.toLocaleString()}
            </span>
            <span className="font-display text-[10px] font-bold text-[#78350F]">COIN</span>
          </div>
        </div>

        {/* 当日連続コンボ数カウンター */}
        <div
          data-testid="status-combo"
          aria-label={`本日連続コンボ ${todayCombo}回`}
          className="flex items-center gap-1.5 rounded-xl bg-[#FFE2DE] border-2 border-[#1E1B18] px-2 py-1 shadow-[inset_0_2px_0_rgba(255,255,255,0.75)]"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#FF4D4D] border-2 border-[#1E1B18] text-white shrink-0">
            <Flame className="h-3 w-3 fill-current" aria-hidden="true" />
          </span>
          <div className="flex items-baseline gap-1">
            <span className="font-display text-sm font-bold tracking-tight text-[#1E1B18] tabular-nums">
              {todayCombo}
            </span>
            <span className="font-display text-[10px] font-bold text-[#881337]">COMBO</span>
          </div>
        </div>

        {/* 筐体内の残りカプセル数（2トーンミニカプセル玉イラスト＋残数） */}
        <div
          data-testid="status-remaining-capsules"
          aria-label={`筐体内の残りカプセル ${remainingCapsules}個`}
          className="flex items-center gap-1.5 rounded-xl bg-[#DDF3FF] border-2 border-[#1E1B18] px-2 py-1 shadow-[inset_0_2px_0_rgba(255,255,255,0.75)]"
        >
          <div className="flex -space-x-1 items-center" aria-hidden="true">
            {previewDotCount > 0 ? (
              Array.from({ length: previewDotCount }).map((_, idx) => (
                <span
                  key={idx}
                  className="inline-flex h-4 w-4 flex-col overflow-hidden rounded-full border-2 border-[#1E1B18] bg-white shadow-2xs"
                >
                  <span
                    className={`h-1/2 w-full ${
                      MINI_CAPSULE_TOP_COLORS[idx % MINI_CAPSULE_TOP_COLORS.length]
                    }`}
                  />
                  <span className="h-1/2 w-full bg-white" />
                </span>
              ))
            ) : (
              <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-[#1E1B18]/50" />
            )}
          </div>
          <div className="flex items-baseline gap-0.5">
            <span className="text-[10px] font-black text-[#0C4A6E]">残</span>
            <span className="font-display text-sm font-bold tracking-tight text-[#1E1B18] tabular-nums">
              {remainingCapsules}
            </span>
            <span className="text-[10px] font-black text-[#0C4A6E]">個</span>
          </div>
        </div>

        {/* サウンドON/OFF物理スイッチ */}
        {onToggleSound && (
          <button
            type="button"
            onClick={onToggleSound}
            aria-label={soundEnabled ? 'サウンドをミュート' : 'サウンドをオン'}
            data-testid="status-sound-toggle"
            className={`flex h-8 w-8 items-center justify-center rounded-xl border-2 border-[#1E1B18] transition active:translate-y-0.5 shrink-0 ${
              soundEnabled
                ? 'bg-[#FFBE0B] text-[#1E1B18] shadow-[0_2px_0_#1E1B18]'
                : 'bg-[#E5DEC9] text-[#57534E] shadow-none'
            }`}
          >
            {soundEnabled ? (
              <Volume2 className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
            ) : (
              <VolumeX className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </header>
  );
};
