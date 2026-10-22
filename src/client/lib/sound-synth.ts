import { isValidMedalRarity, type MedalRarity } from '../../shared/schemas';

/**
 * 5種のプロシージャル効果音タイプ
 * - supply: カプセル補充・コイン獲得音（ポコン＋チャリン）
 * - crack: タップ連打・ヒビ割れクラック音（パキッ）
 * - fanfare: カプセル開封＆メダル獲得ファンファーレ（レア度別和音演出）
 * - pass: スワイプ先送り音（シュッ＋ゴロン）
 * - recycle: リサイクル破棄音（キラキラ変換音）
 */
export type SoundEffectType = 'supply' | 'crack' | 'fanfare' | 'pass' | 'recycle';

/**
 * 最小限の AudioParam 互換インターフェース（単体テスト・ブラウザ両対応）
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime?(value: number, startTime: number): unknown;
  linearRampToValueAtTime?(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime?(value: number, endTime: number): unknown;
}

/**
 * 最小限の GainNode 互換インターフェース
 */
export interface GainNodeLike {
  gain: AudioParamLike;
  connect(destination: unknown): unknown;
  disconnect?(): void;
}

/**
 * 最小限の OscillatorNode 互換インターフェース
 */
export interface OscillatorNodeLike {
  type: OscillatorType;
  frequency: AudioParamLike;
  onended?: ((this: AudioScheduledSourceNode, ev: Event) => unknown) | null;
  connect(destination: unknown): unknown;
  disconnect?(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

/**
 * Web Audio API の AudioContext 互換インターフェース
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state?: AudioContextState | string;
  readonly destination: unknown;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  resume?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

/**
 * 1音分のシンセサイズノート定義
 */
export interface SynthesizedNoteDescriptor {
  /** 開始周波数 (Hz) */
  frequency: number;
  /** 終了周波数 (Hz) — ピッチベンド・スイープ用 */
  endFrequency?: number;
  /** 発音時間 (ms) */
  durationMs: number;
  /** 再生開始までのオフセット遅延 (ms) */
  delayMs?: number;
  /** オシレーター波形種別 */
  oscillatorType: OscillatorType;
  /** 最大ゲイン (0.001 〜 1.0) */
  peakGain: number;
}

/**
 * レア度（N / R / SR / SSR）ごとのファンファーレ構成音（Hz）
 * 高レア度ほど構成音数と最高音域が広がり、華やかな和音アルペジオとなる
 */
export const FANFARE_CHORD_NOTES: Record<MedalRarity, readonly number[]> = {
  N: [523.25, 659.25, 783.99], // C5 - E5 - G5（ブロンズ：軽快なメジャー3和音）
  R: [523.25, 659.25, 783.99, 1046.5], // C5 - E5 - G5 - C6（シルバー：オクターブ到達）
  SR: [523.25, 659.25, 783.99, 987.77, 1174.66, 1318.51], // C5 - E5 - G5 - B5 - D6 - E6（ゴールド：煌びやかな6音）
  SSR: [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98, 2093.0], // C5〜C7（SSRホログラム：2オクターブ祝祭ファンファーレ）
} as const;

/**
 * 効果音種別ごとの標準ハプティクス（navigator.vibrate）振動パターン（ms）
 */
export const HAPTIC_PATTERNS: Record<SoundEffectType, number | number[]> = {
  supply: [15, 30, 25],
  crack: [20],
  fanfare: [35, 35, 65],
  pass: [12, 25, 18],
  recycle: [15, 25, 15, 25, 30],
};

/**
 * レア度別の開封ファンファーレ振動パターン（ms）
 */
export const FANFARE_HAPTIC_PATTERNS: Record<MedalRarity, number[]> = {
  N: [30, 40, 60],
  R: [35, 35, 50, 35, 80],
  SR: [40, 30, 50, 30, 70, 40, 110],
  SSR: [50, 30, 60, 30, 80, 30, 140],
};

type GlobalWithWebkitAudio = typeof globalThis & {
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
};

let sharedAudioContext: AudioContextLike | null = null;

/**
 * ブラウザ環境の AudioContext シングルトンを遅延取得・初期化する。
 * 未対応環境（SSR / JSDOM / 制限環境）や初期化失敗時は例外を投げず null を返す。
 */
export function getOrCreateAudioContext(
  customFactory?: () => AudioContextLike | null,
): AudioContextLike | null {
  if (customFactory) {
    try {
      return customFactory();
    } catch {
      return null;
    }
  }

  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    return sharedAudioContext;
  }

  try {
    const scope = globalThis as GlobalWithWebkitAudio;
    const AudioContextCtor = scope.AudioContext ?? scope.webkitAudioContext;
    if (typeof AudioContextCtor !== 'function') {
      return null;
    }
    sharedAudioContext = new AudioContextCtor();
    return sharedAudioContext;
  } catch {
    sharedAudioContext = null;
    return null;
  }
}

/**
 * 共有 AudioContext シングルトンを破棄・リセットする（単体テストの分離用）
 */
export function resetSharedAudioContext(): void {
  if (sharedAudioContext && typeof sharedAudioContext.close === 'function') {
    try {
      void Promise.resolve(sharedAudioContext.close()).catch(() => undefined);
    } catch {
      // クローズ失敗は無視する
    }
  }
  sharedAudioContext = null;
}

/**
 * AudioContext が suspended または interrupted（iOS Safari 画面ロック復帰時等）の場合に安全に resume を試行する
 */
export function ensureAudioContextResumed(ctx: AudioContextLike): void {
  if (
    (ctx.state === 'suspended' || ctx.state === 'interrupted') &&
    typeof ctx.resume === 'function'
  ) {
    try {
      void Promise.resolve(ctx.resume()).catch(() => undefined);
    } catch {
      // 自動再生制限等による同期例外を無視する
    }
  }
}

/**
 * 単一ノートを OscillatorNode + GainNode でスケジュール再生する
 */
function scheduleNote(
  ctx: AudioContextLike,
  note: SynthesizedNoteDescriptor,
  baseTime: number,
): boolean {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  const startTime = Math.max(0, baseTime + (note.delayMs ?? 0) / 1000);
  const durationSec = Math.max(0.01, note.durationMs / 1000);
  const stopTime = startTime + durationSec;
  const attackTime = Math.min(startTime + 0.008, startTime + durationSec * 0.25);

  osc.type = note.oscillatorType;

  const startFreq = Math.max(20, note.frequency);
  if (typeof osc.frequency.setValueAtTime === 'function') {
    osc.frequency.setValueAtTime(startFreq, startTime);
  } else {
    osc.frequency.value = startFreq;
  }

  if (note.endFrequency !== undefined && note.endFrequency !== note.frequency) {
    const targetFreq = Math.max(20, note.endFrequency);
    if (typeof osc.frequency.exponentialRampToValueAtTime === 'function') {
      osc.frequency.exponentialRampToValueAtTime(targetFreq, stopTime);
    } else if (typeof osc.frequency.linearRampToValueAtTime === 'function') {
      osc.frequency.linearRampToValueAtTime(targetFreq, stopTime);
    } else {
      osc.frequency.value = targetFreq;
    }
  }

  const safePeakGain = Math.min(Math.max(note.peakGain, 0.001), 1.0);
  if (typeof gain.gain.setValueAtTime === 'function') {
    gain.gain.setValueAtTime(0.0001, startTime);
  } else {
    gain.gain.value = safePeakGain;
  }

  if (typeof gain.gain.linearRampToValueAtTime === 'function') {
    gain.gain.linearRampToValueAtTime(safePeakGain, attackTime);
  }

  if (typeof gain.gain.exponentialRampToValueAtTime === 'function') {
    gain.gain.exponentialRampToValueAtTime(0.0001, stopTime);
  } else if (typeof gain.gain.linearRampToValueAtTime === 'function') {
    gain.gain.linearRampToValueAtTime(0.0001, stopTime);
  }

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.onended = () => {
    try {
      osc.disconnect?.();
      gain.disconnect?.();
    } catch {
      // ノード切断時の例外は無視する
    }
  };

  try {
    osc.start(startTime);
    osc.stop(stopTime);
  } catch (error) {
    try {
      osc.disconnect?.();
      gain.disconnect?.();
    } catch {
      // ノード切断時の例外は無視する
    }
    throw error;
  }
  return true;
}

/**
 * 複数ノート列をまとめて AudioContext 上にスケジュールする
 */
function scheduleNoteSequence(
  ctx: AudioContextLike | null | undefined,
  notes: readonly SynthesizedNoteDescriptor[],
): boolean {
  const activeCtx = ctx === undefined ? getOrCreateAudioContext() : ctx;
  if (!activeCtx || notes.length === 0) {
    return false;
  }

  try {
    ensureAudioContextResumed(activeCtx);
    const baseTime =
      typeof activeCtx.currentTime === 'number' && Number.isFinite(activeCtx.currentTime)
        ? activeCtx.currentTime
        : 0;
    for (const note of notes) {
      scheduleNote(activeCtx, note, baseTime);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 1. カプセル補充・コイン獲得音（ポコン＋チャリン）を合成再生する（FR-04）
 */
export function synthesizeSupplySound(ctx?: AudioContextLike | null): boolean {
  const notes: SynthesizedNoteDescriptor[] = [
    // 「ポコン」：カプセルがドームへ弾み落ちるポップ音
    {
      delayMs: 0,
      durationMs: 75,
      frequency: 240,
      endFrequency: 540,
      oscillatorType: 'sine',
      peakGain: 0.28,
    },
    // 「チャリン（1音目 B5）」：コイン獲得チャイム
    {
      delayMs: 70,
      durationMs: 85,
      frequency: 987.77,
      oscillatorType: 'triangle',
      peakGain: 0.25,
    },
    // 「チャリン（2音目 E6）」：コイン獲得の煌びやかな余韻
    {
      delayMs: 135,
      durationMs: 210,
      frequency: 1318.51,
      oscillatorType: 'sine',
      peakGain: 0.3,
    },
    // 倍音きらめき（E7）
    {
      delayMs: 135,
      durationMs: 170,
      frequency: 2637.02,
      oscillatorType: 'triangle',
      peakGain: 0.1,
    },
  ];
  return scheduleNoteSequence(ctx, notes);
}

/**
 * 2. タップ連打・ヒビ割れクラック音（パキッ）を合成再生する（FR-10）
 * @param ctx 任意の AudioContext
 * @param step ヒビ割れ段階（1〜3）。段階が進むほどピッチが上がり開封への期待感を高める
 */
export function synthesizeCrackSound(ctx?: AudioContextLike | null, step: number = 1): boolean {
  const clampedStep = Number.isFinite(step) ? Math.min(Math.max(Math.trunc(step), 1), 3) : 1;
  const pitchFactor = 1 + (clampedStep - 1) * 0.15;

  const notes: SynthesizedNoteDescriptor[] = [
    // 「パッ」：硬質なプラスチック殻へのアタック音
    {
      delayMs: 0,
      durationMs: 45,
      frequency: Math.round(1450 * pitchFactor),
      endFrequency: Math.round(240 * pitchFactor),
      oscillatorType: 'sawtooth',
      peakGain: 0.28,
    },
    // 「キッ」：鋭いクラック高周波スナップ音
    {
      delayMs: 18,
      durationMs: 55,
      frequency: Math.round(2200 * pitchFactor),
      endFrequency: Math.round(420 * pitchFactor),
      oscillatorType: 'square',
      peakGain: 0.2,
    },
  ];
  return scheduleNoteSequence(ctx, notes);
}

/**
 * 3. カプセル開封＆メダル獲得ファンファーレ（レア度に応じた和音演出）を合成再生する（FR-10）
 * @param ctx 任意の AudioContext
 * @param rarity 獲得メダルのレア度（'N' | 'R' | 'SR' | 'SSR'）
 */
export function synthesizeFanfareSound(
  ctx?: AudioContextLike | null,
  rarity: MedalRarity = 'N',
): boolean {
  const safeRarity: MedalRarity = isValidMedalRarity(rarity) ? rarity : 'N';
  const chordFreqs = FANFARE_CHORD_NOTES[safeRarity];

  const notes: SynthesizedNoteDescriptor[] = [
    // カプセルがパカッと割れる弾け音
    {
      delayMs: 0,
      durationMs: 65,
      frequency: 320,
      endFrequency: 880,
      oscillatorType: 'triangle',
      peakGain: 0.26,
    },
  ];

  // レア度別のアルペジオ上昇ノート
  const noteStepDelayMs = safeRarity === 'SSR' ? 55 : 65;
  chordFreqs.forEach((freq, idx) => {
    const isFinalNote = idx === chordFreqs.length - 1;
    notes.push({
      delayMs: 60 + idx * noteStepDelayMs,
      durationMs: isFinalNote ? 340 : 120,
      frequency: freq,
      oscillatorType: safeRarity === 'SSR' || safeRarity === 'SR' ? 'triangle' : 'sine',
      peakGain: isFinalNote ? 0.3 : 0.24,
    });
  });

  // SR / SSR の場合は華やかな倍音コード（和音）を重ねる
  if (safeRarity === 'SR' || safeRarity === 'SSR') {
    const chordStartMs = 60 + (chordFreqs.length - 1) * noteStepDelayMs;
    const rootHarmony = chordFreqs[0];
    const fifthHarmony = chordFreqs[2];
    notes.push(
      {
        delayMs: chordStartMs,
        durationMs: 360,
        frequency: rootHarmony,
        oscillatorType: 'sine',
        peakGain: 0.16,
      },
      {
        delayMs: chordStartMs,
        durationMs: 360,
        frequency: fifthHarmony,
        oscillatorType: 'sine',
        peakGain: 0.16,
      },
    );
  }

  return scheduleNoteSequence(ctx, notes);
}

/**
 * 4. スワイプ先送り音（シュッ＋ゴロン）を合成再生する（FR-07）
 */
export function synthesizePassSound(ctx?: AudioContextLike | null): boolean {
  const notes: SynthesizedNoteDescriptor[] = [
    // 「シュッ」：カプセルを横へスワイプする風切り音
    {
      delayMs: 0,
      durationMs: 90,
      frequency: 680,
      endFrequency: 210,
      oscillatorType: 'sine',
      peakGain: 0.22,
    },
    // 「ゴロン（1バウンド目）」：筐体ホッパー内で次の玉が転がる音
    {
      delayMs: 85,
      durationMs: 80,
      frequency: 190,
      endFrequency: 135,
      oscillatorType: 'triangle',
      peakGain: 0.24,
    },
    // 「ゴロン（2バウンド目）」：排出口へ落ち着く音
    {
      delayMs: 155,
      durationMs: 95,
      frequency: 225,
      endFrequency: 150,
      oscillatorType: 'triangle',
      peakGain: 0.2,
    },
  ];
  return scheduleNoteSequence(ctx, notes);
}

/**
 * 5. リサイクル破棄音（キラキラ変換音）を合成再生する（FR-09）
 */
export function synthesizeRecycleSound(ctx?: AudioContextLike | null): boolean {
  const sparkleFrequencies = [659.25, 830.61, 987.77, 1318.51, 1661.22]; // E5 - G#5 - B5 - E6 - G#6
  const notes: SynthesizedNoteDescriptor[] = sparkleFrequencies.map((freq, idx) => ({
    delayMs: idx * 50,
    durationMs: idx === sparkleFrequencies.length - 1 ? 210 : 85,
    frequency: freq,
    oscillatorType: idx % 2 === 0 ? 'triangle' : 'sine',
    peakGain: idx === sparkleFrequencies.length - 1 ? 0.26 : 0.2,
  }));
  return scheduleNoteSequence(ctx, notes);
}

export interface SynthesizeSoundOptions {
  ctx?: AudioContextLike | null;
  crackStep?: number;
  rarity?: MedalRarity;
}

/**
 * 種別を指定して対応するプロシージャル効果音を合成再生する
 */
export function synthesizeSoundEffect(
  type: SoundEffectType,
  options: SynthesizeSoundOptions = {},
): boolean {
  switch (type) {
    case 'supply':
      return synthesizeSupplySound(options.ctx);
    case 'crack':
      return synthesizeCrackSound(options.ctx, options.crackStep);
    case 'fanfare':
      return synthesizeFanfareSound(options.ctx, options.rarity);
    case 'pass':
      return synthesizePassSound(options.ctx);
    case 'recycle':
      return synthesizeRecycleSound(options.ctx);
    default:
      return false;
  }
}

/**
 * 対応端末で navigator.vibrate を安全に呼び出す。
 * iOS Safari 等の未対応ブラウザや例外発生時はエラーを投げず false を返す。
 */
export function triggerHapticFeedback(pattern: number | number[] = 20): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
      return false;
    }
    return Boolean(navigator.vibrate(pattern));
  } catch {
    return false;
  }
}
