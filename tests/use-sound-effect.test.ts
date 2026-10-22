import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSoundEffect } from '../src/client/hooks/use-sound-effect';
import {
  FANFARE_CHORD_NOTES,
  FANFARE_HAPTIC_PATTERNS,
  HAPTIC_PATTERNS,
  resetSharedAudioContext,
  synthesizeCrackSound,
  synthesizeFanfareSound,
  synthesizePassSound,
  synthesizeRecycleSound,
  synthesizeSupplySound,
  triggerHapticFeedback,
  type AudioContextLike,
  type GainNodeLike,
  type OscillatorNodeLike,
} from '../src/client/lib/sound-synth';

interface RecordedOscillator extends OscillatorNodeLike {
  scheduledFreqs: number[];
  rampedFreqs: number[];
  startedAt: number[];
  stoppedAt: number[];
  disconnected: boolean;
}

interface RecordedGain extends GainNodeLike {
  disconnected: boolean;
}

function createMockAudioContext(initialState: AudioContextState = 'running') {
  const oscillators: RecordedOscillator[] = [];
  const gains: RecordedGain[] = [];
  const destination = { id: 'mock-destination' };

  const resumeMock = vi.fn(() => Promise.resolve());
  const closeMock = vi.fn(() => Promise.resolve());

  const ctx: AudioContextLike & {
    oscillators: RecordedOscillator[];
    gains: RecordedGain[];
    resumeMock: typeof resumeMock;
    closeMock: typeof closeMock;
  } = {
    currentTime: 1.0,
    state: initialState,
    destination,
    oscillators,
    gains,
    resumeMock,
    closeMock,
    resume: resumeMock,
    close: closeMock,
    createOscillator: vi.fn(() => {
      const scheduledFreqs: number[] = [];
      const rampedFreqs: number[] = [];
      const startedAt: number[] = [];
      const stoppedAt: number[] = [];
      const osc: RecordedOscillator = {
        type: 'sine',
        scheduledFreqs,
        rampedFreqs,
        startedAt,
        stoppedAt,
        disconnected: false,
        onended: null,
        frequency: {
          value: 440,
          setValueAtTime: vi.fn((val: number) => {
            scheduledFreqs.push(val);
          }),
          exponentialRampToValueAtTime: vi.fn((val: number) => {
            rampedFreqs.push(val);
          }),
          linearRampToValueAtTime: vi.fn((val: number) => {
            rampedFreqs.push(val);
          }),
        },
        connect: vi.fn(),
        disconnect: vi.fn(() => {
          osc.disconnected = true;
        }),
        start: vi.fn((when = 0) => {
          startedAt.push(when);
        }),
        stop: vi.fn((when = 0) => {
          stoppedAt.push(when);
        }),
      };
      oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn(() => {
      const gain: RecordedGain = {
        disconnected: false,
        gain: {
          value: 1,
          setValueAtTime: vi.fn((val: number) => {
            gain.gain.value = val;
          }),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(() => {
          gain.disconnected = true;
        }),
      };
      gains.push(gain);
      return gain;
    }),
  };

  return ctx;
}

describe('sound-synth (Web Audio API プロシージャル効果音合成)', () => {
  beforeEach(() => {
    resetSharedAudioContext();
  });

  afterEach(() => {
    resetSharedAudioContext();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'AudioContext');
    Reflect.deleteProperty(globalThis, 'webkitAudioContext');
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  it('外部音声ファイルのネットワーク読み込みを行わず、全5種の効果音を OscillatorNode + GainNode で合成する', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mockCtx = createMockAudioContext();

    expect(synthesizeSupplySound(mockCtx)).toBe(true);
    const afterSupplyCount = mockCtx.oscillators.length;
    expect(afterSupplyCount).toBeGreaterThanOrEqual(3);

    expect(synthesizeCrackSound(mockCtx, 1)).toBe(true);
    const afterCrackCount = mockCtx.oscillators.length;
    expect(afterCrackCount).toBeGreaterThan(afterSupplyCount);

    expect(synthesizeFanfareSound(mockCtx, 'N')).toBe(true);
    const afterFanfareCount = mockCtx.oscillators.length;
    expect(afterFanfareCount).toBeGreaterThan(afterCrackCount);

    expect(synthesizePassSound(mockCtx)).toBe(true);
    const afterPassCount = mockCtx.oscillators.length;
    expect(afterPassCount).toBeGreaterThan(afterFanfareCount);

    expect(synthesizeRecycleSound(mockCtx)).toBe(true);
    const afterRecycleCount = mockCtx.oscillators.length;
    expect(afterRecycleCount).toBeGreaterThan(afterPassCount);

    // すべてのオシレーターがノート別 GainNode → 共通マスター GainNode → destination の順に接続され、start/stop が呼ばれていること
    const masterGain = mockCtx.gains[0];
    expect(masterGain.connect).toHaveBeenCalledWith(mockCtx.destination);
    for (const osc of mockCtx.oscillators) {
      expect(osc.connect).toHaveBeenCalledTimes(1);
      expect(osc.startedAt).toHaveLength(1);
      expect(osc.stoppedAt).toHaveLength(1);
      expect(osc.stoppedAt[0]).toBeGreaterThan(osc.startedAt[0]);
    }
    for (const noteGain of mockCtx.gains.slice(1)) {
      expect(noteGain.connect).toHaveBeenCalledWith(masterGain);
    }

    // ネットワークリクエストが一切発生していないこと
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ヒビ割れクラック音は段階（step 1 → 2 → 3）に応じてピッチが段階的に上昇する', () => {
    const ctx1 = createMockAudioContext();
    const ctx2 = createMockAudioContext();
    const ctx3 = createMockAudioContext();

    synthesizeCrackSound(ctx1, 1);
    synthesizeCrackSound(ctx2, 2);
    synthesizeCrackSound(ctx3, 3);

    const freqStep1 = ctx1.oscillators[0].scheduledFreqs[0];
    const freqStep2 = ctx2.oscillators[0].scheduledFreqs[0];
    const freqStep3 = ctx3.oscillators[0].scheduledFreqs[0];

    expect(freqStep1).toBeLessThan(freqStep2);
    expect(freqStep2).toBeLessThan(freqStep3);
  });

  it('開封ファンファーレはレア度（N / R / SR / SSR）に応じて構成音数と最高周波数が豪華になる', () => {
    const ctxN = createMockAudioContext();
    const ctxR = createMockAudioContext();
    const ctxSR = createMockAudioContext();
    const ctxSSR = createMockAudioContext();

    synthesizeFanfareSound(ctxN, 'N');
    synthesizeFanfareSound(ctxR, 'R');
    synthesizeFanfareSound(ctxSR, 'SR');
    synthesizeFanfareSound(ctxSSR, 'SSR');

    expect(ctxN.oscillators.length).toBeLessThan(ctxR.oscillators.length);
    expect(ctxR.oscillators.length).toBeLessThan(ctxSR.oscillators.length);
    expect(ctxSR.oscillators.length).toBeLessThan(ctxSSR.oscillators.length);

    const maxFreq = (ctx: ReturnType<typeof createMockAudioContext>) =>
      Math.max(...ctx.oscillators.flatMap((o) => o.scheduledFreqs));

    expect(maxFreq(ctxN)).toBeLessThan(maxFreq(ctxR));
    expect(maxFreq(ctxR)).toBeLessThan(maxFreq(ctxSR));
    expect(maxFreq(ctxSR)).toBeLessThan(maxFreq(ctxSSR));
    expect(maxFreq(ctxSSR)).toBeCloseTo(
      FANFARE_CHORD_NOTES.SSR[FANFARE_CHORD_NOTES.SSR.length - 1],
      1,
    );
  });

  it('オシレーター終了時（onended）に OscillatorNode とノート用 GainNode が disconnect されメモリリークを防ぐ（共通マスター GainNode は維持）', () => {
    const mockCtx = createMockAudioContext();
    synthesizeSupplySound(mockCtx);

    const masterGain = mockCtx.gains[0];
    const firstOsc = mockCtx.oscillators[0];
    const firstNoteGain = mockCtx.gains[1];
    expect(firstOsc.disconnected).toBe(false);
    expect(firstNoteGain.disconnected).toBe(false);

    firstOsc.onended?.call(firstOsc as unknown as AudioScheduledSourceNode, new Event('ended'));
    expect(firstOsc.disconnected).toBe(true);
    expect(firstNoteGain.disconnected).toBe(true);
    expect(masterGain.disconnected).toBe(false);
  });

  it('AudioContext が suspended 状態の場合は再生時に resume() を呼び出し、resume が失敗しても例外を投げない', () => {
    const suspendedCtx = createMockAudioContext('suspended');
    suspendedCtx.resume = vi.fn(() => Promise.reject(new Error('Autoplay blocked')));

    expect(() => synthesizeSupplySound(suspendedCtx)).not.toThrow();
    expect(suspendedCtx.resume).toHaveBeenCalledTimes(1);
    expect(suspendedCtx.oscillators.length).toBeGreaterThan(0);
  });
});

describe('useSoundEffect フック（ミュート制御・ハプティクス・フォールバック検証）', () => {
  beforeEach(() => {
    resetSharedAudioContext();
  });

  afterEach(() => {
    resetSharedAudioContext();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'AudioContext');
    Reflect.deleteProperty(globalThis, 'webkitAudioContext');
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  it('soundEnabled: true のとき全5種の効果音再生と navigator.vibrate が連携して動作する', () => {
    const mockCtx = createMockAudioContext();
    const vibrateMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: vibrateMock,
    });

    const { result } = renderHook(() =>
      useSoundEffect({
        soundEnabled: true,
        createAudioContext: () => mockCtx,
      }),
    );

    expect(result.current.playSupply()).toBe(true);
    expect(vibrateMock).toHaveBeenLastCalledWith(HAPTIC_PATTERNS.supply);

    expect(result.current.playCrack(2)).toBe(true);
    expect(vibrateMock).toHaveBeenLastCalledWith([27]);

    expect(result.current.playOpenFanfare('SSR')).toBe(true);
    expect(vibrateMock).toHaveBeenLastCalledWith(FANFARE_HAPTIC_PATTERNS.SSR);

    expect(result.current.playPass()).toBe(true);
    expect(vibrateMock).toHaveBeenLastCalledWith(HAPTIC_PATTERNS.pass);

    expect(result.current.playRecycle()).toBe(true);
    expect(vibrateMock).toHaveBeenLastCalledWith(HAPTIC_PATTERNS.recycle);

    expect(mockCtx.oscillators.length).toBeGreaterThanOrEqual(18);
  });

  it('soundEnabled: false の場合は音声が一切鳴らず、AudioContext の初期化も行われない', () => {
    const createCtxSpy = vi.fn(() => createMockAudioContext());
    const globalAudioCtorSpy = vi.fn(() => createMockAudioContext());
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: globalAudioCtorSpy,
    });

    const { result } = renderHook(() =>
      useSoundEffect({
        soundEnabled: false,
        createAudioContext: createCtxSpy,
      }),
    );

    expect(result.current.unlockAudio()).toBe(false);
    expect(result.current.playSupply()).toBe(false);
    expect(result.current.playCrack(1)).toBe(false);
    expect(result.current.playFanfare('SR')).toBe(false);
    expect(result.current.playPass()).toBe(false);
    expect(result.current.playRecycle()).toBe(false);
    expect(result.current.playSound('supply')).toBe(false);

    expect(createCtxSpy).not.toHaveBeenCalled();
    expect(globalAudioCtorSpy).not.toHaveBeenCalled();
  });

  it('PlayerState.soundEnabled の切り替え（true ⇄ false）にリアルタイム連動してミュート制御される', () => {
    const mockCtx = createMockAudioContext();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSoundEffect({
          soundEnabled: enabled,
          createAudioContext: () => mockCtx,
        }),
      { initialProps: { enabled: false } },
    );

    // 初期状態（ミュート）では鳴らない
    expect(result.current.playSupply()).toBe(false);
    expect(mockCtx.oscillators).toHaveLength(0);

    // サウンド ON に切り替え
    rerender({ enabled: true });
    expect(result.current.soundEnabled).toBe(true);
    expect(result.current.playSupply()).toBe(true);
    const countAfterEnable = mockCtx.oscillators.length;
    expect(countAfterEnable).toBeGreaterThan(0);

    // 再びサウンド OFF に切り替え
    rerender({ enabled: false });
    expect(result.current.soundEnabled).toBe(false);
    expect(result.current.playCrack(1)).toBe(false);
    expect(mockCtx.oscillators).toHaveLength(countAfterEnable);
  });

  it('ファンファーレ再生直後にミュートへ切り替えた場合、共通マスター GainNode のゲインが即座に 0 になり予約済みノートが鳴り続けない', () => {
    const mockCtx = createMockAudioContext();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSoundEffect({
          soundEnabled: enabled,
          createAudioContext: () => mockCtx,
        }),
      { initialProps: { enabled: true } },
    );

    // 最大約750ms先までノートが予約されるSSRファンファーレを開始
    expect(result.current.playFanfare('SSR')).toBe(true);
    const masterGain = mockCtx.gains[0];
    expect(masterGain.gain.value).toBe(1);

    // 再生途中にミュートへ切り替え → 共通マスター GainNode のゲインが即座に 0 になること
    rerender({ enabled: false });
    expect(masterGain.gain.cancelScheduledValues).toHaveBeenCalledWith(mockCtx.currentTime);
    expect(masterGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, mockCtx.currentTime);
    expect(masterGain.gain.value).toBe(0);

    // 再度 ON に戻すとマスターゲインが 1 に復帰すること
    rerender({ enabled: true });
    expect(masterGain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, mockCtx.currentTime);
    expect(masterGain.gain.value).toBe(1);
  });

  it('Web Locks 待機中などに別タブで OFF に切り替わった場合でも、待機前に保持された古い再生コールバックが ref から最新の soundEnabled を参照して再生しない', () => {
    const mockCtx = createMockAudioContext();
    const vibrateMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: vibrateMock,
    });

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSoundEffect({
          soundEnabled: enabled,
          createAudioContext: () => mockCtx,
        }),
      { initialProps: { enabled: true } },
    );

    // 非同期ロック待機前に呼び出し元が保持していた関数参照をシミュレート
    const stalePlaySupply = result.current.playSupply;
    const stalePlayCrack = result.current.playCrack;
    const stalePlayFanfare = result.current.playFanfare;
    const stalePlayPass = result.current.playPass;
    const stalePlayRecycle = result.current.playRecycle;
    const stalePlaySound = result.current.playSound;
    const staleUnlockAudio = result.current.unlockAudio;

    // 待機中に別タブでミュートされ再レンダーが発生
    rerender({ enabled: false });

    // 古い関数参照をそのまま呼び出しても、ref 経由で最新の false を参照し一切再生・振動しないこと
    expect(staleUnlockAudio()).toBe(false);
    expect(stalePlaySupply()).toBe(false);
    expect(stalePlayCrack(2)).toBe(false);
    expect(stalePlayFanfare('SSR')).toBe(false);
    expect(stalePlayPass()).toBe(false);
    expect(stalePlayRecycle()).toBe(false);
    expect(stalePlaySound('supply')).toBe(false);

    expect(mockCtx.oscillators).toHaveLength(0);
    expect(vibrateMock).not.toHaveBeenCalled();
  });

  it('AudioContext 未対応環境や navigator.vibrate 未対応環境（iOS Safari 等）でも例外が発生しない', () => {
    Reflect.deleteProperty(globalThis, 'AudioContext');
    Reflect.deleteProperty(globalThis, 'webkitAudioContext');
    Reflect.deleteProperty(navigator, 'vibrate');

    const { result } = renderHook(() => useSoundEffect(true));

    expect(() => {
      expect(result.current.unlockAudio()).toBe(false);
      expect(result.current.playSupply()).toBe(false);
      expect(result.current.playCrack(3)).toBe(false);
      expect(result.current.playFanfare('R')).toBe(false);
      expect(result.current.playPass()).toBe(false);
      expect(result.current.playRecycle()).toBe(false);
      expect(result.current.vibrate([20, 40])).toBe(false);
    }).not.toThrow();
  });

  it('AudioContext コンストラクタや navigator.vibrate が例外を投げた場合でも安全にフォールバックする', () => {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: vi.fn(function ThrowingAudioContext() {
        throw new DOMException('NotAllowedError');
      }),
    });
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('Vibration blocked');
      }),
    });

    const { result } = renderHook(() => useSoundEffect(true));

    expect(() => {
      expect(result.current.playSupply()).toBe(false);
      expect(triggerHapticFeedback(30)).toBe(false);
    }).not.toThrow();
  });

  it('標準 AudioContext がなく webkitAudioContext のみ存在する環境でもフォールバックして再生できる', () => {
    const mockCtx = createMockAudioContext();
    Reflect.deleteProperty(globalThis, 'AudioContext');
    Object.defineProperty(globalThis, 'webkitAudioContext', {
      configurable: true,
      value: function MockWebkitAudioContext() {
        return mockCtx;
      },
    });

    const { result } = renderHook(() => useSoundEffect(true));

    act(() => {
      expect(result.current.playSound('recycle')).toBe(true);
    });
    expect(mockCtx.oscillators.length).toBe(5);
  });
});
