import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PageSizes,
} from 'pdf-lib';
import type {
  AddedImageOverlay,
  AddedTextBox,
  AnnotationOverlay,
  ExtractedTextRun,
  PaperDimension,
  PaperSizeKey,
  TextReplacementEdit,
} from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const PAPER_DIMENSIONS: Record<PaperSizeKey, PaperDimension> = {
  A0: { key: 'A0', label: 'A0 (841 × 1189 mm)', widthPt: PageSizes.A0[0], heightPt: PageSizes.A0[1], widthMm: 841, heightMm: 1189 },
  A1: { key: 'A1', label: 'A1 (594 × 841 mm)', widthPt: PageSizes.A1[0], heightPt: PageSizes.A1[1], widthMm: 594, heightMm: 841 },
  A2: { key: 'A2', label: 'A2 (420 × 594 mm)', widthPt: PageSizes.A2[0], heightPt: PageSizes.A2[1], widthMm: 420, heightMm: 594 },
  A3: { key: 'A3', label: 'A3 (297 × 420 mm)', widthPt: PageSizes.A3[0], heightPt: PageSizes.A3[1], widthMm: 297, heightMm: 420 },
  A4: { key: 'A4', label: 'A4 (210 × 297 mm)', widthPt: PageSizes.A4[0], heightPt: PageSizes.A4[1], widthMm: 210, heightMm: 297 },
  A5: { key: 'A5', label: 'A5 (148 × 210 mm)', widthPt: PageSizes.A5[0], heightPt: PageSizes.A5[1], widthMm: 148, heightMm: 210 },
  A6: { key: 'A6', label: 'A6 (105 × 148 mm)', widthPt: PageSizes.A6[0], heightPt: PageSizes.A6[1], widthMm: 105, heightMm: 148 },
  Letter: { key: 'Letter', label: 'Letter (8.5 × 11 in)', widthPt: PageSizes.Letter[0], heightPt: PageSizes.Letter[1], widthMm: 216, heightMm: 279 },
  Legal: { key: 'Legal', label: 'Legal (8.5 × 14 in)', widthPt: PageSizes.Legal[0], heightPt: PageSizes.Legal[1], widthMm: 216, heightMm: 356 },
  Executive: { key: 'Executive', label: 'Executive (7.25 × 10.5 in)', widthPt: PageSizes.Executive[0], heightPt: PageSizes.Executive[1], widthMm: 184, heightMm: 267 },
  Custom: { key: 'Custom', label: 'Custom Size', widthPt: PageSizes.A4[0], heightPt: PageSizes.A4[1], widthMm: 210, heightMm: 297 },
};

export function cloneBuffer(buf: ArrayBuffer): ArrayBuffer {
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buf));
  return copy;
}

export function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const num = parseInt(full, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return rgb(r, g, b);
}

export function hasNonWinAnsiChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) return true;
  }
  return false;
}

/**
 * Renders text (including full Bengali & Unicode scripts, bold/italic/underline/spacing)
 * onto a transparent high-DPI canvas and returns PNG bytes so pdf-lib embeds any script crisply.
 */
export async function renderUnicodeTextPng(opts: {
  text: string;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing?: number;
  maxWidth?: number;
}): Promise<{ pngBytes: Uint8Array; widthPt: number; heightPt: number }> {
  const dpr = 3;
  const familyMap = {
    sans: "'DM Sans', 'Noto Sans Bengali', sans-serif",
    serif: "Georgia, 'Noto Sans Bengali', serif",
    mono: "'JetBrains Mono', monospace",
  };
  const fontSpec = `${opts.italic ? 'italic ' : ''}${opts.bold ? '700 ' : '400 '}${opts.fontSize}px ${familyMap[opts.fontFamily]}`;

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d')!;
  mCtx.font = fontSpec;
  if (opts.letterSpacing && 'letterSpacing' in mCtx) {
    (mCtx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${opts.letterSpacing}px`;
  }

  const measureInkWidth = (txt: string): number => {
    const m = mCtx.measureText(txt);
    const bboxW = (m.actualBoundingBoxRight || 0) + Math.max(0, m.actualBoundingBoxLeft || 0);
    return Math.max(m.width, bboxW);
  };

  const lines = opts.text.split('\n');
  const wrappedLines: string[] = [];
  const limit = opts.maxWidth && opts.maxWidth > 40 ? opts.maxWidth : 520;

  for (const rawLine of lines) {
    if (!rawLine) {
      wrappedLines.push('');
      continue;
    }
    const words = rawLine.split(' ');
    let cur = '';
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (measureInkWidth(test) > limit && cur) {
        wrappedLines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    wrappedLines.push(cur);
  }

  let widest = 12;
  for (const l of wrappedLines) {
    widest = Math.max(widest, measureInkWidth(l));
  }
  const lineHeight = opts.fontSize * 1.38;
  const padX = 16;
  const widthPt = Math.ceil(Math.max(widest + padX, opts.maxWidth && opts.align !== 'left' ? Math.max(opts.maxWidth, widest + padX) : widest + padX));
  const heightPt = Math.ceil(wrappedLines.length * lineHeight + 10);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(widthPt * dpr));
  canvas.height = Math.max(1, Math.ceil(heightPt * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.font = fontSpec;
  ctx.fillStyle = opts.color;
  ctx.textBaseline = 'top';
  if (opts.letterSpacing && 'letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${opts.letterSpacing}px`;
  }

  wrappedLines.forEach((line, idx) => {
    const y = 4 + idx * lineHeight;
    const m = ctx.measureText(line);
    const lw = Math.max(m.width, (m.actualBoundingBoxRight || 0) + Math.max(0, m.actualBoundingBoxLeft || 0));
    let x = 4;
    if (opts.align === 'center') x = (widthPt - lw) / 2;
    if (opts.align === 'right') x = widthPt - lw - 4;
    ctx.fillText(line, x, y);
    if (opts.underline && lw > 0) {
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = Math.max(1, opts.fontSize * 0.07);
      ctx.beginPath();
      ctx.moveTo(x, y + opts.fontSize * 1.05);
      ctx.lineTo(x + lw, y + opts.fontSize * 1.05);
      ctx.stroke();
    }
  });

  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { pngBytes: bytes, widthPt, heightPt };
}

// Cache a single PDFDocumentProxy per ArrayBuffer so 150+ page PDFs are parsed once instead of per-page
const pdfDocCache = new WeakMap<ArrayBuffer, Promise<pdfjsLib.PDFDocumentProxy>>();
const activeCanvasTasks = new WeakMap<HTMLCanvasElement, pdfjsLib.RenderTask>();
const canvasRenderQueues = new WeakMap<HTMLCanvasElement, Promise<void>>();

export async function getSharedPdfDocument(
  pdfBytes: ArrayBuffer
): Promise<pdfjsLib.PDFDocumentProxy> {
  let cached = pdfDocCache.get(pdfBytes);
  if (!cached) {
    const task = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pdfBytes)) });
    cached = task.promise.catch((err) => {
      pdfDocCache.delete(pdfBytes);
      throw err;
    });
    pdfDocCache.set(pdfBytes, cached);
  }
  return cached;
}

