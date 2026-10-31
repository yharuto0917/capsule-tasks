import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Award, Calendar, Filter, Sparkles, Trophy, X } from 'lucide-react';
import {
  MEDAL_RARITY_STYLE_MAP,
  createFallbackMedalSvgDataUrl,
} from '../../server/lib/medal-frames';
import type { MedalItem, MedalRarity } from '../../shared/schemas';
import type { MedalSortOrder, StoredMedalImageRecord } from '../lib/indexed-db';

export interface MedalCollectionDrawerProps {
  /** ドロワーの表示状態 */
  isOpen: boolean;
  /** ドロワーを閉じるコールバック */
  onClose: () => void;
  /** ソート・フィルタ適用済みのメダル一覧 */
  medals: MedalItem[];
  /** 保存されている全メダル総数（フィルタ前） */
  totalMedalCount: number;
  /** 累計開封カプセル数（PlayerState.totalCracked） */
  totalCracked?: number;
  /** 現在のソート順 */
  sortOrder: MedalSortOrder;
  /** 現在のレア度フィルタ */
  rarityFilter: MedalRarity | 'ALL';
  /** 読み込み中フラグ */
  isLoading?: boolean;
  /** ソート順変更ハンドラ */
  onChangeSortOrder: (order: MedalSortOrder) => void;
  /** レア度フィルタ変更ハンドラ */
  onChangeRarityFilter: (filter: MedalRarity | 'ALL') => void;
  /** IndexedDB から画像レコードを取得する関数 */
  loadMedalImage?: (imageBlobKey: string) => Promise<StoredMedalImageRecord | null>;
  /** ドロワーを開いた際に初期選択する medalId */
  initialSelectedMedalId?: string | null;
  /** ドロワー内でメダル選択状態が変更された際のコールバック */
  onSelectMedal?: (medalId: string | null) => void;
}

const RARITY_FILTER_OPTIONS: Array<{ value: MedalRarity | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'すべて' },
  { value: 'SSR', label: 'SSR' },
  { value: 'SR', label: 'SR' },
  { value: 'R', label: 'R' },
  { value: 'N', label: 'N' },
];

