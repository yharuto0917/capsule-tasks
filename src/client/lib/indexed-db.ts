import { isValidMedalRarity, type MedalItem, type MedalRarity } from '../../shared/schemas';
import { MEDAL_RARITY_ORDER_WEIGHT } from './rarity-calculator';

export const MEDAL_DB_NAME = 'capsule_tasks_medal_db';
export const MEDAL_DB_VERSION = 1;
export const MEDAL_METADATA_STORE = 'medals';
export const MEDAL_IMAGE_STORE = 'medal_images';

export type MedalSortOrder = 'date-desc' | 'date-asc' | 'rarity-desc' | 'rarity-asc';

export interface StoredMedalImageRecord {
  imageBlobKey: string;
  /** Base64 Data URL または Blob */
  imageData: Blob | string;
  mimeType: string;
  updatedAt: string;
}

export interface SaveMedalWithImageInput {
  medal: MedalItem;
  imageData?: Blob | string;
  mimeType?: string;
}

export interface MedalWithImageResult {
  medal: MedalItem;
  imageData: Blob | string | null;
  mimeType: string | null;
}

/**
 * IndexedDB が利用できない環境（プライベートブラウジング制限時など）や
 * 一時的な open 失敗時でも同一の非同期APIで動作・検証できるよう、
 * インメモリフォールバックストアを備える。次回 open 成功時には IndexedDB へ自動移行する。
 */
const memoryMedalStore = new Map<string, MedalItem>();
const memoryImageStore = new Map<string, StoredMedalImageRecord>();
const memoryDeletedMedalIds = new Map<string, number>();
let memoryMutationGeneration = 0;
let memoryClearGeneration = 0;

function hasPendingMemoryChanges(): boolean {
  return (
    memoryClearGeneration > 0 ||
    memoryDeletedMedalIds.size > 0 ||
    memoryMedalStore.size > 0 ||
    memoryImageStore.size > 0
  );
}

function hasNativeIndexedDB(): boolean {
  try {
    return (
      typeof globalThis !== 'undefined' &&
      Boolean(globalThis.indexedDB) &&
      typeof globalThis.indexedDB.open === 'function'
    );
  } catch {
    return false;
  }
}

function openNativeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(MEDAL_DB_NAME, MEDAL_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDAL_METADATA_STORE)) {
        const medalStore = db.createObjectStore(MEDAL_METADATA_STORE, {
          keyPath: 'medalId',
        });
        medalStore.createIndex('by_unlockedAt', 'unlockedAt', { unique: false });
        medalStore.createIndex('by_rarity', 'rarity', { unique: false });
      }
      if (!db.objectStoreNames.contains(MEDAL_IMAGE_STORE)) {
        db.createObjectStore(MEDAL_IMAGE_STORE, {
          keyPath: 'imageBlobKey',
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB のオープンに失敗しました'));
    request.onblocked = () =>
      reject(new Error('IndexedDB のアップグレードが別タブの接続によってブロックされました'));
  });
}

