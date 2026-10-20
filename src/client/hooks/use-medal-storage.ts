import { useCallback, useEffect, useMemo, useState } from 'react';
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

  const refreshMedals = useCallback(async (): Promise<MedalItem[]> => {
    setIsLoading(true);
    setError(null);
    try {
      const items = await listMedals('date-desc', 'ALL');
      setAllMedals(items);
      return sortAndFilterMedals(items, sortOrder, rarityFilter);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'メダル図鑑の読み込みに失敗しました';
      setError(message);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [rarityFilter, sortOrder]);

  useEffect(() => {
    if (!autoLoad) return;
    let cancelled = false;
    listMedals('date-desc', 'ALL')
      .then((items) => {
        if (!cancelled) {
          setAllMedals(items);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'メダル図鑑の読み込みに失敗しました');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [autoLoad]);

  const saveMedal = useCallback(async (input: SaveMedalWithImageInput): Promise<MedalItem> => {
    setError(null);
    const saved = await saveMedalWithImage(input);
    const updatedList = await listMedals('date-desc', 'ALL');
    setAllMedals(updatedList);
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
    await deleteMedalById(medalId);
    const updatedList = await listMedals('date-desc', 'ALL');
    setAllMedals(updatedList);
  }, []);

  const clearMedals = useCallback(async (): Promise<void> => {
    await clearAllMedals();
    setAllMedals([]);
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
