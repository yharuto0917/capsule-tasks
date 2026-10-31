import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Coins, Hammer, RefreshCw, Sparkles, Trash2, Zap } from 'lucide-react';
import { ThreeCapsuleCanvas, type ThreeCapsuleCanvasHandle } from './three-capsule-canvas';
import type { CapsuleColor, CapsuleTask } from '../../shared/schemas';

export interface StageToastNotification {
  type: 'recycle' | 'pass' | 'crack';
  text: string;
}

export type SwipeIntentZone = 'none' | 'pass' | 'recycle-right' | 'recycle-down';

export interface CapsuleExitEffectState {
  seq: number;
  kind: 'pass' | 'recycle-right' | 'recycle-down';
  color: CapsuleColor;
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
  /** 右または下スワイプ（ゴミ箱方向）でリサイクル破棄した際に呼ばれるコールバック（FR-09） */
  onRecycle: () => void | Promise<void>;
  /** 外部操作による3Dカプセル揺れトリガー */
  externalInteractionTrigger?: number;
  /** ステージ上に表示するトースト通知（リサイクル完了！＋5コイン獲得 等） */
  toastNotification?: StageToastNotification | null;
  /** Stage 3（3/3 開封確定〜次カプセル遷移まで）のロック状態変化コールバック */
  onOpeningLockChange?: (isOpening: boolean) => void;
  /** モーダルやボトムシート展開中に3D描画ループを休止する省電力フラグ */
  isPaused?: boolean;
}

/** ドラッグ開始とみなす最小移動量（px） */
const SWIPE_DRAG_SLOP_PX = 6;
/** 通常の横ドラッグ距離によるスワイプ確定閾値（px） */
const SWIPE_COMMIT_THRESHOLD_PX = 40;
/** 下方向ドラッグによるゴミ箱吸引リサイクル確定閾値（px） */
const SWIPE_DOWN_COMMIT_THRESHOLD_PX = 44;
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
    ghostTopStyle: string;
  }
> = {
  blue: {
    label: 'LIGHT CAPSULE ×1.0',
    bgClass:
      'bg-gradient-to-b from-[#7DD3FC] to-[#0284C7] text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.7),0_3px_0_#1E1B18]',
    auraColor: 'rgba(56, 189, 248, 0.38)',
    ghostTopStyle:
      'radial-gradient(circle at 32% 28%, #E0F2FE 0%, #38BDF8 38%, #0284C7 80%, #0369A1 100%)',
  },
  red: {
    label: 'MEDIUM CAPSULE ×1.5',
    bgClass:
      'bg-gradient-to-b from-[#FF6B78] to-[#E11D48] text-white shadow-[inset_0_2px_0_rgba(255,255,255,0.45),0_3px_0_#1E1B18]',
    auraColor: 'rgba(251, 113, 133, 0.38)',
    ghostTopStyle:
      'radial-gradient(circle at 32% 28%, #FFE4E6 0%, #FF4D5E 38%, #E11D48 80%, #9F1239 100%)',
  },
  gold: {
    label: 'GOLD CAPSULE ×2.0',
    bgClass:
      'bg-gradient-to-b from-[#FEF08A] via-[#FFBE0B] to-[#D97706] text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.85),0_3px_0_#1E1B18]',
    auraColor: 'rgba(250, 204, 21, 0.48)',
    ghostTopStyle:
      'radial-gradient(circle at 32% 28%, #FEF9C3 0%, #FACC15 38%, #D97706 80%, #92400E 100%)',
  },
};

