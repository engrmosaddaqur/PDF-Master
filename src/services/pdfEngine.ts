import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PDFArray,
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  LineCapStyle,
  PageSizes,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
} from 'pdf-lib';
import type {
  AddedImageOverlay,
  AddedTextBox,
  AnnotationOverlay,
  ExtractedTextRun,
  PaperDimension,
  PaperSizeKey,
  PdfFontFamily,
  PdfFormFieldDescriptor,
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

export interface StickyArrowGeometry {
  hasArrow: boolean;
  startX: number;
  startY: number;
  tipX: number;
  tipY: number;
  angleDeg: number;
  length: number;
}

export function computeStickyArrowGeometry(ann: AnnotationOverlay): StickyArrowGeometry {
  const boxW = Math.max(84, ann.width || 165);
  const boxH = Math.max(44, ann.height || 76);
  const side = ann.stickyArrow || 'top-left';

  if (side === 'none' && (ann.stickyTipX === undefined || ann.stickyTipY === undefined)) {
    return { hasArrow: false, startX: ann.x, startY: ann.y, tipX: ann.x, tipY: ann.y, angleDeg: 0, length: 0 };
  }

  let tipX = ann.stickyTipX;
  let tipY = ann.stickyTipY;

  if (tipX === undefined || tipY === undefined) {
    const defaultLen = 40;
    const diag = Math.round(defaultLen / Math.SQRT2);
    switch (side) {
      case 'top-left':
        tipX = ann.x - diag;
        tipY = ann.y - diag;
        break;
      case 'top-right':
        tipX = ann.x + boxW + diag;
        tipY = ann.y - diag;
        break;
      case 'bottom-left':
        tipX = ann.x - diag;
        tipY = ann.y + boxH + diag;
        break;
      case 'bottom-right':
        tipX = ann.x + boxW + diag;
        tipY = ann.y + boxH + diag;
        break;
      case 'left':
        tipX = ann.x - defaultLen;
        tipY = ann.y + boxH / 2;
        break;
      case 'right':
        tipX = ann.x + boxW + defaultLen;
        tipY = ann.y + boxH / 2;
        break;
      case 'top':
        tipX = ann.x + boxW / 2;
        tipY = ann.y - defaultLen;
        break;
      case 'bottom':
        tipX = ann.x + boxW / 2;
        tipY = ann.y + boxH + defaultLen;
        break;
      default:
        return { hasArrow: false, startX: ann.x, startY: ann.y, tipX: ann.x, tipY: ann.y, angleDeg: 0, length: 0 };
    }
  }

  const startX = Math.max(ann.x, Math.min(ann.x + boxW, tipX));
  const startY = Math.max(ann.y, Math.min(ann.y + boxH, tipY));
  const dx = tipX - startX;
  const dy = tipY - startY;
  const length = Math.hypot(dx, dy);

  if (length < 2) {
    return { hasArrow: false, startX, startY, tipX, tipY, angleDeg: 0, length: 0 };
  }

  const angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  return { hasArrow: true, startX, startY, tipX, tipY, angleDeg, length };
}

export const OFFICIAL_FONT_OPTIONS: Array<{
  value: PdfFontFamily;
  label: string;
  cssStack: string;
}> = [
  { value: 'arial', label: 'Arial', cssStack: "Arial, Helvetica, 'Noto Sans Bengali', sans-serif" },
  { value: 'calibri', label: 'Calibri', cssStack: "Calibri, 'Segoe UI', 'DM Sans', 'Noto Sans Bengali', sans-serif" },
  { value: 'cambria', label: 'Cambria', cssStack: "Cambria, Georgia, 'Times New Roman', 'Noto Sans Bengali', serif" },
  { value: 'times', label: 'Times New Roman', cssStack: "'Times New Roman', Times, 'Noto Sans Bengali', serif" },
  { value: 'georgia', label: 'Georgia', cssStack: "Georgia, 'Times New Roman', 'Noto Sans Bengali', serif" },
  { value: 'verdana', label: 'Verdana', cssStack: "Verdana, Geneva, 'Noto Sans Bengali', sans-serif" },
  { value: 'tahoma', label: 'Tahoma', cssStack: "Tahoma, Geneva, 'Noto Sans Bengali', sans-serif" },
  { value: 'garamond', label: 'Garamond', cssStack: "Garamond, 'Times New Roman', 'Noto Sans Bengali', serif" },
  { value: 'trebuchet', label: 'Trebuchet MS', cssStack: "'Trebuchet MS', Helvetica, 'Noto Sans Bengali', sans-serif" },
  { value: 'courier', label: 'Courier New', cssStack: "'Courier New', Courier, monospace" },
  { value: 'bengali', label: 'Noto Sans (বাংলা)', cssStack: "'Noto Sans Bengali', 'DM Sans', sans-serif" },
];

export function getFontCssStack(fontFamily: PdfFontFamily): string {
  if (fontFamily === 'sans') return "'DM Sans', Arial, 'Noto Sans Bengali', sans-serif";
  if (fontFamily === 'serif') return "'Times New Roman', Georgia, 'Noto Sans Bengali', serif";
  if (fontFamily === 'mono') return "'Courier New', 'JetBrains Mono', monospace";
  const found = OFFICIAL_FONT_OPTIONS.find((f) => f.value === fontFamily);
  return found ? found.cssStack : "Arial, 'Noto Sans Bengali', sans-serif";
}

export function inferOfficialFontFromPdfName(rawFontName?: string): PdfFontFamily {
  const n = (rawFontName || '').toLowerCase();
  if (n.includes('cambria')) return 'cambria';
  if (n.includes('calibri')) return 'calibri';
  if (n.includes('georgia')) return 'georgia';
  if (n.includes('garamond')) return 'garamond';
  if (n.includes('verdana')) return 'verdana';
  if (n.includes('tahoma')) return 'tahoma';
  if (n.includes('trebuchet')) return 'trebuchet';
  if (n.includes('courier') || n.includes('mono') || n.includes('consola')) return 'courier';
  if (n.includes('times') || n.includes('roman') || n.includes('serif')) return 'times';
  if (n.includes('bengali') || n.includes('noto') || n.includes('kalpurush') || n.includes('solaiman')) return 'bengali';
  return 'arial';
}

/**
 * Renders text (including full Bengali & Unicode scripts, bold/italic/underline/spacing)
 * onto a transparent high-DPI canvas and returns PNG bytes so pdf-lib embeds any script crisply.
 */
export async function renderUnicodeTextPng(opts: {
  text: string;
  fontSize: number;
  fontFamily: PdfFontFamily;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing?: number;
  maxWidth?: number;
}): Promise<{ pngBytes: Uint8Array; widthPt: number; heightPt: number }> {
  const dpr = 3;
  const cssStack = getFontCssStack(opts.fontFamily);
  const fontSpec = `${opts.italic ? 'italic ' : ''}${opts.bold ? '700 ' : '400 '}${opts.fontSize}px ${cssStack}`;

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
    const pushTokenChars = (token: string) => {
      let chunk = '';
      for (const ch of token) {
        const testChunk = chunk + ch;
        if (measureInkWidth(testChunk) > limit && chunk) {
          wrappedLines.push(chunk);
          chunk = ch;
        } else {
          chunk = testChunk;
        }
      }
      cur = chunk;
    };
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (measureInkWidth(test) > limit) {
        if (cur) {
          wrappedLines.push(cur);
          cur = '';
        }
        if (measureInkWidth(w) > limit) {
          pushTokenChars(w);
        } else {
          cur = w;
        }
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

export function cancelCanvasRender(canvas: HTMLCanvasElement): void {
  const prevTask = activeCanvasTasks.get(canvas);
  if (prevTask) {
    try {
      prevTask.cancel();
    } catch {
      // ignore cancellation error
    }
    activeCanvasTasks.delete(canvas);
  }
}

export async function renderPageToCanvas(
  pdfBytes: ArrayBuffer,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5,
  extraRotation = 0,
  transparentBackground = false
): Promise<{ width: number; height: number; unscaledWidth: number; unscaledHeight: number }> {
  // Cancel any in-flight PDF.js render on this exact canvas so transforms never stack/flip
  cancelCanvasRender(canvas);

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
      const rawDpr = Math.min(window.devicePixelRatio || 1, 2);
      // Cap backing store to ~2400px longest side so zooming to 3x on high-DPR phones stays smooth
      const maxDim = Math.max(baseViewport.width, baseViewport.height, 1);
      const maxRenderScale = Math.min(scale * rawDpr, 2400 / maxDim);
      const effectiveRenderScale = Math.max(scale, maxRenderScale);
      const viewport = page.getViewport({ scale: effectiveRenderScale, rotation: rot });

      const displayW = Math.max(1, Math.floor(baseViewport.width * scale));
      const displayH = Math.max(1, Math.floor(baseViewport.height * scale));
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (transparentBackground) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        canvas,
        ...(transparentBackground ? { background: 'rgba(0,0,0,0)' } : {}),
      });
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

const pageEditorRunsCache = new WeakMap<
  ArrayBuffer,
  Map<number, { runs: ExtractedTextRun[]; pageWidth: number; pageHeight: number }>
>();

interface RawTextSpan {
  str: string;
  x: number;
  y: number;
  baselineY: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
}

export async function extractPageTextRuns(
  pdfBytes: ArrayBuffer,
  pageNumber: number
): Promise<{ runs: ExtractedTextRun[]; pageWidth: number; pageHeight: number }> {
  let docMap = pageEditorRunsCache.get(pdfBytes);
  if (!docMap) {
    docMap = new Map();
    pageEditorRunsCache.set(pdfBytes, docMap);
  }
  const cached = docMap.get(pageNumber);
  if (cached) return cached;

  const pdf = await getSharedPdfDocument(pdfBytes);
  const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(safePage);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();

  const rawSpans: RawTextSpan[] = [];
  for (const item of tc.items) {
    if (!('str' in item) || !item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const scaleX = Math.hypot(tx[0], tx[1]);
    const scaleY = Math.hypot(tx[2], tx[3]);
    const fontSize = Math.max(5.5, Math.max(scaleX, scaleY));
    const baselineY = tx[5];
    const x = tx[4];
    const width =
      item.width && item.width > 0
        ? item.width
        : Math.max(4, item.str.length * fontSize * 0.48);
    const height = Math.max(fontSize * 1.15, item.height || fontSize * 1.15);
    const y = baselineY - fontSize * 0.85;

    rawSpans.push({
      str: item.str,
      x,
      y,
      baselineY,
      width,
      height,
      fontSize,
      fontName: item.fontName || 'Helvetica',
    });
  }

  // Group spans onto same horizontal baseline rows, keeping separate columns cleanly divided
  rawSpans.sort((a, b) => a.baselineY - b.baselineY || a.x - b.x);
  const rowClusters: Array<{ avgBaselineY: number; avgFontSize: number; spans: RawTextSpan[] }> = [];

  for (const sp of rawSpans) {
    const lastCluster = rowClusters[rowClusters.length - 1];
    if (
      lastCluster &&
      Math.abs(sp.baselineY - lastCluster.avgBaselineY) <=
        Math.max(2.5, Math.min(sp.fontSize, lastCluster.avgFontSize) * 0.45)
    ) {
      const n = lastCluster.spans.length;
      lastCluster.avgBaselineY = (lastCluster.avgBaselineY * n + sp.baselineY) / (n + 1);
      lastCluster.avgFontSize = (lastCluster.avgFontSize * n + sp.fontSize) / (n + 1);
      lastCluster.spans.push(sp);
    } else {
      rowClusters.push({ avgBaselineY: sp.baselineY, avgFontSize: sp.fontSize, spans: [sp] });
    }
  }

  const mergedRuns: ExtractedTextRun[] = [];
  let runSeq = 0;

  const flushSpan = (span: RawTextSpan) => {
    mergedRuns.push({
      id: `run_${safePage}_${runSeq++}`,
      pageNumber: safePage,
      str: span.str.replace(/\s+/g, ' ').trim(),
      x: span.x,
      y: span.y,
      width: Math.max(10, span.width),
      height: Math.max(10, span.height),
      fontSize: span.fontSize,
      fontName: span.fontName,
    });
  };

  for (const cluster of rowClusters) {
    cluster.spans.sort((a, b) => a.x - b.x);
    let current: RawTextSpan | null = null;

    for (const sp of cluster.spans) {
      if (!current) {
        current = { ...sp };
        continue;
      }

      const prev: RawTextSpan = current;
      const curRight = prev.x + prev.width;
      const gap = sp.x - curRight;
      const maxFs = Math.max(prev.fontSize, sp.fontSize);
      const minFs = Math.min(prev.fontSize, sp.fontSize);
      const compatibleSize = maxFs <= minFs * 1.55;
      const sameLineColumn = gap >= -Math.max(6, maxFs * 0.85) && gap <= maxFs * 2.1;

      if (compatibleSize && sameLineColumn) {
        const needsSpace: boolean =
          gap > minFs * 0.16 && !prev.str.endsWith(' ') && !sp.str.startsWith(' ');
        const nextStr: string = needsSpace ? `${prev.str} ${sp.str}` : `${prev.str}${sp.str}`;
        const nextLeft = Math.min(prev.x, sp.x);
        const nextRight = Math.max(curRight, sp.x + sp.width);
        const nextTop = Math.min(prev.y, sp.y);
        const nextBottom = Math.max(prev.y + prev.height, sp.y + sp.height);

        current = {
          str: nextStr,
          x: nextLeft,
          y: nextTop,
          baselineY: (prev.baselineY + sp.baselineY) / 2,
          width: nextRight - nextLeft,
          height: nextBottom - nextTop,
          fontSize: maxFs,
          fontName: prev.fontName,
        };
      } else {
        flushSpan(prev);
        current = { ...sp };
      }
    }
    if (current) flushSpan(current);
  }

  mergedRuns.sort((a, b) => a.y - b.y || a.x - b.x);
  const result = { runs: mergedRuns, pageWidth: viewport.width, pageHeight: viewport.height };
  docMap.set(pageNumber, result);
  return result;
}

const pageTextBoxCache = new WeakMap<ArrayBuffer, Map<string, ExtractedTextRun[]>>();

export async function extractPageTextBoxes(
  pdfBytes: ArrayBuffer,
  pageNumber: number,
  extraRotation = 0
): Promise<ExtractedTextRun[]> {
  let docMap = pageTextBoxCache.get(pdfBytes);
  if (!docMap) {
    docMap = new Map();
    pageTextBoxCache.set(pdfBytes, docMap);
  }
  const cacheKey = `${pageNumber}:${extraRotation}`;
  const existing = docMap.get(cacheKey);
  if (existing) return existing;

  const pdf = await getSharedPdfDocument(pdfBytes);
  const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(safePage);
  const rot = (((page.rotate || 0) + extraRotation) % 360 + 360) % 360;
  const viewport = page.getViewport({ scale: 1, rotation: rot });
  const tc = await page.getTextContent();
  const runs: ExtractedTextRun[] = [];

  tc.items.forEach((item, index) => {
    if (!('str' in item) || !item.str) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(6, Math.hypot(tx[0], tx[1]));
    const x = tx[4];
    const y = tx[5] - fontSize * 0.85;
    const width = Math.max(4, item.width);
    const height = Math.max(fontSize * 1.12, item.height || fontSize * 1.12);
    runs.push({
      id: `tb_${safePage}_${index}`,
      pageNumber: safePage,
      str: item.str,
      x,
      y,
      width,
      height,
      fontSize,
      fontName: item.fontName || 'Helvetica',
    });
  });

  docMap.set(cacheKey, runs);
  return runs;
}

export interface PdfOutlineEntry {
  title: string;
  pageNumber: number;
  level: number;
}

export async function extractPdfOutline(pdfBytes: ArrayBuffer): Promise<PdfOutlineEntry[]> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const rawOutline = await pdf.getOutline().catch(() => null);
  if (!rawOutline || rawOutline.length === 0) return [];

  const entries: PdfOutlineEntry[] = [];
  const walk = async (items: typeof rawOutline, level: number) => {
    for (const item of items) {
      let pageNumber = 1;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') {
          dest = await pdf.getDestination(dest);
        }
        if (Array.isArray(dest) && dest[0]) {
          const idx = await pdf.getPageIndex(dest[0] as Parameters<typeof pdf.getPageIndex>[0]);
          if (typeof idx === 'number' && idx >= 0) {
            pageNumber = idx + 1;
          }
        }
      } catch {
        pageNumber = 1;
      }
      if (item.title?.trim()) {
        entries.push({
          title: item.title.trim(),
          pageNumber,
          level,
        });
      }
      if (item.items && item.items.length > 0 && entries.length < 250) {
        await walk(item.items, Math.min(3, level + 1));
      }
    }
  };
  await walk(rawOutline, 0);
  return entries;
}

