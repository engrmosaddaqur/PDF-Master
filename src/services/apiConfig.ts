import { Capacitor } from '@capacitor/core';

const DEFAULT_NATIVE_API_ORIGIN =
  'https://ais-pre-34oy47d7syqws5h4yn7suw-60182063165.asia-northeast1.run.app';

export function getApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const envOrigin = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');

  if (envOrigin) {
    return `${envOrigin}${normalizedPath}`;
  }

  if (Capacitor.isNativePlatform()) {
    return `${DEFAULT_NATIVE_API_ORIGIN}${normalizedPath}`;
  }

  return normalizedPath;
}