const RECYCLE_COIN_PARTICLES: ReadonlyArray<{
  tx: string;
  ty: string;
  rot: string;
  delay: string;
  isCoin: boolean;
}> = [
  { tx: '-64px', ty: '-148px', rot: '-160deg', delay: '0ms', isCoin: true },
  { tx: '-26px', ty: '-172px', rot: '140deg', delay: '35ms', isCoin: true },
  { tx: '18px', ty: '-166px', rot: '-120deg', delay: '20ms', isCoin: true },
  { tx: '62px', ty: '-142px', rot: '190deg', delay: '55ms', isCoin: true },
  { tx: '-88px', ty: '-96px', rot: '-210deg', delay: '45ms', isCoin: false },
  { tx: '86px', ty: '-92px', rot: '210deg', delay: '30ms', isCoin: false },
  { tx: '-44px', ty: '-118px', rot: '160deg', delay: '70ms', isCoin: false },
  { tx: '46px', ty: '-122px', rot: '-175deg', delay: '65ms', isCoin: true },
  { tx: '0px', ty: '-185px', rot: '120deg', delay: '15ms', isCoin: false },
  { tx: '-14px', ty: '-104px', rot: '-95deg', delay: '85ms', isCoin: false },
];

const SUNBURST_RAY_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;

function resolveSwipeIntent(dx: number, dy: number): SwipeIntentZone {
  if (dx <= -20 && Math.abs(dx) >= Math.abs(dy) * 0.8) {
    return 'pass';
  }
  if (dx >= 20 && dx >= Math.abs(dy) * 0.7) {
    return 'recycle-right';
  }
  if (dy >= 24 && dy > Math.abs(dx)) {
    return 'recycle-down';
  }
  return 'none';
}

