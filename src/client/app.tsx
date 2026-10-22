import React, { useEffect, useRef, useState } from 'react';
import { Award, PlusCircle, RefreshCw, Timer, Trash2 } from 'lucide-react';
import { CapsuleMachineVisual } from './components/capsule-machine-visual';
import { CapsuleStage, type StageToastNotification } from './components/capsule-stage';
import { HeaderStatusBar } from './components/header-status-bar';
import { useCapsuleStore } from './hooks/use-capsule-store';
import { useSoundEffect } from './hooks/use-sound-effect';
import type { ExtractedCapsuleTaskDraft } from '../shared/schemas';

const QUICK_SUPPLY_PRESETS: ExtractedCapsuleTaskDraft[] = [
  {
    title: '机の上を5分だけ片付ける',
    capsuleColor: 'blue',
    rarityBoost: 1.0,
    medalPrompt:
      "A shining bronze commemorative medal featuring a sparkling tidy desk in high relief, engraved text 'DESK CLEANER' along the rim, 3D metallic render",
  },
  {
    title: '未読メールを3通だけ返信する',
    capsuleColor: 'red',
    rarityBoost: 1.5,
    medalPrompt:
      "A polished silver commemorative medal featuring a flying envelope and lightning bolt in high relief, engraved text 'MAIL RESPONDER' along the rim, 3D metallic render",
  },
  {
    title: '明日の優先タスクをメモに書き出す',
    capsuleColor: 'gold',
    rarityBoost: 2.0,
    medalPrompt:
      "A gleaming golden commemorative medal featuring a compass and star chart in high relief, engraved text 'VISION PLANNER' along the rim, 3D metallic render",
  },
];

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

  const [interactionTrigger, setInteractionTrigger] = useState<number>(0);
  const [statusFeedback, setStatusFeedback] =
    useState<string>('カプセルを連打・長押ししてパカッと開封しよう！');
  const [toastNotification, setToastNotification] = useState<StageToastNotification | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickSupplyIndexRef = useRef<number>(0);

  const showToast = (notification: StageToastNotification) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastNotification(notification);
    toastTimerRef.current = setTimeout(() => {
      setToastNotification(null);
      toastTimerRef.current = null;
    }, 2600);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

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

  const handleCrackStep = (step: number) => {
    unlockAudio();
    playCrack(step);
    setStatusFeedback(`ヒビ割れ進行中 (${step}/3)... もう1回タップ！`);
  };

  const handleCrackComplete = async () => {
    if (!activeCapsule || isUpdating) return;
    unlockAudio();
    const result = await crackActiveCapsule(activeCapsule.id);
    if (result) {
      playFanfare(result.awardedRarity);
      showToast({
        type: 'crack',
        text: `開封完了！＋${result.coinsEarned}コイン獲得`,
      });
      setStatusFeedback(
        `「${result.crackedTask.title}」を開封完了！＋${result.coinsEarned}コイン（${result.awardedRarity}メダル抽選）`,
      );
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
    setInteractionTrigger((prev) => prev + 1);
    const passed = await passActiveCapsule(activeCapsule.id);
    if (!passed) return;
    playPass();
    showToast({
      type: 'pass',
      text: 'ガチャを回し直して次のカプセルを排出！',
    });
    setStatusFeedback('ハンドルを回して次のカプセルを排出しました！');
  };

  const handleRecycleCapsule = async () => {
    if (!activeCapsule || isUpdating) return;
    unlockAudio();
    setInteractionTrigger((prev) => prev + 1);
    const recycled = await recycleActiveCapsule(activeCapsule.id);
    if (!recycled) return;
    playRecycle();
    showToast({
      type: 'recycle',
      text: 'リサイクル完了！＋5コイン獲得',
    });
    setStatusFeedback('リサイクル完了！＋5コイン獲得');
  };

  const handleQuickSupply = async () => {
    if (isUpdating) return;
    unlockAudio();
    const preset = QUICK_SUPPLY_PRESETS[quickSupplyIndexRef.current % QUICK_SUPPLY_PRESETS.length];
    quickSupplyIndexRef.current += 1;
    const supplied = await supplyCapsules(preset);
    if (supplied.length === 0) return;
    playSupply();
    setInteractionTrigger((prev) => prev + 1);
    setStatusFeedback('カプセル補充ボーナス！＋10コイン獲得');
  };

  const handleToggleSound = () => {
    void toggleSound().catch(() => undefined);
  };

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

        {/* 2. 中央メイン画面（筐体内カプセル残数ビジュアル ＆ 1画面1カプセル操作ステージ） */}
        <section
          aria-label="ガチャステージ"
          data-testid="gacha-stage-section"
          className="relative flex flex-1 flex-col items-center justify-between px-3.5 py-1 min-h-0"
        >
          {/* ガチャ筐体内の残りカプセル視覚表現（未完了リストは一切表示しない：FR-06） */}
          <CapsuleMachineVisual capsules={capsules} />

          {/* 1カプセル表示＆クラック・スワイプ操作ステージ（FR-06, FR-07, FR-09, FR-10） */}
          <CapsuleStage
            activeCapsule={activeCapsule}
            remainingCount={capsules.length}
            isUpdating={isUpdating}
            onCrack={handleCrackComplete}
            onCrackStep={handleCrackStep}
            onPass={handlePassCapsule}
            onRecycle={handleRecycleCapsule}
            externalInteractionTrigger={interactionTrigger}
            toastNotification={toastNotification}
          />

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
