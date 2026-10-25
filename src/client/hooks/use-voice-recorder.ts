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

interface RecordingSession {
  /** 録音開始試行ごとの一意な世代番号 */
  id: number;
  recorder: MediaRecorder;
  stream: MediaStream;
  /** この録音セッション専用の音声チャンク配列 */
  chunks: Blob[];
  startTimeMs: number;
  cancelled: boolean;
}

export function useVoiceRecorder(options: UseVoiceRecorderOptions = {}): UseVoiceRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>(() =>
    normalizeRecorderMimeType(detectSupportedAudioMimeType()),
  );

  const sessionRef = useRef<RecordingSession | null>(null);
  const timerIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 録音開始試行の世代カウンタ。新規開始・キャンセル・アンマウントで加算し、旧世代の処理や遅延イベントを無効化する */
  const startAttemptRef = useRef<number>(0);
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

  const stopStream = useCallback((stream: MediaStream | null | undefined) => {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore track stop error
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      // アンマウント時点で進行中の開始処理（getUserMedia 待ち）および旧セッションのイベントを無効化する
      startAttemptRef.current += 1;
      stopTimer();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        session.cancelled = true;
        session.chunks = [];
        if (session.recorder.state !== 'inactive') {
          try {
            session.recorder.stop();
          } catch {
            // ignore
          }
        }
        stopStream(session.stream);
      }
    };
  }, [stopStream, stopTimer]);

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
    const sessionId = ++startAttemptRef.current;
    let acquiredStream: MediaStream | null = null;

    try {
      const stream = await requestUserMedia({ audio: true });
      acquiredStream = stream;

      if (sessionId !== startAttemptRef.current) {
        // 権限ダイアログ表示中にシートが閉じられた／キャンセルされた場合は、
        // 取得したストリームを即座に停止し、非表示のまま録音を開始しない
        stopStream(stream);
        return false;
      }

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

      const session: RecordingSession = {
        id: sessionId,
        recorder,
        stream,
        chunks: [],
        startTimeMs: Date.now(),
        cancelled: false,
      };
      sessionRef.current = session;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (
          session.cancelled ||
          session.id !== startAttemptRef.current ||
          sessionRef.current !== session
        ) {
          return;
        }
        if (event.data && event.data.size > 0) {
          session.chunks.push(event.data);
        }
      };

      setDurationSeconds(0);

      recorder.start();
      setIsRecording(true);
      setIsPreparing(false);

      stopTimer();
      timerIdRef.current = setInterval(() => {
        if (
          session.cancelled ||
          session.id !== startAttemptRef.current ||
          sessionRef.current !== session
        ) {
          return;
        }
        const elapsedSec = Math.max(0, Math.floor((Date.now() - session.startTimeMs) / 1000));
        setDurationSeconds(elapsedSec);
      }, 250);

      return true;
    } catch {
      stopStream(acquiredStream);
      if (sessionRef.current?.id === sessionId) {
        sessionRef.current = null;
      }
      if (sessionId !== startAttemptRef.current) {
        return false;
      }
      stopTimer();
      setIsPreparing(false);
      setIsRecording(false);
      setError('マイクへのアクセスが許可されていないか、録音を開始できませんでした。');
      return false;
    }
  }, [isPreparing, isRecording, stopStream, stopTimer]);

  const stopRecording = useCallback(async (): Promise<VoiceRecordingResult | null> => {
    const session = sessionRef.current;
    if (!session || session.recorder.state === 'inactive') {
      startAttemptRef.current += 1;
      stopTimer();
      if (session) {
        session.cancelled = true;
        session.chunks = [];
        sessionRef.current = null;
        stopStream(session.stream);
      }
      setIsPreparing(false);
      setIsRecording(false);
      return null;
    }

    stopTimer();
    const { recorder } = session;

    return new Promise<VoiceRecordingResult | null>((resolve) => {
      let settled = false;

      const finishRecording = async () => {
        if (settled) return;
        settled = true;

        const isCurrentSession =
          !session.cancelled &&
          session.id === startAttemptRef.current &&
          sessionRef.current === session;

        const durationMs = Math.max(0, Date.now() - session.startTimeMs);
        const rawMimeType = recorder.mimeType || detectSupportedAudioMimeType() || 'audio/webm';
        const normalizedMime = normalizeRecorderMimeType(rawMimeType);
        const collectedChunks = [...session.chunks];

        session.cancelled = true;
        session.chunks = [];
        stopStream(session.stream);

        if (sessionRef.current === session) {
          sessionRef.current = null;
        }

        if (!isCurrentSession) {
          resolve(null);
          return;
        }

        setIsRecording(false);
        setDurationSeconds(0);

        const blob = new Blob(collectedChunks, { type: rawMimeType });
        try {
          const base64Data = await blobToBase64(blob);
          if (session.id !== startAttemptRef.current) {
            resolve(null);
            return;
          }
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
          if (session.id === startAttemptRef.current) {
            setError('録音データの変換に失敗しました。');
          }
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
  }, [stopStream, stopTimer]);

  const cancelRecording = useCallback(() => {
    // 進行中の開始処理（getUserMedia 待ち）および現セッションの遅延イベントを無効化する
    startAttemptRef.current += 1;
    stopTimer();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      session.cancelled = true;
      session.chunks = [];
      if (session.recorder.state !== 'inactive') {
        try {
          session.recorder.stop();
        } catch {
          // ignore
        }
      }
      stopStream(session.stream);
    }
    setIsRecording(false);
    setIsPreparing(false);
    setDurationSeconds(0);
  }, [stopStream, stopTimer]);

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