function formatUnlockedDate(isoString: string): string {
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return isoString;
  }
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  const hh = String(parsed.getHours()).padStart(2, '0');
  const mm = String(parsed.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function resolveImageRecordToUrl(
  record: StoredMedalImageRecord | null,
  createdObjectUrls: string[],
): string | null {
  if (!record || !record.imageData) return null;
  if (typeof record.imageData === 'string') {
    const trimmed = record.imageData.trim();
    if (!trimmed) return null;
    if (
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://')
    ) {
      return trimmed;
    }
    const mime = record.mimeType || 'image/jpeg';
    return `data:${mime};base64,${trimmed}`;
  }
  if (
    typeof Blob !== 'undefined' &&
    record.imageData instanceof Blob &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    try {
      const objUrl = URL.createObjectURL(record.imageData);
      createdObjectUrls.push(objUrl);
      return objUrl;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * メダルコレクション棚（図鑑ドロワー・基本版）（3. ④ / Task 1.6）
 * - IndexedDB に保存された獲得記念メダルを「日付順」「レア度別（ソート＆フィルタ）」で一覧・詳細鑑賞できる。
 */
export const MedalCollectionDrawer: React.FC<MedalCollectionDrawerProps> = ({
  isOpen,
  onClose,
  medals,
  totalMedalCount,
  totalCracked,
  sortOrder,
  rarityFilter,
  isLoading = false,
  onChangeSortOrder,
  onChangeRarityFilter,
  loadMedalImage,
  initialSelectedMedalId = null,
  onSelectMedal,
}) => {
  const currentContextKey = `${isOpen}:${initialSelectedMedalId ?? ''}`;
  const [selectionState, setSelectionState] = useState<{
    contextKey: string;
    medalId: string | null;
  }>({
    contextKey: currentContextKey,
    medalId: initialSelectedMedalId,
  });
  const selectedMedalId =
    selectionState.contextKey === currentContextKey
      ? selectionState.medalId
      : initialSelectedMedalId;
  const setSelectedMedalId = (medalId: string | null) => {
    setSelectionState({ contextKey: currentContextKey, medalId });
    onSelectMedal?.(medalId);
  };

  const [imageUrlByBlobKey, setImageUrlByBlobKey] = useState<Record<string, string>>({});
  const createdObjectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      for (const objUrl of createdObjectUrlsRef.current) {
        try {
          URL.revokeObjectURL(objUrl);
        } catch {
          // ignore
        }
      }
      createdObjectUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !loadMedalImage || medals.length === 0) return;
    let cancelled = false;

    const loadMissingImages = async () => {
      const entriesToLoad = medals.filter((m) => !imageUrlByBlobKey[m.imageBlobKey]);
      if (entriesToLoad.length === 0) return;

      const loadedPairs: Array<[string, string]> = [];
      for (const item of entriesToLoad) {
        try {
          const record = await loadMedalImage(item.imageBlobKey);
          if (cancelled) return;
          const resolvedUrl = resolveImageRecordToUrl(record, createdObjectUrlsRef.current);
          if (resolvedUrl) {
            loadedPairs.push([item.imageBlobKey, resolvedUrl]);
          }
        } catch {
          // 個別の画像取得失敗時はフォールバックSVGを使用する
        }
      }

      if (!cancelled && loadedPairs.length > 0) {
        setImageUrlByBlobKey((prev) => {
          const next = { ...prev };
          for (const [key, url] of loadedPairs) {
            next[key] = url;
          }
          return next;
        });
      }
    };

    void loadMissingImages();

    return () => {
      cancelled = true;
    };
  }, [imageUrlByBlobKey, isOpen, loadMedalImage, medals]);

  const selectedMedal = useMemo(() => {
    if (!selectedMedalId) return null;
    return medals.find((m) => m.medalId === selectedMedalId) ?? null;
  }, [medals, selectedMedalId]);

  if (!isOpen) {
    return null;
  }

  const getMedalDisplayUrl = (medal: MedalItem): string => {
    return (
      imageUrlByBlobKey[medal.imageBlobKey] ??
      createFallbackMedalSvgDataUrl(medal.rarity, medal.engravedText)
    );
  };

  const isDateSort = sortOrder === 'date-desc' || sortOrder === 'date-asc';
  const isRaritySort = sortOrder === 'rarity-desc' || sortOrder === 'rarity-asc';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="メダルコレクション棚"
      data-testid="medal-collection-drawer"
      className="absolute inset-0 z-40 flex flex-col justify-end bg-black/55 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="toy-cream-panel relative flex h-[90%] w-full flex-col overflow-hidden rounded-t-[32px] border-t-4 border-[#1E1B18] bg-[#FFF8EC] px-3.5 pt-3 pb-4 shadow-[0_-8px_28px_rgba(0,0,0,0.35)]">
        {/* 上部ドラッグバー装飾 */}
        <div className="mx-auto mb-2 h-1.5 w-12 shrink-0 rounded-full bg-[#1E1B18]/25" />

        {/* ヘッダー：タイトル・獲得総数・閉じるボタン */}
        <div className="flex shrink-0 items-center justify-between gap-2 pb-2.5 border-b-2 border-[#1E1B18]/15">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border-2 border-[#1E1B18] bg-[#2563EB] text-[#FFBE0B] shadow-[0_2px_0_#1E1B18]">
              <Trophy className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-toy text-sm sm:text-base font-bold text-[#1E1B18] leading-tight">
                記念メダルコレクション棚
              </h2>
              <p
                data-testid="collection-stats-summary"
                className="text-[11px] font-bold text-[#57534E]"
              >
                獲得メダル: <span className="font-black text-[#1E1B18]">{totalMedalCount}</span> 枚
                {typeof totalCracked === 'number' && (
                  <>
                    {' '}
                    / 累計開封: <span className="font-black text-[#1E1B18]">{totalCracked}</span> 個
                  </>
                )}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="メダル図鑑を閉じる"
            data-testid="close-collection-drawer-button"
            className="toy-push-btn flex h-9 w-9 items-center justify-center rounded-xl bg-[#FFE2DE] text-[#1E1B18] cursor-pointer"
          >
            <X className="h-4 w-4 stroke-[2.75]" aria-hidden="true" />
          </button>
        </div>

        {/* ソート順切り替え（日付順 / レア度別）＆ レア度フィルタバー */}
        <div className="mt-2.5 shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-xs font-black text-[#1E1B18]">
              <Filter className="h-3.5 w-3.5 stroke-[2.75] text-[#2563EB]" aria-hidden="true" />
              <span>並び順</span>
            </div>

            <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="メダル並び順">
              <button
                type="button"
                onClick={() => onChangeSortOrder('date-desc')}
                data-testid="collection-sort-date"
                aria-pressed={isDateSort}
                className={`toy-push-btn flex items-center justify-center gap-1 rounded-xl px-2.5 py-1 text-[11px] font-black cursor-pointer ${
                  isDateSort ? 'bg-[#FFBE0B] text-[#1E1B18]' : 'bg-white text-[#57534E]'
                }`}
              >
                <Calendar className="h-3 w-3 stroke-[2.5]" aria-hidden="true" />
                <span>日付順</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeSortOrder('rarity-desc')}
                data-testid="collection-sort-rarity"
                aria-pressed={isRaritySort}
                className={`toy-push-btn flex items-center justify-center gap-1 rounded-xl px-2.5 py-1 text-[11px] font-black cursor-pointer ${
                  isRaritySort ? 'bg-[#FFBE0B] text-[#1E1B18]' : 'bg-white text-[#57534E]'
                }`}
              >
                <Sparkles className="h-3 w-3 stroke-[2.5]" aria-hidden="true" />
                <span>レア度順</span>
              </button>
            </div>
          </div>

          {/* レア度別フィルタピル（ALL / SSR / SR / R / N） */}
          <div role="group" aria-label="レア度フィルタ" className="grid grid-cols-5 gap-1.5">
            {RARITY_FILTER_OPTIONS.map((opt) => {
              const isSelected = rarityFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChangeRarityFilter(opt.value)}
                  data-testid={`collection-filter-${opt.value}`}
                  aria-pressed={isSelected}
                  className={`toy-push-btn flex min-h-[34px] items-center justify-center rounded-xl px-1.5 py-1 font-display text-[11px] font-black cursor-pointer ${
                    isSelected
                      ? 'bg-[#1E1B18] text-[#FFBE0B]'
                      : 'bg-white text-[#1E1B18] hover:bg-[#FFF0B3]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* メインスクロール領域：詳細ビュー（選択時）＋ メダルグリッド一覧 */}
        <div className="mt-2.5 flex-1 space-y-3 overflow-y-auto pr-0.5">
          {/* 選択されたメダルの詳細ショーケースカード */}
          {selectedMedal && (
            <section
              aria-label="選択中のメダル詳細"
              data-testid="collection-medal-detail"
              className="rounded-2xl border-3 border-[#1E1B18] bg-white p-3 shadow-[0_4px_0_#1E1B18]"
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  data-testid="detail-medal-rarity"
                  className={`inline-flex items-center gap-1 rounded-full border-2 border-[#1E1B18] px-2.5 py-0.5 font-display text-[10px] font-black ${
                    MEDAL_RARITY_STYLE_MAP[selectedMedal.rarity].badgeBgClass
                  }`}
                >
                  {MEDAL_RARITY_STYLE_MAP[selectedMedal.rarity].badgeLabel}
                </span>

                <button
                  type="button"
                  onClick={() => setSelectedMedalId(null)}
                  aria-label="メダル詳細を閉じる"
                  data-testid="close-medal-detail-button"
                  className="rounded-lg border-2 border-[#1E1B18] bg-[#FFE2DE] px-2 py-0.5 text-[10px] font-black text-[#1E1B18] cursor-pointer"
                >
                  閉じる
                </button>
              </div>

              <div className="mt-2 flex items-center gap-3">
                <div
                  className={`h-24 w-24 shrink-0 overflow-hidden rounded-2xl border-3 border-[#1E1B18] p-1 ${
                    MEDAL_RARITY_STYLE_MAP[selectedMedal.rarity].frameBorderClass
                  }`}
                >
                  <img
                    src={getMedalDisplayUrl(selectedMedal)}
                    alt={selectedMedal.medalName}
                    data-testid="detail-medal-image"
                    className="h-full w-full rounded-xl object-cover"
                  />
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <h3
                    data-testid="detail-medal-name"
                    className="font-toy text-xs sm:text-sm font-bold text-[#1E1B18] leading-snug"
                  >
                    {selectedMedal.medalName}
                  </h3>

                  <div className="inline-block rounded-lg border border-[#1E1B18] bg-[#1E1B18] px-2 py-0.5">
                    <span
                      data-testid="detail-engraved-text"
                      className="font-display text-[11px] font-bold tracking-wider text-[#FFBE0B]"
                    >
                      {selectedMedal.engravedText}
                    </span>
                  </div>

                  <p className="text-[11px] font-bold text-[#57534E] truncate">
                    達成タスク:{' '}
                    <span data-testid="detail-task-title" className="font-black text-[#1E1B18]">
                      {selectedMedal.taskTitle}
                    </span>
                  </p>

                  <p
                    data-testid="detail-unlocked-at"
                    className="text-[10px] font-bold text-[#78716C]"
                  >
                    獲得日時: {formatUnlockedDate(selectedMedal.unlockedAt)}
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* メダル一覧グリッド */}
          {isLoading && medals.length === 0 ? (
            <div
              data-testid="collection-loading-state"
              className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#1E1B18]/40 bg-white/70 py-10 text-center"
            >
              <p className="text-xs font-black text-[#57534E]">メダル図鑑を読み込み中...</p>
            </div>
          ) : medals.length === 0 ? (
            <div
              data-testid="collection-empty-state"
              className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#1E1B18]/40 bg-white/75 px-4 py-10 text-center"
            >
              <Award className="h-10 w-10 text-[#D97706]" aria-hidden="true" />
              <p className="text-xs font-black text-[#1E1B18]">
                {rarityFilter === 'ALL'
                  ? 'まだ獲得した記念メダルがありません。カプセルを割って最初のメダルを手に入れよう！'
                  : `レア度「${rarityFilter}」のメダルはまだ獲得していません。`}
              </p>
            </div>
          ) : (
            <div
              data-testid="collection-medal-grid"
              className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pb-2"
            >
              {medals.map((medal) => {
                const rarityStyle =
                  MEDAL_RARITY_STYLE_MAP[medal.rarity] ?? MEDAL_RARITY_STYLE_MAP.N;
                const isSelected = selectedMedal?.medalId === medal.medalId;
                return (
                  <button
                    key={medal.medalId}
                    type="button"
                    onClick={() => setSelectedMedalId(medal.medalId)}
                    data-testid={`collection-medal-card-${medal.medalId}`}
                    data-medal-id={medal.medalId}
                    data-medal-rarity={medal.rarity}
                    className={`toy-push-btn flex flex-col items-center rounded-2xl bg-white p-2 text-left transition cursor-pointer ${
                      isSelected ? 'ring-3 ring-[#2563EB] bg-[#EFF6FF]' : ''
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-1 mb-1">
                      <span
                        className={`rounded-full border border-[#1E1B18] px-1.5 py-0.2 font-display text-[10px] font-black ${rarityStyle.badgeBgClass}`}
                      >
                        {medal.rarity}
                      </span>
                      <span className="text-[9px] font-bold text-[#78716C] truncate">
                        {formatUnlockedDate(medal.unlockedAt).split(' ')[0]}
                      </span>
                    </div>

                    <div
                      className={`h-24 w-24 overflow-hidden rounded-2xl border-2 border-[#1E1B18] p-1 ${rarityStyle.frameBorderClass}`}
                    >
                      <img
                        src={getMedalDisplayUrl(medal)}
                        alt={medal.medalName}
                        data-testid={`collection-medal-image-${medal.medalId}`}
                        className="h-full w-full rounded-xl object-cover"
                      />
                    </div>

                    <span
                      data-testid={`collection-medal-engraved-${medal.medalId}`}
                      className="mt-1.5 w-full truncate rounded-md bg-[#1E1B18] px-1.5 py-0.5 text-center font-display text-[10px] font-bold tracking-wider text-[#FFBE0B]"
                    >
                      {medal.engravedText}
                    </span>

                    <span
                      data-testid={`collection-medal-title-${medal.medalId}`}
                      className="mt-1 w-full truncate text-center text-[11px] font-black text-[#1E1B18]"
                    >
                      {medal.taskTitle}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
