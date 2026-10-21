import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MedalItem, MedalRarity } from '../../shared/schemas';
import {
  clearAllMedals,
  deleteMedalById,
  getMedalImageByKey,
  getMedalWithImage,
  listMedals,
  saveMedalWithImage,
  sortAndFilterMedals,
  type MedalSortOrder,
  type MedalWithImageResult,
  type SaveMedalWithImageInput,
  type StoredMedalImageRecord,
} from '../lib/indexed-db';

export interface UseMedalStorageOptions {
  initialSortOrder?: MedalSortOrder;
  initialRarityFilter?: MedalRarity | 'ALL';
  /** 初回マウント時に自動で IndexedDB から一覧を読み込むか（デフォルト true） */
  autoLoad?: boolean;
}

export interface UseMedalStorageReturn {
  /** ソート・フィルタ適用済みのメダル一覧 */
  medals: MedalItem[];
  /** 保存されている全メダル件数（フィルタ前） */
  totalMedalCount: number;
  /** 現在のソート順（'date-desc' | 'date-asc' | 'rarity-desc' | 'rarity-asc'） */
  sortOrder: MedalSortOrder;
  /** 現在のレア度フィルタ（'ALL' | 'N' | 'R' | 'SR' | 'SSR'） */
  rarityFilter: MedalRarity | 'ALL';
  /** 読み込み中フラグ */
  isLoading: boolean;
  /** エラーメッセージ（正常時は null） */
  error: string | null;
  /** ソート順を変更する */
  setSortOrder: (order: MedalSortOrder) => void;
  /** レア度フィルタを変更する */
  setRarityFilter: (filter: MedalRarity | 'ALL') => void;
  /** IndexedDB から最新のメダル一覧を再取得する */
  refreshMedals: () => Promise<MedalItem[]>;
  /** 新規または更新メダルと画像（Blob / Base64）を IndexedDB に保存し、ステートを同期する */
  saveMedal: (input: SaveMedalWithImageInput) => Promise<MedalItem>;
  /** 指定した medalId のメダルと画像データを取得する */
  loadMedalDetail: (medalId: string) => Promise<MedalWithImageResult | null>;
  /** 指定した imageBlobKey の画像レコードを取得する */
  loadMedalImage: (imageBlobKey: string) => Promise<StoredMedalImageRecord | null>;
  /** 指定した medalId を削除する */
  removeMedal: (medalId: string) => Promise<void>;
  /** 全メダルデータを消去する */
  clearMedals: () => Promise<void>;
}

export function useMedalStorage(options: UseMedalStorageOptions = {}): UseMedalStorageReturn {
  const { initialSortOrder = 'date-desc', initialRarityFilter = 'ALL', autoLoad = true } = options;

  const [allMedals, setAllMedals] = useState<MedalItem[]>([]);
  const [sortOrder, setSortOrder] = useState<MedalSortOrder>(initialSortOrder);
  const [rarityFilter, setRarityFilter] = useState<MedalRarity | 'ALL'>(initialRarityFilter);
  const [isLoading, setIsLoading] = useState<boolean>(autoLoad);
  const [error, setError] = useState<string | null>(null);

  // 初回 autoLoad と saveMedal / removeMedal / clearMedals の完了順が前後しても、
  // 古い読み込み結果で最新の一覧を上書きしないためのリクエスト世代番号
  const requestIdRef = useRef<number>(0);

  const refreshMedals = useCallback(async (): Promise<MedalItem[]> => {
    const reqId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const items = await listMedals('date-desc', 'ALL');
      if (reqId === requestIdRef.current) {
        setAllMedals(items);
      }
      return sortAndFilterMedals(items, sortOrder, rarityFilter);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'メダル図鑑の読み込みに失敗しました';
      if (reqId === requestIdRef.current) {
        setError(message);
      }
      return [];
    } finally {
      if (reqId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [rarityFilter, sortOrder]);

  useEffect(() => {
    if (!autoLoad) return;
    let cancelled = false;
    const reqId = ++requestIdRef.current;

    listMedals('date-desc', 'ALL')
      .then((items) => {
        if (!cancelled && reqId === requestIdRef.current) {
          setAllMedals(items);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && reqId === requestIdRef.current) {
          setError(err instanceof Error ? err.message : 'メダル図鑑の読み込みに失敗しました');
        }
      })
      .finally(() => {
        if (!cancelled && reqId === requestIdRef.current) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [autoLoad]);

  const saveMedal = useCallback(async (input: SaveMedalWithImageInput): Promise<MedalItem> => {
    const reqId = ++requestIdRef.current;
    setError(null);
    const saved = await saveMedalWithImage(input);
    const updatedList = await listMedals('date-desc', 'ALL');
    if (reqId === requestIdRef.current) {
      setAllMedals(updatedList);
      setIsLoading(false);
    }
    return saved;
  }, []);

  const loadMedalDetail = useCallback(
    async (medalId: string): Promise<MedalWithImageResult | null> => {
      return getMedalWithImage(medalId);
    },
    [],
  );

  const loadMedalImage = useCallback(
    async (imageBlobKey: string): Promise<StoredMedalImageRecord | null> => {
      return getMedalImageByKey(imageBlobKey);
    },
    [],
  );

  const removeMedal = useCallback(async (medalId: string): Promise<void> => {
    const reqId = ++requestIdRef.current;
    await deleteMedalById(medalId);
    const updatedList = await listMedals('date-desc', 'ALL');
    if (reqId === requestIdRef.current) {
      setAllMedals(updatedList);
      setIsLoading(false);
    }
  }, []);

  const clearMedals = useCallback(async (): Promise<void> => {
    const reqId = ++requestIdRef.current;
    await clearAllMedals();
    if (reqId === requestIdRef.current) {
      setAllMedals([]);
      setIsLoading(false);
    }
  }, []);

  const medals = useMemo(
    () => sortAndFilterMedals(allMedals, sortOrder, rarityFilter),
    [allMedals, sortOrder, rarityFilter],
  );

  return {
    medals,
    totalMedalCount: allMedals.length,
    sortOrder,
    rarityFilter,
    isLoading,
    error,
    setSortOrder,
    setRarityFilter,
    refreshMedals,
    saveMedal,
    loadMedalDetail,
    loadMedalImage,
    removeMedal,
    clearMedals,
  };
}
