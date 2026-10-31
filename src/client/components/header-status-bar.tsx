import React, { useEffect, useRef, useState } from 'react';
import { Coins, Flame, Volume2, VolumeX } from 'lucide-react';

export interface HeaderStatusBarProps {
  coins: number;
  todayCombo: number;
  remainingCapsules: number;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
}

const MINI_CAPSULE_TOP_COLORS = ['bg-[#00A8E8]', 'bg-[#FF2E3B]', 'bg-[#FFBE0B]', 'bg-[#10B981]'];
const COIN_ROLL_DURATION_MS = 240;

interface CoinTrackerState {
  prevCoins: number;
  delta: number;
  seq: number;
}

interface ComboTrackerState {
  prevCombo: number;
  seq: number;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 親ヘッダーの再レンダリングを最小化するため、コイン数値のカウントアップ補間を葉ノード内に分離
 * - 初回マウント時は即座に `coins` を同期表示する
 * - マウント後の `coins` 変化時は約240msでイージング補間しつつ、タイマーフォールバックで確実に収束させる
 */
const RollingCoinDigits: React.FC<{ coins: number }> = ({ coins }) => {
  const [displayedCoins, setDisplayedCoins] = useState<number>(coins);
  const currentDisplayedRef = useRef<number>(coins);
  const reducedMotion = prefersReducedMotion();

  useEffect(() => {
    currentDisplayedRef.current = displayedCoins;
  }, [displayedCoins]);

  useEffect(() => {
    const startCoins = currentDisplayedRef.current;
    if (startCoins === coins) {
      return;
    }

    const durationMs = prefersReducedMotion() ? 0 : COIN_ROLL_DURATION_MS;
    const startTime =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    let rafId: number | null = null;
    let settled = false;

    const finishRoll = () => {
      if (settled) return;
      settled = true;
      if (
        rafId !== null &&
        typeof window !== 'undefined' &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(rafId);
      }
      currentDisplayedRef.current = coins;
      setDisplayedCoins(coins);
    };

    const tick = (nowTimestamp: number) => {
      if (settled) return;
      if (durationMs <= 0) {
        finishRoll();
        return;
      }
      const now =
        typeof nowTimestamp === 'number' && Number.isFinite(nowTimestamp)
          ? nowTimestamp
          : Date.now();
      const elapsed = Math.max(0, now - startTime);
      const t = Math.min(1, elapsed / durationMs);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const nextVal = Math.round(startCoins + (coins - startCoins) * eased);
      currentDisplayedRef.current = nextVal;
      setDisplayedCoins(nextVal);

      if (t >= 1) {
        finishRoll();
      } else if (
        typeof window !== 'undefined' &&
        typeof window.requestAnimationFrame === 'function'
      ) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        finishRoll();
      }
    };

    if (
      durationMs > 0 &&
      typeof window !== 'undefined' &&
      typeof window.requestAnimationFrame === 'function'
    ) {
      rafId = window.requestAnimationFrame(tick);
    }

    // JSDOM や視覚効果軽減設定・バックグラウンドタブでも確実に最終値へ収束させる安全タイマー
    const fallbackTimer = setTimeout(finishRoll, durationMs > 0 ? durationMs + 30 : 0);

    return () => {
      settled = true;
      if (
        rafId !== null &&
        typeof window !== 'undefined' &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(rafId);
      }
      clearTimeout(fallbackTimer);
    };
  }, [coins]);

  const effectiveCoins = reducedMotion ? coins : displayedCoins;

  return (
    <span className="font-display text-sm font-bold tracking-tight text-[#1E1B18] tabular-nums">
      {effectiveCoins.toLocaleString()}
    </span>
  );
};

