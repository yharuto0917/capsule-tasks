import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Award, PlusCircle, RefreshCw, Timer, Trash2 } from 'lucide-react';
import { CapsuleMachineVisual } from './components/capsule-machine-visual';
import { CapsuleStage, type StageToastNotification } from './components/capsule-stage';
import { HeaderStatusBar } from './components/header-status-bar';
import { MedalCollectionDrawer } from './components/medal-collection-drawer';
import { MedalRevealModal } from './components/medal-reveal-modal';
import { TaskSupplySheet } from './components/task-supply-sheet';
import { SUPPLY_BONUS_COINS_PER_CAPSULE, useCapsuleStore } from './hooks/use-capsule-store';
import { useMedalStorage } from './hooks/use-medal-storage';
import { useSoundEffect } from './hooks/use-sound-effect';
import {
  generateCommemorativeMedal,
  type MedalGenerateRequestPayload,
  type MedalGenerateResponse,
} from './lib/api-client';
import { getSafeLocalStorage } from './lib/capsule-store-storage';
import { listMedals } from './lib/indexed-db';
import { createFallbackMedalSvgDataUrl } from '../server/lib/medal-frames';
import {
  isValidMedalRarity,
  type CapsuleTask,
  type MedalItem,
  type MedalRarity,
} from '../shared/schemas';

export const PENDING_MEDAL_GENERATIONS_STORAGE_KEY = 'capsule_tasks_pending_medals_v1';
export const PENDING_RECOVERY_INITIAL_RETRY_DELAY_MS = 40;
export const PENDING_RECOVERY_RETRY_BACKOFF_FACTOR = 2;
export const PENDING_RECOVERY_MAX_RETRY_DELAY_MS = 200;
export const PENDING_RECOVERY_MAX_RETRIES = 4;

const MEDAL_SAVE_ERROR_MESSAGE =
  '記念メダルを図鑑に保存できませんでした。空き容量を確認して再保存してください。';

export interface PendingMedalSaveTarget {
  medal: MedalItem;
  imageDataUrl: string;
  mimeType: string;
  isFallback: boolean;
}

export interface PendingMedalGenerationRecord {
  provisionalMedal: MedalItem;
  fallbackSvgUrl: string;
  medalPrompt: string;
  coinsEarned: number;
  todayCombo: number;
  provisionalSavedInDb: boolean;
  pendingSaveTarget?: PendingMedalSaveTarget;
}

export interface AppProps {
  /** テスト等でのメダル生成API関数差し替え用 */
  generateMedalFn?: (payload: MedalGenerateRequestPayload) => Promise<MedalGenerateResponse>;
  /** テスト等でのレア度抽選乱数関数差し替え用 */
  randomFn?: () => number;
}

interface RevealModalState {
  isOpen: boolean;
  taskTitle: string;
  rarity: MedalRarity;
  coinsEarned: number;
  todayCombo: number;
  medal: MedalItem | null;
  imageUrl: string | null;
  mimeType: string;
  isGenerating: boolean;
  isSaving: boolean;
  hasPersistedInDb: boolean;
  saveError: string | null;
  statusNote: string | null;
  provisionalMedalId: string;
  isFallback: boolean;
}

function isValidMedalItemCandidate(value: unknown): value is MedalItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.medalId === 'string' &&
    record.medalId.length > 0 &&
    typeof record.taskId === 'string' &&
    typeof record.taskTitle === 'string' &&
    typeof record.medalName === 'string' &&
    typeof record.engravedText === 'string' &&
    isValidMedalRarity(record.rarity) &&
    typeof record.imageBlobKey === 'string' &&
    typeof record.modelUsed === 'string' &&
    typeof record.unlockedAt === 'string' &&
    typeof record.upgradeLevel === 'number'
  );
}

