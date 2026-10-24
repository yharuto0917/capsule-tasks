import React from 'react';
import { Sparkles } from 'lucide-react';
import type { CapsuleColor, CapsuleTask } from '../../shared/schemas';

export interface CapsuleMachineVisualProps {
  /** 未完了カプセル配列（タスク名は一切表示せず、カプセル色と個数のみを抽象ビジュアルに使用） */
  capsules?: Pick<CapsuleTask, 'id' | 'capsuleColor'>[];
  /** カプセル配列を渡さない場合の残り個数指定 */
  remainingCount?: number;
}

const MAX_VISIBLE_BALLS = 6;

const FALLBACK_COLORS: CapsuleColor[] = ['gold', 'blue', 'red', 'blue', 'gold', 'red'];

const BALL_3D_SURFACE_STYLE: Record<CapsuleColor, React.CSSProperties> = {
  blue: {
    background:
      'radial-gradient(circle at 32% 28%, #E0F2FE 0%, #38BDF8 36%, #0284C7 74%, #0369A1 100%)',
  },
  red: {
    background:
      'radial-gradient(circle at 32% 28%, #FFE4E6 0%, #FF4D5E 36%, #E11D48 74%, #9F1239 100%)',
  },
  gold: {
    background:
      'radial-gradient(circle at 32% 28%, #FEF9C3 0%, #FACC15 38%, #D97706 76%, #92400E 100%)',
  },
};

const BALL_ROTATIONS = [
  '-rotate-12',
  'rotate-6',
  '-rotate-6',
  'rotate-12',
  '-rotate-3',
  'rotate-9',
];

/**
 * FR-06: 未完了タスク一覧を一切表示せず、「ガチャ筐体の中に○個入っている」ことを
 * 立体3D球体カプセルのイラストと残数バッジで抽象表示するコンポーネント。
 */
export const CapsuleMachineVisual: React.FC<CapsuleMachineVisualProps> = ({
  capsules,
  remainingCount,
}) => {
  const totalCount = remainingCount ?? capsules?.length ?? 0;
  const visibleCount = Math.min(Math.max(totalCount, 0), MAX_VISIBLE_BALLS);
  const overflowCount = Math.max(totalCount - MAX_VISIBLE_BALLS, 0);

  const visibleItems: { key: string; color: CapsuleColor }[] = Array.from(
    { length: visibleCount },
    (_, idx) => {
      const item = capsules?.[idx];
      return {
        key: item?.id ?? `ball_${idx}`,
        color: item?.capsuleColor ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length],
      };
    },
  );

  return (
    <div
      data-testid="capsule-machine-visual"
      aria-label={`ガチャ筐体ホッパー 残りカプセル ${totalCount}個`}
      className="flex w-full items-center justify-between gap-2 rounded-full bg-gradient-to-b from-[#292524] to-[#1C1917] border-2 border-[#FFF8EC] px-3 py-1 text-xs font-bold text-[#FFF8EC] shadow-[inset_0_2px_3px_rgba(255,255,255,0.22),0_3px_0_rgba(0,0,0,0.35)] shrink-0"
    >
      {/* 左側：ステータスメッセージ（タスク名リストは一切表示しない） */}
      <div
        data-testid="machine-dome-indicator"
        className="flex min-w-0 items-center gap-1.5 truncate"
      >
        <Sparkles className="h-3.5 w-3.5 text-[#FFBE0B] shrink-0" aria-hidden="true" />
        <span className="truncate">
          {totalCount > 0
            ? `ガチャドーム内に ${totalCount} 個のカプセルがスタンバイ中`
            : 'ドームは空っぽ！下の「＋カプセル補充」から投入しよう'}
        </span>
      </div>

      {/* 右側：立体3Dシェーディングのミニカプセル玉イラスト群＋残数オーバーフローバッジ */}
      {totalCount > 0 && (
        <div aria-hidden="true" className="flex items-center -space-x-1.5 shrink-0 pl-1">
          {visibleItems.map((ball, idx) => (
            <span
              key={ball.key}
              data-testid="machine-capsule-ball"
              data-capsule-color={ball.color}
              className={`relative inline-flex h-4.5 w-4.5 flex-col overflow-hidden rounded-full border-[1.5px] border-[#1E1B18] shadow-[inset_0_-2px_3px_rgba(0,0,0,0.35),0_2px_3px_rgba(0,0,0,0.4)] ${
                BALL_ROTATIONS[idx % BALL_ROTATIONS.length]
              }`}
            >
              {/* 上半球：3D球面スペキュラ＆グラデーション */}
              <span className="relative h-1/2 w-full" style={BALL_3D_SURFACE_STYLE[ball.color]}>
                <span className="absolute top-0.5 left-1 h-1 w-1.5 -rotate-12 rounded-full bg-white/85 blur-[0.2px]" />
              </span>
              {/* 下半球：立体フロストシェル */}
              <span
                className="h-1/2 w-full border-t border-black/25"
                style={{
                  background:
                    'radial-gradient(circle at 35% 20%, #FFFFFF 0%, #F1F5F9 60%, #CBD5E1 100%)',
                }}
              />
            </span>
          ))}
          {overflowCount > 0 && (
            <span
              data-testid="machine-capsule-overflow"
              className="relative z-10 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full border-[1.5px] border-[#1E1B18] bg-gradient-to-b from-[#FDE047] to-[#F59E0B] px-1 font-display text-[9px] font-black text-[#1E1B18] shadow-[0_2px_2px_rgba(0,0,0,0.35)]"
            >
              +{overflowCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