export async function getPdfDocumentInfo(
  pdfBytes: ArrayBuffer,
  password?: string
): Promise<{ pageCount: number; title?: string; author?: string; subject?: string; keywords?: string }> {
  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  const pdf = password
    ? await (loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pdfBytes)), password })).promise
    : await getSharedPdfDocument(pdfBytes);
  const meta = await pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const pageCount = pdf.numPages;
  if (loadingTask) {
    await loadingTask.destroy();
  }
  return {
    pageCount,
    title: typeof info.Title === 'string' ? info.Title : undefined,
    author: typeof info.Author === 'string' ? info.Author : undefined,
    subject: typeof info.Subject === 'string' ? info.Subject : undefined,
    keywords: typeof info.Keywords === 'string' ? info.Keywords : undefined,
  };
}

export async function getPdfPageDimension(
  pdfBytes: ArrayBuffer,
  pageNumber = 1,
  extraRotation = 0
): Promise<{ width: number; height: number }> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(safePage);
  const rot = (((page.rotate || 0) + extraRotation) % 360 + 360) % 360;
  const vp = page.getViewport({ scale: 1, rotation: rot });
  return { width: vp.width, height: vp.height };
}

export async function renderPageToCanvas(
  pdfBytes: ArrayBuffer,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5,
  extraRotation = 0
): Promise<{ width: number; height: number; unscaledWidth: number; unscaledHeight: number }> {
  // Cancel any in-flight PDF.js render on this exact canvas so transforms never stack/flip
  const prevTask = activeCanvasTasks.get(canvas);
  if (prevTask) {
    try {
      prevTask.cancel();
    } catch {
      // ignore cancellation error
    }
  }

  const prevQueue = canvasRenderQueues.get(canvas) || Promise.resolve();
  let resultDims = { width: 0, height: 0, unscaledWidth: 595, unscaledHeight: 842 };

  const currentRun = prevQueue
    .catch(() => {})
    .then(async () => {
      const pdf = await getSharedPdfDocument(pdfBytes);
      const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
      const page = await pdf.getPage(safePage);
      const rot = (((page.rotate || 0) + extraRotation) % 360 + 360) % 360;
      const baseViewport = page.getViewport({ scale: 1, rotation: rot });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr, rotation: rot });

      const displayW = Math.max(1, Math.floor(baseViewport.width * scale));
      const displayH = Math.max(1, Math.floor(baseViewport.height * scale));
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const renderTask = page.render({ canvasContext: ctx, viewport, canvas });
      activeCanvasTasks.set(canvas, renderTask);
      try {
        await renderTask.promise;
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        if (name !== 'RenderingCancelledException') {
          throw err;
        }
      } finally {
        if (activeCanvasTasks.get(canvas) === renderTask) {
          activeCanvasTasks.delete(canvas);
        }
      }

      resultDims = {
        width: displayW,
        height: displayH,
        unscaledWidth: baseViewport.width,
        unscaledHeight: baseViewport.height,
      };
    });

  canvasRenderQueues.set(canvas, currentRun);
  await currentRun;
  return resultDims;
}

export async function renderPageThumbnail(
  pdfBytes: ArrayBuffer,
  pageNumber = 1,
  targetWidth = 220
): Promise<string> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const page = await pdf.getPage(Math.min(pageNumber, pdf.numPages));
  const vp1 = page.getViewport({ scale: 1 });
  const scale = targetWidth / vp1.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas.toDataURL('image/jpeg', 0.8);
}

export async function renderPageToDataUrl(
  pdfBytes: ArrayBuffer,
  pageNumber: number,
  scale = 2,
  format: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<string> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const page = await pdf.getPage(Math.max(1, Math.min(pageNumber, pdf.numPages)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas.toDataURL(format, 0.92);
}

export async function extractSinglePageText(
  pdfBytes: ArrayBuffer,
  pageNumber: number
): Promise<string> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(safePage);
  const tc = await page.getTextContent();
  let lastY: number | null = null;
  let pageStr = '';
  for (const item of tc.items) {
    if ('str' in item) {
      const y = item.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 4) {
        pageStr += '\n';
      } else if (pageStr && !pageStr.endsWith(' ') && !pageStr.endsWith('\n')) {
        pageStr += ' ';
      }
      pageStr += item.str;
      lastY = y;
    }
  }
  return pageStr.trim();
}