function readPendingMedalGenerations(): PendingMedalGenerationRecord[] {
  const storage = getSafeLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: PendingMedalGenerationRecord[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (!isValidMedalItemCandidate(candidate.provisionalMedal)) continue;
      const provisionalMedal = candidate.provisionalMedal;
      const fallbackSvgUrl =
        typeof candidate.fallbackSvgUrl === 'string' && candidate.fallbackSvgUrl.length > 0
          ? candidate.fallbackSvgUrl
          : createFallbackMedalSvgDataUrl(provisionalMedal.rarity, provisionalMedal.engravedText);
      const medalPrompt = typeof candidate.medalPrompt === 'string' ? candidate.medalPrompt : '';
      const coinsEarned =
        typeof candidate.coinsEarned === 'number' && Number.isFinite(candidate.coinsEarned)
          ? candidate.coinsEarned
          : 30;
      const todayCombo =
        typeof candidate.todayCombo === 'number' && Number.isFinite(candidate.todayCombo)
          ? candidate.todayCombo
          : 1;
      const provisionalSavedInDb = Boolean(candidate.provisionalSavedInDb);

      let pendingSaveTarget: PendingMedalSaveTarget | undefined;
      if (typeof candidate.pendingSaveTarget === 'object' && candidate.pendingSaveTarget !== null) {
        const targetObj = candidate.pendingSaveTarget as Record<string, unknown>;
        if (
          isValidMedalItemCandidate(targetObj.medal) &&
          typeof targetObj.imageDataUrl === 'string' &&
          targetObj.imageDataUrl.length > 0 &&
          typeof targetObj.mimeType === 'string'
        ) {
          pendingSaveTarget = {
            medal: targetObj.medal,
            imageDataUrl: targetObj.imageDataUrl,
            mimeType: targetObj.mimeType,
            isFallback: Boolean(targetObj.isFallback),
          };
        }
      }

      result.push({
        provisionalMedal,
        fallbackSvgUrl,
        medalPrompt,
        coinsEarned,
        todayCombo,
        provisionalSavedInDb,
        ...(pendingSaveTarget ? { pendingSaveTarget } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
}

function writePendingMedalGenerations(records: PendingMedalGenerationRecord[]): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    if (records.length === 0) {
      storage.removeItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY);
      return;
    }
    storage.setItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // 画像データが大きすぎて localStorage 容量を超過した場合は、生成待ちメタデータのみ退避する
    try {
      const lightweight = records.map((item) => ({
        provisionalMedal: item.provisionalMedal,
        fallbackSvgUrl: item.fallbackSvgUrl,
        medalPrompt: item.medalPrompt,
        coinsEarned: item.coinsEarned,
        todayCombo: item.todayCombo,
        provisionalSavedInDb: item.provisionalSavedInDb,
      }));
      storage.setItem(PENDING_MEDAL_GENERATIONS_STORAGE_KEY, JSON.stringify(lightweight));
    } catch {
      // ignore localStorage write failure
    }
  }
}

function upsertPendingMedalGeneration(record: PendingMedalGenerationRecord): void {
  const current = readPendingMedalGenerations();
  const idx = current.findIndex(
    (item) => item.provisionalMedal.medalId === record.provisionalMedal.medalId,
  );
  if (idx >= 0) {
    current[idx] = record;
  } else {
    current.push(record);
  }
  writePendingMedalGenerations(current);
}

function removePendingMedalGeneration(provisionalMedalId: string): void {
  const current = readPendingMedalGenerations();
  const next = current.filter((item) => item.provisionalMedal.medalId !== provisionalMedalId);
  writePendingMedalGenerations(next);
}

function stripPendingGenerationMetadata(medal: MedalItem): MedalItem {
  const cleanMedal: MedalItem = { ...medal };
  delete cleanMedal.pendingGeneration;
  return cleanMedal;
}

function attachPendingGenerationMetadata(record: {
  provisionalMedal: MedalItem;
  fallbackSvgUrl: string;
  medalPrompt: string;
  coinsEarned: number;
  todayCombo: number;
  pendingSaveTarget?: PendingMedalSaveTarget;
}): MedalItem {
  const cleanProvisional = stripPendingGenerationMetadata(record.provisionalMedal);
  const cleanPendingTarget = record.pendingSaveTarget
    ? {
        ...record.pendingSaveTarget,
        medal: stripPendingGenerationMetadata(record.pendingSaveTarget.medal),
      }
    : undefined;

  return {
    ...cleanProvisional,
    pendingGeneration: {
      medalPrompt: record.medalPrompt,
      coinsEarned: record.coinsEarned,
      todayCombo: record.todayCombo,
      fallbackSvgUrl: record.fallbackSvgUrl,
      ...(cleanPendingTarget ? { pendingSaveTarget: cleanPendingTarget } : {}),
    },
  };
}

function recoverPendingRecordFromMedal(medal: MedalItem): PendingMedalGenerationRecord | null {
  if (!medal.pendingGeneration) return null;
  const pg = medal.pendingGeneration;
  const fallbackSvgUrl =
    typeof pg.fallbackSvgUrl === 'string' && pg.fallbackSvgUrl.length > 0
      ? pg.fallbackSvgUrl
      : createFallbackMedalSvgDataUrl(medal.rarity, medal.engravedText);
  const medalPrompt = typeof pg.medalPrompt === 'string' ? pg.medalPrompt : '';
  const coinsEarned =
    typeof pg.coinsEarned === 'number' && Number.isFinite(pg.coinsEarned) ? pg.coinsEarned : 30;
  const todayCombo =
    typeof pg.todayCombo === 'number' && Number.isFinite(pg.todayCombo) ? pg.todayCombo : 1;

  let pendingSaveTarget: PendingMedalSaveTarget | undefined;
  if (
    pg.pendingSaveTarget &&
    isValidMedalItemCandidate(pg.pendingSaveTarget.medal) &&
    typeof pg.pendingSaveTarget.imageDataUrl === 'string' &&
    pg.pendingSaveTarget.imageDataUrl.length > 0 &&
    typeof pg.pendingSaveTarget.mimeType === 'string'
  ) {
    pendingSaveTarget = {
      medal: stripPendingGenerationMetadata(pg.pendingSaveTarget.medal),
      imageDataUrl: pg.pendingSaveTarget.imageDataUrl,
      mimeType: pg.pendingSaveTarget.mimeType,
      isFallback: Boolean(pg.pendingSaveTarget.isFallback),
    };
  }

  return {
    provisionalMedal: medal,
    fallbackSvgUrl,
    medalPrompt,
    coinsEarned,
    todayCombo,
    provisionalSavedInDb: true,
    ...(pendingSaveTarget ? { pendingSaveTarget } : {}),
  };
}

function createInitialRevealStateFromRecord(
  record: PendingMedalGenerationRecord,
): RevealModalState {
  return {
    isOpen: true,
    taskTitle: record.provisionalMedal.taskTitle,
    rarity: record.provisionalMedal.rarity,
    coinsEarned: record.coinsEarned,
    todayCombo: record.todayCombo,
    medal: record.pendingSaveTarget?.medal ?? record.provisionalMedal,
    imageUrl: record.pendingSaveTarget?.imageDataUrl ?? null,
    mimeType: record.pendingSaveTarget?.mimeType ?? 'image/svg+xml',
    isGenerating: !record.pendingSaveTarget,
    isSaving: Boolean(record.pendingSaveTarget),
    hasPersistedInDb: record.provisionalSavedInDb && !record.pendingSaveTarget,
    saveError: null,
    statusNote: null,
    provisionalMedalId: record.provisionalMedal.medalId,
    isFallback: record.pendingSaveTarget?.isFallback ?? false,
  };
}

interface LoadPendingRecordsResult {
  records: PendingMedalGenerationRecord[];
  dbReadFailed: boolean;
  finalizedMedals: Map<string, MedalItem>;
}

async function loadPendingRecordsFromDbAndStorage(): Promise<LoadPendingRecordsResult> {
  const localRecords = readPendingMedalGenerations();
  let dbMedals: MedalItem[] | null;
  try {
    dbMedals = await listMedals('date-asc', 'ALL');
  } catch {
    dbMedals = null;
  }

  if (dbMedals === null) {
    // IndexedDB の読み取りに失敗した場合は「DBに対象がない」と区別し、
    // localStorage の補助レコード（provisionalSavedInDb: true を含む）を削除せず保持する
    return {
      records: [],
      dbReadFailed: true,
      finalizedMedals: new Map(),
    };
  }

  const finalizedProvisionalIds = new Set<string>();
  const finalizedMedals = new Map<string, MedalItem>();
  const dbPendingMap = new Map<string, PendingMedalGenerationRecord>();

  for (const m of dbMedals) {
    if (m.replacedProvisionalMedalId) {
      finalizedProvisionalIds.add(m.replacedProvisionalMedalId);
      finalizedMedals.set(m.replacedProvisionalMedalId, m);
    }
    if (!m.pendingGeneration) {
      finalizedProvisionalIds.add(m.medalId);
      finalizedMedals.set(m.medalId, m);
    } else {
      const recovered = recoverPendingRecordFromMedal(m);
      if (recovered) {
        dbPendingMap.set(m.medalId, recovered);
      }
    }
  }

  const mergedMap = new Map<string, PendingMedalGenerationRecord>();

  // 1. IndexedDB（正本）にある未確定の仮メダルをベースに登録
  for (const [provId, dbRecord] of dbPendingMap.entries()) {
    if (finalizedProvisionalIds.has(provId)) continue;
    mergedMap.set(provId, dbRecord);
  }

  // 2. localStorage（補助）のレコードをマージ
  for (const localRec of localRecords) {
    const provId = localRec.provisionalMedal.medalId;
    if (finalizedProvisionalIds.has(provId)) {
      removePendingMedalGeneration(provId);
      continue;
    }
    const existingDbRec = mergedMap.get(provId);
    if (existingDbRec) {
      if (!existingDbRec.pendingSaveTarget && localRec.pendingSaveTarget) {
        mergedMap.set(provId, {
          ...existingDbRec,
          pendingSaveTarget: localRec.pendingSaveTarget,
        });
      }
    } else if (!localRec.provisionalSavedInDb || localRec.pendingSaveTarget) {
      mergedMap.set(provId, {
        ...localRec,
        provisionalMedal: attachPendingGenerationMetadata(localRec),
      });
    } else {
      removePendingMedalGeneration(provId);
    }
  }

  return {
    records: Array.from(mergedMap.values()),
    dbReadFailed: false,
    finalizedMedals,
  };
}

function extractClientEngravedText(medalPrompt: string, taskTitle: string): string {
  const match = /engraved text\s+['"]([^'"]+)['"]/i.exec(medalPrompt);
  if (match && match[1]?.trim()) {
    return match[1].trim().toUpperCase().slice(0, 24);
  }
  if (taskTitle.includes('企画書')) return 'DRAFT CONQUEROR';
  if (taskTitle.includes('洗濯')) return 'LAUNDRY MASTER';
  if (taskTitle.includes('領収書') || taskTitle.includes('経費')) return 'RECEIPT HUNTER';
  return 'TASK CONQUEROR';
}

export const App: React.FC<AppProps> = ({
  generateMedalFn = generateCommemorativeMedal,
  randomFn,
}) => {
  const {
    capsules,
    activeCapsule,
    playerState,
    storageError,
    isUpdating,
    supplyCapsules,
    supplyStampCapsule,
    passActiveCapsule,
    recycleActiveCapsule,
    crackActiveCapsule,
    toggleSound,
    syncDateComboState,
  } = useCapsuleStore(randomFn ? { randomFn } : {});

  const {
    medals,
    totalMedalCount,
    sortOrder,
    rarityFilter,
    isLoading: isMedalsLoading,
    setSortOrder,
    setRarityFilter,
    refreshMedals,
    saveMedal,
    loadMedalImage,
  } = useMedalStorage();

  const { playSupply, playCrack, playFanfare, playPass, playRecycle, unlockAudio } = useSoundEffect(
    playerState.soundEnabled,
  );

  const [interactionTrigger, setInteractionTrigger] = useState<number>(0);
  const [isOpeningCapsule, setIsOpeningCapsule] = useState<boolean>(false);
  const [isSupplySheetOpen, setIsSupplySheetOpen] = useState<boolean>(false);
  const [isCollectionDrawerOpen, setIsCollectionDrawerOpen] = useState<boolean>(false);
  const [selectedCollectionMedalId, setSelectedCollectionMedalId] = useState<string | null>(null);
  const [revealState, setRevealState] = useState<RevealModalState | null>(() => {
    const pendingRecords = readPendingMedalGenerations();
    if (pendingRecords.length === 0) return null;
    const latestRecord = pendingRecords[pendingRecords.length - 1];
    return createInitialRevealStateFromRecord(latestRecord);
  });
  const revealStateRef = useRef<RevealModalState | null>(revealState);

  const updateRevealState = useCallback(
    (
      updater:
        RevealModalState | null | ((prev: RevealModalState | null) => RevealModalState | null),
    ) => {
      const next = typeof updater === 'function' ? updater(revealStateRef.current) : updater;
      revealStateRef.current = next;
      setRevealState(next);
    },
    [],
  );

  const [statusFeedback, setStatusFeedback] =
    useState<string>('カプセルを連打・長押ししてパカッと開封しよう！');
  const [toastNotification, setToastNotification] = useState<StageToastNotification | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOpeningCapsuleRef = useRef<boolean>(false);
  const crackGenerationSeqRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const generateMedalFnRef = useRef(generateMedalFn);
  const saveMedalRef = useRef(saveMedal);
  const refreshMedalsRef = useRef(refreshMedals);
  const loadMedalImageRef = useRef(loadMedalImage);
  const rarityFilterRef = useRef(rarityFilter);
  const setRarityFilterRef = useRef(setRarityFilter);
  const selectedCollectionMedalIdRef = useRef<string | null>(selectedCollectionMedalId);
  const inFlightProvisionalIdsRef = useRef<Set<string>>(new Set());
  const resumePendingRecoveryRef = useRef<(() => void) | null>(null);
  const unsavedRecordsRef = useRef<PendingMedalGenerationRecord[]>([]);
  const [unsavedRecordCount, setUnsavedRecordCount] = useState<number>(0);

  const syncUnsavedRecords = useCallback((next: PendingMedalGenerationRecord[]) => {
    unsavedRecordsRef.current = next;
    setUnsavedRecordCount(next.length);
  }, []);

  useEffect(() => {
    generateMedalFnRef.current = generateMedalFn;
    saveMedalRef.current = saveMedal;
    refreshMedalsRef.current = refreshMedals;
    loadMedalImageRef.current = loadMedalImage;
    rarityFilterRef.current = rarityFilter;
    setRarityFilterRef.current = setRarityFilter;
    selectedCollectionMedalIdRef.current = selectedCollectionMedalId;
  }, [
    generateMedalFn,
    saveMedal,
    refreshMedals,
    loadMedalImage,
    rarityFilter,
    setRarityFilter,
    selectedCollectionMedalId,
  ]);

  const updateSelectedCollectionMedalId = useCallback((medalId: string | null) => {
    selectedCollectionMedalIdRef.current = medalId;
    setSelectedCollectionMedalId(medalId);
  }, []);

  const handleChangeRarityFilter = useCallback(
    (filter: MedalRarity | 'ALL') => {
      rarityFilterRef.current = filter;
      setRarityFilter(filter);
    },
    [setRarityFilter],
  );

  const handleOpeningLockChange = (isOpening: boolean) => {
    isOpeningCapsuleRef.current = isOpening;
    setIsOpeningCapsule(isOpening);
  };

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

  const executeMedalGenerationFlow = useCallback(
    async (
      initialRecord: PendingMedalGenerationRecord,
      seq: number,
      isCancelled: () => boolean,
    ): Promise<void> => {
      const targetProvisionalId = initialRecord.provisionalMedal.medalId;
      if (inFlightProvisionalIdsRef.current.has(targetProvisionalId)) {
        return;
      }
      inFlightProvisionalIdsRef.current.add(targetProvisionalId);

      const isMatchingRevealTarget = (state: RevealModalState | null): boolean =>
        Boolean(
          !isCancelled() &&
          crackGenerationSeqRef.current === seq &&
          state &&
          state.provisionalMedalId === targetProvisionalId,
        );

      const applyAlreadyFinalizedMedal = async (
        alreadyFinalized: MedalItem,
        fallbackSvgUrl: string,
      ): Promise<void> => {
        removePendingMedalGeneration(targetProvisionalId);
        syncUnsavedRecords(
          unsavedRecordsRef.current.filter(
            (item) => item.provisionalMedal.medalId !== targetProvisionalId,
          ),
        );
        await refreshMedalsRef.current();

        let finalizedImgUrl = fallbackSvgUrl;
        let finalizedMime = 'image/svg+xml';
        try {
          const existingImg = await loadMedalImageRef.current(alreadyFinalized.imageBlobKey);
          if (existingImg && typeof existingImg.imageData === 'string') {
            finalizedImgUrl = existingImg.imageData;
            finalizedMime = existingImg.mimeType;
          }
        } catch {
          // ignore image load failure
        }

        if (
          selectedCollectionMedalIdRef.current === targetProvisionalId ||
          selectedCollectionMedalIdRef.current === alreadyFinalized.medalId
        ) {
          if (
            rarityFilterRef.current !== 'ALL' &&
            rarityFilterRef.current !== alreadyFinalized.rarity
          ) {
            rarityFilterRef.current = 'ALL';
            setRarityFilterRef.current('ALL');
          }
          updateSelectedCollectionMedalId(alreadyFinalized.medalId);
        }

        if (!isCancelled() && crackGenerationSeqRef.current === seq) {
          updateRevealState((prev) =>
            isMatchingRevealTarget(prev)
              ? {
                  ...prev!,
                  rarity: alreadyFinalized.rarity,
                  medal: alreadyFinalized,
                  imageUrl: finalizedImgUrl,
                  mimeType: finalizedMime,
                  isGenerating: false,
                  isSaving: false,
                  hasPersistedInDb: true,
                  saveError: null,
                  statusNote: null,
                  isFallback: false,
                }
              : prev,
          );
        }
      };

      try {
        let record: PendingMedalGenerationRecord = {
          ...initialRecord,
          provisionalMedal: attachPendingGenerationMetadata(initialRecord),
        };
        let saveTarget = record.pendingSaveTarget;

        if (!saveTarget) {
          if (!record.provisionalSavedInDb) {
            try {
              const savedProvisional = await saveMedalRef.current({
                medal: record.provisionalMedal,
                imageData: record.fallbackSvgUrl,
                mimeType: 'image/svg+xml',
              });
              if (!savedProvisional.pendingGeneration) {
                // すでに他タブ等で確定済みのメダルが存在する場合は生成APIを呼ばずに確定状態を反映して終了
                await applyAlreadyFinalizedMedal(savedProvisional, record.fallbackSvgUrl);
                return;
              }
              record = {
                ...record,
                provisionalMedal: savedProvisional,
                provisionalSavedInDb: true,
              };
              upsertPendingMedalGeneration(record);
              if (!isCancelled() && crackGenerationSeqRef.current === seq) {
                updateRevealState((prev) =>
                  isMatchingRevealTarget(prev) ? { ...prev!, hasPersistedInDb: true } : prev,
                );
              }
            } catch {
              // 仮メダル保存が失敗しても生成API呼び出し自体は継続し、最終保存時にエラー表示・再保存導線を出す
            }
          } else {
            // すでに仮メダルがDB保存済みの場合、API呼び出し前にすでに他タブで確定済みでないかチェック
            try {
              const dbMedals = await listMedals('date-desc', 'ALL');
              const alreadyFinalized = dbMedals.find(
                (m) =>
                  m.replacedProvisionalMedalId === targetProvisionalId ||
                  (m.medalId === targetProvisionalId && !m.pendingGeneration),
              );
              if (alreadyFinalized) {
                await applyAlreadyFinalizedMedal(alreadyFinalized, record.fallbackSvgUrl);
                return;
              }
            } catch {
              // ignore read check failure and proceed
            }
          }

          if (isCancelled()) return;

          try {
            const generated = await generateMedalFnRef.current({
              taskId: record.provisionalMedal.taskId,
              taskTitle: record.provisionalMedal.taskTitle,
              medalPrompt: record.medalPrompt,
              rarity: record.provisionalMedal.rarity,
              engravedText: record.provisionalMedal.engravedText,
            });
            saveTarget = {
              medal: stripPendingGenerationMetadata(generated.medal),
              imageDataUrl: generated.imageDataUrl,
              mimeType: generated.mimeType,
              isFallback: false,
            };
          } catch {
            saveTarget = {
              medal: stripPendingGenerationMetadata(record.provisionalMedal),
              imageDataUrl: record.fallbackSvgUrl,
              mimeType: 'image/svg+xml',
              isFallback: true,
            };
          }

          if (isCancelled()) return;

          record = {
            ...record,
            provisionalMedal: attachPendingGenerationMetadata({
              ...record,
              pendingSaveTarget: saveTarget,
            }),
            pendingSaveTarget: saveTarget,
          };
          upsertPendingMedalGeneration(record);
        }

        const finalTarget = {
          ...saveTarget,
          medal: stripPendingGenerationMetadata(saveTarget.medal),
        };

        try {
          const savedMedal = await saveMedalRef.current({
            medal: finalTarget.medal,
            imageData: finalTarget.imageDataUrl,
            mimeType: finalTarget.mimeType,
            replaceMedalId: targetProvisionalId,
            requireReplaceTarget: record.provisionalSavedInDb,
          });

          let resolvedImageUrl = finalTarget.imageDataUrl;
          let resolvedMimeType = finalTarget.mimeType;
          if (savedMedal.medalId !== finalTarget.medal.medalId) {
            try {
              const existingImg = await loadMedalImageRef.current(savedMedal.imageBlobKey);
              if (existingImg && typeof existingImg.imageData === 'string') {
                resolvedImageUrl = existingImg.imageData;
                resolvedMimeType = existingImg.mimeType;
              }
            } catch {
              // ignore image load failure
            }
          }

          removePendingMedalGeneration(targetProvisionalId);
          syncUnsavedRecords(
            unsavedRecordsRef.current.filter(
              (item) => item.provisionalMedal.medalId !== targetProvisionalId,
            ),
          );

          if (
            selectedCollectionMedalIdRef.current === targetProvisionalId ||
            selectedCollectionMedalIdRef.current === finalTarget.medal.medalId ||
            selectedCollectionMedalIdRef.current === savedMedal.medalId
          ) {
            if (
              rarityFilterRef.current !== 'ALL' &&
              rarityFilterRef.current !== savedMedal.rarity
            ) {
              rarityFilterRef.current = 'ALL';
              setRarityFilterRef.current('ALL');
            }
            updateSelectedCollectionMedalId(savedMedal.medalId);
          }

          if (!isCancelled() && crackGenerationSeqRef.current === seq) {
            updateRevealState((prev) =>
              isMatchingRevealTarget(prev)
                ? {
                    ...prev!,
                    rarity: savedMedal.rarity,
                    medal: savedMedal,
                    imageUrl: resolvedImageUrl,
                    mimeType: resolvedMimeType,
                    isGenerating: false,
                    isSaving: false,
                    hasPersistedInDb: true,
                    saveError: null,
                    statusNote: finalTarget.isFallback ? '記念メダルを図鑑に保存しました' : null,
                    isFallback: finalTarget.isFallback,
                  }
                : prev,
            );
          }
        } catch {
          const failedRecord: PendingMedalGenerationRecord = {
            ...record,
            pendingSaveTarget: finalTarget,
          };
          upsertPendingMedalGeneration(failedRecord);
          const existingIdx = unsavedRecordsRef.current.findIndex(
            (item) => item.provisionalMedal.medalId === targetProvisionalId,
          );
          const nextUnsaved = [...unsavedRecordsRef.current];
          if (existingIdx >= 0) {
            nextUnsaved[existingIdx] = failedRecord;
          } else {
            nextUnsaved.push(failedRecord);
          }
          syncUnsavedRecords(nextUnsaved);

          if (!isCancelled() && crackGenerationSeqRef.current === seq) {
            updateRevealState((prev) => {
              if (prev && prev.provisionalMedalId !== targetProvisionalId) {
                return prev;
              }
              return {
                isOpen: prev ? prev.isOpen : true,
                taskTitle: record.provisionalMedal.taskTitle,
                rarity: finalTarget.medal.rarity,
                coinsEarned: record.coinsEarned,
                todayCombo: record.todayCombo,
                medal: finalTarget.medal,
                imageUrl: finalTarget.imageDataUrl,
                mimeType: finalTarget.mimeType,
                isGenerating: false,
                isSaving: false,
                hasPersistedInDb: false,
                saveError: MEDAL_SAVE_ERROR_MESSAGE,
                statusNote: null,
                provisionalMedalId: targetProvisionalId,
                isFallback: finalTarget.isFallback,
              };
            });
          }
        }
      } finally {
        inFlightProvisionalIdsRef.current.delete(targetProvisionalId);
      }
    },
    [syncUnsavedRecords, updateRevealState, updateSelectedCollectionMedalId],
  );

  useEffect(() => {
    isMountedRef.current = true;
    const cancelToken = { cancelled: false };
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let retryExhausted = false;
    let isRecoveryRunning = false;
    let hadDbReadFailure = false;
    const isCancelled = () => cancelToken.cancelled || !isMountedRef.current;
    const seq = ++crackGenerationSeqRef.current;

    const runPendingRecovery = async (): Promise<void> => {
      if (isRecoveryRunning || isCancelled()) return;
      isRecoveryRunning = true;
      try {
        const {
          records: loadedRecords,
          dbReadFailed,
          finalizedMedals,
        } = await loadPendingRecordsFromDbAndStorage();
        if (isCancelled()) return;

        if (dbReadFailed) {
          hadDbReadFailure = true;
          if (retryCount < PENDING_RECOVERY_MAX_RETRIES) {
            const delayMs = Math.min(
              PENDING_RECOVERY_INITIAL_RETRY_DELAY_MS *
                PENDING_RECOVERY_RETRY_BACKOFF_FACTOR ** retryCount,
              PENDING_RECOVERY_MAX_RETRY_DELAY_MS,
            );
            retryCount += 1;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!isCancelled()) {
                void runPendingRecovery();
              }
            }, delayMs);
          } else {
            retryExhausted = true;
          }
          return;
        }

        retryCount = 0;
        retryExhausted = false;
        if (hadDbReadFailure) {
          void refreshMedalsRef.current();
        }

        const pendingRecords = loadedRecords.filter(
          (rec) => !inFlightProvisionalIdsRef.current.has(rec.provisionalMedal.medalId),
        );

        if (pendingRecords.length === 0) {
          const currentReveal = revealStateRef.current;
          if (currentReveal && currentReveal.isGenerating) {
            const alreadyFinalized = finalizedMedals.get(currentReveal.provisionalMedalId);
            if (alreadyFinalized) {
              let finalizedImgUrl = currentReveal.imageUrl;
              let finalizedMime = currentReveal.mimeType;
              try {
                const existingImg = await loadMedalImageRef.current(alreadyFinalized.imageBlobKey);
                if (existingImg && typeof existingImg.imageData === 'string') {
                  finalizedImgUrl = existingImg.imageData;
                  finalizedMime = existingImg.mimeType;
                }
              } catch {
                // ignore image load failure
              }
              if (!isCancelled() && crackGenerationSeqRef.current === seq) {
                updateRevealState((prev) =>
                  prev && prev.provisionalMedalId === currentReveal.provisionalMedalId
                    ? {
                        ...prev,
                        rarity: alreadyFinalized.rarity,
                        medal: alreadyFinalized,
                        imageUrl: finalizedImgUrl,
                        mimeType: finalizedMime,
                        isGenerating: false,
                        isSaving: false,
                        hasPersistedInDb: true,
                        saveError: null,
                        statusNote: null,
                        isFallback: false,
                      }
                    : prev,
                );
              }
            } else if (!isCancelled() && crackGenerationSeqRef.current === seq) {
              updateRevealState((prev) =>
                prev && prev.provisionalMedalId === currentReveal.provisionalMedalId ? null : prev,
              );
            }
          }
          return;
        }

        const latestRecord = pendingRecords[pendingRecords.length - 1];
        if (!isCancelled() && crackGenerationSeqRef.current === seq) {
          updateRevealState((prev) => {
            if (prev && prev.provisionalMedalId !== latestRecord.provisionalMedal.medalId) {
              return createInitialRevealStateFromRecord(latestRecord);
            }
            return prev ?? createInitialRevealStateFromRecord(latestRecord);
          });
        }

        for (let i = 0; i < pendingRecords.length; i++) {
          if (isCancelled()) return;
          const record = pendingRecords[i];
          if (inFlightProvisionalIdsRef.current.has(record.provisionalMedal.medalId)) continue;
          const isLatest = i === pendingRecords.length - 1;
          await executeMedalGenerationFlow(record, isLatest ? seq : -1, isCancelled);
        }
      } finally {
        isRecoveryRunning = false;
      }
    };

    resumePendingRecoveryRef.current = () => {
      if (isCancelled() || !retryExhausted || isRecoveryRunning) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      retryCount = 0;
      retryExhausted = false;
      void runPendingRecovery();
    };

    void runPendingRecovery();

    return () => {
      cancelToken.cancelled = true;
      isMountedRef.current = false;
      resumePendingRecoveryRef.current = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, [executeMedalGenerationFlow, updateRevealState]);

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
    if (!activeCapsule) return;
    unlockAudio();
    const result = await crackActiveCapsule(activeCapsule.id);
    if (!result) return;

    playFanfare(result.awardedRarity);
    showToast({
      type: 'crack',
      text: `開封完了！＋${result.coinsEarned}コイン獲得`,
    });
    setStatusFeedback(
      `「${result.crackedTask.title}」を開封完了！＋${result.coinsEarned}コイン（${result.awardedRarity}メダル抽選）`,
    );

    const seq = ++crackGenerationSeqRef.current;
    const fallbackEngraved = extractClientEngravedText(
      result.crackedTask.medalPrompt,
      result.crackedTask.title,
    );
    const provisionalMedalId = `medal_${result.awardedRarity.toLowerCase()}_${Date.now()}_${seq}`;
    const fallbackSvgUrl = createFallbackMedalSvgDataUrl(result.awardedRarity, fallbackEngraved);
    const provisionalMedal: MedalItem = {
      medalId: provisionalMedalId,
      taskId: result.crackedTask.id,
      taskTitle: result.crackedTask.title,
      medalName: `「${result.crackedTask.title}」記念メダル`,
      engravedText: fallbackEngraved,
      rarity: result.awardedRarity,
      imageBlobKey: `img_${provisionalMedalId}`,
      modelUsed: 'gemini-nano-banana-2.1',
      unlockedAt: new Date().toISOString(),
      upgradeLevel: 0,
      pendingGeneration: {
        medalPrompt: result.crackedTask.medalPrompt,
        coinsEarned: result.coinsEarned,
        todayCombo: result.updatedCombo,
        fallbackSvgUrl,
      },
    };

    const pendingRecord: PendingMedalGenerationRecord = {
      provisionalMedal,
      fallbackSvgUrl,
      medalPrompt: result.crackedTask.medalPrompt,
      coinsEarned: result.coinsEarned,
      todayCombo: result.updatedCombo,
      provisionalSavedInDb: false,
    };
    upsertPendingMedalGeneration(pendingRecord);

    updateRevealState({
      isOpen: true,
      taskTitle: result.crackedTask.title,
      rarity: result.awardedRarity,
      coinsEarned: result.coinsEarned,
      todayCombo: result.updatedCombo,
      medal: provisionalMedal,
      imageUrl: null,
      mimeType: 'image/svg+xml',
      isGenerating: true,
      isSaving: false,
      hasPersistedInDb: false,
      saveError: null,
      statusNote: null,
      provisionalMedalId,
      isFallback: false,
    });

    await executeMedalGenerationFlow(pendingRecord, seq, () => !isMountedRef.current);
  };

  const handleRetrySaveMedal = async () => {
    if (!revealState || !revealState.medal || !revealState.imageUrl || revealState.isSaving) {
      return;
    }
    unlockAudio();
    const currentMedal = stripPendingGenerationMetadata(revealState.medal);
    const currentImageUrl = revealState.imageUrl;
    const currentMimeType = revealState.mimeType;
    const currentProvisionalId = revealState.provisionalMedalId;
    const currentCoinsEarned = revealState.coinsEarned;
    const currentTodayCombo = revealState.todayCombo;
    const currentIsFallback = revealState.isFallback;
    const retrySeq = crackGenerationSeqRef.current;

    const isStillTargetActive = (state: RevealModalState | null): boolean =>
      Boolean(
        isMountedRef.current &&
        crackGenerationSeqRef.current === retrySeq &&
        state &&
        state.provisionalMedalId === currentProvisionalId,
      );

    updateRevealState((prev) =>
      isStillTargetActive(prev) ? { ...prev!, isSaving: true, saveError: null } : prev,
    );

    try {
      const targetUnsavedRecord = unsavedRecordsRef.current.find(
        (item) => item.provisionalMedal.medalId === currentProvisionalId,
      );
      const savedMedal = await saveMedal({
        medal: currentMedal,
        imageData: currentImageUrl,
        mimeType: currentMimeType,
        replaceMedalId: currentProvisionalId,
        requireReplaceTarget: Boolean(targetUnsavedRecord?.provisionalSavedInDb),
      });

      let resolvedImageUrl = currentImageUrl;
      let resolvedMimeType = currentMimeType;
      if (savedMedal.medalId !== currentMedal.medalId) {
        try {
          const existingImg = await loadMedalImageRef.current(savedMedal.imageBlobKey);
          if (existingImg && typeof existingImg.imageData === 'string') {
            resolvedImageUrl = existingImg.imageData;
            resolvedMimeType = existingImg.mimeType;
          }
        } catch {
          // ignore image load failure
        }
      }

      removePendingMedalGeneration(currentProvisionalId);
      syncUnsavedRecords(
        unsavedRecordsRef.current.filter(
          (item) => item.provisionalMedal.medalId !== currentProvisionalId,
        ),
      );

      if (
        selectedCollectionMedalIdRef.current === currentProvisionalId ||
        selectedCollectionMedalIdRef.current === currentMedal.medalId ||
        selectedCollectionMedalIdRef.current === savedMedal.medalId
      ) {
        if (rarityFilterRef.current !== 'ALL' && rarityFilterRef.current !== savedMedal.rarity) {
          handleChangeRarityFilter('ALL');
        }
        updateSelectedCollectionMedalId(savedMedal.medalId);
      }

      const remaining = [...unsavedRecordsRef.current];
      for (const pendingItem of remaining) {
        if (!pendingItem.pendingSaveTarget) continue;
        const extraTargetMedal = stripPendingGenerationMetadata(
          pendingItem.pendingSaveTarget.medal,
        );
        try {
          const extraSaved = await saveMedal({
            medal: extraTargetMedal,
            imageData: pendingItem.pendingSaveTarget.imageDataUrl,
            mimeType: pendingItem.pendingSaveTarget.mimeType,
            replaceMedalId: pendingItem.provisionalMedal.medalId,
            requireReplaceTarget: pendingItem.provisionalSavedInDb,
          });
          removePendingMedalGeneration(pendingItem.provisionalMedal.medalId);
          syncUnsavedRecords(
            unsavedRecordsRef.current.filter(
              (item) => item.provisionalMedal.medalId !== pendingItem.provisionalMedal.medalId,
            ),
          );
          if (
            selectedCollectionMedalIdRef.current === pendingItem.provisionalMedal.medalId ||
            selectedCollectionMedalIdRef.current === extraTargetMedal.medalId ||
            selectedCollectionMedalIdRef.current === extraSaved.medalId
          ) {
            if (
              rarityFilterRef.current !== 'ALL' &&
              rarityFilterRef.current !== extraSaved.rarity
            ) {
              handleChangeRarityFilter('ALL');
            }
            updateSelectedCollectionMedalId(extraSaved.medalId);
          }
        } catch {
          const targetSaveInfo = pendingItem.pendingSaveTarget;
          if (isStillTargetActive(revealStateRef.current)) {
            updateRevealState((prev) =>
              isStillTargetActive(prev)
                ? {
                    isOpen: true,
                    taskTitle: pendingItem.provisionalMedal.taskTitle,
                    rarity: extraTargetMedal.rarity,
                    coinsEarned: pendingItem.coinsEarned,
                    todayCombo: pendingItem.todayCombo,
                    medal: extraTargetMedal,
                    imageUrl: targetSaveInfo.imageDataUrl,
                    mimeType: targetSaveInfo.mimeType,
                    isGenerating: false,
                    isSaving: false,
                    hasPersistedInDb: false,
                    saveError: MEDAL_SAVE_ERROR_MESSAGE,
                    statusNote: null,
                    provisionalMedalId: pendingItem.provisionalMedal.medalId,
                    isFallback: targetSaveInfo.isFallback,
                  }
                : prev,
            );
          }
          return;
        }
      }

      if (isStillTargetActive(revealStateRef.current)) {
        updateRevealState((prev) =>
          isStillTargetActive(prev)
            ? {
                ...prev!,
                rarity: savedMedal.rarity,
                medal: savedMedal,
                imageUrl: resolvedImageUrl,
                mimeType: resolvedMimeType,
                isSaving: false,
                hasPersistedInDb: true,
                saveError: null,
                statusNote: '記念メダルを図鑑に保存しました',
              }
            : prev,
        );
        setStatusFeedback('記念メダルを図鑑に保存しました！');
      }
    } catch {
      const existingUnsaved = unsavedRecordsRef.current.some(
        (item) => item.provisionalMedal.medalId === currentProvisionalId,
      );
      if (!existingUnsaved) {
        const fallbackSvgUrl = createFallbackMedalSvgDataUrl(
          currentMedal.rarity,
          currentMedal.engravedText,
        );
        const fallbackRecord: PendingMedalGenerationRecord = {
          provisionalMedal: attachPendingGenerationMetadata({
            provisionalMedal: {
              ...currentMedal,
              medalId: currentProvisionalId,
            },
            fallbackSvgUrl,
            medalPrompt: '',
            coinsEarned: currentCoinsEarned,
            todayCombo: currentTodayCombo,
            pendingSaveTarget: {
              medal: currentMedal,
              imageDataUrl: currentImageUrl,
              mimeType: currentMimeType,
              isFallback: currentIsFallback,
            },
          }),
          fallbackSvgUrl,
          medalPrompt: '',
          coinsEarned: currentCoinsEarned,
          todayCombo: currentTodayCombo,
          provisionalSavedInDb: false,
          pendingSaveTarget: {
            medal: currentMedal,
            imageDataUrl: currentImageUrl,
            mimeType: currentMimeType,
            isFallback: currentIsFallback,
          },
        };
        upsertPendingMedalGeneration(fallbackRecord);
        syncUnsavedRecords([...unsavedRecordsRef.current, fallbackRecord]);
      }

      if (isStillTargetActive(revealStateRef.current)) {
        updateRevealState((prev) =>
          isStillTargetActive(prev)
            ? {
                ...prev!,
                isSaving: false,
                hasPersistedInDb: false,
                saveError: MEDAL_SAVE_ERROR_MESSAGE,
                statusNote: null,
              }
            : prev,
        );
      }
    }
  };

  const handlePassCapsule = async () => {
    if (!activeCapsule || isUpdating || isOpeningCapsuleRef.current) return;
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
    if (!activeCapsule || isUpdating || isOpeningCapsuleRef.current) return;
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

  const handleOpenSupplySheet = () => {
    if (isUpdating) return;
    unlockAudio();
    setIsSupplySheetOpen(true);
  };

  const handleCloseSupplySheet = () => {
    setIsSupplySheetOpen(false);
  };

  const handleOpenCollectionDrawer = (initialMedalId: string | null = null) => {
    unlockAudio();
    resumePendingRecoveryRef.current?.();
    updateSelectedCollectionMedalId(initialMedalId);
    setIsCollectionDrawerOpen(true);
    setStatusFeedback('オリジナル記念メダル図鑑（N / R / SR / SSR）');
  };

  const handleCloseCollectionDrawer = () => {
    setIsCollectionDrawerOpen(false);
  };

  const handleCloseRevealModal = () => {
    updateRevealState((prev) => (prev ? { ...prev, isOpen: false } : null));
  };

  const handleOpenCollectionFromModal = () => {
    if (
      !revealState ||
      !revealState.hasPersistedInDb ||
      revealState.saveError ||
      revealState.isSaving
    ) {
      return;
    }
    const targetMedalId = revealState.medal?.medalId ?? null;
    const targetRarity = revealState.medal?.rarity ?? revealState.rarity;
    if (rarityFilterRef.current !== 'ALL' && rarityFilterRef.current !== targetRarity) {
      handleChangeRarityFilter('ALL');
    }
    updateRevealState((prev) => (prev ? { ...prev, isOpen: false } : null));
    handleOpenCollectionDrawer(targetMedalId);
  };

  const handleSupplySuccess = (suppliedTasks: CapsuleTask[]) => {
    if (suppliedTasks.length === 0) return;
    unlockAudio();
    playSupply();
    setInteractionTrigger((prev) => prev + 1);
    const earnedCoins = suppliedTasks.length * SUPPLY_BONUS_COINS_PER_CAPSULE;
    const summaryText =
      suppliedTasks.length === 1
        ? `「${suppliedTasks[0].title}」を補充！＋${earnedCoins}コイン獲得`
        : `${suppliedTasks.length}個のカプセルを一括補充！＋${earnedCoins}コイン獲得`;
    setStatusFeedback(summaryText);
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
        {(Boolean(revealState?.saveError) || unsavedRecordCount > 0) && !revealState?.isOpen && (
          <div
            role="alert"
            data-testid="unsaved-medal-alert"
            className="mx-3 flex shrink-0 items-center justify-between gap-2 rounded-lg border-2 border-[#991B1B] bg-[#FFE2DE] px-3 py-1.5 text-xs font-bold text-[#991B1B]"
          >
            <span className="truncate">未保存の記念メダルがあります</span>
            <button
              type="button"
              onClick={() => {
                if (revealState?.saveError) {
                  updateRevealState((prev) => (prev ? { ...prev, isOpen: true } : null));
                  return;
                }
                const target = unsavedRecordsRef.current[unsavedRecordsRef.current.length - 1];
                if (target?.pendingSaveTarget) {
                  updateRevealState({
                    isOpen: true,
                    taskTitle: target.provisionalMedal.taskTitle,
                    rarity: target.pendingSaveTarget.medal.rarity,
                    coinsEarned: target.coinsEarned,
                    todayCombo: target.todayCombo,
                    medal: target.pendingSaveTarget.medal,
                    imageUrl: target.pendingSaveTarget.imageDataUrl,
                    mimeType: target.pendingSaveTarget.mimeType,
                    isGenerating: false,
                    isSaving: false,
                    hasPersistedInDb: false,
                    saveError: MEDAL_SAVE_ERROR_MESSAGE,
                    statusNote: null,
                    provisionalMedalId: target.provisionalMedal.medalId,
                    isFallback: target.pendingSaveTarget.isFallback,
                  });
                }
              }}
              data-testid="reopen-unsaved-medal-button"
              className="shrink-0 rounded-md bg-[#EF3E36] px-2.5 py-1 text-[11px] font-black text-white cursor-pointer"
            >
              再保存画面を開く
            </button>
          </div>
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
            onOpeningLockChange={handleOpeningLockChange}
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
              disabled={!activeCapsule || isUpdating || isOpeningCapsule}
              data-testid="action-pass-button"
              className="toy-push-btn flex min-h-[44px] items-center justify-center gap-1.5 rounded-2xl bg-[#7DD3FC] py-2 px-2 text-xs font-black text-[#1E1B18] disabled:opacity-45 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5 stroke-[2.75] shrink-0" aria-hidden="true" />
              <span>パス(次へ)</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFeedback('放置オート開封タイマー（5/15/25分）をセット可能')}
              disabled={!activeCapsule || isUpdating || isOpeningCapsule}
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
              disabled={!activeCapsule || isUpdating || isOpeningCapsule}
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
              onClick={handleOpenSupplySheet}
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
              onClick={() => handleOpenCollectionDrawer(null)}
              data-testid="open-collection-drawer-button"
              className="toy-push-btn col-span-2 flex min-h-[50px] items-center justify-center gap-1.5 rounded-2xl bg-[#2563EB] py-2.5 px-2.5 text-xs sm:text-sm font-black text-white whitespace-nowrap cursor-pointer"
            >
              <Award className="h-4 w-4 stroke-[2.75] text-[#FFBE0B] shrink-0" aria-hidden="true" />
              <span>メダル図鑑</span>
              {totalMedalCount > 0 && (
                <span
                  data-testid="collection-count-badge"
                  className="rounded-full bg-[#FFBE0B] text-[#1E1B18] px-1.5 py-0.5 font-display text-[10px] font-bold"
                >
                  {totalMedalCount}
                </span>
              )}
            </button>
          </div>
        </footer>

        {/* 4. タスク補充ボトムシート（AI音声ボヤき・常連スタンプ8種・複数行テキスト一括補充） */}
        <TaskSupplySheet
          isOpen={isSupplySheetOpen}
          onClose={handleCloseSupplySheet}
          stamps={playerState.customStamps}
          isUpdating={isUpdating}
          onSupplyStamp={supplyStampCapsule}
          onSupplyCapsules={supplyCapsules}
          onSupplySuccess={handleSupplySuccess}
        />

        {/* 5. カプセル開封・AI記念メダル獲得モーダル（FR-13, FR-14） */}
        <MedalRevealModal
          isOpen={Boolean(revealState?.isOpen)}
          onClose={handleCloseRevealModal}
          onOpenCollection={handleOpenCollectionFromModal}
          canOpenCollection={Boolean(
            revealState?.hasPersistedInDb && !revealState?.saveError && !revealState?.isSaving,
          )}
          taskTitle={revealState?.taskTitle ?? ''}
          rarity={revealState?.rarity ?? 'N'}
          coinsEarned={revealState?.coinsEarned ?? 30}
          todayCombo={revealState?.todayCombo}
          medal={revealState?.medal ?? null}
          imageUrl={revealState?.imageUrl ?? null}
          isGenerating={Boolean(revealState?.isGenerating)}
          statusNote={revealState?.statusNote}
          saveError={revealState?.saveError}
          isSaving={Boolean(revealState?.isSaving)}
          onRetrySave={handleRetrySaveMedal}
        />

        {/* 6. メダルコレクション棚（図鑑ドロワー・レア度別/日付順・詳細表示）（FR-13, FR-16） */}
        <MedalCollectionDrawer
          isOpen={isCollectionDrawerOpen}
          onClose={handleCloseCollectionDrawer}
          medals={medals}
          totalMedalCount={totalMedalCount}
          totalCracked={playerState.totalCracked}
          sortOrder={sortOrder}
          rarityFilter={rarityFilter}
          isLoading={isMedalsLoading}
          onChangeSortOrder={setSortOrder}
          onChangeRarityFilter={handleChangeRarityFilter}
          loadMedalImage={loadMedalImage}
          initialSelectedMedalId={selectedCollectionMedalId}
          onSelectMedal={updateSelectedCollectionMedalId}
        />
      </main>
    </div>
  );
};