async function flushMemoryToDatabase(db: IDBDatabase): Promise<void> {
  while (hasPendingMemoryChanges()) {
    const targetClearGeneration = memoryClearGeneration;
    const shouldClear = targetClearGeneration > 0;
    const deletedEntries = Array.from(memoryDeletedMedalIds.entries());
    const deletedIdSet = new Set(deletedEntries.map(([id]) => id));
    const medalsToFlush = Array.from(memoryMedalStore.values());
    const flushedMedalMap = new Map(medalsToFlush.map((medal) => [medal.medalId, medal]));
    const imagesToFlush = Array.from(memoryImageStore.values());
    const flushedImageKeys = new Set(memoryImageStore.keys());

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([MEDAL_METADATA_STORE, MEDAL_IMAGE_STORE], 'readwrite');
      const medalStore = tx.objectStore(MEDAL_METADATA_STORE);
      const imageStore = tx.objectStore(MEDAL_IMAGE_STORE);

      if (shouldClear) {
        medalStore.clear();
        imageStore.clear();
        for (const medal of medalsToFlush) {
          medalStore.put(medal);
        }
        for (const imageRecord of imagesToFlush) {
          imageStore.put(imageRecord);
        }
      } else {
        for (const imageRecord of imagesToFlush) {
          imageStore.put(imageRecord);
        }

        const affectedMedalIds = new Set<string>([...deletedIdSet, ...flushedMedalMap.keys()]);

        for (const medalId of affectedMedalIds) {
          const wasDeleted = deletedIdSet.has(medalId);
          const newMedal = flushedMedalMap.get(medalId);
          const getExistingReq = medalStore.get(medalId);

          getExistingReq.onsuccess = () => {
            const existing = getExistingReq.result as MedalItem | undefined;

            if (wasDeleted && !newMedal) {
              if (existing && !flushedImageKeys.has(existing.imageBlobKey)) {
                imageStore.delete(existing.imageBlobKey);
              }
              medalStore.delete(medalId);
              return;
            }

            if (wasDeleted && newMedal) {
              if (existing && !flushedImageKeys.has(existing.imageBlobKey)) {
                imageStore.delete(existing.imageBlobKey);
              }
              if (!flushedImageKeys.has(newMedal.imageBlobKey)) {
                imageStore.delete(newMedal.imageBlobKey);
              }
              medalStore.put(newMedal);
              return;
            }

            if (newMedal) {
              medalStore.put(newMedal);
              if (existing && existing.imageBlobKey !== newMedal.imageBlobKey) {
                if (flushedImageKeys.has(newMedal.imageBlobKey)) {
                  if (!flushedImageKeys.has(existing.imageBlobKey)) {
                    imageStore.delete(existing.imageBlobKey);
                  }
                } else {
                  const getOldImgReq = imageStore.get(existing.imageBlobKey);
                  getOldImgReq.onsuccess = () => {
                    const oldImg = getOldImgReq.result as StoredMedalImageRecord | undefined;
                    if (oldImg) {
                      imageStore.put({
                        ...oldImg,
                        imageBlobKey: newMedal.imageBlobKey,
                        updatedAt: new Date().toISOString(),
                      });
                      if (!flushedImageKeys.has(existing.imageBlobKey)) {
                        imageStore.delete(existing.imageBlobKey);
                      }
                    }
                  };
                }
              }
            }
          };
        }
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('メモリデータのIndexedDB移行に失敗しました'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('メモリデータのIndexedDB移行が中断されました'));
    });

    if (shouldClear && memoryClearGeneration === targetClearGeneration) {
      memoryClearGeneration = 0;
    }
    for (const [deletedId, deletedGen] of deletedEntries) {
      if (memoryDeletedMedalIds.get(deletedId) === deletedGen) {
        memoryDeletedMedalIds.delete(deletedId);
      }
    }
    for (const medal of medalsToFlush) {
      if (memoryMedalStore.get(medal.medalId) === medal) {
        memoryMedalStore.delete(medal.medalId);
      }
    }
    for (const imageRecord of imagesToFlush) {
      if (memoryImageStore.get(imageRecord.imageBlobKey) === imageRecord) {
        memoryImageStore.delete(imageRecord.imageBlobKey);
      }
    }
  }
}

async function tryOpenNativeDatabase(): Promise<IDBDatabase | null> {
  if (!hasNativeIndexedDB()) return null;
  let db: IDBDatabase;
  try {
    db = await openNativeDatabase();
  } catch {
    return null;
  }

  try {
    await flushMemoryToDatabase(db);
    return db;
  } catch {
    db.close();
    return null;
  }
}

/**
 * メダル一覧を指定されたソート順（レア度順・日付順）およびレア度フィルタで整列する純粋関数
 */
export function sortAndFilterMedals(
  medals: readonly MedalItem[],
  sortOrder: MedalSortOrder = 'date-desc',
  filterRarity?: MedalRarity | 'ALL',
): MedalItem[] {
  const filtered =
    filterRarity && filterRarity !== 'ALL' && isValidMedalRarity(filterRarity)
      ? medals.filter((item) => item.rarity === filterRarity)
      : [...medals];

  return filtered.sort((a, b) => {
    const timeA = Date.parse(a.unlockedAt) || 0;
    const timeB = Date.parse(b.unlockedAt) || 0;
    const weightA = MEDAL_RARITY_ORDER_WEIGHT[a.rarity] ?? 0;
    const weightB = MEDAL_RARITY_ORDER_WEIGHT[b.rarity] ?? 0;

    switch (sortOrder) {
      case 'rarity-desc': {
        if (weightB !== weightA) return weightB - weightA;
        if (b.upgradeLevel !== a.upgradeLevel) return b.upgradeLevel - a.upgradeLevel;
        return timeB - timeA;
      }
      case 'rarity-asc': {
        if (weightA !== weightB) return weightA - weightB;
        if (a.upgradeLevel !== b.upgradeLevel) return a.upgradeLevel - b.upgradeLevel;
        return timeB - timeA;
      }
      case 'date-asc': {
        if (timeA !== timeB) return timeA - timeB;
        return weightB - weightA;
      }
      case 'date-desc':
      default: {
        if (timeB !== timeA) return timeB - timeA;
        return weightB - weightA;
      }
    }
  });
}

