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
 * IndexedDB が利用できない環境（JSDOM 単体テスト環境やプライベートブラウジング制限時など）でも
 * 同一の非同期APIで動作・検証できるよう、インメモリフォールバックストアを備える。
 */
const memoryMedalStore = new Map<string, MedalItem>();
const memoryImageStore = new Map<string, StoredMedalImageRecord>();

function hasNativeIndexedDB(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
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
  });
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
 * MedalItem メタデータと生成メダル画像（Blob / Base64）を保存（新規または更新）する
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

  if (!hasNativeIndexedDB()) {
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

  const db = await openNativeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([MEDAL_METADATA_STORE, MEDAL_IMAGE_STORE], 'readwrite');
      tx.objectStore(MEDAL_METADATA_STORE).put(normalizedMedal);

      if (imageData !== undefined) {
        const imageRecord: StoredMedalImageRecord = {
          imageBlobKey: normalizedMedal.imageBlobKey,
          imageData,
          mimeType,
          updatedAt: new Date().toISOString(),
        };
        tx.objectStore(MEDAL_IMAGE_STORE).put(imageRecord);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('メダルデータの保存に失敗しました'));
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
  if (!hasNativeIndexedDB()) {
    const items = Array.from(memoryMedalStore.values());
    return sortAndFilterMedals(items, sortOrder, filterRarity);
  }

  const db = await openNativeDatabase();
  try {
    const rawItems = await new Promise<MedalItem[]>((resolve, reject) => {
      const tx = db.transaction(MEDAL_METADATA_STORE, 'readonly');
      const request = tx.objectStore(MEDAL_METADATA_STORE).getAll();
      request.onsuccess = () => resolve((request.result as MedalItem[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error('メダル一覧の取得に失敗しました'));
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
  if (!hasNativeIndexedDB()) {
    const medal = memoryMedalStore.get(medalId);
    if (!medal) return null;
    const imgRecord = memoryImageStore.get(medal.imageBlobKey);
    return {
      medal,
      imageData: imgRecord?.imageData ?? null,
      mimeType: imgRecord?.mimeType ?? null,
    };
  }

  const db = await openNativeDatabase();
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
  if (!hasNativeIndexedDB()) {
    return memoryImageStore.get(imageBlobKey) ?? null;
  }

  const db = await openNativeDatabase();
  try {
    return await new Promise<StoredMedalImageRecord | null>((resolve, reject) => {
      const tx = db.transaction(MEDAL_IMAGE_STORE, 'readonly');
      const req = tx.objectStore(MEDAL_IMAGE_STORE).get(imageBlobKey);
      req.onsuccess = () => resolve((req.result as StoredMedalImageRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('画像データの取得に失敗しました'));
    });
  } finally {
    db.close();
  }
}

/**
 * 指定した `medalId` のメダルと紐づく画像を削除する
 */
export async function deleteMedalById(medalId: string): Promise<void> {
  if (!hasNativeIndexedDB()) {
    const existing = memoryMedalStore.get(medalId);
    if (existing) {
      memoryImageStore.delete(existing.imageBlobKey);
      memoryMedalStore.delete(medalId);
    }
    return;
  }

  const db = await openNativeDatabase();
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
    });
  } finally {
    db.close();
  }
}

/**
 * 全メダル・画像ストアをクリアする（テストおよび初期化用）
 */
export async function clearAllMedals(): Promise<void> {
  memoryMedalStore.clear();
  memoryImageStore.clear();

  if (!hasNativeIndexedDB()) {
    return;
  }

  const db = await openNativeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([MEDAL_METADATA_STORE, MEDAL_IMAGE_STORE], 'readwrite');
      tx.objectStore(MEDAL_METADATA_STORE).clear();
      tx.objectStore(MEDAL_IMAGE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('メダルストアの初期化に失敗しました'));
    });
  } finally {
    db.close();
  }
}