export const HeaderStatusBar: React.FC<HeaderStatusBarProps> = ({
  coins,
  todayCombo,
  remainingCapsules,
  soundEnabled = true,
  onToggleSound,
}) => {
  const previewDotCount = Math.min(Math.max(remainingCapsules, 0), 4);
  const [coinTracker, setCoinTracker] = useState<CoinTrackerState>({
    prevCoins: coins,
    delta: 0,
    seq: 0,
  });
  const [comboTracker, setComboTracker] = useState<ComboTrackerState>({
    prevCombo: todayCombo,
    seq: 0,
  });

  if (coins !== coinTracker.prevCoins) {
    setCoinTracker({
      prevCoins: coins,
      delta: coins - coinTracker.prevCoins,
      seq: coinTracker.seq + 1,
    });
  }

  if (todayCombo !== comboTracker.prevCombo) {
    setComboTracker({
      prevCombo: todayCombo,
      seq: todayCombo > comboTracker.prevCombo ? comboTracker.seq + 1 : comboTracker.seq,
    });
  }

  return (
    <header
      aria-label="プレイヤーステータスバー"
      data-testid="header-status-bar"
      className="safe-top-pad w-full px-2.5 sm:px-3 pb-1.5 shrink-0 z-20"
    >
      <div className="toy-cream-panel relative flex items-center justify-between gap-1 sm:gap-1.5 rounded-2xl px-2 sm:px-2.5 py-2">
        {/* 所持コインカウンター（加算ポップアップは status-coins の外側に配置しテキストアサーションを汚染しない） */}
        <div className="relative flex items-center">
          <div
            data-testid="status-coins"
            aria-label={`所持コイン ${coins}枚`}
            className="flex items-center gap-1 sm:gap-1.5 rounded-xl bg-[#FFF0B3] border-2 border-[#1E1B18] px-1.5 sm:px-2 py-1 shadow-[inset_0_2px_0_rgba(255,255,255,0.75)]"
          >
            <span
              key={`coin-icon-${coinTracker.seq}`}
              className={`flex h-5 w-5 items-center justify-center rounded-full bg-[#FFBE0B] border-2 border-[#1E1B18] text-[#1E1B18] shrink-0 ${
                coinTracker.seq > 0 ? 'animate-coin-badge-pop' : ''
              }`}
            >
              <Coins className="h-3 w-3 stroke-[2.75]" aria-hidden="true" />
            </span>
            <div className="flex items-baseline gap-0.5 sm:gap-1">
              <RollingCoinDigits coins={coins} />
              <span className="font-display text-[10px] font-bold text-[#78350F]">COIN</span>
            </div>
          </div>

          {coinTracker.seq > 0 && coinTracker.delta > 0 && (
            <span
              key={coinTracker.seq}
              aria-hidden="true"
              data-testid="coin-delta-popup"
              className="animate-coin-delta-float pointer-events-none absolute -top-2.5 right-0 z-30 rounded-full border-2 border-[#1E1B18] bg-gradient-to-b from-[#FEF08A] to-[#FFBE0B] px-1.5 py-0.5 text-[10px] font-display font-black text-[#1E1B18] shadow-[0_2px_0_#1E1B18]"
            >
              +{coinTracker.delta}
            </span>
          )}
        </div>

        {/* 当日連続コンボ数カウンター */}
        <div
          data-testid="status-combo"
          aria-label={`本日連続コンボ ${todayCombo}回`}
          className="flex items-center gap-1 sm:gap-1.5 rounded-xl bg-[#FFE2DE] border-2 border-[#1E1B18] px-1.5 sm:px-2 py-1 shadow-[inset_0_2px_0_rgba(255,255,255,0.75)]"
        >
          <span
            key={`combo-icon-${comboTracker.seq}`}
            className={`flex h-5 w-5 items-center justify-center rounded-full bg-[#FF4D4D] border-2 border-[#1E1B18] text-white shrink-0 ${
              comboTracker.seq > 0 ? 'animate-coin-badge-pop' : ''
            }`}
          >
            <Flame className="h-3 w-3 fill-current" aria-hidden="true" />
          </span>
          <div className="flex items-baseline gap-0.5 sm:gap-1">
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
          className="flex items-center gap-1 sm:gap-1.5 rounded-xl bg-[#DDF3FF] border-2 border-[#1E1B18] px-1.5 sm:px-2 py-1 shadow-[inset_0_2px_0_rgba(255,255,255,0.75)]"
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
            className={`flex h-8.5 w-8.5 items-center justify-center rounded-xl border-2 border-[#1E1B18] transition active:translate-y-0.5 active:scale-95 shrink-0 cursor-pointer ${
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