export async function extractDocumentPagesText(
  pdfBytes: ArrayBuffer
): Promise<Array<{ pageNumber: number; text: string }>> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const results: Array<{ pageNumber: number; text: string }> = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let lastY: number | null = null;
    let pageStr = '';
    for (const item of tc.items) {
      if ('str' in item) {
        const y = item.transform?.[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 4) {
          pageStr += '\n';
        } else if (pageStr && !pageStr.endsWith(' ') && !pageStr.endsWith('\n')) {
          pageStr += ' ';
        }
        pageStr += item.str;
        lastY = y;
      }
    }
    results.push({ pageNumber: p, text: pageStr.trim() });
    if (p % 15 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return results;
}

export async function extractPageTextRuns(
  pdfBytes: ArrayBuffer,
  pageNumber: number
): Promise<{ runs: ExtractedTextRun[]; pageWidth: number; pageHeight: number }> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const page = await pdf.getPage(Math.max(1, Math.min(pageNumber, pdf.numPages)));
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const runs: ExtractedTextRun[] = [];

  tc.items.forEach((item, index) => {
    if (!('str' in item) || !item.str.trim()) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(8, Math.hypot(tx[0], tx[1]));
    const x = tx[4];
    const y = tx[5] - fontSize * 0.85;
    const width = Math.max(12, item.width);
    const height = Math.max(fontSize * 1.15, item.height || fontSize * 1.15);

    runs.push({
      id: `run_${pageNumber}_${index}`,
      pageNumber,
      str: item.str,
      x,
      y,
      width,
      height,
      fontSize,
      fontName: item.fontName || 'Helvetica',
    });
  });

  return { runs, pageWidth: viewport.width, pageHeight: viewport.height };
}

/**
 * Genuine PDF edit applicator using pdf-lib.
 * Preserves all original vectors/pages while applying text replacements,
 * added text boxes, images, freehand strokes, shapes, stamps, and signatures.
 */
