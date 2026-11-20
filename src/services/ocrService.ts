import { createWorker } from 'tesseract.js';
import type { ExtractedTextRun } from '../types';

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

export async function detectOcrLineRuns(
  canvas: HTMLCanvasElement,
  pageNumber: number,
  pageWidthPt: number,
  pageHeightPt: number,
  existingRuns: ExtractedTextRun[],
  lang: OcrLanguage = 'eng+ben'
): Promise<ExtractedTextRun[]> {
  const worker = await createWorker(lang, 1);
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const scaleX = canvas.width / Math.max(1, pageWidthPt);
    const scaleY = canvas.height / Math.max(1, pageHeightPt);
    const discovered: ExtractedTextRun[] = [];
    let seq = 0;

    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const text = (line.text || '').replace(/\s+/g, ' ').trim();
          if (!text || line.confidence < 35) continue;
          if (text.length === 1 && /^[^\w\u0980-\u09FF]$/.test(text)) continue;

          const x = line.bbox.x0 / scaleX;
          const y = line.bbox.y0 / scaleY;
          const width = Math.max(8, (line.bbox.x1 - line.bbox.x0) / scaleX);
          const height = Math.max(8, (line.bbox.y1 - line.bbox.y0) / scaleY);
          if (height > 90 || height < 5) continue;

          const lineArea = width * height;
          const overlapsNative = existingRuns.some((ex) => {
            const ix1 = Math.max(x, ex.x);
            const iy1 = Math.max(y, ex.y);
            const ix2 = Math.min(x + width, ex.x + ex.width);
            const iy2 = Math.min(y + height, ex.y + ex.height);
            if (ix2 <= ix1 || iy2 <= iy1) return false;
            const inter = (ix2 - ix1) * (iy2 - iy1);
            return inter / lineArea > 0.4;
          });
          if (overlapsNative) continue;

          discovered.push({
            id: `ocr_${pageNumber}_${seq++}_${Date.now()}`,
            pageNumber,
            str: text,
            x,
            y,
            width,
            height,
            fontSize: Math.max(6, Math.min(44, Math.round(height * 0.78))),
            fontName: line.words?.[0]?.font_name || 'Arial',
          });
        }
      }
    }
    return discovered;
  } finally {
    await worker.terminate();
  }
}
