import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Hammer, RefreshCw, Sparkles, Trash2, Zap } from 'lucide-react';
import { ThreeCapsuleCanvas } from './three-capsule-canvas';
import type { CapsuleColor, CapsuleTask } from '../../shared/schemas';

export interface StageToastNotification {
  type: 'recycle' | 'pass' | 'crack';
  text: string;
}

export interface CapsuleStageProps {
  /** 現在目の前にある1個の未開封カプセル（空の場合は null） */
  activeCapsule: CapsuleTask | null;
  /** 筐体内の残りカプセル総数 */
  remainingCount: number;
  /** ストレージ更新中フラグ */
  isUpdating: boolean;
  /** 開封完了（3タップまたは1秒長押し完了）時に呼ばれるコールバック（FR-10） */
  onCrack: () => void | Promise<void>;
  /** ヒビ割れ段階（1〜2）が進行した際に呼ばれるコールバック（効果音・触覚再生用） */
  onCrackStep?: (step: number) => void;
  /** 左スワイプで先送り（パス）した際に呼ばれるコールバック（FR-07） */
  onPass: () => void | Promise<void>;
  /** 右スワイプ（ゴミ箱方向）でリサイクル破棄した際に呼ばれるコールバック（FR-09） */
  onRecycle: () => void | Promise<void>;
  /** 外部操作による3Dカプセル揺れトリガー */
  externalInteractionTrigger?: number;
  /** ステージ上に表示するトースト通知（リサイクル完了！＋5コイン獲得 等） */
  toastNotification?: StageToastNotification | null;
}

/** ドラッグ開始とみなす最小移動量（px） */
const SWIPE_DRAG_SLOP_PX = 6;
/** 通常のドラッグ距離によるスワイプ確定閾値（px） */
const SWIPE_COMMIT_THRESHOLD_PX = 40;
/** 素早いフリック時の最小距離閾値（px） */
const SWIPE_FLICK_MIN_DISTANCE_PX = 24;
/** 素早いフリック時の速度閾値（px/ms） */
const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.3;

const LONG_PRESS_STEP_1_MS = 340;
const LONG_PRESS_STEP_2_MS = 670;
const LONG_PRESS_COMPLETE_MS = 1000;

const CAPSULE_BADGE_CONFIG: Record<
  CapsuleColor,
  {
    label: string;
    bgClass: string;
    shellGradientClass: string;
    rimGlowClass: string;
  }
> = {
  blue: {
    label: 'LIGHT CAPSULE ×1.0',
    bgClass: 'bg-[#38BDF8] text-[#1E1B18]',
    shellGradientClass:
      'from-[#7DD3FC] via-[#0284C7] to-[#0369A1] shadow-[0_10px_24px_rgba(2,132,199,0.35)]',
    rimGlowClass: 'ring-[#38BDF8]/60',
  },
  red: {
    label: 'MEDIUM CAPSULE ×1.5',
    bgClass: 'bg-[#FF4D4D] text-white',
    shellGradientClass:
      'from-[#FDA4AF] via-[#EF4444] to-[#B91C1C] shadow-[0_10px_24px_rgba(239,68,68,0.35)]',
    rimGlowClass: 'ring-[#FF4D4D]/60',
  },
  gold: {
    label: 'GOLD CAPSULE ×2.0',
    bgClass: 'bg-[#FFBE0B] text-[#1E1B18]',
    shellGradientClass:
      'from-[#FEF08A] via-[#FFBE0B] to-[#B45309] shadow-[0_10px_28px_rgba(245,158,11,0.45)]',
    rimGlowClass: 'ring-[#FFBE0B]/75',
  },
};

/**
 * FR-06, FR-07, FR-09, FR-10:
 * 画面中央に常に1個の未開封カプセルのみを表示し、
 * タップ連打 / 1秒長押しによる段階的クラック開封、左スワイプ先送り、右スワイプリサイクルを制御するステージ。
 */
