import type {
  AppSettings,
  DocumentRecord,
  FolderRecord,
  PdfEditorState,
  SavedSignature,
} from '../types';
import {
  cloneBuffer,
  createStarterSamplePdfs,
  renderPageThumbnail,
} from './pdfEngine';
import {
  saveBufferToDeviceStorage,
  syncFileToNativeDocuments,
} from './deviceFileActions';

const DB_NAME = 'pdf_master_vault_db';
const DB_VERSION = 1;
const STORE_DOCS = 'documents';
const STORE_FOLDERS = 'folders';
const STORE_SIGNATURES = 'signatures';
const SETTINGS_KEY = 'pdf_master_settings_v1';
const SEEDED_FLAG = 'pdf_master_seeded_v1';

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'en',
  theme: 'dark',
  defaultViewMode: 'continuous',
  defaultPageSize: 'A4',
  defaultFont: 'DM Sans',
  scannerAutoCrop: true,
  scannerDefaultFilter: 'magic',
  exportQuality: 'high',
  localOnlyMode: false,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function openVaultDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SIGNATURES)) {
        db.createObjectStore(STORE_SIGNATURES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => reject(req.error);
  });
}

async function putInStore<T>(storeName: string, item: T): Promise<void> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFromStore(storeName: string, id: string): Promise<void> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllDocuments(): Promise<DocumentRecord[]> {
  const docs = await getAllFromStore<DocumentRecord>(STORE_DOCS);
  return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const MAX_DOC_VERSIONS = 5;

export function cloneEditorState(state?: PdfEditorState | null): PdfEditorState | undefined {
  if (!state) return undefined;
  return {
    replacements: (state.replacements || []).map((r) => ({ ...r })),
    addedTexts: (state.addedTexts || []).map((tb) => ({ ...tb })),
    addedImages: (state.addedImages || []).map((im) => ({ ...im })),
    annotations: (state.annotations || []).map((an) => ({
      ...an,
      points: an.points ? an.points.map((pt) => ({ ...pt })) : undefined,
    })),
  };
}

export async function saveDocument(doc: DocumentRecord): Promise<void> {
  const safeDoc: DocumentRecord = {
    ...doc,
    pdfBytes: cloneBuffer(doc.pdfBytes),
    basePdfBytes: doc.basePdfBytes ? cloneBuffer(doc.basePdfBytes) : undefined,
    editorState: cloneEditorState(doc.editorState),
    versions: (doc.versions || []).slice(0, MAX_DOC_VERSIONS).map((v) => ({
      ...v,
      pdfBytes: cloneBuffer(v.pdfBytes),
      editorState: cloneEditorState(v.editorState),
    })),
  };
  await putInStore(STORE_DOCS, safeDoc);
  if (!safeDoc.isTrashed && !safeDoc.isVaultLocked) {
    void syncFileToNativeDocuments(safeDoc.pdfBytes, safeDoc.name);
  }
}

export async function deleteDocumentForever(id: string): Promise<void> {
  await deleteFromStore(STORE_DOCS, id);
}

export async function deleteAllDocuments(): Promise<void> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCS, 'readwrite');
    tx.objectStore(STORE_DOCS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllFolders(): Promise<FolderRecord[]> {
  const folders = await getAllFromStore<FolderRecord>(STORE_FOLDERS);
  return folders.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveFolder(folder: FolderRecord): Promise<void> {
  await putInStore(STORE_FOLDERS, folder);
}

export async function deleteFolder(id: string): Promise<void> {
  await deleteFromStore(STORE_FOLDERS, id);
}

export async function getAllSignatures(): Promise<SavedSignature[]> {
  const sigs = await getAllFromStore<SavedSignature>(STORE_SIGNATURES);
  return sigs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveSignature(sig: SavedSignature): Promise<void> {
  await putInStore(STORE_SIGNATURES, sig);
}

export async function deleteSignature(id: string): Promise<void> {
  await deleteFromStore(STORE_SIGNATURES, id);
}

export async function seedInitialDocumentsIfNeeded(): Promise<DocumentRecord[]> {
  const existing = await getAllDocuments();
  if (existing.length > 0 || localStorage.getItem(SEEDED_FLAG)) {
    return existing;
  }

  try {
    const samples = await createStarterSamplePdfs();
    const now = Date.now();
    const created: DocumentRecord[] = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const thumb = await renderPageThumbnail(s.pdfBytes, 1, 200).catch(() => undefined);
      const record: DocumentRecord = {
        id: `doc_seed_${now}_${i}`,
        name: s.name,
        origin: s.origin,
        createdAt: now - i * 60000,
        updatedAt: now - i * 60000,
        lastOpenedAt: now - i * 60000,
        sizeBytes: s.pdfBytes.byteLength,
        pageCount: s.pageCount,
        isStarred: i === 0,
        isShared: false,
        isTrashed: false,
        folderId: null,
        thumbnailDataUrl: thumb,
        pdfBytes: cloneBuffer(s.pdfBytes),
        bookmarks: [],
        versions: [
          {
            id: `ver_${now}_${i}`,
            timestamp: now - i * 60000,
            note: 'Initial document',
            sizeBytes: s.pdfBytes.byteLength,
            pdfBytes: cloneBuffer(s.pdfBytes),
          },
        ],
      };
      await saveDocument(record);
      created.push(record);
    }
    localStorage.setItem(SEEDED_FLAG, '1');
    return created;
  } catch (err) {
    console.warn('Could not seed starter PDFs:', err);
    return [];
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRelativeTime(timestamp: number, lang: 'en' | 'bn' = 'en'): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return lang === 'bn' ? 'এইমাত্র' : 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return lang === 'bn' ? `${mins} মি. আগে` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    return lang === 'bn'
      ? `${hrs} ঘণ্টা আগে`
      : `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(hrs / 24);
  if (days < 30) {
    return lang === 'bn'
      ? `${days} দিন আগে`
      : `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

export function downloadArrayBuffer(
  buf: ArrayBuffer,
  filename: string,
  mime = 'application/pdf'
) {
  void saveBufferToDeviceStorage(buf, filename, mime);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
