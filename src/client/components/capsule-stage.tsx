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
  /** Stage 3（3/3 開封確定〜次カプセル遷移まで）のロック状態変化コールバック */
  onOpeningLockChange?: (isOpening: boolean) => void;
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
/** Stage 3（3/3 開封完了エフェクト・3D上蓋オープン）を描画維持してから次カプセルへ遷移する演出時間（ms） */
export const STAGE_3_OPEN_DURATION_MS = 260;

const CAPSULE_BADGE_CONFIG: Record<
  CapsuleColor,
  {
    label: string;
    bgClass: string;
    auraColor: string;
  }
> = {
  blue: {
    label: 'LIGHT CAPSULE ×1.0',
    bgClass:
      'bg-gradient-to-b from-[#7DD3FC] to-[#0284C7] text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.7),0_3px_0_#1E1B18]',
    auraColor: 'rgba(56, 189, 248, 0.38)',
  },
  red: {
    label: 'MEDIUM CAPSULE ×1.5',
    bgClass:
      'bg-gradient-to-b from-[#FF6B78] to-[#E11D48] text-white shadow-[inset_0_2px_0_rgba(255,255,255,0.45),0_3px_0_#1E1B18]',
    auraColor: 'rgba(251, 113, 133, 0.38)',
  },
  gold: {
    label: 'GOLD CAPSULE ×2.0',
    bgClass:
      'bg-gradient-to-b from-[#FEF08A] via-[#FFBE0B] to-[#D97706] text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.85),0_3px_0_#1E1B18]',
    auraColor: 'rgba(250, 204, 21, 0.48)',
  },
};

