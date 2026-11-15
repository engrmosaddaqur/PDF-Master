import { createWorker } from 'tesseract.js';
import { getApiUrl } from './apiConfig';

export type OcrLanguage = 'eng' | 'ben' | 'eng+ben';

export async function runOnDeviceOcr(
  imageInput: string | HTMLCanvasElement,
  lang: OcrLanguage,
  onProgress?: (pct: number, status: string) => void
): Promise<string> {
  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (onProgress && typeof m.progress === 'number') {
        onProgress(Math.round(m.progress * 100), m.status || 'Recognizing...');
      }
    },
  });

  try {
    const {
      data: { text },
    } = await worker.recognize(imageInput);
    return text.trim();
  } finally {
    await worker.terminate();
  }
}

export async function runAiVisionOcr(
  imageBase64: string,
  lang: OcrLanguage
): Promise<string> {
  const res = await fetch(getApiUrl('/api/ai/ocr-vision'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64,
      mimeType: imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
      language: lang,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'AI Vision OCR failed');
  }
  return data.text || '';
}