/**
 * MedalItem メタデータと生成メダル画像（Blob / Base64）を保存（新規または更新）する。
 * 既存メダルを更新する際に `imageBlobKey` が変更された場合は、古い画像レコードも自動削除する。
 */
export async function saveMedalWithImage({
  medal,
  imageData,
  mimeType = 'image/png',
}: SaveMedalWithImageInput): Promise<MedalItem> {
  const normalizedMedal: MedalItem = {
    ...medal,
    upgradeLevel: Number.isFinite(medal.upgradeLevel) ? medal.upgradeLevel : 0,
  };

  const db = await tryOpenNativeDatabase();
  if (!db) {
    // DB側の削除が完了するまで memoryDeletedMedalIds の記録は消さずに保持する
    const prev = memoryMedalStore.get(normalizedMedal.medalId);
    if (prev && prev.imageBlobKey !== normalizedMedal.imageBlobKey) {
      if (imageData !== undefined) {
        memoryImageStore.delete(prev.imageBlobKey);
      } else {
        const prevImage = memoryImageStore.get(prev.imageBlobKey);
        if (prevImage) {
          memoryImageStore.set(normalizedMedal.imageBlobKey, {
            ...prevImage,
            imageBlobKey: normalizedMedal.imageBlobKey,
            updatedAt: new Date().toISOString(),
          });
          memoryImageStore.delete(prev.imageBlobKey);
        }
      }
    }
    memoryMedalStore.set(normalizedMedal.medalId, normalizedMedal);
    if (imageData !== undefined) {
      memoryImageStore.set(normalizedMedal.imageBlobKey, {
        imageBlobKey: normalizedMedal.imageBlobKey,
        imageData,
        mimeType,
        updatedAt: new Date().toISOString(),
      });
    }
    return normalizedMedal;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([MEDAL_METADATA_STORE, MEDAL_IMAGE_STORE], 'readwrite');
      const medalStore = tx.objectStore(MEDAL_METADATA_STORE);
      const imageStore = tx.objectStore(MEDAL_IMAGE_STORE);

      const getExistingReq = medalStore.get(normalizedMedal.medalId);
      getExistingReq.onsuccess = () => {
        const existing = getExistingReq.result as MedalItem | undefined;
        medalStore.put(normalizedMedal);

        if (imageData !== undefined) {
          if (existing && existing.imageBlobKey !== normalizedMedal.imageBlobKey) {
            imageStore.delete(existing.imageBlobKey);
          }
          const imageRecord: StoredMedalImageRecord = {
            imageBlobKey: normalizedMedal.imageBlobKey,
            imageData,
            mimeType,
            updatedAt: new Date().toISOString(),
          };
          imageStore.put(imageRecord);
        } else if (existing && existing.imageBlobKey !== normalizedMedal.imageBlobKey) {
          const getOldImgReq = imageStore.get(existing.imageBlobKey);
          getOldImgReq.onsuccess = () => {
            const oldImg = getOldImgReq.result as StoredMedalImageRecord | undefined;
            if (oldImg) {
              imageStore.put({
                ...oldImg,
                imageBlobKey: normalizedMedal.imageBlobKey,
                updatedAt: new Date().toISOString(),
              });
              imageStore.delete(existing.imageBlobKey);
            }
          };
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('メダルデータの保存に失敗しました'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('メダルデータの保存トランザクションが中断されました'));
    });
    return normalizedMedal;
  } finally {
    db.close();
  }
}

/**
 * 保存されている全 MedalItem を取得し、指定されたソート順で返す
 */