export async function applyPdfEditsToBytes(
  originalBytes: ArrayBuffer,
  edits: {
    replacements: TextReplacementEdit[];
    addedTexts: AddedTextBox[];
    addedImages: AddedImageOverlay[];
    annotations: AnnotationOverlay[];
  }
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(originalBytes), { ignoreEncryption: true });
  const fontHelv = await doc.embedFont(StandardFonts.Helvetica);
  const fontHelvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontHelvItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const fontTimes = await doc.embedFont(StandardFonts.TimesRoman);
  const fontTimesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const fontCourier = await doc.embedFont(StandardFonts.Courier);

  const pickStandardFont = (family: 'sans' | 'serif' | 'mono', bold: boolean, italic: boolean) => {
    if (family === 'mono') return fontCourier;
    if (family === 'serif') return bold ? fontTimesBold : fontTimes;
    if (bold) return fontHelvBold;
    if (italic) return fontHelvItalic;
    return fontHelv;
  };

  const pages = doc.getPages();

  // 1. Existing text replacements/deletions
  for (const rep of edits.replacements) {
    const page = pages[rep.pageNumber - 1];
    if (!page) continue;
    const { height: pageH } = page.getSize();
    const pdfY = pageH - rep.y - rep.height;

    // Clear original text bounding area cleanly
    page.drawRectangle({
      x: Math.max(0, rep.x - 1.5),
      y: Math.max(0, pdfY - 2),
      width: rep.width + 4,
      height: rep.height + 4,
      color: rgb(1, 1, 1),
    });

    if (!rep.deleted && rep.newText.trim()) {
      if (hasNonWinAnsiChars(rep.newText) || (rep.letterSpacing || 0) !== 0) {
        const rendered = await renderUnicodeTextPng({
          text: rep.newText,
          fontSize: rep.fontSize,
          fontFamily: rep.fontFamily,
          color: rep.color,
          bold: rep.bold,
          italic: rep.italic,
          underline: rep.underline,
          align: rep.align,
          letterSpacing: rep.letterSpacing,
          maxWidth: Math.max(rep.width, 180),
        });
        const img = await doc.embedPng(rendered.pngBytes);
        page.drawImage(img, {
          x: rep.x,
          y: pageH - rep.y - rendered.heightPt,
          width: rendered.widthPt,
          height: rendered.heightPt,
        });
      } else {
        const font = pickStandardFont(rep.fontFamily, rep.bold, rep.italic);
        const col = hexToRgb(rep.color);
        const tw = font.widthOfTextAtSize(rep.newText, rep.fontSize);
        const boxW = Math.max(rep.width, tw);
        let drawX = rep.x;
        if (rep.align === 'center') drawX = rep.x + (boxW - tw) / 2;
        if (rep.align === 'right') drawX = rep.x + boxW - tw;
        const baselineY = pageH - rep.y - rep.fontSize * 0.9;
        page.drawText(rep.newText, {
          x: drawX,
          y: baselineY,
          size: rep.fontSize,
          font,
          color: col,
        });
        if (rep.underline && tw > 0) {
          page.drawLine({
            start: { x: drawX, y: baselineY - 2 },
            end: { x: drawX + tw, y: baselineY - 2 },
            thickness: Math.max(0.8, rep.fontSize * 0.07),
            color: col,
          });
        }
      }
    }
  }

  // 2. Added text boxes
  for (const tb of edits.addedTexts) {
    const page = pages[tb.pageNumber - 1];
    if (!page || !tb.text.trim()) continue;
    const { height: pageH } = page.getSize();

    if (hasNonWinAnsiChars(tb.text) || (tb.letterSpacing || 0) !== 0) {
      const rendered = await renderUnicodeTextPng({
        text: tb.text,
        fontSize: tb.fontSize,
        fontFamily: tb.fontFamily,
        color: tb.color,
        bold: tb.bold,
        italic: tb.italic,
        underline: tb.underline,
        align: tb.align,
        letterSpacing: tb.letterSpacing,
        maxWidth: tb.width,
      });
      const img = await doc.embedPng(rendered.pngBytes);
      page.drawImage(img, {
        x: tb.x,
        y: pageH - tb.y - rendered.heightPt,
        width: rendered.widthPt,
        height: rendered.heightPt,
      });
    } else {
      // Emit genuine editable vector PDF text for WinAnsi added text boxes (even multiline/aligned/underlined)
      const font = pickStandardFont(tb.fontFamily, tb.bold, tb.italic);
      const col = hexToRgb(tb.color);
      const lineStep = tb.fontSize * 1.32;
      const boxW = Math.max(80, tb.width || 260);
      const outLines: string[] = [];

      for (const rawLine of tb.text.split('\n')) {
        if (!rawLine.trim()) {
          outLines.push('');
          continue;
        }
        const words = rawLine.split(/\s+/);
        let cur = '';
        for (const w of words) {
          const test = cur ? `${cur} ${w}` : w;
          if (font.widthOfTextAtSize(test, tb.fontSize) > boxW && cur) {
            outLines.push(cur);
            cur = w;
          } else {
            cur = test;
          }
        }
        if (cur) outLines.push(cur);
      }

      outLines.forEach((line, idx) => {
        if (!line) return;
        const tw = font.widthOfTextAtSize(line, tb.fontSize);
        let drawX = tb.x;
        if (tb.align === 'center') drawX = tb.x + Math.max(0, (boxW - tw) / 2);
        if (tb.align === 'right') drawX = tb.x + Math.max(0, boxW - tw);
        const baselineY = pageH - tb.y - tb.fontSize - idx * lineStep;
        page.drawText(line, {
          x: drawX,
          y: baselineY,
          size: tb.fontSize,
          font,
          color: col,
        });
        if (tb.underline && tw > 0) {
          page.drawLine({
            start: { x: drawX, y: baselineY - 2 },
            end: { x: drawX + tw, y: baselineY - 2 },
            thickness: Math.max(0.8, tb.fontSize * 0.07),
            color: col,
          });
        }
      });
    }
  }

  // 3. Added images
  for (const imgOv of edits.addedImages) {
    const page = pages[imgOv.pageNumber - 1];
    if (!page) continue;
    const { height: pageH } = page.getSize();
    const base64 = imgOv.dataUrl.split(',')[1];
    if (!base64) continue;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const embedded = imgOv.dataUrl.includes('image/png')
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
    page.drawImage(embedded, {
      x: imgOv.x,
      y: pageH - imgOv.y - imgOv.height,
      width: imgOv.width,
      height: imgOv.height,
      rotate: degrees(-imgOv.rotation),
    });
  }

  // 4. Annotations, drawings, shapes, sticky notes, stamps, signatures
  for (const ann of edits.annotations) {
    const page = pages[ann.pageNumber - 1];
    if (!page) continue;
    const { height: pageH } = page.getSize();
    const color = hexToRgb(ann.color || '#2563EB');

    if (ann.kind === 'highlight') {
      page.drawRectangle({
        x: ann.x,
        y: pageH - ann.y - ann.height,
        width: ann.width,
        height: ann.height,
        color,
        opacity: 0.32,
      });
    } else if (ann.kind === 'underline') {
      page.drawLine({
        start: { x: ann.x, y: pageH - ann.y - ann.height },
        end: { x: ann.x + ann.width, y: pageH - ann.y - ann.height },
        thickness: 2,
        color,
      });
    } else if (ann.kind === 'strikethrough') {
      page.drawLine({
        start: { x: ann.x, y: pageH - ann.y - ann.height / 2 },
        end: { x: ann.x + ann.width, y: pageH - ann.y - ann.height / 2 },
        thickness: 2,
        color,
      });
    } else if (ann.kind === 'rect') {
      page.drawRectangle({
        x: ann.x,
        y: pageH - ann.y - ann.height,
        width: ann.width,
        height: ann.height,
        borderColor: color,
        borderWidth: ann.strokeWidth || 2,
      });
    } else if (ann.kind === 'circle') {
      page.drawEllipse({
        x: ann.x + ann.width / 2,
        y: pageH - ann.y - ann.height / 2,
        xScale: ann.width / 2,
        yScale: ann.height / 2,
        borderColor: color,
        borderWidth: ann.strokeWidth || 2,
      });
    } else if (ann.kind === 'arrow') {
      const startX = ann.x;
      const startY = pageH - ann.y;
      const endX = ann.x + ann.width;
      const endY = pageH - (ann.y + ann.height);
      page.drawLine({
        start: { x: startX, y: startY },
        end: { x: endX, y: endY },
        thickness: ann.strokeWidth || 2.5,
        color,
      });
      const angle = Math.atan2(endY - startY, endX - startX);
      const headLen = 10;
      page.drawLine({
        start: { x: endX, y: endY },
        end: { x: endX - headLen * Math.cos(angle - Math.PI / 6), y: endY - headLen * Math.sin(angle - Math.PI / 6) },
        thickness: ann.strokeWidth || 2.5,
        color,
      });
      page.drawLine({
        start: { x: endX, y: endY },
        end: { x: endX - headLen * Math.cos(angle + Math.PI / 6), y: endY - headLen * Math.sin(angle + Math.PI / 6) },
        thickness: ann.strokeWidth || 2.5,
        color,
      });
    } else if (ann.kind === 'freehand' && ann.points && ann.points.length > 1) {
      for (let i = 1; i < ann.points.length; i++) {
        const p1 = ann.points[i - 1];
        const p2 = ann.points[i];
        page.drawLine({
          start: { x: p1.x, y: pageH - p1.y },
          end: { x: p2.x, y: pageH - p2.y },
          thickness: ann.strokeWidth || 2.5,
          color,
        });
      }
    } else if (ann.kind === 'sticky') {
      const boxW = 150;
      const boxH = 54;
      const boxY = pageH - ann.y - boxH;
      const borderAmber = rgb(0.92, 0.62, 0.08);
      page.drawRectangle({
        x: ann.x,
        y: boxY,
        width: boxW,
        height: boxH,
        color: rgb(1, 0.96, 0.72),
        borderColor: borderAmber,
        borderWidth: 1.2,
      });

      // Draw callout pointer arrow indicator
      const arrowSide = ann.stickyArrow || 'left';
      let stemStart = { x: ann.x, y: boxY + boxH / 2 };
      let stemEnd = { x: ann.x - 16, y: boxY + boxH / 2 };
      if (arrowSide === 'right') {
        stemStart = { x: ann.x + boxW, y: boxY + boxH / 2 };
        stemEnd = { x: ann.x + boxW + 16, y: boxY + boxH / 2 };
      } else if (arrowSide === 'top') {
        stemStart = { x: ann.x + boxW / 2, y: boxY + boxH };
        stemEnd = { x: ann.x + boxW / 2, y: boxY + boxH + 16 };
      } else if (arrowSide === 'bottom') {
        stemStart = { x: ann.x + boxW / 2, y: boxY };
        stemEnd = { x: ann.x + boxW / 2, y: boxY - 16 };
      }
      page.drawLine({ start: stemStart, end: stemEnd, thickness: 2, color: borderAmber });
      const ang = Math.atan2(stemEnd.y - stemStart.y, stemEnd.x - stemStart.x);
      page.drawLine({
        start: stemEnd,
        end: { x: stemEnd.x - 6 * Math.cos(ang - Math.PI / 5), y: stemEnd.y - 6 * Math.sin(ang - Math.PI / 5) },
        thickness: 2,
        color: borderAmber,
      });
      page.drawLine({
        start: stemEnd,
        end: { x: stemEnd.x - 6 * Math.cos(ang + Math.PI / 5), y: stemEnd.y - 6 * Math.sin(ang + Math.PI / 5) },
        thickness: 2,
        color: borderAmber,
      });

      const noteText = (ann.comment || 'Note').slice(0, 80);
      if (hasNonWinAnsiChars(noteText)) {
        const rendered = await renderUnicodeTextPng({
          text: noteText,
          fontSize: 9,
          fontFamily: 'sans',
          color: '#1E293B',
          bold: false,
          italic: false,
          underline: false,
          align: 'left',
          maxWidth: 138,
        });
        const img = await doc.embedPng(rendered.pngBytes);
        page.drawImage(img, {
          x: ann.x + 5,
          y: pageH - ann.y - 6 - rendered.heightPt,
          width: rendered.widthPt,
          height: rendered.heightPt,
        });
      } else {
        page.drawText(noteText, {
          x: ann.x + 6,
          y: pageH - ann.y - 16,
          size: 9,
          font: fontHelv,
          color: rgb(0.12, 0.16, 0.23),
          maxWidth: 138,
          lineHeight: 11,
        });
      }
    } else if (ann.kind === 'stamp') {
      const label = ann.dateStr || new Date().toLocaleDateString();
      page.drawRectangle({
        x: ann.x,
        y: pageH - ann.y - 26,
        width: Math.max(105, label.length * 6.5 + 16),
        height: 26,
        borderColor: color,
        borderWidth: 1.5,
        color: rgb(0.97, 0.98, 1),
        opacity: 0.9,
      });
      page.drawText(label, {
        x: ann.x + 8,
        y: pageH - ann.y - 17,
        size: 10,
        font: fontHelvBold,
        color,
      });
    } else if (ann.kind === 'signature' && ann.signatureDataUrl) {
      const base64 = ann.signatureDataUrl.split(',')[1];
      if (base64) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const sigImg = ann.signatureDataUrl.includes('image/png')
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        page.drawImage(sigImg, {
          x: ann.x,
          y: pageH - ann.y - ann.height,
          width: ann.width,
          height: ann.height,
        });
        if (ann.signerName || ann.dateStr) {
          const caption = `${ann.signerName || ''} ${ann.dateStr ? `· ${ann.dateStr}` : ''}`.trim();
          if (caption) {
            page.drawText(caption.replace(/[^\x20-\x7E]/g, ''), {
              x: ann.x,
              y: Math.max(4, pageH - ann.y - ann.height - 11),
              size: 8,
              font: fontHelv,
              color: rgb(0.3, 0.35, 0.45),
            });
          }
        }
      }
    }
  }

  const saved = await doc.save();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
}

