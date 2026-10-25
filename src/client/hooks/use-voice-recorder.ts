import { useCallback, useEffect, useRef, useState } from 'react';

export const SUPPORTED_AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/aac',
] as const;

export interface VoiceRecordingResult {
  /** Data URL プレフィックスを除いた純粋な Base64 音声文字列 */
  base64Data: string;
  /** Gemini API 送信用の正規化済み MIME タイプ（例: 'audio/webm', 'audio/mp4'） */
  mimeType: string;
  /** MediaRecorder が実際に使用した生の MIME タイプ */
  rawMimeType: string;
  /** 録音された音声 Blob */
  blob: Blob;
  /** 録音時間（ミリ秒） */
  durationMs: number;
}

export interface UseVoiceRecorderOptions {
  /** テスト用のカスタム getUserMedia 関数 */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** テスト用のカスタム MediaRecorder コンストラクタ */
  MediaRecorderClass?: typeof MediaRecorder;
}

export interface UseVoiceRecorderReturn {
  /** 現在録音中かどうか */
  isRecording: boolean;
  /** マイク権限取得・初期化中かどうか */
  isPreparing: boolean;
  /** 録音経過秒数 */
  durationSeconds: number;
  /** 選択された MIME タイプ（正規化済み） */
  mimeType: string;
  /** エラーメッセージ（マイク拒否・非対応環境など） */
  error: string | null;
  /** ブラウザが MediaRecorder & getUserMedia に対応しているか */
  isSupported: boolean;
  /** 録音を開始する（成功時 true） */
  startRecording: () => Promise<boolean>;
  /** 録音を停止し、Base64 エンコード済みの録音データを返す */
  stopRecording: () => Promise<VoiceRecordingResult | null>;
  /** 録音を破棄して停止する */
  cancelRecording: () => void;
  /** エラー表示をクリアする */
  clearError: () => void;
}

/**
 * `audio/webm` / `audio/mp4` 等の候補からブラウザがサポートする最適な MIME タイプを自動判定する
 */
export function detectSupportedAudioMimeType(
  isTypeSupportedFn?: (mimeType: string) => boolean,
): string {
  const checker =
    isTypeSupportedFn ??
    (typeof globalThis.MediaRecorder !== 'undefined' &&
    typeof globalThis.MediaRecorder.isTypeSupported === 'function'
      ? (mime: string) => globalThis.MediaRecorder.isTypeSupported(mime)
      : undefined);

  if (checker) {
    for (const candidate of SUPPORTED_AUDIO_MIME_CANDIDATES) {
      try {
        if (checker(candidate)) {
          return candidate;
        }
      } catch {
        // 一部ブラウザで未対応MIME判定時に例外が投げられるケースを無視
      }
    }
  }

  return 'audio/webm';
}

/**
 * `;codecs=...` パラメータを除去して `audio/webm` や `audio/mp4` に正規化する
 */
export function normalizeRecorderMimeType(rawMimeType?: string): string {
  if (typeof rawMimeType !== 'string' || rawMimeType.trim().length === 0) {
    return 'audio/webm';
  }
  const base = rawMimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('audio/')) {
    return base;
  }
  return 'audio/webm';
}