export async function listMedals(
  sortOrder: MedalSortOrder = 'date-desc',
  filterRarity?: MedalRarity | 'ALL',
): Promise<MedalItem[]> {
  const db = await tryOpenNativeDatabase();
  if (!db) {
    const items = Array.from(memoryMedalStore.values());
    return sortAndFilterMedals(items, sortOrder, filterRarity);
  }

  try {
    const rawItems = await new Promise<MedalItem[]>((resolve, reject) => {
      const tx = db.transaction(MEDAL_METADATA_STORE, 'readonly');
      const request = tx.objectStore(MEDAL_METADATA_STORE).getAll();
      request.onsuccess = () => resolve((request.result as MedalItem[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error('メダル一覧の取得に失敗しました'));
      tx.onabort = () => reject(tx.error ?? new Error('メダル一覧の取得が中断されました'));
    });
    return sortAndFilterMedals(rawItems, sortOrder, filterRarity);
  } finally {
    db.close();
  }
}

/**
 * 指定した `medalId` の MedalItem と紐づく画像データを取得する
 */
export async function getMedalWithImage(medalId: string): Promise<MedalWithImageResult | null> {
  const db = await tryOpenNativeDatabase();
  if (!db) {
    const medal = memoryMedalStore.get(medalId);
    if (!medal) return null;
    const imgRecord = memoryImageStore.get(medal.imageBlobKey);
    return {
      medal,
      imageData: imgRecord?.imageData ?? null,
      mimeType: imgRecord?.mimeType ?? null,
    };
  }

  try {
    return await new Promise<MedalWithImageResult | null>((resolve, reject) => {
      const tx = db.transaction([MEDAL_METADATA_STORE, MEDAL_IMAGE_STORE], 'readonly');
      const medalReq = tx.objectStore(MEDAL_METADATA_STORE).get(medalId);

      medalReq.onsuccess = () => {
        const medal = medalReq.result as MedalItem | undefined;
        if (!medal) {
          resolve(null);
          return;
        }
        const imgReq = tx.objectStore(MEDAL_IMAGE_STORE).get(medal.imageBlobKey);
        imgReq.onsuccess = () => {
          const imgRecord = imgReq.result as StoredMedalImageRecord | undefined;
          resolve({
            medal,
            imageData: imgRecord?.imageData ?? null,
            mimeType: imgRecord?.mimeType ?? null,
          });
        };
        imgReq.onerror = () => reject(imgReq.error ?? new Error('メダル画像の取得に失敗しました'));
      };
      medalReq.onerror = () =>
        reject(medalReq.error ?? new Error('メダルメタデータの取得に失敗しました'));
      tx.onabort = () => reject(tx.error ?? new Error('メダル詳細の取得が中断されました'));
    });
  } finally {
    db.close();
  }
}

/**
 * 指定した `imageBlobKey` の画像データ（Blob / Base64）を単体取得する
 */
export async function getMedalImageByKey(
  imageBlobKey: string,
): Promise<StoredMedalImageRecord | null> {
  const db = await tryOpenNativeDatabase();
  if (!db) {
    return memoryImageStore.get(imageBlobKey) ?? null;
  }

  try {
    return await new Promise<StoredMedalImageRecord | null>((resolve, reject) => {
      const tx = db.transaction(MEDAL_IMAGE_STORE, 'readonly');
      const req = tx.objectStore(MEDAL_IMAGE_STORE).get(imageBlobKey);
      req.onsuccess = () => resolve((req.result as StoredMedalImageRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('画像データの取得に失敗しました'));
      tx.onabort = () => reject(tx.error ?? new Error('画像データの取得が中断されました'));
    });
  } finally {
    db.close();
  }
}

/**
 * 指定した `medalId` のメダルと紐づく画像を削除する
 */
export async function deleteMedalById(medalId: string): Promise<void> {
  const db = await tryOpenNativeDatabase();
  if (!db) {
    const existing = memoryMedalStore.get(medalId);
    if (existing) {
      memoryImageStore.delete(existing.imageBlobKey);
      memoryMedalStore.delete(medalId);
    }
    memoryDeletedMedalIds.set(medalId, ++memoryMutationGeneration);
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([MEDAL_METADATA_STORE, MEDAL_IMAGE_STORE], 'readwrite');
      const medalStore = tx.objectStore(MEDAL_METADATA_STORE);
      const imageStore = tx.objectStore(MEDAL_IMAGE_STORE);

      const getReq = medalStore.get(medalId);
      getReq.onsuccess = () => {
        const existing = getReq.result as MedalItem | undefined;
        if (existing) {
          imageStore.delete(existing.imageBlobKey);
        }
        medalStore.delete(medalId);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('メダルデータの削除に失敗しました'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('メダルデータの削除トランザクションが中断されました'));
    });
  } finally {
    db.close();
  }
}

/**
 * 全メダル・画像ストアをクリアする（テストおよび初期化用）
 */
export async function clearAllMedals(): Promise<void> {
  const clearGen = ++memoryMutationGeneration;
  memoryMedalStore.clear();
  memoryImageStore.clear();
  memoryDeletedMedalIds.clear();
  memoryClearGeneration = clearGen;

  if (!hasNativeIndexedDB()) {
    return;
  }

  let db: IDBDatabase;
  try {
    db = await openNativeDatabase();
  } catch {
    return;
  }

  try {
    await flushMemoryToDatabase(db);
  } finally {
    db.close();
  }
}