export async function extractPdfFormFields(
  pdfBytes: ArrayBuffer,
  extraRotation = 0
): Promise<PdfFormFieldDescriptor[]> {
  const libDoc = await PDFDocument.load(cloneBuffer(pdfBytes), { ignoreEncryption: true });
  const form = libDoc.getForm();
  const libFields = form.getFields();
  if (libFields.length === 0) return [];

  const fieldMeta = new Map<
    string,
    { kind: PdfFormFieldDescriptor['kind']; value: string; checked: boolean; options?: string[] }
  >();

  for (const field of libFields) {
    const name = field.getName();
    if (field instanceof PDFTextField) {
      fieldMeta.set(name, {
        kind: 'text',
        value: field.getText() || '',
        checked: false,
      });
    } else if (field instanceof PDFCheckBox) {
      fieldMeta.set(name, {
        kind: 'checkbox',
        value: field.isChecked() ? 'true' : 'false',
        checked: field.isChecked(),
      });
    } else if (field instanceof PDFDropdown) {
      const sel = field.getSelected();
      fieldMeta.set(name, {
        kind: 'dropdown',
        value: sel[0] || '',
        checked: false,
        options: field.getOptions(),
      });
    } else if (field instanceof PDFOptionList) {
      const sel = field.getSelected();
      fieldMeta.set(name, {
        kind: 'dropdown',
        value: sel[0] || '',
        checked: false,
        options: field.getOptions(),
      });
    } else if (field instanceof PDFRadioGroup) {
      fieldMeta.set(name, {
        kind: 'radio',
        value: field.getSelected() || '',
        checked: false,
        options: field.getOptions(),
      });
    }
  }

  const pdf = await getSharedPdfDocument(pdfBytes);
  const descriptors: PdfFormFieldDescriptor[] = [];
  const seenNames = new Set<string>();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const rot = (((page.rotate || 0) + extraRotation) % 360 + 360) % 360;
    const viewport = page.getViewport({ scale: 1, rotation: rot });
    const annotations = await page.getAnnotations().catch(() => []);
    for (const ann of annotations) {
      if (ann.subtype !== 'Widget' || !ann.fieldName || !Array.isArray(ann.rect)) continue;
      const meta = fieldMeta.get(ann.fieldName);
      if (!meta) continue;
      const [vx1, vy1] = viewport.convertToViewportPoint(ann.rect[0], ann.rect[1]);
      const [vx2, vy2] = viewport.convertToViewportPoint(ann.rect[2], ann.rect[3]);
      const x = Math.min(vx1, vx2);
      const y = Math.min(vy1, vy2);
      const width = Math.max(16, Math.abs(vx2 - vx1));
      const height = Math.max(14, Math.abs(vy2 - vy1));
      descriptors.push({
        name: ann.fieldName,
        pageNumber: p,
        kind: meta.kind,
        value: meta.value,
        checked: meta.checked,
        options: meta.options,
        x,
        y,
        width,
        height,
      });
      seenNames.add(ann.fieldName);
    }
  }

  // Fallback for any fields whose widgets weren't matched
  let fallbackOffset = 0;
  for (const [name, meta] of fieldMeta.entries()) {
    if (!seenNames.has(name)) {
      descriptors.push({
        name,
        pageNumber: 1,
        kind: meta.kind,
        value: meta.value,
        checked: meta.checked,
        options: meta.options,
        x: 40,
        y: 60 + fallbackOffset * 34,
        width: 220,
        height: 24,
      });
      fallbackOffset++;
    }
  }

  return descriptors;
}