/**
 * 録音された `Blob` を Base64 文字列（`data:...;base64,` プレフィックスなし）へ変換する
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer === 'function') {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength === 0) {
      return '';
    }
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
      const subArray = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...subArray);
    }
    return btoa(binary);
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        resolve('');
        return;
      }
      const commaIdx = reader.result.indexOf(',');
      resolve(commaIdx !== -1 ? reader.result.slice(commaIdx + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error('音声データのBase64変換に失敗しました。'));
    reader.readAsDataURL(blob);
  });
}

export function useVoiceRecorder(options: UseVoiceRecorderOptions = {}): UseVoiceRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>(() =>
    normalizeRecorderMimeType(detectSupportedAudioMimeType()),
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeMsRef = useRef<number>(0);
  const timerIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef<boolean>(false);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const stopTimer = useCallback(() => {
    if (timerIdRef.current !== null) {
      clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
  }, []);

  const stopStreamTracks = useCallback(() => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore track stop error
        }
      }
      mediaStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopTimer();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      stopStreamTracks();
    };
  }, [stopStreamTracks, stopTimer]);

  const RecorderCtor =
    options.MediaRecorderClass ??
    (typeof globalThis.MediaRecorder !== 'undefined' ? globalThis.MediaRecorder : undefined);

  const hasGetUserMedia =
    Boolean(options.getUserMedia) ||
    (typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices) &&
      typeof navigator.mediaDevices.getUserMedia === 'function');

  const isSupported = Boolean(RecorderCtor) && hasGetUserMedia;

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const startRecording = useCallback(async (): Promise<boolean> => {
    if (isRecording || isPreparing) return false;
    setError(null);

    const ResolvedRecorder =
      optionsRef.current.MediaRecorderClass ??
      (typeof globalThis.MediaRecorder !== 'undefined' ? globalThis.MediaRecorder : undefined);

    const requestUserMedia =
      optionsRef.current.getUserMedia ??
      (typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
        ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
        : undefined);

    if (!ResolvedRecorder || !requestUserMedia) {
      setError('お使いのブラウザは音声録音（MediaRecorder API）に対応していません。');
      return false;
    }

    setIsPreparing(true);
    cancelledRef.current = false;
    chunksRef.current = [];

    try {
      const stream = await requestUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const checker =
        typeof ResolvedRecorder.isTypeSupported === 'function'
          ? (mime: string) => ResolvedRecorder.isTypeSupported(mime)
          : undefined;
      const preferredMime = detectSupportedAudioMimeType(checker);

      let recorder: MediaRecorder;
      try {
        recorder = new ResolvedRecorder(stream, { mimeType: preferredMime });
      } catch {
        recorder = new ResolvedRecorder(stream);
      }

      const activeMime = normalizeRecorderMimeType(recorder.mimeType || preferredMime);
      setMimeType(activeMime);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current = recorder;
      startTimeMsRef.current = Date.now();
      setDurationSeconds(0);

      recorder.start();
      setIsRecording(true);
      setIsPreparing(false);

      stopTimer();
      timerIdRef.current = setInterval(() => {
        const elapsedSec = Math.max(0, Math.floor((Date.now() - startTimeMsRef.current) / 1000));
        setDurationSeconds(elapsedSec);
      }, 250);

      return true;
    } catch {
      stopStreamTracks();
      setIsPreparing(false);
      setIsRecording(false);
      setError('マイクへのアクセスが許可されていないか、録音を開始できませんでした。');
      return false;
    }
  }, [isPreparing, isRecording, stopStreamTracks, stopTimer]);

  const stopRecording = useCallback(async (): Promise<VoiceRecordingResult | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      stopTimer();
      stopStreamTracks();
      setIsRecording(false);
      return null;
    }

    stopTimer();

    return new Promise<VoiceRecordingResult | null>((resolve) => {
      const finishRecording = async () => {
        const durationMs = Math.max(0, Date.now() - startTimeMsRef.current);
        const rawMimeType = recorder.mimeType || detectSupportedAudioMimeType() || 'audio/webm';
        const normalizedMime = normalizeRecorderMimeType(rawMimeType);
        const collectedChunks = [...chunksRef.current];
        chunksRef.current = [];
        mediaRecorderRef.current = null;
        stopStreamTracks();
        setIsRecording(false);
        setDurationSeconds(0);

        if (cancelledRef.current) {
          resolve(null);
          return;
        }

        const blob = new Blob(collectedChunks, { type: rawMimeType });
        try {
          const base64Data = await blobToBase64(blob);
          if (!base64Data) {
            setError('録音データが空でした。もう一度マイクに向かって話してください。');
            resolve(null);
            return;
          }
          resolve({
            base64Data,
            mimeType: normalizedMime,
            rawMimeType,
            blob,
            durationMs,
          });
        } catch {
          setError('録音データの変換に失敗しました。');
          resolve(null);
        }
      };

      recorder.onstop = () => {
        void finishRecording();
      };

      try {
        recorder.stop();
      } catch {
        void finishRecording();
      }
    });
  }, [stopStreamTracks, stopTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    stopTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    chunksRef.current = [];
    mediaRecorderRef.current = null;
    stopStreamTracks();
    setIsRecording(false);
    setIsPreparing(false);
    setDurationSeconds(0);
  }, [stopStreamTracks, stopTimer]);

  return {
    isRecording,
    isPreparing,
    durationSeconds,
    mimeType,
    error,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
    clearError,
  };
}
