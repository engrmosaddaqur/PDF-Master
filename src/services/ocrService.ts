import { createWorker } from 'tesseract.js';

export type OcrLanguage = 'eng' | 'ben' | 'eng+ben';

export async function runOnDeviceOcr(
  imageInput: string | HTMLCanvasElement,
  lang: OcrLanguage,
  onProgress?: (pct: number, status: string) => void
): Promise<string> {
  const results = await runOnDeviceOcrBatch([imageInput], lang, (_idx, pct, status) => {
    onProgress?.(pct, status);
  });
  return results[0] || '';
}

export async function runOnDeviceOcrBatch(
  imageInputs: Array<string | HTMLCanvasElement>,
  lang: OcrLanguage,
  onPageProgress?: (pageIdx: number, pct: number, status: string) => void
): Promise<string[]> {
  if (imageInputs.length === 0) return [];

  let activeIdx = 0;
  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (onPageProgress && typeof m.progress === 'number') {
        onPageProgress(activeIdx, Math.round(m.progress * 100), m.status || 'Recognizing...');
      }
    },
  });

  try {
    const out: string[] = [];
    for (let i = 0; i < imageInputs.length; i++) {
      activeIdx = i;
      const {
        data: { text },
      } = await worker.recognize(imageInputs[i]);
      out.push(text.trim());
    }
    return out;
  } finally {
    await worker.terminate();
  }
}
