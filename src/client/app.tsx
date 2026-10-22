import React, { useEffect, useState } from 'react';
import { Award, Hammer, PlusCircle, RefreshCw, Sparkles, Timer, Trash2, Zap } from 'lucide-react';
import { HeaderStatusBar } from './components/header-status-bar';
import { ThreeCapsuleCanvas } from './components/three-capsule-canvas';
import { useCapsuleStore } from './hooks/use-capsule-store';
import { useSoundEffect } from './hooks/use-sound-effect';
import type { CapsuleColor } from '../shared/schemas';

const CAPSULE_BADGE_CONFIG: Record<
  CapsuleColor,
  {
    label: string;
    bgClass: string;
  }
> = {
  blue: {
    label: 'LIGHT CAPSULE ×1.0',
    bgClass: 'bg-[#38BDF8] text-[#1E1B18]',
  },
  red: {
    label: 'MEDIUM CAPSULE ×1.5',
    bgClass: 'bg-[#FF4D4D] text-white',
  },
  gold: {
    label: 'GOLD CAPSULE ×2.0',
    bgClass: 'bg-[#FFBE0B] text-[#1E1B18]',
  },
};

export const App: React.FC = () => {
  const {
    capsules,
    activeCapsule,
    playerState,
    storageError,
    isUpdating,
    supplyCapsules,
    passActiveCapsule,
    recycleActiveCapsule,
    crackActiveCapsule,
    toggleSound,
    syncDateComboState,
  } = useCapsuleStore();

  const { playSupply, playCrack, playFanfare, playPass, playRecycle, unlockAudio } = useSoundEffect(
    playerState.soundEnabled,
  );

  const [crackState, setCrackState] = useState<{ capsuleId: string | null; progress: number }>({
    capsuleId: null,
    progress: 0,
  });
  const crackProgress = crackState.capsuleId === activeCapsule?.id ? crackState.progress : 0;
  const [interactionTrigger, setInteractionTrigger] = useState<number>(0);
  const [statusFeedback, setStatusFeedback] =
    useState<string>('カプセルを連打・長押ししてパカッと開封しよう！');

  // 画面復帰時やフォーカス時に日付跨ぎをチェックし、ペナルティなしで todayCombo のみ同期する
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'hidden') return;
      void syncDateComboState().catch(() => undefined);
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    return () => {
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    };
  }, [syncDateComboState]);

  const handleTapCapsule = async () => {
    if (!activeCapsule || isUpdating) return;
    unlockAudio();
    setInteractionTrigger((prev) => prev + 1);
    const nextProgress = crackProgress + 1;
    if (nextProgress >= 3) {
      setCrackState({ capsuleId: activeCapsule.id, progress: 0 });
      const result = await crackActiveCapsule(activeCapsule.id);
      if (result) {
        playFanfare(result.awardedRarity);
        setStatusFeedback(
          `「${result.crackedTask.title}」を開封完了！＋${result.coinsEarned}コイン（${result.awardedRarity}メダル抽選）`,
        );
      }
    } else {
      playCrack(nextProgress);
      setCrackState({ capsuleId: activeCapsule.id, progress: nextProgress });
      setStatusFeedback(`ヒビ割れ進行中 (${nextProgress}/3)... もう1回タップ！`);
    }
  };

  const handlePassCapsule = async () => {
    if (!activeCapsule || isUpdating) return;
    if (capsules.length <= 1) {
      setInteractionTrigger((prev) => prev + 1);
      setStatusFeedback('筐体内のカプセルはこれ1個だけです');
      return;
    }
    unlockAudio();
    setCrackState({ capsuleId: activeCapsule.id, progress: 0 });
    setInteractionTrigger((prev) => prev + 1);
    const passed = await passActiveCapsule(activeCapsule.id);
    if (!passed) return;
    playPass();
    setStatusFeedback('ハンドルを回して次のカプセルを排出しました！');
  };

  const handleRecycleCapsule = async () => {
    if (!activeCapsule || isUpdating) return;
    unlockAudio();
    setCrackState({ capsuleId: activeCapsule.id, progress: 0 });
    setInteractionTrigger((prev) => prev + 1);
    const recycled = await recycleActiveCapsule(activeCapsule.id);
    if (!recycled) return;
    playRecycle();
    setStatusFeedback('リサイクル完了！＋5コインに変換しました');
  };

  const handleQuickSupply = async () => {
    if (isUpdating) return;
    unlockAudio();
    const supplied = await supplyCapsules({
      title: '机の上を5分だけ片付ける',
      capsuleColor: 'blue',
      rarityBoost: 1.0,
      medalPrompt:
        "A shining bronze commemorative medal featuring a sparkling tidy desk in high relief, engraved text 'DESK CLEANER' along the rim, 3D metallic render",
    });
    if (supplied.length === 0) return;
    playSupply();
    setInteractionTrigger((prev) => prev + 1);
    setStatusFeedback('カプセル補充ボーナス！＋10コイン獲得');
  };

  const handleToggleSound = () => {
    void toggleSound().catch(() => undefined);
  };

  const activeBadge = activeCapsule
    ? CAPSULE_BADGE_CONFIG[activeCapsule.capsuleColor]
    : CAPSULE_BADGE_CONFIG.blue;

  return (
    <div
      data-testid="viewport-shell"
      className="toy-room-backdrop relative flex h-[100dvh] w-full items-center justify-center overflow-hidden select-none"
    >
      {/* モバイルファースト 1画面完結ガチャ筐体コンテナ（320px〜430px基準 / PC時は物理ガチャマシン筐体中央配置） */}
      <main
        data-testid="mobile-stage-container"
        className="toy-cabinet-body relative flex h-[100dvh] w-full max-w-[430px] flex-col justify-between overflow-hidden sm:h-[min(852px,95dvh)] sm:rounded-[44px] sm:border-[5px] sm:border-[#1E1B18] sm:shadow-[0_14px_0_#1E1B18,0_28px_60px_rgba(30,27,24,0.45)]"
      >
        {/* 1. 上部ステータスバー（ガチャ筐体トップパネル） */}
        <HeaderStatusBar
          coins={playerState.coins}
          todayCombo={playerState.todayCombo}
          remainingCapsules={capsules.length}
          soundEnabled={playerState.soundEnabled}
          onToggleSound={handleToggleSound}
        />
        {storageError && (
          <p
            role="alert"
            className="mx-3 shrink-0 rounded-lg bg-[#FFF0B3] px-3 py-2 text-xs font-bold text-[#78350F]"
          >
            {storageError}
          </p>
        )}

        {/* 2. 中央メイン画面（アクリルドーム窓＆Three.js 3Dカプセルステージ） */}
        <section
          aria-label="ガチャステージ"
          data-testid="gacha-stage-section"
          className="relative flex flex-1 flex-col items-center justify-between px-3.5 py-1 min-h-0"
        >
          {/* ガチャ筐体ホッパー残数プレート（未完了リストは見せない） */}
          <div
            data-testid="machine-dome-indicator"
            className="flex items-center gap-2 rounded-full bg-[#1E1B18] border-2 border-[#FFF8EC] px-3.5 py-1 text-xs font-bold text-[#FFF8EC] shadow-[0_3px_0_rgba(0,0,0,0.28)]"
          >
            <Sparkles className="h-3.5 w-3.5 text-[#FFBE0B] shrink-0" aria-hidden="true" />
            <span className="truncate">
              {capsules.length > 0
                ? `ガチャドーム内に ${capsules.length} 個のカプセルがスタンバイ中`
                : 'ドームは空っぽ！下の「＋カプセル補充」から投入しよう'}
            </span>
          </div>

          {/* 透明アクリルドームショーケース（Three.js 3Dカプセル + タスクスリップ） */}
          <div className="toy-acrylic-dome relative flex flex-1 flex-col items-center justify-between w-full my-1.5 rounded-[32px] p-3 min-h-0 overflow-hidden">
            {/* アクリルドームの左上ハイライト反射 */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-6 -left-6 h-28 w-44 -rotate-12 rounded-full bg-white/55 blur-[2px]"
            />

            {/* 筐体コーナーのビス装飾 */}
            <span aria-hidden="true" className="toy-screw absolute top-3 left-3" />
            <span aria-hidden="true" className="toy-screw absolute top-3 right-3" />

            {activeCapsule ? (
              <>
                {/* 上部：カプセルレア度タグ＆3段階クラックゲージ */}
                <div className="relative z-10 flex w-full items-center justify-between px-4 pt-0.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2.5 py-0.5 font-display text-[11px] font-bold tracking-wide shadow-[0_2px_0_#1E1B18] ${activeBadge.bgClass}`}
                  >
                    <Zap className="h-3 w-3 fill-current" aria-hidden="true" />
                    {activeBadge.label}
                  </span>

                  {/* 3段階クラックランプ */}
                  <div
                    aria-label={`ヒビ割れ段階 ${crackProgress}/3`}
                    className="flex items-center gap-1 rounded-full bg-[#1E1B18] px-2.5 py-1 border-2 border-white/80"
                  >
                    {[1, 2, 3].map((step) => (
                      <span
                        key={step}
                        className={`h-2.5 w-2.5 rounded-full border border-[#1E1B18] transition-colors ${
                          crackProgress >= step
                            ? 'bg-[#FFBE0B] shadow-[0_0_6px_#FFBE0B]'
                            : 'bg-[#44403C]'
                        }`}
                      />
                    ))}
                    <span className="ml-1 font-display text-[10px] font-bold text-[#FFF8EC]">
                      {crackProgress}/3
                    </span>
                  </div>
                </div>

                {/* 中央：Three.js 3Dカプセル本体ボタン */}
                <button
                  type="button"
                  onClick={handleTapCapsule}
                  disabled={isUpdating}
                  data-testid="active-capsule-button"
                  aria-label={`現在のカプセルタスク: ${activeCapsule.title}。タップして開封`}
                  className="group relative z-10 flex flex-col items-center justify-center focus:outline-none cursor-pointer my-auto"
                >
                  <ThreeCapsuleCanvas
                    capsuleColor={activeCapsule.capsuleColor}
                    crackProgress={crackProgress}
                    interactionTrigger={interactionTrigger}
                  />
                </button>

                {/* 下部：カプセル同梱ミニブック風タスク名スリップ */}
                <div className="relative z-10 w-full rounded-2xl bg-[#FFFDF9] border-3 border-[#1E1B18] px-3.5 py-2 shadow-[0_4px_0_#1E1B18]">
                  <p
                    data-testid="active-capsule-title"
                    className="font-toy text-center text-sm sm:text-base font-normal leading-snug text-[#1E1B18] line-clamp-2"
                  >
                    {activeCapsule.title}
                  </p>
                  <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-black text-[#B45309]">
                    <Hammer className="h-3.5 w-3.5 stroke-[2.5]" aria-hidden="true" />
                    <span>
                      {crackProgress === 0
                        ? '3Dカプセルをタップ連打 / 長押しで割る！'
                        : `ヒビ割れ ${crackProgress}/3（あと ${3 - crackProgress} 回タップ）`}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div
                data-testid="empty-capsule-stage"
                className="relative z-10 my-auto flex flex-col items-center justify-center rounded-2xl bg-[#FFFDF9] border-3 border-[#1E1B18] px-5 py-7 text-center shadow-[0_5px_0_#1E1B18]"
              >
                <p className="font-toy text-base text-[#1E1B18]">
                  すべてのカプセルを開封しました！
                </p>
                <p className="mt-1.5 text-xs font-bold text-[#57534E]">
                  下の「＋カプセル補充」から音声やスタンプで新しいカプセルを投入しよう
                </p>
              </div>
            )}
          </div>

          {/* 筐体ステータスインジケーターバー */}
          <div
            role="status"
            aria-live="polite"
            data-testid="stage-feedback-banner"
            className="w-full rounded-xl bg-[#FFF8EC] border-3 border-[#1E1B18] px-3 py-1.5 text-center text-xs font-black text-[#1E1B18] truncate shadow-[0_3px_0_#1E1B18]"
          >
            {statusFeedback}
          </div>
        </section>

        {/* 3. 下部親指エリア（ガチャ筐体コントロールデッキ） */}
        <footer
          aria-label="親指操作エリア"
          data-testid="thumb-action-dock"
          className="w-full px-3.5 pt-1 pb-3 shrink-0 space-y-2 z-20"
        >
          {/* サブ操作行：パス（ハンドル回し直し） / オートタイマー / リサイクル（破棄） */}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={handlePassCapsule}
              disabled={!activeCapsule || isUpdating}
              data-testid="action-pass-button"
              className="toy-push-btn flex min-h-[44px] items-center justify-center gap-1.5 rounded-2xl bg-[#7DD3FC] py-2 px-2 text-xs font-black text-[#1E1B18] disabled:opacity-45 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5 stroke-[2.75] shrink-0" aria-hidden="true" />
              <span>パス(次へ)</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFeedback('放置オート開封タイマー（5/15/25分）をセット可能')}
              disabled={!activeCapsule || isUpdating}
              data-testid="action-timer-button"
              className="toy-push-btn flex min-h-[44px] items-center justify-center gap-1.5 rounded-2xl bg-[#FFF8EC] py-2 px-2 text-xs font-black text-[#1E1B18] disabled:opacity-45 cursor-pointer"
            >
              <Timer
                className="h-3.5 w-3.5 stroke-[2.75] text-[#D97706] shrink-0"
                aria-hidden="true"
              />
              <span>タイマー</span>
            </button>

            <button
              type="button"
              onClick={handleRecycleCapsule}
              disabled={!activeCapsule || isUpdating}
              data-testid="action-recycle-button"
              className="toy-push-btn flex min-h-[44px] items-center justify-center gap-1.5 rounded-2xl bg-[#6EE7B7] py-2 px-2 text-xs font-black text-[#1E1B18] disabled:opacity-45 cursor-pointer"
            >
              <Trash2
                className="h-3.5 w-3.5 stroke-[2.75] text-[#065F46] shrink-0"
                aria-hidden="true"
              />
              <span>破棄(+5)</span>
            </button>
          </div>

          {/* メインナビゲーション行：＋カプセル補充（＋10コイン） / メダル図鑑 */}
          <div className="grid grid-cols-5 gap-2">
            <button
              type="button"
              onClick={handleQuickSupply}
              disabled={isUpdating}
              data-testid="open-supply-sheet-button"
              className="toy-push-btn col-span-3 flex min-h-[50px] items-center justify-center gap-1.5 rounded-2xl bg-[#FFBE0B] py-2.5 px-2.5 text-xs sm:text-sm font-black text-[#1E1B18] whitespace-nowrap cursor-pointer"
            >
              <PlusCircle className="h-4 w-4 stroke-[2.75] shrink-0" aria-hidden="true" />
              <span>＋ カプセル補充</span>
              <span className="rounded-full bg-[#1E1B18] text-[#FFBE0B] px-1.5 py-0.5 font-display text-[10px] font-bold">
                +10
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFeedback('オリジナル記念メダル図鑑（N / R / SR / SSR）')}
              data-testid="open-collection-drawer-button"
              className="toy-push-btn col-span-2 flex min-h-[50px] items-center justify-center gap-1.5 rounded-2xl bg-[#2563EB] py-2.5 px-2.5 text-xs sm:text-sm font-black text-white whitespace-nowrap cursor-pointer"
            >
              <Award className="h-4 w-4 stroke-[2.75] text-[#FFBE0B] shrink-0" aria-hidden="true" />
              <span>メダル図鑑</span>
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
};