export const CapsuleStage: React.FC<CapsuleStageProps> = ({
  activeCapsule,
  remainingCount,
  isUpdating,
  onCrack,
  onCrackStep,
  onPass,
  onRecycle,
  externalInteractionTrigger = 0,
  toastNotification = null,
}) => {
  // カプセルIDとskipCountを組み合わせた一意キー。パスで巡回して再排出された場合も確実に新規状態として扱う
  const activeCapsuleKey = activeCapsule ? `${activeCapsule.id}:${activeCapsule.skipCount}` : null;

  const [interactionState, setInteractionState] = useState<{
    capsuleKey: string | null;
    progress: number;
    dragOffsetX: number;
    isPressing: boolean;
  }>({
    capsuleKey: null,
    progress: 0,
    dragOffsetX: 0,
    isPressing: false,
  });
  const [localTrigger, setLocalTrigger] = useState<number>(0);

  const isCurrentCapsuleState =
    activeCapsuleKey !== null && interactionState.capsuleKey === activeCapsuleKey;
  const crackProgress = isCurrentCapsuleState ? interactionState.progress : 0;
  const dragOffsetX = isCurrentCapsuleState ? interactionState.dragOffsetX : 0;
  const isPressing = isCurrentCapsuleState ? interactionState.isPressing : false;

  const crackStateRef = useRef<{ capsuleKey: string | null; progress: number }>({
    capsuleKey: null,
    progress: 0,
  });
  const isLockedForCapsuleKeyRef = useRef<string | null>(null);
  const suppressNextClickRef = useRef<boolean>(false);
  const longPressTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const gestureRef = useRef<{
    active: boolean;
    inputType: 'pointer' | 'touch' | null;
    identifier: number | null;
    capsuleKey: string | null;
    startX: number;
    startY: number;
    lastX: number;
    startTimeMs: number;
    isDragging: boolean;
  }>({
    active: false,
    inputType: null,
    identifier: null,
    capsuleKey: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    startTimeMs: 0,
    isDragging: false,
  });

  const latestCallbacksRef = useRef({
    activeCapsule,
    activeCapsuleKey,
    isUpdating,
    onPass,
    onRecycle,
  });

  useEffect(() => {
    latestCallbacksRef.current = {
      activeCapsule,
      activeCapsuleKey,
      isUpdating,
      onPass,
      onRecycle,
    };
  }, [activeCapsule, activeCapsuleKey, isUpdating, onPass, onRecycle]);

  const clearLongPressTimers = useCallback(() => {
    for (const timerId of longPressTimersRef.current) {
      clearTimeout(timerId);
    }
    longPressTimersRef.current = [];
  }, []);

  // カプセル切り替え時（またはパス巡回時）・アンマウント時にタイマー・ドラッグ状態・ロックをクリーンアップ
  useEffect(() => {
    clearLongPressTimers();
    crackStateRef.current = { capsuleKey: activeCapsuleKey, progress: 0 };
    isLockedForCapsuleKeyRef.current = null;
    suppressNextClickRef.current = false;
    gestureRef.current = {
      active: false,
      inputType: null,
      identifier: null,
      capsuleKey: null,
      startX: 0,
      startY: 0,
      lastX: 0,
      startTimeMs: 0,
      isDragging: false,
    };
    return () => {
      clearLongPressTimers();
    };
  }, [activeCapsuleKey, clearLongPressTimers]);

  const triggerCompleteCrack = useCallback(
    (targetKey: string) => {
      if (isLockedForCapsuleKeyRef.current === targetKey) return;
      isLockedForCapsuleKeyRef.current = targetKey;
      clearLongPressTimers();
      // Stage 3（progress: 3）を保持し、開封の瞬間（閃光スターバースト・3D開口・ゲージ3/3）を描画する
      crackStateRef.current = { capsuleKey: targetKey, progress: 3 };
      setInteractionState({
        capsuleKey: targetKey,
        progress: 3,
        dragOffsetX: 0,
        isPressing: false,
      });
      setLocalTrigger((prev) => prev + 1);
      void onCrack();
    },
    [clearLongPressTimers, onCrack],
  );

  const advanceCrackStep = useCallback(
    (targetKey: string, minimumStep?: number) => {
      if (isLockedForCapsuleKeyRef.current === targetKey) return;
      const current =
        crackStateRef.current.capsuleKey === targetKey ? crackStateRef.current.progress : 0;
      const nextStep = minimumStep !== undefined ? Math.max(current + 1, minimumStep) : current + 1;

      if (nextStep >= 3) {
        triggerCompleteCrack(targetKey);
        return;
      }

      crackStateRef.current = { capsuleKey: targetKey, progress: nextStep };
      setInteractionState((prev) => ({
        capsuleKey: targetKey,
        progress: nextStep,
        dragOffsetX: prev.capsuleKey === targetKey ? prev.dragOffsetX : 0,
        isPressing: prev.capsuleKey === targetKey ? prev.isPressing : false,
      }));
      setLocalTrigger((prev) => prev + 1);
      onCrackStep?.(nextStep);
    },
    [onCrackStep, triggerCompleteCrack],
  );

  const updateGestureMove = useCallback(
    (clientX: number, clientY: number) => {
      const g = gestureRef.current;
      if (!g.active || !g.capsuleKey) return;

      const dx = clientX - g.startX;
      const dy = clientY - g.startY;
      g.lastX = clientX;

      if (!g.isDragging) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const distance = Math.hypot(dx, dy);
        if (absDx > SWIPE_DRAG_SLOP_PX || distance > SWIPE_DRAG_SLOP_PX * 1.5) {
          g.isDragging = true;
          suppressNextClickRef.current = true;
          clearLongPressTimers();
          // 縦移動よりも横移動が小さい場合でも長押しは解除する
          if (absDy > absDx * 2 && absDx < SWIPE_DRAG_SLOP_PX) {
            return;
          }
        }
      }

      if (g.isDragging) {
        const targetKey = g.capsuleKey;
        const clampedOffset = Math.max(-130, Math.min(130, dx));
        setInteractionState((prev) => ({
          capsuleKey: targetKey,
          progress: prev.capsuleKey === targetKey ? prev.progress : 0,
          dragOffsetX: clampedOffset,
          isPressing: false,
        }));
      }
    },
    [clearLongPressTimers],
  );

  const completeGesture = useCallback(
    (endClientX: number | null, cancelled: boolean) => {
      const g = gestureRef.current;
      if (!g.active) return;

      clearLongPressTimers();

      const wasDragging = g.isDragging;
      const resolvedEndX =
        typeof endClientX === 'number' && Number.isFinite(endClientX) ? endClientX : g.lastX;
      const finalDeltaX = resolvedEndX - g.startX;
      const elapsedMs = Math.max(1, Date.now() - g.startTimeMs);
      const velocityX = finalDeltaX / elapsedMs;
      const targetKey = g.capsuleKey;

      gestureRef.current = {
        active: false,
        inputType: null,
        identifier: null,
        capsuleKey: null,
        startX: 0,
        startY: 0,
        lastX: 0,
        startTimeMs: 0,
        isDragging: false,
      };

      if (targetKey) {
        setInteractionState((prev) => ({
          capsuleKey: targetKey,
          progress: prev.capsuleKey === targetKey ? prev.progress : 0,
          dragOffsetX: 0,
          isPressing: false,
        }));
      }

      const {
        activeCapsule: currentCapsule,
        activeCapsuleKey: currentKey,
        isUpdating: currentlyUpdating,
        onPass: passFn,
        onRecycle: recycleFn,
      } = latestCallbacksRef.current;

      if (cancelled || !currentCapsule || !currentKey || currentlyUpdating) {
        return;
      }

      if (wasDragging) {
        suppressNextClickRef.current = true;
        const isLeftCommit =
          finalDeltaX <= -SWIPE_COMMIT_THRESHOLD_PX ||
          (finalDeltaX <= -SWIPE_FLICK_MIN_DISTANCE_PX &&
            velocityX <= -SWIPE_FLICK_VELOCITY_PX_PER_MS);
        const isRightCommit =
          finalDeltaX >= SWIPE_COMMIT_THRESHOLD_PX ||
          (finalDeltaX >= SWIPE_FLICK_MIN_DISTANCE_PX &&
            velocityX >= SWIPE_FLICK_VELOCITY_PX_PER_MS);

        if (isLeftCommit) {
          setLocalTrigger((prev) => prev + 1);
          void passFn();
        } else if (isRightCommit) {
          setLocalTrigger((prev) => prev + 1);
          void recycleFn();
        }
      }
    },
    [clearLongPressTimers],
  );

  // 要素外（画面端・ボタン外）で指やマウスを動かした/離した場合でも確実に追跡するための window リスナー
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleWindowPointerMove = (event: PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active || g.inputType !== 'pointer') return;
      if (g.identifier !== null && event.pointerId !== g.identifier) return;
      updateGestureMove(event.clientX, event.clientY);
    };

    const handleWindowPointerUp = (event: PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active || g.inputType !== 'pointer') return;
      if (g.identifier !== null && event.pointerId !== g.identifier) return;
      completeGesture(event.clientX, false);
    };

    const handleWindowPointerCancel = (event: PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active || g.inputType !== 'pointer') return;
      if (g.identifier !== null && event.pointerId !== g.identifier) return;
      completeGesture(null, true);
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
    };
  }, [completeGesture, updateGestureMove]);

  const startGesture = (
    inputType: 'pointer' | 'touch',
    identifier: number,
    clientX: number,
    clientY: number,
    enableLongPress: boolean,
  ) => {
    if (
      !activeCapsule ||
      !activeCapsuleKey ||
      isUpdating ||
      isLockedForCapsuleKeyRef.current === activeCapsuleKey
    ) {
      return;
    }
    if (gestureRef.current.active) {
      return;
    }

    const targetKey = activeCapsuleKey;
    gestureRef.current = {
      active: true,
      inputType,
      identifier,
      capsuleKey: targetKey,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      startTimeMs: Date.now(),
      isDragging: false,
    };
    suppressNextClickRef.current = false;

    setInteractionState((prev) => ({
      capsuleKey: targetKey,
      progress: prev.capsuleKey === targetKey ? prev.progress : 0,
      dragOffsetX: 0,
      isPressing: enableLongPress,
    }));

    clearLongPressTimers();

    if (!enableLongPress) {
      return;
    }

    // 1秒長押し（340ms -> Stage 1, 670ms -> Stage 2, 1000ms -> 開封完了）
    const timer1 = setTimeout(() => {
      if (!gestureRef.current.active || gestureRef.current.isDragging) return;
      suppressNextClickRef.current = true;
      const current =
        crackStateRef.current.capsuleKey === targetKey ? crackStateRef.current.progress : 0;
      if (current < 1) {
        advanceCrackStep(targetKey, 1);
      }
    }, LONG_PRESS_STEP_1_MS);

    const timer2 = setTimeout(() => {
      if (!gestureRef.current.active || gestureRef.current.isDragging) return;
      suppressNextClickRef.current = true;
      const current =
        crackStateRef.current.capsuleKey === targetKey ? crackStateRef.current.progress : 0;
      if (current < 2) {
        advanceCrackStep(targetKey, 2);
      }
    }, LONG_PRESS_STEP_2_MS);

    const timer3 = setTimeout(() => {
      if (!gestureRef.current.active || gestureRef.current.isDragging) return;
      suppressNextClickRef.current = true;
      triggerCompleteCrack(targetKey);
    }, LONG_PRESS_COMPLETE_MS);

    longPressTimersRef.current = [timer1, timer2, timer3];
  };

  const handleStagePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const isCapsuleButton =
      event.target instanceof Element &&
      Boolean(event.target.closest('[data-testid="active-capsule-button"]'));

    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // JSDOM 等で setPointerCapture が未実装の場合でも安全に続行
      }
    }

    startGesture('pointer', event.pointerId, event.clientX, event.clientY, isCapsuleButton);
  };

  const handleStagePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g.active || g.inputType !== 'pointer') return;
    if (g.identifier !== null && event.pointerId !== g.identifier) return;
    updateGestureMove(event.clientX, event.clientY);
  };

  const handleStagePointerUp = (event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const g = gestureRef.current;
    if (!g.active || g.inputType !== 'pointer') return;
    if (g.identifier !== null && event.pointerId !== g.identifier) return;

    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 安全に無視
      }
    }

    completeGesture(event.clientX, cancelled);
  };

  const handleStageTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    if (gestureRef.current.active) return;
    const touch = event.touches[0];
    if (!touch) return;
    const isCapsuleButton =
      event.target instanceof Element &&
      Boolean(event.target.closest('[data-testid="active-capsule-button"]'));
    startGesture('touch', touch.identifier, touch.clientX, touch.clientY, isCapsuleButton);
  };

  const handleStageTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g.active || g.inputType !== 'touch') return;
    const touch =
      Array.from(event.touches).find((t) => t.identifier === g.identifier) ?? event.touches[0];
    if (!touch) return;
    updateGestureMove(touch.clientX, touch.clientY);
  };

  const handleStageTouchEnd = (event: React.TouchEvent<HTMLElement>, cancelled: boolean) => {
    const g = gestureRef.current;
    if (!g.active || g.inputType !== 'touch') return;
    const touch =
      Array.from(event.changedTouches).find((t) => t.identifier === g.identifier) ??
      event.changedTouches[0];
    completeGesture(touch ? touch.clientX : null, cancelled);
  };

  const handleClick = () => {
    if (!activeCapsule || !activeCapsuleKey || isUpdating) return;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (isLockedForCapsuleKeyRef.current === activeCapsuleKey) {
      return;
    }
    advanceCrackStep(activeCapsuleKey);
  };

  const activeBadge = activeCapsule
    ? CAPSULE_BADGE_CONFIG[activeCapsule.capsuleColor]
    : CAPSULE_BADGE_CONFIG.blue;

  const combinedTrigger = externalInteractionTrigger + localTrigger;
  const isSwipingLeft = dragOffsetX <= -20;
  const isSwipingRight = dragOffsetX >= 20;
  const isActivelyDragging = dragOffsetX !== 0;

  return (
    <div
      data-testid="capsule-stage-dome"
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={(e) => handleStagePointerUp(e, false)}
      onPointerCancel={(e) => handleStagePointerUp(e, true)}
      onTouchStart={handleStageTouchStart}
      onTouchMove={handleStageTouchMove}
      onTouchEnd={(e) => handleStageTouchEnd(e, false)}
      onTouchCancel={(e) => handleStageTouchEnd(e, true)}
      className="toy-acrylic-dome relative flex flex-1 flex-col items-center justify-between w-full my-1.5 rounded-[32px] p-3 min-h-0 overflow-hidden touch-none select-none"
    >
      {/* アクリルドームの左上ハイライト反射 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-6 -left-6 h-28 w-44 -rotate-12 rounded-full bg-white/55 blur-[2px]"
      />

      {/* 筐体コーナーのビス装飾 */}
      <span aria-hidden="true" className="toy-screw absolute top-3 left-3" />
      <span aria-hidden="true" className="toy-screw absolute top-3 right-3" />

      {/* リサイクル完了（+5コイン）やパス演出のフロートトースト */}
      {toastNotification && (
        <div
          role="status"
          aria-live="polite"
          data-testid={
            toastNotification.type === 'recycle'
              ? 'recycle-toast'
              : toastNotification.type === 'pass'
                ? 'pass-toast'
                : 'crack-toast'
          }
          className={`pointer-events-none absolute top-18 left-1/2 z-30 -translate-x-1/2 flex items-center gap-1.5 rounded-full border-2 border-[#1E1B18] px-3.5 py-1 text-xs font-black whitespace-nowrap shadow-[0_4px_0_#1E1B18] ${
            toastNotification.type === 'recycle'
              ? 'bg-[#6EE7B7] text-[#064E3B]'
              : toastNotification.type === 'pass'
                ? 'bg-[#7DD3FC] text-[#0C4A6E]'
                : 'bg-[#FFBE0B] text-[#1E1B18]'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{toastNotification.text}</span>
        </div>
      )}

      {activeCapsule ? (
        <>
          {/* 上部：カプセルレア度タグ＆3段階クラックゲージ */}
          <div className="relative z-10 flex w-full items-center justify-between px-4 pt-0.5">
            <span
              data-testid="active-capsule-badge"
              className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2.5 py-0.5 font-display text-[11px] font-bold tracking-wide shadow-[0_2px_0_#1E1B18] ${activeBadge.bgClass}`}
            >
              <Zap className="h-3 w-3 fill-current" aria-hidden="true" />
              {activeBadge.label}
            </span>

            {/* 3段階クラックランプ */}
            <div
              aria-label={`ヒビ割れ段階 ${crackProgress}/3`}
              data-testid="crack-progress-gauge"
              className="flex items-center gap-1 rounded-full bg-[#1E1B18] px-2.5 py-1 border-2 border-white/80"
            >
              {[1, 2, 3].map((step) => (
                <span
                  key={step}
                  className={`h-2.5 w-2.5 rounded-full border border-[#1E1B18] transition-colors ${
                    crackProgress >= step ? 'bg-[#FFBE0B] shadow-[0_0_6px_#FFBE0B]' : 'bg-[#44403C]'
                  }`}
                />
              ))}
              <span className="ml-1 font-display text-[10px] font-bold text-[#FFF8EC]">
                {crackProgress}/3
              </span>
            </div>
          </div>

          {/* 左右スワイプ操作ガイドピル（ドラッグ中にハイライト） */}
          <div
            aria-hidden="true"
            className="pointer-events-none relative z-10 flex w-full items-center justify-between px-1 text-[10px] font-black"
          >
            <span
              className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2 py-0.5 transition-transform ${
                isSwipingLeft
                  ? 'scale-110 bg-[#38BDF8] text-[#1E1B18] shadow-[0_2px_0_#1E1B18]'
                  : 'bg-white/75 text-[#0C4A6E]'
              }`}
            >
              <RefreshCw className="h-2.5 w-2.5" />
              <span>{remainingCount > 1 ? '← 左スワイプ: パス' : '← 残1個'}</span>
            </span>

            <span
              className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2 py-0.5 transition-transform ${
                isSwipingRight
                  ? 'scale-110 bg-[#34D399] text-[#1E1B18] shadow-[0_2px_0_#1E1B18]'
                  : 'bg-white/75 text-[#065F46]'
              }`}
            >
              <span>右スワイプ: 破棄(+5) →</span>
              <Trash2 className="h-2.5 w-2.5" />
            </span>
          </div>

          {/* 中央：1カプセル表示＆クラック操作ボタン（タップ連打・1秒長押し・左右スワイプ対応） */}
          <button
            type="button"
            onClick={handleClick}
            onContextMenu={(e) => e.preventDefault()}
            disabled={isUpdating}
            data-testid="active-capsule-button"
            aria-label={`現在のカプセルタスク: ${activeCapsule.title}。タップ連打または1秒長押しで開封、左スワイプでパス、右スワイプでリサイクル`}
            style={{
              transform: `translateX(${dragOffsetX}px) rotate(${dragOffsetX * 0.14}deg) scale(${
                isPressing ? 0.96 : 1
              })`,
            }}
            className={`group relative z-10 my-auto flex flex-col items-center justify-center focus:outline-none cursor-grab active:cursor-grabbing touch-none select-none ${
              isActivelyDragging ? 'transition-none' : 'transition-transform duration-150'
            }`}
          >
            {/* 3D風グラデーション＆光沢シェル背景（Three.jsキャンバスの背面ハロー＆フォールバック立体表現） */}
            <div
              data-testid="capsule-3d-shell"
              data-capsule-color={activeCapsule.capsuleColor}
              className={`pointer-events-none absolute h-44 w-44 sm:h-48 sm:w-48 rounded-full border-4 border-[#1E1B18] overflow-hidden ring-4 ${activeBadge.rimGlowClass} transition-transform ${
                isPressing ? 'scale-105' : 'group-hover:scale-[1.02]'
              }`}
            >
              {/* 上半球：カラー3Dグラデーション＋光沢ハイライト */}
              <div
                className={`relative h-1/2 w-full bg-gradient-to-b ${activeBadge.shellGradientClass} border-b-3 border-[#1E1B18]`}
              >
                <span className="absolute top-2.5 left-5 h-5 w-14 -rotate-12 rounded-full bg-white/65 blur-[1px]" />
                <span className="absolute top-7 left-4 h-2.5 w-5 -rotate-12 rounded-full bg-white/45" />
              </div>
              {/* 下半球：半透明フロストホワイト＋立体陰影 */}
              <div className="relative h-1/2 w-full bg-gradient-to-b from-[#FFFFFF] via-[#F8FAFC] to-[#CBD5E1]">
                <span className="absolute bottom-3 right-6 h-4 w-12 -rotate-12 rounded-full bg-white/80" />
              </div>
            </div>

            {/* Three.js 3Dカプセルキャンバス */}
            <ThreeCapsuleCanvas
              capsuleColor={activeCapsule.capsuleColor}
              crackProgress={crackProgress}
              interactionTrigger={combinedTrigger}
            />

            {/* 段階的ヒビ割れ（クラックSVG）オーバーレイ（FR-10） */}
            <svg
              viewBox="0 0 200 200"
              data-testid="capsule-crack-svg"
              data-crack-step={crackProgress}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 m-auto h-48 w-48 sm:h-52 sm:w-52 z-20"
            >
              {/* 長押しホールド中の外周チャージリング */}
              {isPressing && (
                <circle
                  cx="100"
                  cy="100"
                  r="90"
                  fill="none"
                  stroke="#FFBE0B"
                  strokeWidth="5"
                  strokeDasharray="18 10"
                  className="animate-spin"
                />
              )}

              {/* Stage 1 ヒビ割れ：中央シームから上下へ走る初期クラック */}
              {crackProgress >= 1 && (
                <g data-testid="crack-layer-1">
                  <path
                    d="M 68 100 L 86 84 L 96 98 L 112 74 L 128 100 L 106 118 L 90 104 Z"
                    fill="rgba(255, 243, 176, 0.35)"
                    stroke="#1E1B18"
                    strokeWidth="4"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M 56 100 L 84 96 L 98 72 L 108 98 L 138 94"
                    fill="none"
                    stroke="#FFFBEB"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              )}

              {/* Stage 2 ヒビ割れ：ドーム全体へ広がる大きな放射状クラック＆光漏れ */}
              {crackProgress >= 2 && (
                <g data-testid="crack-layer-2">
                  <path
                    d="M 98 72 L 82 48 L 94 34 M 108 98 L 126 128 L 116 154 M 84 96 L 62 124 L 46 132 M 122 86 L 148 64"
                    fill="none"
                    stroke="#1E1B18"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M 98 72 L 82 48 L 94 34 M 108 98 L 126 128 L 116 154 M 84 96 L 62 124 L 46 132 M 122 86 L 148 64"
                    fill="none"
                    stroke="#FFBE0B"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="100" cy="96" r="10" fill="#FEF08A" opacity="0.85" />
                </g>
              )}

              {/* Stage 3 開封瞬間：パカッと割れる閃光スターバースト */}
              {crackProgress >= 3 && (
                <g data-testid="crack-layer-3">
                  <circle cx="100" cy="100" r="64" fill="#FEF08A" opacity="0.75" />
                </g>
              )}
            </svg>
          </button>

          {/* 下部：カプセル同梱ミニブック風タスク名スリップ（スワイプ連動で少し追従） */}
          <div
            style={{
              transform: `translateX(${dragOffsetX * 0.35}px)`,
            }}
            className={`relative z-10 w-full rounded-2xl bg-[#FFFDF9] border-3 border-[#1E1B18] px-3.5 py-2 shadow-[0_4px_0_#1E1B18] ${
              isActivelyDragging ? 'transition-none' : 'transition-transform duration-150'
            }`}
          >
            <p
              data-testid="active-capsule-title"
              className="font-toy text-center text-sm sm:text-base font-normal leading-snug text-[#1E1B18] line-clamp-2"
            >
              {activeCapsule.title}
            </p>
            <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-black text-[#B45309]">
              <Hammer className="h-3.5 w-3.5 stroke-[2.5]" aria-hidden="true" />
              <span>
                {isSwipingLeft
                  ? '指を離すと「パス（あとで回す）」！'
                  : isSwipingRight
                    ? '指を離すと「リサイクル破棄（＋5コイン）」！'
                    : isPressing
                      ? '長押しチャージ中... そのままホールドで開封！'
                      : crackProgress >= 3
                        ? 'パカッ！カプセル開封！'
                        : crackProgress === 0
                          ? 'タップ連打 または 1秒長押しで割る！'
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
          <p className="font-toy text-base text-[#1E1B18]">すべてのカプセルを開封しました！</p>
          <p className="mt-1.5 text-xs font-bold text-[#57534E]">
            下の「＋カプセル補充」から音声やスタンプで新しいカプセルを投入しよう
          </p>
        </div>
      )}
    </div>
  );
};
