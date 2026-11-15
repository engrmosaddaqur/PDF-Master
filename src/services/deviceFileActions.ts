import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { cloneBuffer } from './pdfEngine';

export interface AppToastDetail {
  message: string;
  variant?: 'success' | 'info' | 'error';
  shareFile?: {
    buf: ArrayBuffer;
    filename: string;
    mime: string;
  };
}

export function emitAppToast(detail: AppToastDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppToastDetail>('pm-app-toast', { detail }));
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return cleaned || `document_${Date.now()}.pdf`;
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function ensureNativeFilesystemPermissions(): Promise<void> {
  try {
    const status = await Filesystem.checkPermissions();
    if (status.publicStorage !== 'granted') {
      await Filesystem.requestPermissions().catch(() => null);
    }
  } catch {
    // Scoped storage on Android 11+ does not require legacy permission for App/Documents
  }
}

/**
 * Quietly mirrors newly created/saved PDFs to Android Documents/PDF MASTER/
 * so created files are always accessible in phone local storage.
 */
export async function syncFileToNativeDocuments(
  buf: ArrayBuffer,
  filename: string
): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const safeName = sanitizeFilename(filename);
    await ensureNativeFilesystemPermissions();
    const res = await Filesystem.writeFile({
      path: `PDF MASTER/${safeName}`,
      data: bufferToBase64(buf),
      directory: Directory.Documents,
      recursive: true,
    });
    return res.uri;
  } catch {
    return null;
  }
}

/**
 * Saves/Downloads an ArrayBuffer cleanly on both Native Android/iOS (Capacitor)
 * and Desktop/Mobile Web browsers.
 */
export async function saveBufferToDeviceStorage(
  buf: ArrayBuffer,
  filename: string,
  mime = 'application/pdf'
): Promise<void> {
  const safeName = sanitizeFilename(filename);
  const safeBuf = cloneBuffer(buf);

  if (Capacitor.isNativePlatform()) {
    const b64 = bufferToBase64(safeBuf);
    await ensureNativeFilesystemPermissions();

    // 1. Primary: write directly into device Documents/PDF MASTER/
    try {
      await Filesystem.writeFile({
        path: `PDF MASTER/${safeName}`,
        data: b64,
        directory: Directory.Documents,
        recursive: true,
      });
      emitAppToast({
        message: `Saved to Documents/PDF MASTER/${safeName}`,
        variant: 'success',
        shareFile: { buf: safeBuf, filename: safeName, mime },
      });
      return;
    } catch {
      // Fallback below
    }

    // 2. Fallback: write to ExternalStorage or Cache & open native Save/Share chooser
    try {
      await Filesystem.writeFile({
        path: safeName,
        data: b64,
        directory: Directory.Cache,
        recursive: true,
      });
      const uriRes = await Filesystem.getUri({
        directory: Directory.Cache,
        path: safeName,
      });
      await Share.share({
        title: safeName,
        text: safeName,
        url: uriRes.uri,
        dialogTitle: 'Save or Share File',
      });
      emitAppToast({
        message: `Ready to save ${safeName}`,
        variant: 'info',
      });
      return;
    } catch (err) {
      emitAppToast({
        message: err instanceof Error ? err.message : 'Failed to save file to device storage.',
        variant: 'error',
      });
      return;
    }
  }

  // Standard Web Browser download
  try {
    const blob = new Blob([safeBuf], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 10000);
    emitAppToast({
      message: `Downloaded ${safeName}`,
      variant: 'success',
    });
  } catch (err) {
    emitAppToast({
      message: err instanceof Error ? err.message : 'Download failed.',
      variant: 'error',
    });
  }
}

/**
 * Shares a file via Android/iOS native Share Sheet (Capacitor Share + Cache FileProvider)
 * or Web Share API on supported browsers, with download fallback.
 */
export async function shareBufferNativeOrWeb(
  buf: ArrayBuffer,
  filename: string,
  mime = 'application/pdf'
): Promise<void> {
  const safeName = sanitizeFilename(filename);
  const safeBuf = cloneBuffer(buf);

  if (Capacitor.isNativePlatform()) {
    try {
      const b64 = bufferToBase64(safeBuf);
      await Filesystem.writeFile({
        path: safeName,
        data: b64,
        directory: Directory.Cache,
        recursive: true,
      });
      const uriRes = await Filesystem.getUri({
        directory: Directory.Cache,
        path: safeName,
      });
      await Share.share({
        title: safeName,
        text: safeName,
        url: uriRes.uri,
        dialogTitle: 'Share PDF',
      });
      return;
    } catch (err) {
      // User dismissed share sheet or share unavailable; ignore cancellation
      const msg = err instanceof Error ? err.message : '';
      if (/cancel/i.test(msg)) return;
    }
    await saveBufferToDeviceStorage(safeBuf, safeName, mime);
    return;
  }

  // Web Share API (file sharing)
  try {
    const file = new File([safeBuf], safeName, { type: mime });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: safeName, files: [file] });
      return;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
  }

  await saveBufferToDeviceStorage(safeBuf, safeName, mime);
}