// ==========================================
// PAGE MANAGEMENT OPERATIONS
// ==========================================

export async function mergePdfs(buffers: ArrayBuffer[]): Promise<ArrayBuffer> {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
    const copied = await merged.copyPages(src, src.getPageIndices());
    copied.forEach((p) => merged.addPage(p));
  }
  const out = await merged.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function splitPdfByRanges(
  buf: ArrayBuffer,
  pageNumbers1Based: number[]
): Promise<ArrayBuffer> {
  const src = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const target = await PDFDocument.create();
  const validIndices = pageNumbers1Based
    .map((p) => p - 1)
    .filter((idx) => idx >= 0 && idx < src.getPageCount());
  const copied = await target.copyPages(src, validIndices);
  copied.forEach((p) => target.addPage(p));
  const out = await target.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function organizePdfPages(
  buf: ArrayBuffer,
  plan: Array<{ sourcePageIndex: number | null; rotationDelta: number; insertBlank?: boolean }>
): Promise<ArrayBuffer> {
  const src = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const outDoc = await PDFDocument.create();
  const defaultSize = src.getPageCount() > 0 ? src.getPage(0).getSize() : { width: 595.28, height: 841.89 };

  for (const step of plan) {
    if (step.insertBlank || step.sourcePageIndex === null) {
      outDoc.addPage([defaultSize.width, defaultSize.height]);
    } else if (step.sourcePageIndex >= 0 && step.sourcePageIndex < src.getPageCount()) {
      const [copied] = await outDoc.copyPages(src, [step.sourcePageIndex]);
      if (step.rotationDelta !== 0) {
        const curRot = copied.getRotation().angle;
        copied.setRotation(degrees((curRot + step.rotationDelta + 360) % 360));
      }
      outDoc.addPage(copied);
    }
  }
  const out = await outDoc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function insertPdfIntoDocument(
  baseBuf: ArrayBuffer,
  insertBuf: ArrayBuffer,
  atIndex: number
): Promise<ArrayBuffer> {
  const base = await PDFDocument.load(cloneBuffer(baseBuf), { ignoreEncryption: true });
  const extra = await PDFDocument.load(cloneBuffer(insertBuf), { ignoreEncryption: true });
  const copied = await base.copyPages(extra, extra.getPageIndices());
  let pos = Math.max(0, Math.min(atIndex, base.getPageCount()));
  for (const page of copied) {
    base.insertPage(pos, page);
    pos++;
  }
  const out = await base.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

// ==========================================
// UTILITY TOOLS
// ==========================================

export async function rotateAllPages(buf: ArrayBuffer, angleDelta: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  for (const page of doc.getPages()) {
    const cur = page.getRotation().angle;
    page.setRotation(degrees((cur + angleDelta + 360) % 360));
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function resizePdfPages(
  buf: ArrayBuffer,
  paperSize: PaperSizeKey,
  orientation: 'portrait' | 'landscape',
  customWidthMm = 210,
  customHeightMm = 297
): Promise<ArrayBuffer> {
  const mmToPt = 2.83464567;
  const baseDim = PAPER_DIMENSIONS[paperSize];
  let targetW = paperSize === 'Custom' ? Math.max(40, customWidthMm) * mmToPt : baseDim.widthPt;
  let targetH = paperSize === 'Custom' ? Math.max(40, customHeightMm) * mmToPt : baseDim.heightPt;

  if (orientation === 'landscape' && targetW < targetH) {
    [targetW, targetH] = [targetH, targetW];
  } else if (orientation === 'portrait' && targetW > targetH) {
    [targetW, targetH] = [targetH, targetW];
  }

  const srcDoc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const outDoc = await PDFDocument.create();
  const srcPages = srcDoc.getPages();

  for (const srcPage of srcPages) {
    const { width: srcW, height: srcH } = srcPage.getSize();
    const embedded = await outDoc.embedPage(srcPage);
    const scaleFactor = Math.min(targetW / Math.max(1, srcW), targetH / Math.max(1, srcH));
    const drawW = srcW * scaleFactor;
    const drawH = srcH * scaleFactor;
    const x = (targetW - drawW) / 2;
    const y = (targetH - drawH) / 2;

    const newPage = outDoc.addPage([targetW, targetH]);
    newPage.drawRectangle({ x: 0, y: 0, width: targetW, height: targetH, color: rgb(1, 1, 1) });
    newPage.drawPage(embedded, { x, y, width: drawW, height: drawH });
  }

  const out = await outDoc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function createBlankPdf(options: {
  paperSize: PaperSizeKey;
  orientation: 'portrait' | 'landscape';
  pageCount?: number;
  customWidthMm?: number;
  customHeightMm?: number;
}): Promise<ArrayBuffer> {
  const mmToPt = 2.83464567;
  const baseDim = PAPER_DIMENSIONS[options.paperSize];
  let w =
    options.paperSize === 'Custom'
      ? Math.max(40, options.customWidthMm || 210) * mmToPt
      : baseDim.widthPt;
  let h =
    options.paperSize === 'Custom'
      ? Math.max(40, options.customHeightMm || 297) * mmToPt
      : baseDim.heightPt;

  if (options.orientation === 'landscape' && w < h) {
    [w, h] = [h, w];
  } else if (options.orientation === 'portrait' && w > h) {
    [w, h] = [h, w];
  }

  const count = Math.max(1, Math.min(200, Math.floor(options.pageCount || 1)));
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    doc.addPage([w, h]);
  }
  doc.setProducer('PDF MASTER');
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function addWatermarkToPdf(
  buf: ArrayBuffer,
  options: { text: string; opacity: number; fontSize: number; color: string; angle: number }
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const col = hexToRgb(options.color);
  const safeText = options.text.trim() || 'CONFIDENTIAL';

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    if (hasNonWinAnsiChars(safeText)) {
      const rendered = await renderUnicodeTextPng({
        text: safeText,
        fontSize: options.fontSize,
        fontFamily: 'sans',
        color: options.color,
        bold: true,
        italic: false,
        underline: false,
        align: 'center',
      });
      const img = await doc.embedPng(rendered.pngBytes);
      page.drawImage(img, {
        x: (width - rendered.widthPt) / 2,
        y: (height - rendered.heightPt) / 2,
        width: rendered.widthPt,
        height: rendered.heightPt,
        opacity: options.opacity,
        rotate: degrees(options.angle),
      });
    } else {
      const tw = font.widthOfTextAtSize(safeText, options.fontSize);
      page.drawText(safeText, {
        x: width / 2 - tw / 2,
        y: height / 2,
        size: options.fontSize,
        font,
        color: col,
        opacity: options.opacity,
        rotate: degrees(options.angle),
      });
    }
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function addPageNumbersToPdf(
  buf: ArrayBuffer,
  position: 'bottom-center' | 'bottom-right' | 'top-right' = 'bottom-center',
  format: 'number' | 'pageOfTotal' = 'pageOfTotal'
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;

  pages.forEach((page, idx) => {
    const { width, height } = page.getSize();
    const label = format === 'pageOfTotal' ? `Page ${idx + 1} of ${total}` : `${idx + 1}`;
    const tw = font.widthOfTextAtSize(label, 10);
    let x = width / 2 - tw / 2;
    let y = 22;
    if (position === 'bottom-right') {
      x = width - tw - 32;
      y = 22;
    } else if (position === 'top-right') {
      x = width - tw - 32;
      y = height - 28;
    }
    page.drawText(label, {
      x,
      y,
      size: 10,
      font,
      color: rgb(0.35, 0.42, 0.52),
    });
  });

  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function addHeaderFooterToPdf(
  buf: ArrayBuffer,
  headerText: string,
  footerText: string
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    if (headerText.trim()) {
      page.drawText(headerText.trim().slice(0, 100).replace(/[^\x20-\x7E]/g, ''), {
        x: 36,
        y: height - 28,
        size: 9.5,
        font,
        color: rgb(0.3, 0.36, 0.46),
      });
    }
    if (footerText.trim()) {
      page.drawText(footerText.trim().slice(0, 100).replace(/[^\x20-\x7E]/g, ''), {
        x: 36,
        y: 22,
        size: 9.5,
        font,
        color: rgb(0.3, 0.36, 0.46),
      });
    }
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function compressPdfBytes(
  buf: ArrayBuffer,
  mode: 'object-streams' | 'raster-medium' | 'raster-compact'
): Promise<ArrayBuffer> {
  if (mode === 'object-streams') {
    const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
    const out = await doc.save({ useObjectStreams: true });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }

  // Re-rasterize pages at balanced JPEG quality to shrink heavy scanned PDFs substantially
  const scale = mode === 'raster-medium' ? 1.35 : 1.0;
  const quality = mode === 'raster-medium' ? 0.72 : 0.52;
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(buf)) });
  const srcPdf = await loadingTask.promise;
  const outDoc = await PDFDocument.create();

  for (let p = 1; p <= srcPdf.numPages; p++) {
    const page = await srcPdf.getPage(p);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

    const jpgDataUrl = canvas.toDataURL('image/jpeg', quality);
    const bin = atob(jpgDataUrl.split(',')[1]);
    const jpgBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) jpgBytes[i] = bin.charCodeAt(i);
    const embedded = await outDoc.embedJpg(jpgBytes);
    const newPage = outDoc.addPage([vp1.width, vp1.height]);
    newPage.drawImage(embedded, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  await loadingTask.destroy();
  const out = await outDoc.save({ useObjectStreams: true });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function repairPdfBytes(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), {
    ignoreEncryption: true,
    updateMetadata: true,
  });
  const out = await doc.save({ useObjectStreams: true });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function updatePdfMetadata(
  buf: ArrayBuffer,
  meta: { title?: string; author?: string; subject?: string; keywords?: string }
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) {
    doc.setKeywords(
      meta.keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    );
  }
  doc.setProducer('PDF MASTER Mobile Suite');
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function unlockPasswordProtectedPdf(
  buf: ArrayBuffer,
  password: string
): Promise<ArrayBuffer> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(cloneBuffer(buf)),
    password,
  });
  const srcPdf = await loadingTask.promise;
  const outDoc = await PDFDocument.create();

  for (let p = 1; p <= srcPdf.numPages; p++) {
    const page = await srcPdf.getPage(p);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

    const pngDataUrl = canvas.toDataURL('image/png');
    const bin = atob(pngDataUrl.split(',')[1]);
    const pngBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pngBytes[i] = bin.charCodeAt(i);
    const embedded = await outDoc.embedPng(pngBytes);
    const newPage = outDoc.addPage([vp1.width, vp1.height]);
    newPage.drawImage(embedded, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  await loadingTask.destroy();
  const out = await outDoc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/**
 * Generates a Searchable PDF with the scanned page image and invisible selectable OCR text overlaid.
 */
export async function createSearchablePdfFromOcr(
  pages: Array<{ imageDataUrl: string; ocrText: string }>
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const p of pages) {
    const base64 = p.imageDataUrl.split(',')[1];
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const embedded = p.imageDataUrl.includes('image/png')
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);

    const aspect = embedded.height / embedded.width;
    const widthPt = 595.28;
    const heightPt = widthPt * aspect;
    const page = doc.addPage([widthPt, heightPt]);

    // Draw invisible searchable text behind image for ASCII-compatible terms
    const asciiSafe = p.ocrText.replace(/[^\x20-\x7E\n]/g, ' ').trim();
    if (asciiSafe) {
      page.drawText(asciiSafe.slice(0, 12000), {
        x: 24,
        y: heightPt - 36,
        size: 9,
        font,
        color: rgb(1, 1, 1),
        opacity: 0.01,
        maxWidth: widthPt - 48,
        lineHeight: 12,
      });
    }

    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: widthPt,
      height: heightPt,
    });
  }

  doc.setTitle('OCR Searchable Document');
  doc.setProducer('PDF MASTER OCR Engine');
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

// ==========================================
// WEB CRYPTO INTEGRITY SEAL & AES-GCM VAULT
// ==========================================

export async function computeSha256Hex(buf: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', cloneBuffer(buf));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveAesKey(password: string, salt: Uint8Array) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptVaultBytes(
  buf: ArrayBuffer,
  password: string
): Promise<{ encrypted: ArrayBuffer; saltB64: string; ivB64: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    cloneBuffer(buf)
  );
  return {
    encrypted,
    saltB64: btoa(String.fromCharCode(...salt)),
    ivB64: btoa(String.fromCharCode(...iv)),
  };
}

export async function decryptVaultBytes(
  encrypted: ArrayBuffer,
  password: string,
  saltB64: string,
  ivB64: string
): Promise<ArrayBuffer> {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const key = await deriveAesKey(password, salt);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    cloneBuffer(encrypted)
  );
}

// ==========================================
// INITIAL STARTER DOCUMENTS
// ==========================================

export async function createStarterSamplePdfs(): Promise<
  Array<{ name: string; origin: 'imported' | 'created'; pdfBytes: ArrayBuffer; pageCount: number }>
> {
  // Sample 1: PDF Master Guide (2 pages)
  const guideDoc = await PDFDocument.create();
  const hBold = await guideDoc.embedFont(StandardFonts.HelveticaBold);
  const hReg = await guideDoc.embedFont(StandardFonts.Helvetica);

  const p1 = guideDoc.addPage(PageSizes.A4);
  p1.drawRectangle({ x: 0, y: 740, width: 595.28, height: 101.89, color: rgb(0.08, 0.17, 0.29) });
  p1.drawText('PDF MASTER', { x: 48, y: 792, size: 24, font: hBold, color: rgb(1, 1, 1) });
  p1.drawText('Everything PDF. One Powerful Mobile Suite.', { x: 48, y: 766, size: 12, font: hReg, color: rgb(0.68, 0.82, 0.98) });

  p1.drawText('1. Core Capabilities Overview', { x: 48, y: 690, size: 16, font: hBold, color: rgb(0.08, 0.17, 0.29) });
  const body1 = [
    'PDF MASTER combines genuine PDF text editing, page organization, smart camera scanning,',
    'English and Bengali OCR, Word-style document creation, format conversion, document',
    'comparison, digital signatures, and an AI PDF Assistant in one mobile-first workspace.',
    '',
    'Try opening this document in:',
    '- Edit PDF: Tap any existing text line to edit or replace it directly.',
    '- Page Organizer: Reorder, duplicate, rotate, or split pages visually.',
    '- AI Assistant: Summarize, translate to Bengali, or ask questions with page citations.',
    '- Compare PDFs: Diff this guide against a revised version line by line.',
  ];
  let y = 660;
  for (const line of body1) {
    p1.drawText(line, { x: 48, y, size: 11, font: hReg, color: rgb(0.18, 0.22, 0.3) });
    y -= 20;
  }

  const p2 = guideDoc.addPage(PageSizes.A4);
  p2.drawText('2. Security, Privacy & Local Processing', { x: 48, y: 770, size: 16, font: hBold, color: rgb(0.08, 0.17, 0.29) });
  const body2 = [
    'Local-First Architecture:',
    'All PDF rendering, page editing, compression, scanning, and Tesseract OCR run',
    'directly on your device using IndexedDB storage. Original files are preserved',
    'through version history so edits never silently overwrite your source document.',
    '',
    'Cryptographic Integrity:',
    'Signed documents include a visual signature layer paired with an optional SHA-256',
    'hash digest seal to verify that document bytes remain unmodified.',
  ];
  y = 738;
  for (const line of body2) {
    p2.drawText(line, { x: 48, y, size: 11, font: hReg, color: rgb(0.18, 0.22, 0.3) });
    y -= 20;
  }
  p2.drawText('Page 2 of 2 · PDF MASTER Guide', { x: 48, y: 36, size: 9, font: hReg, color: rgb(0.45, 0.52, 0.6) });

  const guideSaved = await guideDoc.save();

  // Sample 2: Project Proposal (2 pages)
  const propDoc = await PDFDocument.create();
  const pb = await propDoc.embedFont(StandardFonts.HelveticaBold);
  const pr = await propDoc.embedFont(StandardFonts.Helvetica);

  const pp1 = propDoc.addPage(PageSizes.A4);
  pp1.drawText('Q4 MOBILE DOCUMENT WORKFLOW PROPOSAL', { x: 48, y: 770, size: 18, font: pb, color: rgb(0.14, 0.38, 0.92) });
  pp1.drawText('Prepared for Enterprise Operations Team · November 2026', { x: 48, y: 746, size: 11, font: pr, color: rgb(0.35, 0.42, 0.52) });
  pp1.drawLine({ start: { x: 48, y: 734 }, end: { x: 547, y: 734 }, thickness: 1, color: rgb(0.85, 0.88, 0.93) });

  const propLines = [
    'Executive Summary:',
    'Field teams process over 1,400 inspection forms, vendor agreements, and delivery',
    'receipts monthly. Consolidating scanning, bilingual OCR, and digital approvals',
    'reduces turnaround time from 3 days to under 15 minutes.',
    '',
    'Budget & Milestones:',
    'Phase 1 - Mobile Field Scanner Rollout: $4,200 (Weeks 1-2)',
    'Phase 2 - Bilingual Bengali & English OCR Pipeline: $3,800 (Weeks 3-4)',
    'Phase 3 - Automated PDF Archival & Signatures: $2,500 (Weeks 5-6)',
    'Total Estimated Investment: $10,500',
  ];
  y = 700;
  for (const line of propLines) {
    pp1.drawText(line, { x: 48, y, size: 11.5, font: pr, color: rgb(0.12, 0.16, 0.23) });
    y -= 22;
  }

  const propSaved = await propDoc.save();

  return [
    {
      name: 'PDF Master Welcome Guide.pdf',
      origin: 'imported',
      pdfBytes: guideSaved.buffer.slice(guideSaved.byteOffset, guideSaved.byteOffset + guideSaved.byteLength) as ArrayBuffer,
      pageCount: 2,
    },
    {
      name: 'Q4 Mobile Workflow Proposal.pdf',
      origin: 'imported',
      pdfBytes: propSaved.buffer.slice(propSaved.byteOffset, propSaved.byteOffset + propSaved.byteLength) as ArrayBuffer,
      pageCount: 1,
    },
  ];
}