/**
 * FR-06, FR-07, FR-09, FR-10:
 * 画面中央に常に1個の未開封カプセルのみをThree.js 3D空間で表示し、
 * タップ連打 / 1秒長押しによる段階的クラック開封、左スワイプ先送り、右・下スワイプリサイクルを制御するステージ。
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
  isPaused = false,
}) => {
  // カプセルIDとskipCountを組み合わせた一意キー。パスで巡回して再排出された場合も確実に新規状態として扱う
  const activeCapsuleKey = activeCapsule ? `${activeCapsule.id}:${activeCapsule.skipCount}` : null;

  const [interactionState, setInteractionState] = useState<{
    capsuleKey: string | null;
    progress: number;
    swipeIntent: SwipeIntentZone;
    isDragging: boolean;
    isPressing: boolean;
  }>({
    capsuleKey: null,
    progress: 0,
    swipeIntent: 'none',
    isDragging: false,
    isPressing: false,
  });
  const [localTrigger, setLocalTrigger] = useState<number>(0);
  const [exitEffect, setExitEffect] = useState<CapsuleExitEffectState | null>(null);

  const isCurrentCapsuleState =
    activeCapsuleKey !== null && interactionState.capsuleKey === activeCapsuleKey;
  const crackProgress = isCurrentCapsuleState ? interactionState.progress : 0;
  const swipeIntent: SwipeIntentZone = isCurrentCapsuleState
    ? interactionState.swipeIntent
    : 'none';
  const isActivelyDragging = isCurrentCapsuleState ? interactionState.isDragging : false;
  const isPressing = isCurrentCapsuleState ? interactionState.isPressing : false;

  const threeCanvasRef = useRef<ThreeCapsuleCanvasHandle | null>(null);
  const capsuleButtonRef = useRef<HTMLButtonElement | null>(null);
  const taskSlipRef = useRef<HTMLDivElement | null>(null);
  const exitSeqRef = useRef<number>(0);
  const lastGestureExitTimeRef = useRef<number>(0);
  const lastActiveColorRef = useRef<CapsuleColor>(activeCapsule?.capsuleColor ?? 'blue');

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
    lastY: number;
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
    lastY: 0,
    startTimeMs: 0,
    isDragging: false,
  });

  const latestCallbacksRef = useRef({
    activeCapsule,
    activeCapsuleKey,
    remainingCount,
    isUpdating,
    onCrack,
    onPass,
    onRecycle,
    onOpeningLockChange,
  });

  useEffect(() => {
    if (activeCapsule) {
      lastActiveColorRef.current = activeCapsule.capsuleColor;
    }
    latestCallbacksRef.current = {
      activeCapsule,
      activeCapsuleKey,
      remainingCount,
      isUpdating,
      onCrack,
      onPass,
      onRecycle,
      onOpeningLockChange,
    };
  }, [
    activeCapsule,
    activeCapsuleKey,
    remainingCount,
    isUpdating,
    onCrack,
    onPass,
    onRecycle,
    onOpeningLockChange,
  ]);

  /**
   * React再レンダリングを起こさず CSS Custom Properties と Three.js Ref を直接 60/120fps 更新する
   */
  const applyVisualDragOffset = useCallback((rawDx: number, rawDy: number) => {
    const clampedX = Math.max(-130, Math.min(130, rawDx));
    const clampedY = Math.max(-45, Math.min(130, rawDy));
    const downShrink = clampedY > 12 ? Math.max(0.86, 1 - (clampedY - 12) / 760) : 1;

    const btn = capsuleButtonRef.current;
    if (btn) {
      btn.style.setProperty('--drag-x', `${clampedX.toFixed(1)}px`);
      btn.style.setProperty('--drag-y', `${clampedY.toFixed(1)}px`);
      btn.style.setProperty('--drag-rot-y', `${(clampedX * 0.14).toFixed(2)}deg`);
      btn.style.setProperty('--drag-rot-z', `${(clampedX * 0.06).toFixed(2)}deg`);
      btn.style.setProperty('--drag-scale', downShrink.toFixed(3));
    }

    const slip = taskSlipRef.current;
    if (slip) {
      slip.style.setProperty('--drag-x', `${clampedX.toFixed(1)}px`);
      slip.style.setProperty('--drag-y', `${clampedY.toFixed(1)}px`);
      slip.style.setProperty('--drag-rot-y', `${(clampedX * 0.14).toFixed(2)}deg`);
    }

    threeCanvasRef.current?.setDragOffset(clampedX, clampedY);
  }, []);

  const spawnExitEffect = useCallback(
    (kind: 'pass' | 'recycle-right' | 'recycle-down', color: CapsuleColor) => {
      exitSeqRef.current += 1;
      setExitEffect({
        seq: exitSeqRef.current,
        kind,
        color,
      });
    },
    [],
  );

  // フッターの親指ボタン（「パス(次へ)」「破棄(+5)」）押下時にも退場吸い込み＆キラキラ粒子を連動発火
  const prevToastRef = useRef<StageToastNotification | null>(null);
  useEffect(() => {
    if (!toastNotification || toastNotification === prevToastRef.current) {
      prevToastRef.current = toastNotification;
      return;
    }
    prevToastRef.current = toastNotification;
    const elapsedSinceGestureExit = Date.now() - lastGestureExitTimeRef.current;
    if (elapsedSinceGestureExit < 220) {
      return;
    }
    if (toastNotification.type === 'pass') {
      spawnExitEffect('pass', lastActiveColorRef.current);
    } else if (toastNotification.type === 'recycle') {
      spawnExitEffect('recycle-right', lastActiveColorRef.current);
    }
  }, [spawnExitEffect, toastNotification]);

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

  // カプセル切り替え時（またはパス巡回時）・アンマウント時にタイマー・ロック・ドラッグ変位をクリーンアップ
  // 注意: suppressNextClickRef および押しっぱなし中の gestureRef は、長押し開封後に指を離した際の
  // 合成 click を確実に消費して次カプセルが 1/3 進まないようここではリセットしない
  useEffect(() => {
    clearLongPressTimers();
    clearStage3OpenTimer();
    applyVisualDragOffset(0, 0);
    crackStateRef.current = { capsuleKey: activeCapsuleKey, progress: 0 };
    isLockedForCapsuleKeyRef.current = null;
    pendingCrackKeyRef.current = null;
    latestCallbacksRef.current.onOpeningLockChange?.(false);
    return () => {
      clearLongPressTimers();
      clearStage3OpenTimer();
      latestCallbacksRef.current.onOpeningLockChange?.(false);
    };
  }, [activeCapsuleKey, applyVisualDragOffset, clearLongPressTimers, clearStage3OpenTimer]);

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
      if (gestureRef.current.active) {
        suppressNextClickRef.current = true;
      }
      clearLongPressTimers();
      clearStage3OpenTimer();
      applyVisualDragOffset(0, 0);
      latestCallbacksRef.current.onOpeningLockChange?.(true);
      // Stage 3（progress: 3）を保持し、Web Locks 非対応環境等の即時更新でも
      // 開封演出（3D開口・閃光・ゲージ3/3）が完了してから次カプセルへ切り替える
      crackStateRef.current = { capsuleKey: targetKey, progress: 3 };
      setInteractionState({
        capsuleKey: targetKey,
        progress: 3,
        swipeIntent: 'none',
        isDragging: false,
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
    [applyVisualDragOffset, clearLongPressTimers, clearStage3OpenTimer],
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
        swipeIntent: prev.capsuleKey === targetKey ? prev.swipeIntent : 'none',
        isDragging: prev.capsuleKey === targetKey ? prev.isDragging : false,
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
      g.lastY = clientY;

      if (!g.isDragging) {
        const absDx = Math.abs(dx);
        const distance = Math.hypot(dx, dy);
        if (
          absDx > SWIPE_DRAG_SLOP_PX ||
          dy > SWIPE_DRAG_SLOP_PX ||
          distance > SWIPE_DRAG_SLOP_PX * 1.5
        ) {
          g.isDragging = true;
          suppressNextClickRef.current = true;
          clearLongPressTimers();
        }
      }

      if (g.isDragging) {
        const targetKey = g.capsuleKey;
        applyVisualDragOffset(dx, dy);
        const nextIntent = resolveSwipeIntent(dx, dy);
        // 離散的なスワイプ意図ゾーンまたはドラッグ開始フラグが変化したときのみ React State を更新
        setInteractionState((prev) => {
          const prevProgress = prev.capsuleKey === targetKey ? prev.progress : 0;
          if (
            prev.capsuleKey === targetKey &&
            prev.isDragging &&
            !prev.isPressing &&
            prev.swipeIntent === nextIntent
          ) {
            return prev;
          }
          return {
            capsuleKey: targetKey,
            progress: prevProgress,
            swipeIntent: nextIntent,
            isDragging: true,
            isPressing: false,
          };
        });
      }
    },
    [applyVisualDragOffset, clearLongPressTimers],
  );

  const completeGesture = useCallback(
    (endClientX: number | null, endClientY: number | null, cancelled: boolean) => {
      const g = gestureRef.current;
      if (!g.active) return;

      clearLongPressTimers();

      const wasDragging = g.isDragging;
      const resolvedEndX =
        typeof endClientX === 'number' && Number.isFinite(endClientX) ? endClientX : g.lastX;
      const resolvedEndY =
        typeof endClientY === 'number' && Number.isFinite(endClientY) ? endClientY : g.lastY;
      const finalDeltaX = resolvedEndX - g.startX;
      const finalDeltaY = resolvedEndY - g.startY;
      const elapsedMs = Math.max(1, Date.now() - g.startTimeMs);
      const velocityX = finalDeltaX / elapsedMs;
      const velocityY = finalDeltaY / elapsedMs;
      const targetKey = g.capsuleKey;

      gestureRef.current = {
        active: false,
        inputType: null,
        identifier: null,
        capsuleKey: null,
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        startTimeMs: 0,
        isDragging: false,
      };

      applyVisualDragOffset(0, 0);

      if (targetKey) {
        setInteractionState((prev) => ({
          capsuleKey: targetKey,
          progress: prev.capsuleKey === targetKey ? prev.progress : 0,
          swipeIntent: 'none',
          isDragging: false,
          isPressing: false,
        }));
      }

      const {
        activeCapsule: currentCapsule,
        activeCapsuleKey: currentKey,
        remainingCount: currentRemaining,
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
        const absDx = Math.abs(finalDeltaX);
        const absDy = Math.abs(finalDeltaY);

        const isLeftCommit =
          (finalDeltaX <= -SWIPE_COMMIT_THRESHOLD_PX ||
            (finalDeltaX <= -SWIPE_FLICK_MIN_DISTANCE_PX &&
              velocityX <= -SWIPE_FLICK_VELOCITY_PX_PER_MS)) &&
          absDx >= absDy * 0.8;

        const isRightRecycleCommit =
          (finalDeltaX >= SWIPE_COMMIT_THRESHOLD_PX ||
            (finalDeltaX >= SWIPE_FLICK_MIN_DISTANCE_PX &&
              velocityX >= SWIPE_FLICK_VELOCITY_PX_PER_MS)) &&
          finalDeltaX >= absDy * 0.7;

        const isDownRecycleCommit =
          (finalDeltaY >= SWIPE_DOWN_COMMIT_THRESHOLD_PX ||
            (finalDeltaY >= SWIPE_FLICK_MIN_DISTANCE_PX &&
              velocityY >= SWIPE_FLICK_VELOCITY_PX_PER_MS)) &&
          finalDeltaY > absDx;

        if (isLeftCommit) {
          setLocalTrigger((prev) => prev + 1);
          if (currentRemaining > 1) {
            lastGestureExitTimeRef.current = Date.now();
            spawnExitEffect('pass', currentCapsule.capsuleColor);
          }
          void passFn();
        } else if (isRightRecycleCommit || isDownRecycleCommit) {
          setLocalTrigger((prev) => prev + 1);
          lastGestureExitTimeRef.current = Date.now();
          spawnExitEffect(
            isDownRecycleCommit && !isRightRecycleCommit ? 'recycle-down' : 'recycle-right',
            currentCapsule.capsuleColor,
          );
          void recycleFn();
        }
      }
    },
    [applyVisualDragOffset, clearLongPressTimers, spawnExitEffect],
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
      completeGesture(event.clientX, event.clientY, false);
    };

    const handleWindowPointerCancel = (event: PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active || g.inputType !== 'pointer') return;
      if (g.identifier !== null && event.pointerId !== g.identifier) return;
      completeGesture(null, null, true);
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
      lastY: clientY,
      startTimeMs: Date.now(),
      isDragging: false,
    };
    suppressNextClickRef.current = false;
    applyVisualDragOffset(0, 0);

    setInteractionState((prev) => ({
      capsuleKey: targetKey,
      progress: prev.capsuleKey === targetKey ? prev.progress : 0,
      swipeIntent: 'none',
      isDragging: false,
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
    // 右クリック（button=2）や中クリック（button=1）での長押しタイマー・ドラッグ誤発火を防止
    if (typeof event.button === 'number' && event.button > 0) {
      return;
    }
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

    completeGesture(event.clientX, event.clientY, cancelled);
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
    completeGesture(touch ? touch.clientX : null, touch ? touch.clientY : null, cancelled);
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
  const isSwipingLeft = swipeIntent === 'pass';
  const isSwipingRight = swipeIntent === 'recycle-right';
  const isSwipingDown = swipeIntent === 'recycle-down';
  const isSwipingRecycle = isSwipingRight || isSwipingDown;

  const stageShakeClass =
    crackProgress >= 3
      ? 'animate-burst-shake'
      : crackProgress === 2
        ? 'animate-crack-shake-2'
        : crackProgress === 1
          ? 'animate-crack-shake-1'
          : isPressing
            ? 'animate-charge-tremor'
            : '';

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

      {/* Stage 3（3/3 パカッ開封瞬間）のドーム閃光ホワイトゴールドフラッシュ */}
      {crackProgress >= 3 && (
        <div
          aria-hidden="true"
          data-testid="capsule-burst-flash"
          className="animate-stage-burst-flash pointer-events-none absolute inset-0 z-30 rounded-[28px] bg-[radial-gradient(circle_at_50%_48%,#FFFFFF_0%,#FEF08A_42%,rgba(255,190,11,0)_76%)]"
        />
      )}

      {/* 非ブロッキング退場ゴースト（左パス：ホッパー吸い込み / 右・下リサイクル：ゴミ箱吸引＋5コインキラキラ粒子） */}
      {exitEffect && (
        <div
          key={exitEffect.seq}
          aria-hidden="true"
          data-testid="capsule-exit-effect"
          data-exit-kind={exitEffect.kind}
          className="pointer-events-none absolute inset-0 z-25 flex items-center justify-center"
        >
          <div
            className={`relative flex h-24 w-24 flex-col overflow-hidden rounded-full border-3 border-[#1E1B18] shadow-[0_6px_14px_rgba(30,27,24,0.3)] ${
              exitEffect.kind === 'pass'
                ? 'animate-capsule-pass-suck'
                : exitEffect.kind === 'recycle-down'
                  ? 'animate-capsule-recycle-down'
                  : 'animate-capsule-recycle-right'
            }`}
          >
            <div
              className="relative h-1/2 w-full"
              style={{ background: CAPSULE_BADGE_CONFIG[exitEffect.color].ghostTopStyle }}
            >
              <span className="absolute top-2 left-3 h-3 w-5 -rotate-12 rounded-full bg-white/80 blur-[0.5px]" />
            </div>
            <div className="h-1/2 w-full border-t-2 border-[#1E1B18]/30 bg-gradient-to-b from-white/90 to-[#E2E8F0]/85" />
          </div>

          {(exitEffect.kind === 'recycle-right' || exitEffect.kind === 'recycle-down') && (
            <div
              data-testid="recycle-coin-particles"
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              {RECYCLE_COIN_PARTICLES.map((particle, idx) => (
                <span
                  key={idx}
                  style={
                    {
                      '--tx': particle.tx,
                      '--ty': particle.ty,
                      '--rot': particle.rot,
                      '--delay': particle.delay,
                    } as React.CSSProperties
                  }
                  className="animate-coin-particle absolute flex items-center justify-center"
                >
                  {particle.isCoin ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-[#1E1B18] bg-gradient-to-b from-[#FEF08A] to-[#FFBE0B] text-[#1E1B18] shadow-[0_2px_0_#1E1B18]">
                      <Coins className="h-2.5 w-2.5 stroke-[2.75]" />
                    </span>
                  ) : (
                    <Sparkles className="h-4 w-4 fill-[#FDE047] text-[#D97706]" />
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

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
          className={`animate-toy-toast-pop pointer-events-none absolute top-13 left-1/2 z-30 flex items-center gap-1.5 rounded-full border-2 border-[#1E1B18] px-3.5 py-1 text-xs font-black whitespace-nowrap shadow-[inset_0_2px_0_rgba(255,255,255,0.65),0_4px_0_#1E1B18] ${
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
          <div className="relative z-10 flex w-full shrink-0 items-center justify-between gap-1.5 px-2.5 sm:px-4 pt-0.5">
            <span
              data-testid="active-capsule-badge"
              className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2 sm:px-2.5 py-0.5 font-display text-[10px] sm:text-[11px] font-bold tracking-wide truncate ${activeBadge.bgClass}`}
            >
              <Zap className="h-3 w-3 fill-current shrink-0" aria-hidden="true" />
              <span className="truncate">{activeBadge.label}</span>
            </span>

            {/* 3段階クラックドームLEDランプ */}
            <div
              aria-label={`ヒビ割れ段階 ${crackProgress}/3`}
              data-testid="crack-progress-gauge"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-b from-[#292524] to-[#1C1917] px-2.5 py-1 border-2 border-white/85 shadow-[inset_0_2px_3px_rgba(0,0,0,0.6),0_2px_0_#1E1B18]"
            >
              {[1, 2, 3].map((step) => (
                <span
                  key={step}
                  className={`h-2.5 w-2.5 rounded-full border border-[#1E1B18] transition-all ${
                    crackProgress >= step
                      ? 'scale-110 bg-[radial-gradient(circle_at_35%_30%,#FFFBEB_0%,#FFBE0B_55%,#D97706_100%)] shadow-[0_0_8px_#FFBE0B]'
                      : 'bg-[radial-gradient(circle_at_35%_30%,#57534E_0%,#292524_100%)]'
                  }`}
                />
              ))}
              <span className="ml-0.5 font-display text-[10px] font-bold text-[#FFF8EC]">
                {crackProgress}/3
              </span>
            </div>
          </div>

          {/* スワイプドラッグ中のみ立体的に浮かび上がる左・右・下アクションインジケーター */}
          {isActivelyDragging && (
            <>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2 z-20 flex items-center justify-between"
              >
                <div
                  className={`flex items-center gap-1 rounded-2xl border-2 border-[#1E1B18] bg-gradient-to-b from-[#BAE6FD] to-[#38BDF8] px-2.5 py-1.5 text-xs font-black text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.7),0_4px_0_#1E1B18] transition-all ${
                    isSwipingLeft ? 'opacity-100 scale-105' : 'opacity-30 -translate-x-1 scale-95'
                  }`}
                >
                  <RefreshCw className="h-3.5 w-3.5 stroke-[2.75]" />
                  <span>{remainingCount > 1 ? 'パス' : '残1個'}</span>
                </div>

                <div
                  className={`flex items-center gap-1 rounded-2xl border-2 border-[#1E1B18] bg-gradient-to-b from-[#A7F3D0] to-[#34D399] px-2.5 py-1.5 text-xs font-black text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.7),0_4px_0_#1E1B18] transition-all ${
                    isSwipingRight ? 'opacity-100 scale-105' : 'opacity-30 translate-x-1 scale-95'
                  }`}
                >
                  <Trash2 className="h-3.5 w-3.5 stroke-[2.75]" />
                  <span>+5</span>
                </div>
              </div>

              {/* 下スワイプ用のゴミ箱シュート吸引インジケーター */}
              <div
                aria-hidden="true"
                data-testid="recycle-down-chute-indicator"
                className={`pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border-2 border-[#1E1B18] bg-gradient-to-b from-[#A7F3D0] to-[#10B981] px-3 py-1 text-[11px] font-black text-[#1E1B18] shadow-[inset_0_2px_0_rgba(255,255,255,0.75),0_4px_0_#1E1B18] transition-all ${
                  isSwipingDown ? 'opacity-100 scale-105' : 'opacity-0 translate-y-2 scale-90'
                }`}
              >
                <Trash2 className="h-3.5 w-3.5 stroke-[2.75]" />
                <span>ゴミ箱吸引 +5 COIN</span>
              </div>
            </>
          )}

          {/* 中央：Three.js 3Dカプセルステージ本体（邪魔な2D黒枠を廃し3D空間で統合表現） */}
          <div
            className={`relative z-10 my-auto flex min-h-0 flex-1 items-center justify-center ${stageShakeClass}`}
          >
            <button
              ref={capsuleButtonRef}
              type="button"
              onContextMenu={(e) => e.preventDefault()}
              disabled={isUpdating}
              data-testid="active-capsule-button"
              aria-label={`現在のカプセルタスク: ${activeCapsule.title}。タップ連打または1秒長押しで開封、左スワイプでパス、右または下スワイプでリサイクル`}
              className={`capsule-drag-follower group relative flex flex-col items-center justify-center rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FFBE0B] focus-visible:ring-offset-2 focus-visible:ring-offset-[#E0F2FE] cursor-grab active:cursor-grabbing touch-none select-none ${
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
                className={`capsule-3d-viewport-size pointer-events-none absolute rounded-full transition-transform duration-200 ${
                  isPressing || crackProgress > 0 ? 'scale-115' : 'scale-100'
                }`}
              />

              {/* Three.js 3Dカプセルキャンバス（3D排出バウンド・3D開口＆シャード飛散・3Dスワイプ転がり） */}
              <ThreeCapsuleCanvas
                ref={threeCanvasRef}
                capsuleKey={activeCapsuleKey}
                capsuleColor={activeCapsule.capsuleColor}
                crackProgress={crackProgress}
                interactionTrigger={combinedTrigger}
                isPressing={isPressing}
                isPaused={isPaused}
              />

              {/* 3D空間に溶け込む光の亀裂フレア＆Stage 3放射線サンバースト（2Dの黒い太線は一切描かず立体発光のみ） */}
              <svg
                viewBox="0 0 200 200"
                data-testid="capsule-crack-svg"
                data-crack-step={crackProgress}
                aria-hidden="true"
                className="capsule-3d-viewport-size pointer-events-none absolute inset-0 m-auto z-20"
              >
                <defs>
                  <radialGradient id="stage3dGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
                    <stop offset="38%" stopColor="#FEF08A" stopOpacity="0.55" />
                    <stop offset="100%" stopColor="#FFBE0B" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="lightCrackBeam" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#FFBE0B" stopOpacity="0" />
                    <stop offset="25%" stopColor="#FDE047" stopOpacity="0.92" />
                    <stop offset="50%" stopColor="#FFFFFF" stopOpacity="1" />
                    <stop offset="75%" stopColor="#FDE047" stopOpacity="0.92" />
                    <stop offset="100%" stopColor="#FFBE0B" stopOpacity="0" />
                  </linearGradient>
                </defs>

                {crackProgress >= 1 && (
                  <g data-testid="crack-layer-1">
                    <ellipse cx="100" cy="102" rx="52" ry="12" fill="url(#stage3dGlow)" />
                    <path
                      d="M 52 103 L 72 98 L 86 105 L 103 96 L 119 104 L 134 99 L 149 103"
                      fill="none"
                      stroke="#FFBE0B"
                      strokeOpacity="0.65"
                      strokeWidth="4.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M 54 103 L 72 98 L 86 105 L 103 96 L 119 104 L 134 99 L 147 103"
                      fill="none"
                      stroke="url(#lightCrackBeam)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </g>
                )}

                {crackProgress >= 2 && (
                  <g data-testid="crack-layer-2">
                    <ellipse cx="100" cy="99" rx="72" ry="22" fill="url(#stage3dGlow)" />
                    <path
                      d="M 86 104 L 76 82 L 82 67 M 103 96 L 113 76 L 108 61 M 118 104 L 128 122"
                      fill="none"
                      stroke="#FFFBEB"
                      strokeOpacity="0.92"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="72" cy="84" r="2.2" fill="#FFFFFF" />
                    <circle cx="126" cy="82" r="2.5" fill="#FEF08A" />
                    <circle cx="64" cy="112" r="1.8" fill="#FEF08A" />
                    <circle cx="136" cy="114" r="2.2" fill="#FFFFFF" />
                  </g>
                )}

                {crackProgress >= 3 && (
                  <g data-testid="crack-layer-3" className="origin-center animate-sunburst-rays">
                    <circle cx="100" cy="98" r="82" fill="url(#stage3dGlow)" />
                    {SUNBURST_RAY_ANGLES.map((deg) => (
                      <line
                        key={deg}
                        x1="100"
                        y1="98"
                        x2={100 + Math.cos((deg * Math.PI) / 180) * 92}
                        y2={98 + Math.sin((deg * Math.PI) / 180) * 92}
                        stroke="#FFFBEB"
                        strokeOpacity={deg % 60 === 0 ? '0.95' : '0.65'}
                        strokeWidth={deg % 60 === 0 ? '3.4' : '1.8'}
                        strokeLinecap="round"
                      />
                    ))}
                  </g>
                )}
              </svg>
            </button>
          </div>

          {/* 下部：立体成形のミニブック風タスク名プレート（3Dパースペクティブ連動） */}
          <div
            ref={taskSlipRef}
            className={`capsule-slip-follower toy-cream-panel relative z-10 w-full shrink-0 rounded-2xl px-3 sm:px-3.5 py-1.5 sm:py-2 ${
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
              <Hammer className="h-3.5 w-3.5 stroke-[2.5] shrink-0" aria-hidden="true" />
              <span className="truncate">
                {isSwipingLeft
                  ? '指を離すと「パス（あとで回す）」！'
                  : isSwipingRecycle
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
