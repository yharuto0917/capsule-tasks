import { useCallback, useLayoutEffect, useRef } from 'react';
import { isValidMedalRarity, type MedalRarity } from '../../shared/schemas';
import {
  FANFARE_HAPTIC_PATTERNS,
  HAPTIC_PATTERNS,
  ensureAudioContextResumed,
  getOrCreateAudioContext,
  setSoundMasterMuted,
  synthesizeCrackSound,
  synthesizeFanfareSound,
  synthesizePassSound,
  synthesizeRecycleSound,
  synthesizeSupplySound,
  triggerHapticFeedback,
  type AudioContextLike,
  type SoundEffectType,
} from '../lib/sound-synth';

export interface UseSoundEffectOptions {
  /** PlayerState.soundEnabled と連動するミュート制御フラグ（デフォルト: true） */
  soundEnabled?: boolean;
  /** 触覚フィードバック（navigator.vibrate）の有効フラグ（デフォルト: true） */
  hapticsEnabled?: boolean;
  /** 単体テスト等でのカスタム AudioContext 生成ファクトリ */
  createAudioContext?: () => AudioContextLike | null;
}

export interface PlaySoundOptions {
  /** タップ連打・ヒビ割れ段階（1〜3） */
  crackStep?: number;
  /** 開封ファンファーレのメダルレア度（'N' | 'R' | 'SR' | 'SSR'） */
  rarity?: MedalRarity;
}

export interface UseSoundEffectReturn {
  /** 現在サウンド出力が有効かどうか */
  soundEnabled: boolean;
  /** 現在触覚フィードバックが有効かどうか */
  hapticsEnabled: boolean;
  /** 1. カプセル補充・コイン獲得音（ポコン＋チャリン）＆触覚フィードバック（FR-04） */
  playSupply: () => boolean;
  /** 2. タップ連打・ヒビ割れクラック音（パキッ）＆触覚フィードバック（FR-10） */
  playCrack: (step?: number) => boolean;
  /** 3. カプセル開封＆メダル獲得ファンファーレ（レア度別和音演出）＆祝祭振動（FR-10） */
  playFanfare: (rarity?: MedalRarity) => boolean;
  /** 3のエイリアス：カプセル開封＆メダル獲得ファンファーレ */
  playOpenFanfare: (rarity?: MedalRarity) => boolean;
  /** 4. スワイプ先送り音（シュッ＋ゴロン）＆触覚フィードバック（FR-07） */
  playPass: () => boolean;
  /** 5. リサイクル破棄音（キラキラ変換音）＆触覚フィードバック（FR-09） */
  playRecycle: () => boolean;
  /** 効果音種別を指定して再生する汎用トリガー */
  playSound: (type: SoundEffectType, options?: PlaySoundOptions) => boolean;
  /** 任意のパターンで触覚フィードバックのみを発火する */
  vibrate: (pattern?: number | number[]) => boolean;
  /**
   * ユーザー操作イベント内で同期的に AudioContext を初期化・resume するためのヘルパー。
   * soundEnabled: false の場合は何もしない。
   */
  unlockAudio: () => boolean;
}

/**
 * Web Audio API シンセサイザー効果音（外部ファイル通信ゼロ）と
 * navigator.vibrate 触覚フィードバックを統合制御するカスタムフック。
 *
 * @param optionsOrSoundEnabled `PlayerState.soundEnabled` の真偽値、または詳細オプションオブジェクト
 */