export async function applyPdfFormFieldValues(
  pdfBytes: ArrayBuffer,
  values: Record<string, { value?: string; checked?: boolean }>,
  flatten = false
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(pdfBytes), { ignoreEncryption: true });
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const entry = values[field.getName()];
    if (!entry) continue;
    try {
      if (field instanceof PDFTextField) {
        field.setText(entry.value ?? '');
      } else if (field instanceof PDFCheckBox) {
        if (entry.checked) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (entry.value) field.select(entry.value);
      } else if (field instanceof PDFRadioGroup) {
        if (entry.value) field.select(entry.value);
      }
    } catch {
      // Skip incompatible field value cleanly
    }
  }

  try {
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helv);
  } catch {
    // Fallback to existing appearances
  }

  if (flatten) {
    try {
      form.flatten();
    } catch {
      // Ignore flatten errors on non-standard fields
    }
  }

  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
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
  const fontHelvBoldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const fontTimes = await doc.embedFont(StandardFonts.TimesRoman);
  const fontTimesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const fontTimesItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const fontTimesBoldItalic = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const fontCourier = await doc.embedFont(StandardFonts.Courier);
  const fontCourierBold = await doc.embedFont(StandardFonts.CourierBold);
  const fontCourierItalic = await doc.embedFont(StandardFonts.CourierOblique);
  const fontCourierBoldItalic = await doc.embedFont(StandardFonts.CourierBoldOblique);

  const isCustomDesktopFont = (family: PdfFontFamily) =>
    family === 'calibri' ||
    family === 'cambria' ||
    family === 'georgia' ||
    family === 'verdana' ||
    family === 'tahoma' ||
    family === 'garamond' ||
    family === 'trebuchet' ||
    family === 'bengali';

  const pickStandardFont = (family: PdfFontFamily, bold: boolean, italic: boolean) => {
    if (family === 'mono' || family === 'courier') {
      if (bold && italic) return fontCourierBoldItalic;
      if (bold) return fontCourierBold;
      if (italic) return fontCourierItalic;
      return fontCourier;
    }
    if (
      family === 'serif' ||
      family === 'times' ||
      family === 'cambria' ||
      family === 'georgia' ||
      family === 'garamond'
    ) {
      if (bold && italic) return fontTimesBoldItalic;
      if (bold) return fontTimesBold;
      if (italic) return fontTimesItalic;
      return fontTimes;
    }
    if (bold && italic) return fontHelvBoldItalic;
    if (bold) return fontHelvBold;
    if (italic) return fontHelvItalic;
    return fontHelv;
  };

  const embedDataUrlImage = async (dataUrl: string) => {
    const normalizePngBytes = async (srcUrl: string): Promise<Uint8Array> => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to decode image overlay'));
        img.src = srcUrl;
      });
      const c = document.createElement('canvas');
      c.width = Math.max(1, img.naturalWidth || 200);
      c.height = Math.max(1, img.naturalHeight || 200);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const pngUrl = c.toDataURL('image/png');
      const b64 = pngUrl.split(',')[1] || '';
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };

    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;
    if (dataUrl.startsWith('data:image/png')) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return doc.embedPng(bytes);
    }
    if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return doc.embedJpg(bytes);
    }
    const pngBytes = await normalizePngBytes(dataUrl);
    return doc.embedPng(pngBytes);
  };

  const makeVisualMapper = (page: ReturnType<PDFDocument['getPages']>[number]) => {
    const { visW, visH, toPdfPoint } = getVisualPageGeometry(page);
    const pageRot = ((page.getRotation().angle % 360) + 360) % 360;
    const swapped = pageRot === 90 || pageRot === 270;

    const mapPoint = (vx: number, vyTop: number) => toPdfPoint(vx, visH - vyTop, 0);

    const mapRect = (vx: number, vyTop: number, w: number, h: number, visCwDeg = 0) => {
      const vcx = vx + w / 2;
      const vcy = visH - vyTop - h / 2;
      const vRotDeg = -visCwDeg;
      const rad = (vRotDeg * Math.PI) / 180;
      const ox = (w / 2) * Math.cos(rad) - (h / 2) * Math.sin(rad);
      const oy = (w / 2) * Math.sin(rad) + (h / 2) * Math.cos(rad);
      return toPdfPoint(vcx - ox, vcy - oy, vRotDeg);
    };

    const mapBaselineText = (
      vx: number,
      vyTopBaseline: number,
      visCwDeg = 0,
      centerX?: number,
      centerYTop?: number
    ) => {
      const vcy = centerYTop !== undefined ? visH - centerYTop : visH - vyTopBaseline;
      const vyPdf = visH - vyTopBaseline;
      if (visCwDeg !== 0 && centerX !== undefined) {
        const rad = (-visCwDeg * Math.PI) / 180;
        const rx = centerX + (vx - centerX) * Math.cos(rad) - (vyPdf - vcy) * Math.sin(rad);
        const ry = vcy + (vx - centerX) * Math.sin(rad) + (vyPdf - vcy) * Math.cos(rad);
        return toPdfPoint(rx, ry, -visCwDeg);
      }
      return toPdfPoint(vx, vyPdf, -visCwDeg);
    };

    return { visW, visH, swapped, mapPoint, mapRect, mapBaselineText, toPdfPoint };
  };

  const bakeAdjustedImageDataUrl = async (imgOv: AddedImageOverlay): Promise<string> => {
    const flipX = Boolean(imgOv.flipX);
    const flipY = Boolean(imgOv.flipY);
    const brightness = imgOv.brightness ?? 100;
    const contrast = imgOv.contrast ?? 100;
    const grayscale = Boolean(imgOv.grayscale);
    const radiusPct = Math.max(0, Math.min(50, imgOv.borderRadius ?? 0));
    const borderW = Math.max(0, imgOv.borderWidth ?? 0);

    if (
      !flipX &&
      !flipY &&
      brightness === 100 &&
      contrast === 100 &&
      !grayscale &&
      radiusPct === 0 &&
      borderW === 0
    ) {
      return imgOv.dataUrl;
    }

    const imgEl = new Image();
    await new Promise<void>((resolve, reject) => {
      imgEl.onload = () => resolve();
      imgEl.onerror = () => reject(new Error('Failed to decode adjusted image'));
      imgEl.src = imgOv.dataUrl;
    });

    const pxScale = 3;
    const cw = Math.max(60, Math.round(imgOv.width * pxScale));
    const ch = Math.max(60, Math.round(imgOv.height * pxScale));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d')!;

    const radiusPx = Math.min(cw, ch) * (radiusPct / 100);
    const traceRoundedPath = (inset = 0) => {
      const rw = Math.max(4, cw - inset * 2);
      const rh = Math.max(4, ch - inset * 2);
      const r = Math.max(0, Math.min(Math.min(rw, rh) / 2, radiusPx - inset));
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(inset, inset, rw, rh, r);
      } else {
        ctx.moveTo(inset + r, inset);
        ctx.lineTo(inset + rw - r, inset);
        ctx.quadraticCurveTo(inset + rw, inset, inset + rw, inset + r);
        ctx.lineTo(inset + rw, inset + rh - r);
        ctx.quadraticCurveTo(inset + rw, inset + rh, inset + rw - r, inset + rh);
        ctx.lineTo(inset + r, inset + rh);
        ctx.quadraticCurveTo(inset, inset + rh, inset, inset + rh - r);
        ctx.lineTo(inset, inset + r);
        ctx.quadraticCurveTo(inset, inset, inset + r, inset);
      }
      ctx.closePath();
    };

    ctx.save();
    if (radiusPx > 0) {
      traceRoundedPath(0);
      ctx.clip();
    }
    const filters: string[] = [];
    if (brightness !== 100) filters.push(`brightness(${brightness}%)`);
    if (contrast !== 100) filters.push(`contrast(${contrast}%)`);
    if (grayscale) filters.push('grayscale(100%)');
    if (filters.length > 0) ctx.filter = filters.join(' ');

    ctx.translate(cw / 2, ch / 2);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.drawImage(imgEl, -cw / 2, -ch / 2, cw, ch);
    ctx.restore();

    if (borderW > 0) {
      const strokePx = borderW * pxScale;
      ctx.save();
      traceRoundedPath(strokePx / 2);
      ctx.strokeStyle = imgOv.borderColor || '#142B4A';
      ctx.lineWidth = strokePx;
      ctx.stroke();
      ctx.restore();
    }

    return c.toDataURL('image/png');
  };

  type PageRef = ReturnType<PDFDocument['getPages']>[number];
  type VisualMapper = ReturnType<typeof makeVisualMapper>;

  const renderReplacement = async (page: PageRef, vm: VisualMapper, rep: TextReplacementEdit) => {
    const maskPt = vm.mapRect(
      Math.max(0, rep.x - 1.5),
      Math.max(0, rep.y - 1.5),
      rep.width + 4,
      rep.height + 4,
      0
    );
    page.drawRectangle({
      x: maskPt.x,
      y: maskPt.y,
      width: rep.width + 4,
      height: rep.height + 4,
      color: rep.backgroundColor ? hexToRgb(rep.backgroundColor) : rgb(1, 1, 1),
      ...(maskPt.angleDeg !== 0 ? { rotate: degrees(maskPt.angleDeg) } : {}),
    });

    if (!rep.deleted && rep.newText.trim()) {
      if (
        hasNonWinAnsiChars(rep.newText) ||
        (rep.letterSpacing || 0) !== 0 ||
        rep.newText.includes('\n') ||
        isCustomDesktopFont(rep.fontFamily)
      ) {
        const availableW = rep.newText.includes('\n')
          ? Math.max(rep.width + 24, 320)
          : Math.max(rep.width + 40, vm.visW - rep.x - 12);
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
          maxWidth: availableW,
        });
        const img = await doc.embedPng(rendered.pngBytes);
        const imgPt = vm.mapRect(rep.x, rep.y, rendered.widthPt, rendered.heightPt, 0);
        page.drawImage(img, {
          x: imgPt.x,
          y: imgPt.y,
          width: rendered.widthPt,
          height: rendered.heightPt,
          ...(imgPt.angleDeg !== 0 ? { rotate: degrees(imgPt.angleDeg) } : {}),
        });
      } else {
        const font = pickStandardFont(rep.fontFamily, rep.bold, rep.italic);
        const col = hexToRgb(rep.color);
        const tw = font.widthOfTextAtSize(rep.newText, rep.fontSize);
        const boxW = Math.max(rep.width, tw);
        let drawX = rep.x;
        if (rep.align === 'center') drawX = rep.x + (boxW - tw) / 2;
        if (rep.align === 'right') drawX = rep.x + boxW - tw;
        const baselineTop = rep.y + rep.fontSize * 0.9;
        const txtPt = vm.mapBaselineText(drawX, baselineTop, 0);
        page.drawText(rep.newText, {
          x: txtPt.x,
          y: txtPt.y,
          size: rep.fontSize,
          font,
          color: col,
          ...(txtPt.angleDeg !== 0 ? { rotate: degrees(txtPt.angleDeg) } : {}),
        });
        if (rep.underline && tw > 0) {
          const u1 = vm.mapPoint(drawX, baselineTop + 2);
          const u2 = vm.mapPoint(drawX + tw, baselineTop + 2);
          page.drawLine({
            start: { x: u1.x, y: u1.y },
            end: { x: u2.x, y: u2.y },
            thickness: Math.max(0.8, rep.fontSize * 0.07),
            color: col,
          });
        }
      }
    }
  };

  const renderTextBox = async (page: PageRef, vm: VisualMapper, tb: AddedTextBox) => {
    if (!tb.text.trim()) return;
    const boxW = Math.max(80, tb.width || 260);
    const rotCw = tb.rotation || 0;

    if (
      hasNonWinAnsiChars(tb.text) ||
      (tb.letterSpacing || 0) !== 0 ||
      isCustomDesktopFont(tb.fontFamily)
    ) {
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
        maxWidth: boxW,
      });
      const drawW = Math.max(boxW, rendered.widthPt);
      const drawH = rendered.heightPt + 6;

      if ((tb.backgroundColor && tb.backgroundColor !== 'transparent') || tb.borderColor) {
        const bgPt = vm.mapRect(tb.x, tb.y, drawW, drawH, rotCw);
        page.drawRectangle({
          x: bgPt.x,
          y: bgPt.y,
          width: drawW,
          height: drawH,
          ...(tb.backgroundColor && tb.backgroundColor !== 'transparent'
            ? { color: hexToRgb(tb.backgroundColor), opacity: 0.96 }
            : {}),
          ...(tb.borderColor
            ? { borderColor: hexToRgb(tb.borderColor), borderWidth: 1 }
            : {}),
          ...(bgPt.angleDeg !== 0 ? { rotate: degrees(bgPt.angleDeg) } : {}),
        });
      }

      const img = await doc.embedPng(rendered.pngBytes);
      const centerX = tb.x + drawW / 2;
      const centerYTop = tb.y + drawH / 2;
      const imgPt = vm.mapRect(
        centerX - rendered.widthPt / 2,
        centerYTop - rendered.heightPt / 2,
        rendered.widthPt,
        rendered.heightPt,
        rotCw
      );
      page.drawImage(img, {
        x: imgPt.x,
        y: imgPt.y,
        width: rendered.widthPt,
        height: rendered.heightPt,
        ...(imgPt.angleDeg !== 0 ? { rotate: degrees(imgPt.angleDeg) } : {}),
      });
    } else {
      const font = pickStandardFont(tb.fontFamily, tb.bold, tb.italic);
      const col = hexToRgb(tb.color);
      const lineStep = tb.fontSize * 1.32;
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
          if (font.widthOfTextAtSize(test, tb.fontSize) > boxW - 8 && cur) {
            outLines.push(cur);
            cur = w;
          } else {
            cur = test;
          }
        }
        if (cur) outLines.push(cur);
      }

      const boxH = Math.max(tb.fontSize * 1.5 + 6, outLines.length * lineStep + 8);
      const centerX = tb.x + boxW / 2;
      const centerYTop = tb.y + boxH / 2;

      if ((tb.backgroundColor && tb.backgroundColor !== 'transparent') || tb.borderColor) {
        const bgPt = vm.mapRect(tb.x, tb.y, boxW, boxH, rotCw);
        page.drawRectangle({
          x: bgPt.x,
          y: bgPt.y,
          width: boxW,
          height: boxH,
          ...(tb.backgroundColor && tb.backgroundColor !== 'transparent'
            ? { color: hexToRgb(tb.backgroundColor), opacity: 0.96 }
            : {}),
          ...(tb.borderColor
            ? { borderColor: hexToRgb(tb.borderColor), borderWidth: 1 }
            : {}),
          ...(bgPt.angleDeg !== 0 ? { rotate: degrees(bgPt.angleDeg) } : {}),
        });
      }

      const vRad = (rotCw * Math.PI) / 180;
      const rotScreenPt = (px: number, py: number) =>
        rotCw === 0
          ? { x: px, y: py }
          : {
              x: centerX + (px - centerX) * Math.cos(vRad) - (py - centerYTop) * Math.sin(vRad),
              y: centerYTop + (px - centerX) * Math.sin(vRad) + (py - centerYTop) * Math.cos(vRad),
            };

      outLines.forEach((line, idx) => {
        if (!line) return;
        const tw = font.widthOfTextAtSize(line, tb.fontSize);
        let drawX = tb.x + 4;
        if (tb.align === 'center') drawX = tb.x + Math.max(4, (boxW - tw) / 2);
        if (tb.align === 'right') drawX = tb.x + Math.max(4, boxW - tw - 4);
        const baselineTop = tb.y + tb.fontSize + 3 + idx * lineStep;
        const txtPt = vm.mapBaselineText(drawX, baselineTop, rotCw, centerX, centerYTop);
        page.drawText(line, {
          x: txtPt.x,
          y: txtPt.y,
          size: tb.fontSize,
          font,
          color: col,
          ...(txtPt.angleDeg !== 0 ? { rotate: degrees(txtPt.angleDeg) } : {}),
        });
        if (tb.underline && tw > 0) {
          const s1 = rotScreenPt(drawX, baselineTop + 2);
          const s2 = rotScreenPt(drawX + tw, baselineTop + 2);
          const u1 = vm.mapPoint(s1.x, s1.y);
          const u2 = vm.mapPoint(s2.x, s2.y);
          page.drawLine({
            start: { x: u1.x, y: u1.y },
            end: { x: u2.x, y: u2.y },
            thickness: Math.max(0.8, tb.fontSize * 0.07),
            color: col,
          });
        }
      });
    }
  };

  const renderImageOverlay = async (page: PageRef, vm: VisualMapper, imgOv: AddedImageOverlay) => {
    const processedUrl = await bakeAdjustedImageDataUrl(imgOv);
    const embedded = await embedDataUrlImage(processedUrl);
    if (!embedded) return;
    const imgPt = vm.mapRect(imgOv.x, imgOv.y, imgOv.width, imgOv.height, imgOv.rotation || 0);
    page.drawImage(embedded, {
      x: imgPt.x,
      y: imgPt.y,
      width: imgOv.width,
      height: imgOv.height,
      opacity: imgOv.opacity ?? 1,
      ...(imgPt.angleDeg !== 0 ? { rotate: degrees(imgPt.angleDeg) } : {}),
    });
  };

  const renderAnnotationOverlay = async (page: PageRef, vm: VisualMapper, ann: AnnotationOverlay) => {
    const color = hexToRgb(ann.color || '#2563EB');

    if (ann.kind === 'highlight') {
      const pt = vm.mapRect(ann.x, ann.y, ann.width, ann.height, 0);
      page.drawRectangle({
        x: pt.x,
        y: pt.y,
        width: ann.width,
        height: ann.height,
        color,
        opacity: ann.opacity ?? 0.34,
        ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
      });
    } else if (ann.kind === 'whiteout') {
      const pt = vm.mapRect(ann.x, ann.y, ann.width, ann.height, 0);
      page.drawRectangle({
        x: pt.x,
        y: pt.y,
        width: ann.width,
        height: ann.height,
        color: hexToRgb(ann.fillColor || ann.color || '#FFFFFF'),
        opacity: ann.opacity ?? 1,
        ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
      });
    } else if (ann.kind === 'underline') {
      const p1 = vm.mapPoint(ann.x, ann.y + ann.height);
      const p2 = vm.mapPoint(ann.x + ann.width, ann.y + ann.height);
      page.drawLine({
        start: { x: p1.x, y: p1.y },
        end: { x: p2.x, y: p2.y },
        thickness: ann.strokeWidth || 2,
        color,
        lineCap: LineCapStyle.Round,
        opacity: ann.opacity ?? 1,
      });
    } else if (ann.kind === 'strikethrough') {
      const p1 = vm.mapPoint(ann.x, ann.y + ann.height / 2);
      const p2 = vm.mapPoint(ann.x + ann.width, ann.y + ann.height / 2);
      page.drawLine({
        start: { x: p1.x, y: p1.y },
        end: { x: p2.x, y: p2.y },
        thickness: ann.strokeWidth || 2,
        color,
        lineCap: LineCapStyle.Round,
        opacity: ann.opacity ?? 1,
      });
    } else if (ann.kind === 'rect') {
      const pt = vm.mapRect(ann.x, ann.y, ann.width, ann.height, 0);
      page.drawRectangle({
        x: pt.x,
        y: pt.y,
        width: ann.width,
        height: ann.height,
        borderColor: color,
        borderWidth: ann.strokeWidth || 2,
        ...(ann.lineStyle === 'dashed' ? { borderDashArray: [6, 4] } : {}),
        ...(ann.fillColor
          ? { color: hexToRgb(ann.fillColor), opacity: 0.18, borderOpacity: ann.opacity ?? 1 }
          : { borderOpacity: ann.opacity ?? 1 }),
        ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
      });
    } else if (ann.kind === 'circle') {
      const center = vm.mapPoint(ann.x + ann.width / 2, ann.y + ann.height / 2);
      const rx = Math.max(1, ann.width / 2);
      const ry = Math.max(1, ann.height / 2);
      page.drawEllipse({
        x: center.x,
        y: center.y,
        xScale: vm.swapped ? ry : rx,
        yScale: vm.swapped ? rx : ry,
        borderColor: color,
        borderWidth: ann.strokeWidth || 2,
        ...(ann.lineStyle === 'dashed' ? { borderDashArray: [6, 4] } : {}),
        ...(ann.fillColor
          ? { color: hexToRgb(ann.fillColor), opacity: 0.18, borderOpacity: ann.opacity ?? 1 }
          : { borderOpacity: ann.opacity ?? 1 }),
      });
    } else if (ann.kind === 'arrow') {
      const sx = ann.x;
      const sy = ann.y;
      const ex = ann.x + ann.width;
      const ey = ann.y + ann.height;
      const startPt = vm.mapPoint(sx, sy);
      const endPt = vm.mapPoint(ex, ey);
      const thick = ann.strokeWidth || 2.5;
      const op = ann.opacity ?? 1;
      const arrowStyle = ann.arrowStyle || 'single';
      page.drawLine({
        start: { x: startPt.x, y: startPt.y },
        end: { x: endPt.x, y: endPt.y },
        thickness: thick,
        color,
        lineCap: LineCapStyle.Round,
        opacity: op,
        ...(ann.lineStyle === 'dashed' ? { dashArray: [6, 4] } : {}),
      });
      const angle = Math.atan2(endPt.y - startPt.y, endPt.x - startPt.x);
      const headLen = Math.max(9, thick * 3.4);
      if (arrowStyle !== 'line') {
        page.drawLine({
          start: { x: endPt.x, y: endPt.y },
          end: { x: endPt.x - headLen * Math.cos(angle - Math.PI / 6), y: endPt.y - headLen * Math.sin(angle - Math.PI / 6) },
          thickness: thick,
          color,
          lineCap: LineCapStyle.Round,
          opacity: op,
        });
        page.drawLine({
          start: { x: endPt.x, y: endPt.y },
          end: { x: endPt.x - headLen * Math.cos(angle + Math.PI / 6), y: endPt.y - headLen * Math.sin(angle + Math.PI / 6) },
          thickness: thick,
          color,
          lineCap: LineCapStyle.Round,
          opacity: op,
        });
      }
      if (arrowStyle === 'double') {
        const revAngle = angle + Math.PI;
        page.drawLine({
          start: { x: startPt.x, y: startPt.y },
          end: { x: startPt.x - headLen * Math.cos(revAngle - Math.PI / 6), y: startPt.y - headLen * Math.sin(revAngle - Math.PI / 6) },
          thickness: thick,
          color,
          lineCap: LineCapStyle.Round,
          opacity: op,
        });
        page.drawLine({
          start: { x: startPt.x, y: startPt.y },
          end: { x: startPt.x - headLen * Math.cos(revAngle + Math.PI / 6), y: startPt.y - headLen * Math.sin(revAngle + Math.PI / 6) },
          thickness: thick,
          color,
          lineCap: LineCapStyle.Round,
          opacity: op,
        });
      }
    } else if (ann.kind === 'freehand' && ann.points && ann.points.length > 1) {
      const pts = ann.points;
      const thick = ann.strokeWidth || 2.5;
      const op = ann.opacity ?? 1;
      const smoothPts: Array<{ x: number; y: number }> = [pts[0]];
      if (pts.length === 2) {
        smoothPts.push(pts[1]);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const prev = smoothPts[smoothPts.length - 1];
          const ctrl = pts[i];
          const nextMid = {
            x: (pts[i].x + pts[i + 1].x) / 2,
            y: (pts[i].y + pts[i + 1].y) / 2,
          };
          for (let s = 1; s <= 4; s++) {
            const t = s / 4;
            const mt = 1 - t;
            smoothPts.push({
              x: mt * mt * prev.x + 2 * mt * t * ctrl.x + t * t * nextMid.x,
              y: mt * mt * prev.y + 2 * mt * t * ctrl.y + t * t * nextMid.y,
            });
          }
        }
        smoothPts.push(pts[pts.length - 1]);
      }
      for (let i = 1; i < smoothPts.length; i++) {
        const p1 = vm.mapPoint(smoothPts[i - 1].x, smoothPts[i - 1].y);
        const p2 = vm.mapPoint(smoothPts[i].x, smoothPts[i].y);
        page.drawLine({
          start: { x: p1.x, y: p1.y },
          end: { x: p2.x, y: p2.y },
          thickness: thick,
          color,
          lineCap: LineCapStyle.Round,
          opacity: op,
        });
      }
    } else if (ann.kind === 'sticky') {
      const boxW = Math.max(84, ann.width || 165);
      const boxH = Math.max(44, ann.height || 76);
      const noteBg = hexToRgb(ann.fillColor || '#FEF3C7');
      const noteAccent = hexToRgb(ann.color && ann.color !== '#FACC15' ? ann.color : '#D97706');
      const fontSize = Math.max(7, Math.min(24, ann.fontSize || 9.5));

      const boxPt = vm.mapRect(ann.x, ann.y, boxW, boxH, 0);
      page.drawRectangle({
        x: boxPt.x,
        y: boxPt.y,
        width: boxW,
        height: boxH,
        color: noteBg,
        borderColor: noteAccent,
        borderWidth: 1.4,
        ...(boxPt.angleDeg !== 0 ? { rotate: degrees(boxPt.angleDeg) } : {}),
      });

      const arrowGeo = computeStickyArrowGeometry(ann);
      if (arrowGeo.hasArrow) {
        const stemStart = vm.mapPoint(arrowGeo.startX, arrowGeo.startY);
        const stemEnd = vm.mapPoint(arrowGeo.tipX, arrowGeo.tipY);
        const thick = Math.max(1.8, ann.strokeWidth || 2.1);
        page.drawLine({
          start: { x: stemStart.x, y: stemStart.y },
          end: { x: stemEnd.x, y: stemEnd.y },
          thickness: thick,
          color: noteAccent,
          lineCap: LineCapStyle.Round,
        });
        const ang = Math.atan2(stemEnd.y - stemStart.y, stemEnd.x - stemStart.x);
        const headLen = Math.max(7, Math.min(13, thick * 3.6));
        page.drawLine({
          start: { x: stemEnd.x, y: stemEnd.y },
          end: { x: stemEnd.x - headLen * Math.cos(ang - Math.PI / 6), y: stemEnd.y - headLen * Math.sin(ang - Math.PI / 6) },
          thickness: thick,
          color: noteAccent,
          lineCap: LineCapStyle.Round,
        });
        page.drawLine({
          start: { x: stemEnd.x, y: stemEnd.y },
          end: { x: stemEnd.x - headLen * Math.cos(ang + Math.PI / 6), y: stemEnd.y - headLen * Math.sin(ang + Math.PI / 6) },
          thickness: thick,
          color: noteAccent,
          lineCap: LineCapStyle.Round,
        });
      }

      const noteText = (ann.comment || 'Note').slice(0, 800);
      const innerW = Math.max(40, boxW - 12);
      if (hasNonWinAnsiChars(noteText)) {
        const rendered = await renderUnicodeTextPng({
          text: noteText,
          fontSize,
          fontFamily: 'sans',
          color: '#1E293B',
          bold: false,
          italic: false,
          underline: false,
          align: 'left',
          maxWidth: innerW,
        });
        const img = await doc.embedPng(rendered.pngBytes);
        const drawH = Math.min(boxH - 8, rendered.heightPt);
        const drawW = rendered.heightPt > boxH - 8 ? rendered.widthPt * (drawH / rendered.heightPt) : rendered.widthPt;
        const imgPt = vm.mapRect(ann.x + 6, ann.y + 5, Math.min(innerW, drawW), drawH, 0);
        page.drawImage(img, {
          x: imgPt.x,
          y: imgPt.y,
          width: Math.min(innerW, drawW),
          height: drawH,
          ...(imgPt.angleDeg !== 0 ? { rotate: degrees(imgPt.angleDeg) } : {}),
        });
      } else {
        const lineHeight = fontSize * 1.28;
        const maxLines = Math.max(1, Math.floor((boxH - 10) / lineHeight));
        const wrapped: string[] = [];
        for (const rawLine of noteText.split('\n')) {
          const words = rawLine.split(/\s+/);
          let cur = '';
          for (const w of words) {
            const test = cur ? `${cur} ${w}` : w;
            if (fontHelv.widthOfTextAtSize(test, fontSize) > innerW && cur) {
              wrapped.push(cur);
              cur = w;
            } else {
              cur = test;
            }
          }
          wrapped.push(cur);
        }
        wrapped.slice(0, maxLines).forEach((ln, idx) => {
          if (!ln) return;
          const txtPt = vm.mapBaselineText(ann.x + 6, ann.y + fontSize + 5 + idx * lineHeight, 0);
          page.drawText(ln, {
            x: txtPt.x,
            y: txtPt.y,
            size: fontSize,
            font: fontHelv,
            color: rgb(0.12, 0.16, 0.23),
            ...(txtPt.angleDeg !== 0 ? { rotate: degrees(txtPt.angleDeg) } : {}),
          });
        });
      }
    } else if (ann.kind === 'stamp') {
      const label = (ann.comment || ann.dateStr || new Date().toLocaleDateString()).trim();
      const stampFont = Math.max(8, Math.min(26, ann.fontSize || 10));
      const stampW = Math.max(96, ann.width || label.length * stampFont * 0.72 + 20);
      const stampH = Math.max(24, ann.height || stampFont * 2.4);
      const rotCw = ann.rotation || 0;
      const isSolidFill = Boolean(ann.fillColor);

      const rectPt = vm.mapRect(ann.x, ann.y, stampW, stampH, rotCw);
      page.drawRectangle({
        x: rectPt.x,
        y: rectPt.y,
        width: stampW,
        height: stampH,
        borderColor: color,
        borderWidth: 1.8,
        color: isSolidFill ? color : rgb(0.98, 0.99, 1),
        opacity: isSolidFill ? 0.92 : 0.94,
        ...(rectPt.angleDeg !== 0 ? { rotate: degrees(rectPt.angleDeg) } : {}),
      });
      const textColorHex = isSolidFill ? '#FFFFFF' : ann.color || '#2563EB';
      const textCol = isSolidFill ? rgb(1, 1, 1) : color;
      const centerX = ann.x + stampW / 2;
      const centerYTop = ann.y + stampH / 2;

      if (hasNonWinAnsiChars(label)) {
        const rendered = await renderUnicodeTextPng({
          text: label,
          fontSize: stampFont,
          fontFamily: 'sans',
          color: textColorHex,
          bold: true,
          italic: false,
          underline: false,
          align: 'center',
          maxWidth: stampW - 8,
        });
        const img = await doc.embedPng(rendered.pngBytes);
        const imgPt = vm.mapRect(
          centerX - rendered.widthPt / 2,
          centerYTop - rendered.heightPt / 2,
          rendered.widthPt,
          rendered.heightPt,
          rotCw
        );
        page.drawImage(img, {
          x: imgPt.x,
          y: imgPt.y,
          width: rendered.widthPt,
          height: rendered.heightPt,
          ...(imgPt.angleDeg !== 0 ? { rotate: degrees(imgPt.angleDeg) } : {}),
        });
      } else {
        const tw = fontHelvBold.widthOfTextAtSize(label, stampFont);
        const rawTx = ann.x + Math.max(8, (stampW - tw) / 2);
        const baselineTop = ann.y + stampH / 2 + stampFont * 0.35;
        const txtPt = vm.mapBaselineText(rawTx, baselineTop, rotCw, centerX, centerYTop);
        page.drawText(label, {
          x: txtPt.x,
          y: txtPt.y,
          size: stampFont,
          font: fontHelvBold,
          color: textCol,
          ...(txtPt.angleDeg !== 0 ? { rotate: degrees(txtPt.angleDeg) } : {}),
        });
      }
    } else if (ann.kind === 'signature' && ann.signatureDataUrl) {
      const sigImg = await embedDataUrlImage(ann.signatureDataUrl);
      if (sigImg) {
        const rotCw = ann.rotation || 0;
        const sigPt = vm.mapRect(ann.x, ann.y, ann.width, ann.height, rotCw);
        page.drawImage(sigImg, {
          x: sigPt.x,
          y: sigPt.y,
          width: ann.width,
          height: ann.height,
          ...(sigPt.angleDeg !== 0 ? { rotate: degrees(sigPt.angleDeg) } : {}),
        });
        if (ann.signerName || ann.dateStr) {
          const caption = `${ann.signerName || ''} ${ann.dateStr ? `· ${ann.dateStr}` : ''}`.trim();
          if (caption) {
            if (hasNonWinAnsiChars(caption)) {
              const rendered = await renderUnicodeTextPng({
                text: caption,
                fontSize: 8,
                fontFamily: 'sans',
                color: '#475569',
                bold: false,
                italic: false,
                underline: false,
                align: 'left',
                maxWidth: Math.max(120, ann.width + 40),
              });
              const capImg = await doc.embedPng(rendered.pngBytes);
              const capPt = vm.mapRect(ann.x, ann.y + ann.height + 2, rendered.widthPt, rendered.heightPt, 0);
              page.drawImage(capImg, {
                x: capPt.x,
                y: capPt.y,
                width: rendered.widthPt,
                height: rendered.heightPt,
                ...(capPt.angleDeg !== 0 ? { rotate: degrees(capPt.angleDeg) } : {}),
              });
            } else {
              const txtPt = vm.mapBaselineText(ann.x, ann.y + ann.height + 10, 0);
              page.drawText(caption, {
                x: txtPt.x,
                y: txtPt.y,
                size: 8,
                font: fontHelv,
                color: rgb(0.3, 0.35, 0.45),
                ...(txtPt.angleDeg !== 0 ? { rotate: degrees(txtPt.angleDeg) } : {}),
              });
            }
          }
        }
      }
    }
  };

  type UnifiedRenderItem =
    | { kind: 'textBox'; z: number; order: number; behind: boolean; item: AddedTextBox }
    | { kind: 'image'; z: number; order: number; behind: boolean; item: AddedImageOverlay }
    | { kind: 'annotation'; z: number; order: number; behind: boolean; item: AnnotationOverlay };

  const pages = doc.getPages();
  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const pageNum = pIdx + 1;
    const page = pages[pIdx];
    const vm = makeVisualMapper(page);

    const pageReps = edits.replacements.filter((r) => r.pageNumber === pageNum);
    const items: UnifiedRenderItem[] = [];
    edits.addedTexts.forEach((tb, i) => {
      if (tb.pageNumber === pageNum) {
        items.push({
          kind: 'textBox',
          z: tb.zIndex ?? 1000 + i,
          order: i,
          behind: tb.layerPlacement === 'behind',
          item: tb,
        });
      }
    });
    edits.addedImages.forEach((im, i) => {
      if (im.pageNumber === pageNum) {
        items.push({
          kind: 'image',
          z: im.zIndex ?? 2000 + i,
          order: 100000 + i,
          behind: im.layerPlacement === 'behind',
          item: im,
        });
      }
    });
    edits.annotations.forEach((an, i) => {
      if (an.pageNumber === pageNum) {
        items.push({
          kind: 'annotation',
          z: an.zIndex ?? 3000 + i,
          order: 200000 + i,
          behind: an.layerPlacement === 'behind',
          item: an,
        });
      }
    });

    items.sort((a, b) => a.z - b.z || a.order - b.order);
    const behindItems = items.filter((it) => it.behind);
    const frontItems = items.filter((it) => !it.behind);

    if (behindItems.length > 0) {
      page.node.normalize();
      const origContents = page.node.Contents();
      const origLen = origContents instanceof PDFArray ? origContents.size() : 0;

      for (const entry of behindItems) {
        if (entry.kind === 'textBox') await renderTextBox(page, vm, entry.item);
        else if (entry.kind === 'image') await renderImageOverlay(page, vm, entry.item);
        else await renderAnnotationOverlay(page, vm, entry.item);
      }

      const afterContents = page.node.Contents();
      if (afterContents instanceof PDFArray && afterContents.size() > origLen && origLen > 0) {
        const behindStreamRef = afterContents.get(afterContents.size() - 1);
        afterContents.remove(afterContents.size() - 1);
        afterContents.insert(0, behindStreamRef);
        // Wrap original content streams in q/Q so CTM resets cleanly before front overlays
        afterContents.insert(1, doc.context.getPushGraphicsStateContentStream());
        afterContents.push(doc.context.getPopGraphicsStateContentStream());
      }
      page.resetPosition();
    }

    for (const rep of pageReps) {
      await renderReplacement(page, vm, rep);
    }

    for (const entry of frontItems) {
      if (entry.kind === 'textBox') await renderTextBox(page, vm, entry.item);
      else if (entry.kind === 'image') await renderImageOverlay(page, vm, entry.item);
      else await renderAnnotationOverlay(page, vm, entry.item);
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

export async function rotateAllPages(
  buf: ArrayBuffer,
  angleDelta: number,
  pageNumbers1Based?: number[]
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const targetSet =
    pageNumbers1Based && pageNumbers1Based.length > 0 ? new Set(pageNumbers1Based) : null;
  doc.getPages().forEach((page, idx) => {
    if (targetSet && !targetSet.has(idx + 1)) return;
    const cur = page.getRotation().angle;
    page.setRotation(degrees((cur + angleDelta + 360) % 360));
  });
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
    const rot = ((srcPage.getRotation().angle % 360) + 360) % 360;
    const isSwapped = rot === 90 || rot === 270;
    const visW = isSwapped ? srcH : srcW;
    const visH = isSwapped ? srcW : srcH;

    const embedded = await outDoc.embedPage(srcPage);
    const scaleFactor = Math.min(targetW / Math.max(1, visW), targetH / Math.max(1, visH));
    const drawW = srcW * scaleFactor;
    const drawH = srcH * scaleFactor;

    const newPage = outDoc.addPage([targetW, targetH]);
    newPage.drawRectangle({ x: 0, y: 0, width: targetW, height: targetH, color: rgb(1, 1, 1) });

    if (rot === 0) {
      newPage.drawPage(embedded, {
        x: (targetW - drawW) / 2,
        y: (targetH - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    } else {
      const pdfRotDeg = -rot;
      const rad = (pdfRotDeg * Math.PI) / 180;
      const ox = (drawW / 2) * Math.cos(rad) - (drawH / 2) * Math.sin(rad);
      const oy = (drawW / 2) * Math.sin(rad) + (drawH / 2) * Math.cos(rad);
      newPage.drawPage(embedded, {
        x: targetW / 2 - ox,
        y: targetH / 2 - oy,
        width: drawW,
        height: drawH,
        rotate: degrees(pdfRotDeg),
      });
    }
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

function getVisualPageGeometry(page: ReturnType<PDFDocument['getPages']>[number]) {
  const cb = page.getCropBox?.() || { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() };
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const swapped = rot === 90 || rot === 270;
  const visW = swapped ? cb.height : cb.width;
  const visH = swapped ? cb.width : cb.height;

  const toPdfPoint = (vx: number, vy: number, visAngleDeg = 0) => {
    if (rot === 90) {
      return { x: cb.x + cb.width - vy, y: cb.y + vx, angleDeg: visAngleDeg + 90 };
    }
    if (rot === 180) {
      return { x: cb.x + cb.width - vx, y: cb.y + cb.height - vy, angleDeg: visAngleDeg + 180 };
    }
    if (rot === 270) {
      return { x: cb.x + vy, y: cb.y + cb.height - vx, angleDeg: visAngleDeg + 270 };
    }
    return { x: cb.x + vx, y: cb.y + vy, angleDeg: visAngleDeg };
  };

  return { visW, visH, toPdfPoint };
}

export async function addWatermarkToPdf(
  buf: ArrayBuffer,
  options: { text: string; opacity: number; fontSize: number; color: string; angle: number }
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const col = hexToRgb(options.color);
  const safeText = options.text.trim() || 'CONFIDENTIAL';

  let cachedUnicodeImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  let unicodeW = 0;
  let unicodeH = 0;
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
    cachedUnicodeImg = await doc.embedPng(rendered.pngBytes);
    unicodeW = rendered.widthPt;
    unicodeH = rendered.heightPt;
  }

  for (const page of doc.getPages()) {
    const { visW, visH, toPdfPoint } = getVisualPageGeometry(page);
    const vcx = visW / 2;
    const vcy = visH / 2;
    const vRad = (options.angle * Math.PI) / 180;

    if (cachedUnicodeImg) {
      const ox = (unicodeW / 2) * Math.cos(vRad) - (unicodeH / 2) * Math.sin(vRad);
      const oy = (unicodeW / 2) * Math.sin(vRad) + (unicodeH / 2) * Math.cos(vRad);
      const pt = toPdfPoint(vcx - ox, vcy - oy, options.angle);
      page.drawImage(cachedUnicodeImg, {
        x: pt.x,
        y: pt.y,
        width: unicodeW,
        height: unicodeH,
        opacity: options.opacity,
        rotate: degrees(pt.angleDeg),
      });
    } else {
      const tw = font.widthOfTextAtSize(safeText, options.fontSize);
      const th = options.fontSize * 0.72;
      const ox = (tw / 2) * Math.cos(vRad) - (th / 2) * Math.sin(vRad);
      const oy = (tw / 2) * Math.sin(vRad) + (th / 2) * Math.cos(vRad);
      const pt = toPdfPoint(vcx - ox, vcy - oy, options.angle);
      page.drawText(safeText, {
        x: pt.x,
        y: pt.y,
        size: options.fontSize,
        font,
        color: col,
        opacity: options.opacity,
        rotate: degrees(pt.angleDeg),
      });
    }
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export type PageNumberPosition =
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'top-left'
  | 'top-center'
  | 'top-right';

export async function addPageNumbersToPdf(
  buf: ArrayBuffer,
  position: PageNumberPosition = 'bottom-center',
  format: 'number' | 'slash' | 'pageOfTotal' = 'pageOfTotal',
  options?: { startNumber?: number; skipFirstPage?: boolean; fontSize?: number; color?: string }
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  const startNum = Math.max(1, Math.floor(options?.startNumber ?? 1));
  const skipFirst = Boolean(options?.skipFirstPage);
  const fontSize = Math.max(7, Math.min(20, options?.fontSize ?? 10));
  const color = options?.color ? hexToRgb(options.color) : rgb(0.32, 0.39, 0.5);

  pages.forEach((page, idx) => {
    if (skipFirst && idx === 0) return;
    const displayNum = startNum + idx;
    const displayTotal = startNum + total - 1;
    const label =
      format === 'pageOfTotal'
        ? `Page ${displayNum} of ${displayTotal}`
        : format === 'slash'
        ? `${displayNum} / ${displayTotal}`
        : `${displayNum}`;

    const { visW, visH, toPdfPoint } = getVisualPageGeometry(page);
    const tw = font.widthOfTextAtSize(label, fontSize);
    const isTop = position.startsWith('top');
    const vy = isTop ? visH - 26 : 20;
    let vx = (visW - tw) / 2;
    if (position.endsWith('-left')) {
      vx = 32;
    } else if (position.endsWith('-right')) {
      vx = Math.max(32, visW - tw - 32);
    }

    const pt = toPdfPoint(vx, vy, 0);
    page.drawText(label, {
      x: pt.x,
      y: pt.y,
      size: fontSize,
      font,
      color,
      ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
    });
  });

  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function addHeaderFooterToPdf(
  buf: ArrayBuffer,
  headerText: string,
  footerText: string,
  options?: { align?: 'left' | 'center' | 'right'; fontSize?: number; color?: string }
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const align = options?.align || 'left';
  const fontSize = Math.max(7, Math.min(18, options?.fontSize ?? 9.5));
  const colorHex = options?.color || '#475569';
  const col = hexToRgb(colorHex);

  const cleanHeader = headerText.trim().slice(0, 120);
  const cleanFooter = footerText.trim().slice(0, 120);

  let headerUnicodeImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  let headerUnicodeW = 0;
  let headerUnicodeH = 0;
  if (cleanHeader && hasNonWinAnsiChars(cleanHeader)) {
    const rendered = await renderUnicodeTextPng({
      text: cleanHeader,
      fontSize,
      fontFamily: 'sans',
      color: colorHex,
      bold: false,
      italic: false,
      underline: false,
      align,
    });
    headerUnicodeImg = await doc.embedPng(rendered.pngBytes);
    headerUnicodeW = rendered.widthPt;
    headerUnicodeH = rendered.heightPt;
  }

  let footerUnicodeImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  let footerUnicodeW = 0;
  let footerUnicodeH = 0;
  if (cleanFooter && hasNonWinAnsiChars(cleanFooter)) {
    const rendered = await renderUnicodeTextPng({
      text: cleanFooter,
      fontSize,
      fontFamily: 'sans',
      color: colorHex,
      bold: false,
      italic: false,
      underline: false,
      align,
    });
    footerUnicodeImg = await doc.embedPng(rendered.pngBytes);
    footerUnicodeW = rendered.widthPt;
    footerUnicodeH = rendered.heightPt;
  }

  for (const page of doc.getPages()) {
    const { visW, visH, toPdfPoint } = getVisualPageGeometry(page);
    const computeVx = (itemW: number) => {
      if (align === 'center') return Math.max(24, (visW - itemW) / 2);
      if (align === 'right') return Math.max(24, visW - itemW - 32);
      return 32;
    };

    if (cleanHeader) {
      if (headerUnicodeImg) {
        const vx = computeVx(headerUnicodeW);
        const vy = Math.max(12, visH - 18 - headerUnicodeH);
        const pt = toPdfPoint(vx, vy, 0);
        page.drawImage(headerUnicodeImg, {
          x: pt.x,
          y: pt.y,
          width: headerUnicodeW,
          height: headerUnicodeH,
          ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
        });
      } else {
        const tw = font.widthOfTextAtSize(cleanHeader, fontSize);
        const pt = toPdfPoint(computeVx(tw), Math.max(12, visH - 26), 0);
        page.drawText(cleanHeader, {
          x: pt.x,
          y: pt.y,
          size: fontSize,
          font,
          color: col,
          ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
        });
      }
    }

    if (cleanFooter) {
      if (footerUnicodeImg) {
        const vx = computeVx(footerUnicodeW);
        const pt = toPdfPoint(vx, 16, 0);
        page.drawImage(footerUnicodeImg, {
          x: pt.x,
          y: pt.y,
          width: footerUnicodeW,
          height: footerUnicodeH,
          ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
        });
      } else {
        const tw = font.widthOfTextAtSize(cleanFooter, fontSize);
        const pt = toPdfPoint(computeVx(tw), 20, 0);
        page.drawText(cleanFooter, {
          x: pt.x,
          y: pt.y,
          size: fontSize,
          font,
          color: col,
          ...(pt.angleDeg !== 0 ? { rotate: degrees(pt.angleDeg) } : {}),
        });
      }
    }
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function rasterCompressPdf(
  buf: ArrayBuffer,
  scale: number,
  quality: number
): Promise<ArrayBuffer> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(buf)) });
  try {
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
      if (p % 6 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const out = await outDoc.save({ useObjectStreams: true });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export async function compressPdfWithReport(
  buf: ArrayBuffer,
  mode: 'object-streams' | 'raster-medium' | 'raster-compact' | 'target-size',
  targetBytes?: number
): Promise<{ bytes: ArrayBuffer; achievedTarget: boolean }> {
  const doc = await PDFDocument.load(cloneBuffer(buf), { ignoreEncryption: true });
  const losslessOut = await doc.save({ useObjectStreams: true });
  const losslessBuf = losslessOut.buffer.slice(
    losslessOut.byteOffset,
    losslessOut.byteOffset + losslessOut.byteLength
  ) as ArrayBuffer;

  const smallestLosslessOrOrig =
    losslessBuf.byteLength <= buf.byteLength ? losslessBuf : cloneBuffer(buf);

  if (mode === 'object-streams') {
    return { bytes: smallestLosslessOrOrig, achievedTarget: true };
  }

  if (mode === 'target-size' && targetBytes && targetBytes > 0) {
    if (smallestLosslessOrOrig.byteLength <= targetBytes) {
      return { bytes: smallestLosslessOrOrig, achievedTarget: true };
    }
    let bestBytes = smallestLosslessOrOrig;
    const presets: Array<{ scale: number; quality: number }> = [
      { scale: 1.35, quality: 0.78 },
      { scale: 1.15, quality: 0.65 },
      { scale: 0.95, quality: 0.5 },
      { scale: 0.78, quality: 0.36 },
      { scale: 0.62, quality: 0.25 },
      { scale: 0.48, quality: 0.18 },
    ];
    for (const preset of presets) {
      const candidate = await rasterCompressPdf(buf, preset.scale, preset.quality);
      if (candidate.byteLength < bestBytes.byteLength) {
        bestBytes = candidate;
      }
      if (candidate.byteLength <= targetBytes) {
        return { bytes: candidate, achievedTarget: true };
      }
    }
    return { bytes: bestBytes, achievedTarget: bestBytes.byteLength <= targetBytes };
  }

  const scale = mode === 'raster-medium' ? 1.35 : 1.0;
  const quality = mode === 'raster-medium' ? 0.72 : 0.52;
  const candidate = await rasterCompressPdf(buf, scale, quality);
  // Never return a bloated rasterized file when lossless/original is already smaller
  const bytes =
    candidate.byteLength <= smallestLosslessOrOrig.byteLength
      ? candidate
      : smallestLosslessOrOrig;
  return { bytes, achievedTarget: true };
}

export async function compressPdfBytes(
  buf: ArrayBuffer,
  mode: 'object-streams' | 'raster-medium' | 'raster-compact' | 'target-size',
  targetBytes?: number
): Promise<ArrayBuffer> {
  const res = await compressPdfWithReport(buf, mode, targetBytes);
  return res.bytes;
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
  try {
    const srcPdf = await loadingTask.promise;
    const outDoc = await PDFDocument.create();

    for (let p = 1; p <= srcPdf.numPages; p++) {
      const page = await srcPdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const maxDim = Math.max(vp1.width, vp1.height, 1);
      const safeScale = Math.min(2.0, Math.max(1.25, 2200 / maxDim));
      const vp = page.getViewport({ scale: safeScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

      const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.94);
      const bin = atob(jpgDataUrl.split(',')[1]);
      const jpgBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) jpgBytes[i] = bin.charCodeAt(i);
      const embedded = await outDoc.embedJpg(jpgBytes);
      const newPage = outDoc.addPage([vp1.width, vp1.height]);
      newPage.drawImage(embedded, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      if (p % 6 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const out = await outDoc.save({ useObjectStreams: true });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name || '';
    const msg = err instanceof Error ? err.message : '';
    if (name === 'PasswordException' || /password/i.test(msg)) {
      throw new Error('Incorrect PDF password or unable to decrypt this file.');
    }
    throw err instanceof Error ? err : new Error('Failed to unlock PDF.');
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
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
    if (!base64) continue;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const embedded = p.imageDataUrl.includes('image/png')
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);

    const aspect = embedded.height / Math.max(1, embedded.width);
    const widthPt = 595.28;
    const heightPt = widthPt * aspect;
    const page = doc.addPage([widthPt, heightPt]);

    // Filter to characters encodable by WinAnsi Helvetica so stray symbols never throw
    let safeText = '';
    for (const ch of p.ocrText) {
      if (ch === '\n' || ch === ' ') {
        safeText += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 32 && code <= 255) {
        try {
          font.encodeText(ch);
          safeText += ch;
        } catch {
          safeText += ' ';
        }
      }
    }

    const lines = safeText
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (lines.length > 0) {
      const margin = 20;
      const usableH = Math.max(40, heightPt - margin * 2);
      const stepY = Math.min(13, Math.max(7, usableH / lines.length));
      const fontSize = Math.min(9.5, Math.max(5.5, stepY * 0.8));
      lines.forEach((line, idx) => {
        const y = heightPt - margin - fontSize - idx * stepY;
        if (y < margin) return;
        page.drawText(line, {
          x: margin,
          y,
          size: fontSize,
          font,
          color: rgb(1, 1, 1),
          opacity: 0.01,
          maxWidth: widthPt - margin * 2,
          lineHeight: stepY,
        });
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
    'comparison, and cryptographic digital signatures in one mobile-first workspace.',
    '',
    'Try opening this document in:',
    '- Edit PDF: Tap any existing text line to edit or replace it directly.',
    '- Page Organizer: Reorder, duplicate, rotate, or split pages visually.',
    '- OCR & Scanner: Scan documents with 4-corner detection and extract English/Bengali text.',
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