/**
 * FR-06, FR-07, FR-09, FR-10:
 * 画面中央に常に1個の未開封カプセルのみをThree.js 3D空間で表示し、
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
  onOpeningLockChange,
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
  const pendingCrackKeyRef = useRef<string | null>(null);
  const suppressNextClickRef = useRef<boolean>(false);
  const longPressTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stage3OpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    onCrack,
    onPass,
    onRecycle,
    onOpeningLockChange,
  });

  useEffect(() => {
    latestCallbacksRef.current = {
      activeCapsule,
      activeCapsuleKey,
      isUpdating,
      onCrack,
      onPass,
      onRecycle,
      onOpeningLockChange,
    };
  }, [
    activeCapsule,
    activeCapsuleKey,
    isUpdating,
    onCrack,
    onPass,
    onRecycle,
    onOpeningLockChange,
  ]);

  const clearLongPressTimers = useCallback(() => {
    for (const timerId of longPressTimersRef.current) {
      clearTimeout(timerId);
    }
    longPressTimersRef.current = [];
  }, []);

  const clearStage3OpenTimer = useCallback(() => {
    if (stage3OpenTimerRef.current !== null) {
      clearTimeout(stage3OpenTimerRef.current);
      stage3OpenTimerRef.current = null;
    }
  }, []);

  // カプセル切り替え時（またはパス巡回時）・アンマウント時にタイマー・ロックをクリーンアップ
  // 注意: suppressNextClickRef および押しっぱなし中の gestureRef は、長押し開封後に指を離した際の
  // 合成 click を確実に消費して次カプセルが 1/3 進まないようここではリセットしない
  useEffect(() => {
    clearLongPressTimers();
    clearStage3OpenTimer();
    crackStateRef.current = { capsuleKey: activeCapsuleKey, progress: 0 };
    isLockedForCapsuleKeyRef.current = null;
    pendingCrackKeyRef.current = null;
    latestCallbacksRef.current.onOpeningLockChange?.(false);
    return () => {
      clearLongPressTimers();
      clearStage3OpenTimer();
      latestCallbacksRef.current.onOpeningLockChange?.(false);
    };
  }, [activeCapsuleKey, clearLongPressTimers, clearStage3OpenTimer]);

  // Stage 3 演出完了時点で補充やサウンド切替等の別更新（isUpdating）が進行中だった場合、
  // 更新完了後に保留していた開封（onCrack）を自動的に再試行して 3/3 で操作不能になるのを防ぐ
  useEffect(() => {
    if (
      !isUpdating &&
      activeCapsuleKey !== null &&
      pendingCrackKeyRef.current === activeCapsuleKey &&
      stage3OpenTimerRef.current === null
    ) {
      pendingCrackKeyRef.current = null;
      void latestCallbacksRef.current.onCrack();
    }
  }, [isUpdating, activeCapsuleKey]);

  const triggerCompleteCrack = useCallback(
    (targetKey: string) => {
      if (isLockedForCapsuleKeyRef.current === targetKey) return;
      isLockedForCapsuleKeyRef.current = targetKey;
      pendingCrackKeyRef.current = null;
      gestureRef.current.isDragging = false;
      suppressNextClickRef.current = true;
      clearLongPressTimers();
      clearStage3OpenTimer();
      latestCallbacksRef.current.onOpeningLockChange?.(true);
      // Stage 3（progress: 3）を保持し、Web Locks 非対応環境等の即時更新でも
      // 開封演出（3D開口・閃光・ゲージ3/3）が完了してから次カプセルへ切り替える
      crackStateRef.current = { capsuleKey: targetKey, progress: 3 };
      setInteractionState({
        capsuleKey: targetKey,
        progress: 3,
        dragOffsetX: 0,
        isPressing: false,
      });
      setLocalTrigger((prev) => prev + 1);
      stage3OpenTimerRef.current = setTimeout(() => {
        stage3OpenTimerRef.current = null;
        const { activeCapsuleKey: currentKey, isUpdating: currentlyUpdating } =
          latestCallbacksRef.current;
        if (currentKey !== targetKey) return;
        if (currentlyUpdating) {
          pendingCrackKeyRef.current = targetKey;
          return;
        }
        void latestCallbacksRef.current.onCrack();
      }, STAGE_3_OPEN_DURATION_MS);
    },
    [clearLongPressTimers, clearStage3OpenTimer],
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

      const currentKey = latestCallbacksRef.current.activeCapsuleKey;
      if (g.capsuleKey !== currentKey || isLockedForCapsuleKeyRef.current === g.capsuleKey) {
        suppressNextClickRef.current = true;
        return;
      }

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

      if (
        targetKey &&
        (targetKey !== currentKey || isLockedForCapsuleKeyRef.current === targetKey)
      ) {
        suppressNextClickRef.current = true;
        return;
      }

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
    if (gestureRef.current.active && gestureRef.current.capsuleKey === activeCapsuleKey) {
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

    // 1秒長押し（340ms -> +1段階, 670ms -> +1段階, 1000ms -> 開封完了）
    const timer1 = setTimeout(() => {
      if (!gestureRef.current.active || gestureRef.current.isDragging) return;
      suppressNextClickRef.current = true;
      advanceCrackStep(targetKey);
    }, LONG_PRESS_STEP_1_MS);

    const timer2 = setTimeout(() => {
      if (!gestureRef.current.active || gestureRef.current.isDragging) return;
      suppressNextClickRef.current = true;
      advanceCrackStep(targetKey);
    }, LONG_PRESS_STEP_2_MS);

    const timer3 = setTimeout(() => {
      if (!gestureRef.current.active || gestureRef.current.isDragging) return;
      suppressNextClickRef.current = true;
      triggerCompleteCrack(targetKey);
    }, LONG_PRESS_COMPLETE_MS);

    longPressTimersRef.current = [timer1, timer2, timer3];
  };

  const handleStagePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    // 親ドーム要素で setPointerCapture を呼ぶと pointerup の target が親へリターゲットされ、
    // 子ボタン（active-capsule-button / Three.js canvas）でブラウザ標準の click イベントが発火しなくなるため呼ばない
    startGesture('pointer', event.pointerId, event.clientX, event.clientY, true);
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

    completeGesture(event.clientX, cancelled);
  };

  const handleStageTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    if (gestureRef.current.active) return;
    const touch = event.touches[0];
    if (!touch) return;
    startGesture('touch', touch.identifier, touch.clientX, touch.clientY, true);
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
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (!activeCapsule || !activeCapsuleKey || isUpdating) return;
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
      onClick={handleClick}
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={(e) => handleStagePointerUp(e, false)}
      onPointerCancel={(e) => handleStagePointerUp(e, true)}
      onTouchStart={handleStageTouchStart}
      onTouchMove={handleStageTouchMove}
      onTouchEnd={(e) => handleStageTouchEnd(e, false)}
      onTouchCancel={(e) => handleStageTouchEnd(e, true)}
      className="toy-acrylic-dome relative flex flex-1 flex-col items-center justify-between w-full my-1.5 rounded-[32px] p-3 min-h-0 overflow-hidden touch-none select-none cursor-pointer"
    >
      {/* アクリルドームの左上ハイライト曲面反射 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-6 -left-6 h-28 w-44 -rotate-12 rounded-full bg-white/55 blur-[2px]"
      />
      {/* ドーム底面の立体ステージフロア反射 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-12 left-1/2 -translate-x-1/2 h-14 w-64 rounded-full bg-white/45 blur-md"
      />

      {/* 筐体コーナーのビス装飾 */}
      <span aria-hidden="true" className="toy-screw absolute top-3 left-3" />
      <span aria-hidden="true" className="toy-screw absolute top-3 right-3" />

      {/* リサイクル完了（+5コイン）やパス演出の立体カプセルプレートトースト */}
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
          className={`pointer-events-none absolute top-13 left-1/2 z-30 -translate-x-1/2 flex items-center gap-1.5 rounded-full border-2 border-[#1E1B18] px-3.5 py-1 text-xs font-black whitespace-nowrap shadow-[inset_0_2px_0_rgba(255,255,255,0.65),0_4px_0_#1E1B18] ${
            toastNotification.type === 'recycle'
              ? 'bg-gradient-to-b from-[#A7F3D0] to-[#34D399] text-[#064E3B]'
              : toastNotification.type === 'pass'
                ? 'bg-gradient-to-b from-[#BAE6FD] to-[#38BDF8] text-[#0C4A6E]'
                : 'bg-gradient-to-b from-[#FEF08A] to-[#FFBE0B] text-[#1E1B18]'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{toastNotification.text}</span>
        </div>
      )}

      {activeCapsule ? (
        <>
          {/* 上部：立体レア度プレート＆3連ドームLEDクラックゲージ */}
          <div className="relative z-10 flex w-full items-center justify-between px-4 pt-0.5">
            <span
              data-testid="active-capsule-badge"
              className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2.5 py-0.5 font-display text-[11px] font-bold tracking-wide ${activeBadge.bgClass}`}
            >
              <Zap className="h-3 w-3 fill-current" aria-hidden="true" />
              {activeBadge.label}
            </span>

            {/* 3段階クラックドームLEDランプ */}
            <div
              aria-label={`ヒビ割れ段階 ${crackProgress}/3`}
              data-testid="crack-progress-gauge"
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-b from-[#292524] to-[#1C1917] px-2.5 py-1 border-2 border-white/85 shadow-[inset_0_2px_3px_rgba(0,0,0,0.6),0_2px_0_#1E1B18]"
            >
              {[1, 2, 3].map((step) => (
                <span
                  key={step}
                  className={`h-2.5 w-2.5 rounded-full border border-[#1E1B18] transition-all ${
                    crackProgress >= step
                      ? 'bg-[radial-gradient(circle_at_35%_30%,#FFFBEB_0%,#FFBE0B_55%,#D97706_100%)] shadow-[0_0_8px_#FFBE0B]'
                      : 'bg-[radial-gradient(circle_at_35%_30%,#57534E_0%,#292524_100%)]'
                  }`}
                />
              ))}
              <span className="ml-0.5 font-display text-[10px] font-bold text-[#FFF8EC]">
                {crackProgress}/3
              </span>
            </div>
          </div>

          {/* スワイプドラッグ中のみ立体的に浮かび上がる左右アクションインジケーター */}
          {isActivelyDragging && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2 z-20 flex items-center justify-between"
            >
              <div
                className={`flex items-center gap-1 rounded-2xl border-2 border-[#1E1B18] bg-gradient-to-b from-[#BAE6FD] to-[#38BDF8] px-2.5 py-1.5 text-xs font-black text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.7),0_4px_0_#1E1B18] transition-all ${
                  isSwipingLeft ? 'opacity-100 scale-105' : 'opacity-0 -translate-x-2 scale-90'
                }`}
              >
                <RefreshCw className="h-3.5 w-3.5 stroke-[2.75]" />
                <span>{remainingCount > 1 ? 'パス' : '残1個'}</span>
              </div>

              <div
                className={`flex items-center gap-1 rounded-2xl border-2 border-[#1E1B18] bg-gradient-to-b from-[#A7F3D0] to-[#34D399] px-2.5 py-1.5 text-xs font-black text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.7),0_4px_0_#1E1B18] transition-all ${
                  isSwipingRight ? 'opacity-100 scale-105' : 'opacity-0 translate-x-2 scale-90'
                }`}
              >
                <Trash2 className="h-3.5 w-3.5 stroke-[2.75]" />
                <span>+5</span>
              </div>
            </div>
          )}

          {/* 中央：Three.js 3Dカプセルステージ本体（邪魔な2D黒枠を廃し3D空間で統合表現） */}
          <button
            type="button"
            onContextMenu={(e) => e.preventDefault()}
            disabled={isUpdating}
            data-testid="active-capsule-button"
            aria-label={`現在のカプセルタスク: ${activeCapsule.title}。タップ連打または1秒長押しで開封、左スワイプでパス、右スワイプでリサイクル`}
            style={{
              transform: `perspective(700px) translate3d(${dragOffsetX * 0.45}px, 0, 0) rotateY(${
                dragOffsetX * 0.14
              }deg) rotateZ(${dragOffsetX * 0.06}deg)`,
            }}
            className={`group relative z-10 my-auto flex flex-col items-center justify-center focus:outline-none cursor-grab active:cursor-grabbing touch-none select-none ${
              isActivelyDragging ? 'transition-none' : 'transition-transform duration-150'
            }`}
          >
            {/* 3Dカプセル背面の空間ボリューメトリック・オーラ（2Dの黒枠線は使わず奥行き光のみを表現） */}
            <div
              data-testid="capsule-3d-shell"
              data-capsule-color={activeCapsule.capsuleColor}
              aria-hidden="true"
              style={{
                background: `radial-gradient(circle, ${activeBadge.auraColor} 0%, rgba(255,255,255,0) 70%)`,
              }}
              className={`pointer-events-none absolute h-56 w-56 sm:h-60 sm:w-60 rounded-full transition-transform duration-200 ${
                isPressing || crackProgress > 0 ? 'scale-115' : 'scale-100'
              }`}
            />

            {/* Three.js 3Dカプセルキャンバス（3D開口・3Dクラックシャード・3Dスワイプ転がり） */}
            <ThreeCapsuleCanvas
              capsuleColor={activeCapsule.capsuleColor}
              crackProgress={crackProgress}
              interactionTrigger={combinedTrigger}
              dragOffsetX={dragOffsetX}
              isPressing={isPressing}
            />

            {/* 3D空間に溶け込む繊細なリム発光エフェクトレイヤー（2Dの黒い太線は描かず立体グロウのみ） */}
            <svg
              viewBox="0 0 200 200"
              data-testid="capsule-crack-svg"
              data-crack-step={crackProgress}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 m-auto h-56 w-56 sm:h-60 sm:w-60 z-20"
            >
              <defs>
                <radialGradient id="stage3dGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#FFFBEB" stopOpacity="0.85" />
                  <stop offset="45%" stopColor="#FDE047" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#FFBE0B" stopOpacity="0" />
                </radialGradient>
              </defs>

              {crackProgress >= 1 && (
                <g data-testid="crack-layer-1">
                  <ellipse cx="100" cy="102" rx="48" ry="10" fill="url(#stage3dGlow)" />
                </g>
              )}

              {crackProgress >= 2 && (
                <g data-testid="crack-layer-2">
                  <ellipse cx="100" cy="98" rx="68" ry="18" fill="url(#stage3dGlow)" />
                </g>
              )}

              {crackProgress >= 3 && (
                <g data-testid="crack-layer-3">
                  <circle cx="100" cy="98" r="76" fill="url(#stage3dGlow)" />
                </g>
              )}
            </svg>
          </button>

          {/* 下部：立体成形のミニブック風タスク名プレート（3Dパースペクティブ連動） */}
          <div
            style={{
              transform: `perspective(600px) translate3d(${dragOffsetX * 0.25}px, 0, 0) rotateY(${
                dragOffsetX * 0.08
              }deg)`,
            }}
            className={`toy-cream-panel relative z-10 w-full rounded-2xl px-3.5 py-2 ${
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
                          ? '3Dカプセルをタップ連打 / 1秒長押しで割る！'
                          : `ヒビ割れ ${crackProgress}/3（あと ${3 - crackProgress} 回タップ）`}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div
          data-testid="empty-capsule-stage"
          className="toy-cream-panel relative z-10 my-auto flex flex-col items-center justify-center rounded-2xl px-5 py-7 text-center"
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