export function useSoundEffect(
  optionsOrSoundEnabled: boolean | UseSoundEffectOptions = true,
): UseSoundEffectReturn {
  const normalizedOptions: UseSoundEffectOptions =
    typeof optionsOrSoundEnabled === 'boolean'
      ? { soundEnabled: optionsOrSoundEnabled }
      : optionsOrSoundEnabled;

  const soundEnabled = normalizedOptions.soundEnabled ?? true;
  const hapticsEnabled = normalizedOptions.hapticsEnabled ?? true;
  const customFactory = normalizedOptions.createAudioContext;

  const soundEnabledRef = useRef<boolean>(soundEnabled);
  const hapticsEnabledRef = useRef<boolean>(hapticsEnabled);
  const customFactoryRef = useRef<(() => AudioContextLike | null) | undefined>(customFactory);
  const customCtxRef = useRef<AudioContextLike | null>(null);

  // Web Locks 待機中に別タブの storage イベント等で soundEnabled が OFF に切り替わった場合でも、
  // 待機開始前に捕捉された古い再生コールバックが最新のミュート状態を参照できるよう ref を同期更新し、
  // 既に予約済みのファンファーレ等も共通マスター GainNode のゲイン 0 化で即座に消音する。
  useLayoutEffect(() => {
    soundEnabledRef.current = soundEnabled;
    hapticsEnabledRef.current = hapticsEnabled;
    customFactoryRef.current = customFactory;
    setSoundMasterMuted(!soundEnabled, customCtxRef.current);
  }, [soundEnabled, hapticsEnabled, customFactory]);

  const resolveAudioContext = useCallback((): AudioContextLike | null => {
    const factory = customFactoryRef.current;
    if (factory) {
      if (customCtxRef.current && customCtxRef.current.state !== 'closed') {
        return customCtxRef.current;
      }
      customCtxRef.current = getOrCreateAudioContext(factory);
      return customCtxRef.current;
    }
    return getOrCreateAudioContext();
  }, []);

  const vibrate = useCallback((pattern: number | number[] = 20): boolean => {
    if (!hapticsEnabledRef.current) {
      return false;
    }
    return triggerHapticFeedback(pattern);
  }, []);

  const unlockAudio = useCallback((): boolean => {
    if (!soundEnabledRef.current) {
      return false;
    }
    const ctx = resolveAudioContext();
    if (!ctx) {
      return false;
    }
    setSoundMasterMuted(false, ctx);
    ensureAudioContextResumed(ctx);
    return true;
  }, [resolveAudioContext]);

  const playSupply = useCallback((): boolean => {
    if (!soundEnabledRef.current) {
      setSoundMasterMuted(true, customCtxRef.current);
      return false;
    }
    vibrate(HAPTIC_PATTERNS.supply);
    const ctx = resolveAudioContext();
    setSoundMasterMuted(false, ctx);
    return synthesizeSupplySound(ctx);
  }, [resolveAudioContext, vibrate]);

  const playCrack = useCallback(
    (step: number = 1): boolean => {
      if (!soundEnabledRef.current) {
        setSoundMasterMuted(true, customCtxRef.current);
        return false;
      }
      const clampedStep = Number.isFinite(step) ? Math.min(Math.max(Math.trunc(step), 1), 3) : 1;
      const crackVibration = clampedStep === 1 ? HAPTIC_PATTERNS.crack : [15 + clampedStep * 6];
      vibrate(crackVibration);
      const ctx = resolveAudioContext();
      setSoundMasterMuted(false, ctx);
      return synthesizeCrackSound(ctx, clampedStep);
    },
    [resolveAudioContext, vibrate],
  );

  const playFanfare = useCallback(
    (rarity: MedalRarity = 'N'): boolean => {
      if (!soundEnabledRef.current) {
        setSoundMasterMuted(true, customCtxRef.current);
        return false;
      }
      const safeRarity: MedalRarity = isValidMedalRarity(rarity) ? rarity : 'N';
      vibrate(FANFARE_HAPTIC_PATTERNS[safeRarity]);
      const ctx = resolveAudioContext();
      setSoundMasterMuted(false, ctx);
      return synthesizeFanfareSound(ctx, safeRarity);
    },
    [resolveAudioContext, vibrate],
  );

  const playPass = useCallback((): boolean => {
    if (!soundEnabledRef.current) {
      setSoundMasterMuted(true, customCtxRef.current);
      return false;
    }
    vibrate(HAPTIC_PATTERNS.pass);
    const ctx = resolveAudioContext();
    setSoundMasterMuted(false, ctx);
    return synthesizePassSound(ctx);
  }, [resolveAudioContext, vibrate]);

  const playRecycle = useCallback((): boolean => {
    if (!soundEnabledRef.current) {
      setSoundMasterMuted(true, customCtxRef.current);
      return false;
    }
    vibrate(HAPTIC_PATTERNS.recycle);
    const ctx = resolveAudioContext();
    setSoundMasterMuted(false, ctx);
    return synthesizeRecycleSound(ctx);
  }, [resolveAudioContext, vibrate]);

  const playSound = useCallback(
    (type: SoundEffectType, options: PlaySoundOptions = {}): boolean => {
      switch (type) {
        case 'supply':
          return playSupply();
        case 'crack':
          return playCrack(options.crackStep);
        case 'fanfare':
          return playFanfare(options.rarity);
        case 'pass':
          return playPass();
        case 'recycle':
          return playRecycle();
        default:
          return false;
      }
    },
    [playCrack, playFanfare, playPass, playRecycle, playSupply],
  );

  return {
    soundEnabled,
    hapticsEnabled,
    playSupply,
    playCrack,
    playFanfare,
    playOpenFanfare: playFanfare,
    playPass,
    playRecycle,
    playSound,
    vibrate,
    unlockAudio,
  };
}
