import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import type { PdfFontFamily, WordPageSettings } from '../types';
import {
  PAPER_DIMENSIONS,
  cloneBuffer,
  getSharedPdfDocument,
  hasNonWinAnsiChars,
  hexToRgb,
  renderPageToCanvas,
  renderPageToDataUrl,
  renderUnicodeTextPng,
  splitPdfByRanges,
} from './pdfEngine';
import { runOnDeviceOcr } from './ocrService';

export type ImageToPdfFitMode = 'a4-fit' | 'a4-fill' | 'auto';

export interface PdfToDocxOptions {
  includeVisualOnScanned?: boolean;
  useOcr?: boolean;
  preservePageBreaks?: boolean;
}

export interface PdfToXlsxOptions {
  mergeSheets?: boolean;
  useOcr?: boolean;
}

export interface PdfToPptxOptions {
  mode?: 'editable' | 'visual';
  useOcr?: boolean;
}

export async function imagesToPdf(
  files: File[],
  options?: { fitMode?: ImageToPdfFitMode }
): Promise<ArrayBuffer> {
  const fitMode: ImageToPdfFitMode = options?.fitMode || 'a4-fit';
  const doc = await PDFDocument.create();
  for (const file of files) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Normalize any image (webp/png/jpg) onto canvas so pdf-lib always embeds cleanly
    const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = imgEl.naturalWidth || 800;
    canvas.height = imgEl.naturalHeight || 1000;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgEl, 0, 0);

    const jpgUrl = canvas.toDataURL('image/jpeg', 0.92);
    const bin = atob(jpgUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const embedded = await doc.embedJpg(bytes);

    if (fitMode === 'auto') {
      const widthPt = 595.28;
      const heightPt = (embedded.height / Math.max(1, embedded.width)) * widthPt;
      const page = doc.addPage([widthPt, heightPt]);
      page.drawImage(embedded, { x: 0, y: 0, width: widthPt, height: heightPt });
    } else {
      const isLandscape = embedded.width > embedded.height * 1.05;
      const pageW = isLandscape ? 841.89 : 595.28;
      const pageH = isLandscape ? 595.28 : 841.89;
      const margin = fitMode === 'a4-fit' ? 24 : 0;
      const availW = pageW - margin * 2;
      const availH = pageH - margin * 2;
      const scale = Math.min(
        availW / Math.max(1, embedded.width),
        availH / Math.max(1, embedded.height)
      );
      const drawW = embedded.width * scale;
      const drawH = embedded.height * scale;
      const page = doc.addPage([pageW, pageH]);
      page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(1, 1, 1) });
      page.drawImage(embedded, {
        x: (pageW - drawW) / 2,
        y: (pageH - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    }
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function pdfToImagesZip(
  pdfBytes: ArrayBuffer,
  format: 'image/png' | 'image/jpeg' = 'image/png',
  renderScale = 2
): Promise<{ zipBuffer: ArrayBuffer; previewImages: string[] }> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const count = pdf.numPages;

  const zip = new JSZip();
  const previewImages: string[] = [];
  const ext = format === 'image/png' ? 'png' : 'jpg';

  for (let p = 1; p <= count; p++) {
    const dataUrl = await renderPageToDataUrl(pdfBytes, p, renderScale, format);
    previewImages.push(dataUrl);
    const base64 = dataUrl.split(',')[1];
    zip.file(`page-${String(p).padStart(3, '0')}.${ext}`, base64, { base64: true });
    if (p % 6 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return { zipBuffer, previewImages };
}

export async function splitPdfPagesAsZip(
  pdfBytes: ArrayBuffer,
  pageNumbers1Based: number[],
  baseName: string
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const cleanBase = baseName.replace(/\.pdf$/i, '') || 'document';
  for (const pageNum of pageNumbers1Based) {
    const single = await splitPdfByRanges(pdfBytes, [pageNum]);
    zip.file(`${cleanBase}_page_${String(pageNum).padStart(3, '0')}.pdf`, new Uint8Array(single));
  }
  return zip.generateAsync({ type: 'arraybuffer' });
}

interface PositionedSpan {
  str: string;
  x: number;
  right: number;
  baselineY: number;
  topY: number;
  width: number;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  fontTone: 'sans' | 'serif' | 'mono';
}

interface RowCell {
  x: number;
  right: number;
  fontSize: number;
  text: string;
  spans: PositionedSpan[];
}

interface ClusteredRow {
  avgY: number;
  topY: number;
  avgFontSize: number;
  spans: PositionedSpan[];
  cells: RowCell[];
  left: number;
  right: number;
  align: 'left' | 'center' | 'right';
}

interface ColInterval {
  left: number;
  right: number;
  center: number;
}

type PageBlock =
  | {
      kind: 'table';
      topY: number;
      bottomY: number;
      left: number;
      right: number;
      colWidths: number[];
      rows: Array<Array<{ text: string; spans: PositionedSpan[]; isNumeric: boolean }>>;
    }
  | {
      kind: 'paragraph';
      topY: number;
      bottomY: number;
      left: number;
      right: number;
      fontSize: number;
      align: 'left' | 'center' | 'right';
      isList: boolean;
      runs: Array<{
        text: string;
        bold: boolean;
        italics: boolean;
        fontTone: 'sans' | 'serif' | 'mono';
        fontSize: number;
      }>;
    };

async function extractVisualSpansPerPage(pdfBytes: ArrayBuffer): Promise<
  Array<{ pageNumber: number; width: number; height: number; spans: PositionedSpan[] }>
> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const pages: Array<{ pageNumber: number; width: number; height: number; spans: PositionedSpan[] }> = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const stylesMap = (tc as unknown as { styles?: Record<string, { fontFamily?: string }> }).styles || {};
    const spans: PositionedSpan[] = [];

    for (const item of tc.items) {
      if (!('str' in item) || !item.str || !item.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const scaleX = Math.hypot(tx[0], tx[1]);
      const scaleY = Math.hypot(tx[2], tx[3]);
      const fontSize = Math.max(5.5, Math.max(scaleX, scaleY));
      const x = tx[4];
      const baselineY = tx[5];
      const width =
        item.width && item.width > 0
          ? item.width
          : Math.max(4, item.str.length * fontSize * 0.48);

      const styleEntry = item.fontName ? stylesMap[item.fontName] : undefined;
      const combinedFontDesc = `${item.fontName || ''} ${styleEntry?.fontFamily || ''}`.toLowerCase();
      const isBold =
        combinedFontDesc.includes('bold') ||
        combinedFontDesc.includes('black') ||
        combinedFontDesc.includes('heavy') ||
        combinedFontDesc.includes('semibold') ||
        combinedFontDesc.includes('demi');
      const isItalic =
        combinedFontDesc.includes('italic') ||
        combinedFontDesc.includes('oblique') ||
        combinedFontDesc.includes('slant');
      const fontTone: 'sans' | 'serif' | 'mono' =
        combinedFontDesc.includes('courier') ||
        combinedFontDesc.includes('mono') ||
        combinedFontDesc.includes('consolas')
          ? 'mono'
          : combinedFontDesc.includes('times') ||
            combinedFontDesc.includes('serif') ||
            combinedFontDesc.includes('georgia') ||
            combinedFontDesc.includes('cambria') ||
            combinedFontDesc.includes('garamond')
          ? 'serif'
          : 'sans';

      spans.push({
        str: item.str,
        x,
        right: x + width,
        baselineY,
        topY: baselineY - fontSize * 0.85,
        width,
        fontSize,
        isBold,
        isItalic,
        fontTone,
      });
    }

    pages.push({
      pageNumber: p,
      width: viewport.width,
      height: viewport.height,
      spans,
    });
    if (p % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  return pages;
}

function splitRowIntoCells(spans: PositionedSpan[]): RowCell[] {
  const cells: RowCell[] = [];
  for (const sp of spans) {
    const clean = sp.str.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const prev = cells[cells.length - 1];
    const gap = prev ? sp.x - prev.right : Infinity;
    const joinThreshold = prev ? Math.max(prev.fontSize, sp.fontSize) * 1.15 : 0;
    if (prev && gap <= joinThreshold) {
      const needsSpace =
        gap > Math.min(sp.fontSize, prev.fontSize) * 0.16 &&
        !prev.text.endsWith(' ') &&
        !clean.startsWith(' ');
      prev.text = `${prev.text}${needsSpace ? ' ' : ''}${clean}`;
      prev.right = Math.max(prev.right, sp.right);
      prev.fontSize = Math.max(prev.fontSize, sp.fontSize);
      prev.spans.push(sp);
    } else {
      cells.push({
        x: sp.x,
        right: sp.right,
        fontSize: sp.fontSize,
        text: clean,
        spans: [sp],
      });
    }
  }
  return cells;
}

function inferRowAlignment(
  left: number,
  right: number,
  pageWidth: number
): 'left' | 'center' | 'right' {
  const contentW = right - left;
  if (contentW >= pageWidth * 0.74) return 'left';
  const leftMargin = Math.max(0, left);
  const rightMargin = Math.max(0, pageWidth - right);
  if (leftMargin > pageWidth * 0.14 && Math.abs(leftMargin - rightMargin) <= pageWidth * 0.1) {
    return 'center';
  }
  if (leftMargin > pageWidth * 0.45 && rightMargin <= pageWidth * 0.16) {
    return 'right';
  }
  return 'left';
}

function clusterSpansIntoRows(spans: PositionedSpan[], pageWidth = 595): ClusteredRow[] {
  const sorted = [...spans].sort((a, b) => a.baselineY - b.baselineY || a.x - b.x);
  const rawRows: Array<{ avgY: number; avgFontSize: number; spans: PositionedSpan[] }> = [];

  for (const sp of sorted) {
    const last = rawRows[rawRows.length - 1];
    if (
      last &&
      Math.abs(sp.baselineY - last.avgY) <=
        Math.max(2.6, Math.min(sp.fontSize, last.avgFontSize) * 0.45)
    ) {
      const n = last.spans.length;
      last.avgY = (last.avgY * n + sp.baselineY) / (n + 1);
      last.avgFontSize = (last.avgFontSize * n + sp.fontSize) / (n + 1);
      last.spans.push(sp);
    } else {
      rawRows.push({ avgY: sp.baselineY, avgFontSize: sp.fontSize, spans: [sp] });
    }
  }

  return rawRows
    .map((r) => {
      r.spans.sort((a, b) => a.x - b.x);
      const cells = splitRowIntoCells(r.spans);
      const left = r.spans.reduce((m, s) => Math.min(m, s.x), Infinity);
      const right = r.spans.reduce((m, s) => Math.max(m, s.right), -Infinity);
      const topY = r.spans.reduce((m, s) => Math.min(m, s.topY), r.avgY - r.avgFontSize * 0.85);
      return {
        avgY: r.avgY,
        topY,
        avgFontSize: r.avgFontSize,
        spans: r.spans,
        cells,
        left: Number.isFinite(left) ? left : 0,
        right: Number.isFinite(right) ? right : 0,
        align: inferRowAlignment(left, right, pageWidth),
      };
    })
    .filter((r) => r.cells.length > 0);
}

/**
 * Clusters horizontal cell intervals from multi-cell rows into clean non-overlapping column tracks.
 * Handles both left-aligned text columns and right-aligned numeric/currency columns accurately.
 */
function buildColumnIntervals(multiCellRows: RowCell[][]): ColInterval[] {
  const flat = multiCellRows.flat().sort((a, b) => a.x - b.x || a.right - b.right);
  const intervals: ColInterval[] = [];

  for (const cell of flat) {
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < intervals.length; i++) {
      const col = intervals[i];
      const overlap = Math.min(col.right, cell.right) - Math.max(col.left, cell.x);
      const minW = Math.max(4, Math.min(col.right - col.left, cell.right - cell.x));
      // Strong horizontal overlap OR tight left/right edge alignment (for right-aligned numbers)
      if (
        overlap > minW * 0.22 ||
        Math.abs(cell.x - col.left) <= 12 ||
        Math.abs(cell.right - col.right) <= 10
      ) {
        const score = Math.abs((cell.x + cell.right) / 2 - col.center);
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }

    if (bestIdx >= 0) {
      const c = intervals[bestIdx];
      c.left = Math.min(c.left, cell.x);
      c.right = Math.max(c.right, cell.right);
      c.center = (c.left + c.right) / 2;
    } else {
      intervals.push({
        left: cell.x,
        right: cell.right,
        center: (cell.x + cell.right) / 2,
      });
    }
  }

  intervals.sort((a, b) => a.left - b.left);
  // Merge intervals that ended up overlapping significantly after expansion
  const merged: ColInterval[] = [];
  for (const col of intervals) {
    const prev = merged[merged.length - 1];
    if (prev && col.left < prev.right - 4) {
      prev.left = Math.min(prev.left, col.left);
      prev.right = Math.max(prev.right, col.right);
      prev.center = (prev.left + prev.right) / 2;
    } else {
      merged.push({ ...col });
    }
  }
  return merged;
}

function matchCellToColumn(cell: RowCell, cols: ColInterval[]): number {
  let bestCol = 0;
  let bestScore = -Infinity;
  const cellCenter = (cell.x + cell.right) / 2;

  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const overlap = Math.min(col.right, cell.right) - Math.max(col.left, cell.x);
    if (overlap > 0) {
      const score = overlap * 10 - Math.abs(cellCenter - col.center);
      if (score > bestScore) {
        bestScore = score;
        bestCol = i;
      }
    } else {
      const dist = cell.right < col.left ? col.left - cell.right : cell.x - col.right;
      const score = -1000 - dist;
      if (score > bestScore) {
        bestScore = score;
        bestCol = i;
      }
    }
  }
  return bestCol;
}

function isBulletOrNumberedLine(text: string): boolean {
  return /^([•●○▪▫■◆➤➢✓✔\-*]\s+|(\d{1,3}|[a-zA-Z])[.)]\s+)/.test(text.trim());
}

function mergeSpansIntoStyledRuns(
  spans: PositionedSpan[]
): Array<{
  text: string;
  bold: boolean;
  italics: boolean;
  fontTone: 'sans' | 'serif' | 'mono';
  fontSize: number;
}> {
  const runs: Array<{
    text: string;
    bold: boolean;
    italics: boolean;
    fontTone: 'sans' | 'serif' | 'mono';
    fontSize: number;
  }> = [];
  let lastRight = -Infinity;

  for (const sp of spans) {
    const gap = lastRight === -Infinity ? 0 : sp.x - lastRight;
    let prefix = '';
    if (runs.length > 0 && lastRight !== -Infinity) {
      if (gap > sp.fontSize * 1.9) {
        prefix = '    ';
      } else if (
        gap > sp.fontSize * 0.16 &&
        !runs[runs.length - 1].text.endsWith(' ') &&
        !sp.str.startsWith(' ')
      ) {
        prefix = ' ';
      }
    }
    const piece = `${prefix}${sp.str}`;
    lastRight = Math.max(lastRight, sp.right);

    const roundedFs = Math.round(sp.fontSize * 2) / 2;
    const prev = runs[runs.length - 1];
    if (
      prev &&
      prev.bold === sp.isBold &&
      prev.italics === sp.isItalic &&
      prev.fontTone === sp.fontTone &&
      Math.abs(prev.fontSize - roundedFs) <= 0.8
    ) {
      prev.text += piece;
    } else {
      runs.push({
        text: piece,
        bold: sp.isBold,
        italics: sp.isItalic,
        fontTone: sp.fontTone,
        fontSize: roundedFs,
      });
    }
  }
  return runs.filter((r) => r.text.length > 0);
}

function analyzePageBlocks(rows: ClusteredRow[], pageWidth: number): PageBlock[] {
  const blocks: PageBlock[] = [];
  let idx = 0;

  while (idx < rows.length) {
    // Try to detect a multi-row table starting at idx
    if (rows[idx].cells.length >= 2) {
      let endIdx = idx + 1;
      while (endIdx < rows.length) {
        const yGap = rows[endIdx].avgY - rows[endIdx - 1].avgY;
        const maxGap = Math.max(rows[endIdx].avgFontSize, rows[endIdx - 1].avgFontSize) * 3.1;
        if (yGap > maxGap) break;
        if (rows[endIdx].cells.length >= 2) {
          endIdx++;
          continue;
        }
        // Allow a wrapped 1-cell continuation inside a table ONLY if next row returns to >= 2 cells quickly
        if (
          endIdx + 1 < rows.length &&
          rows[endIdx + 1].cells.length >= 2 &&
          rows[endIdx + 1].avgY - rows[endIdx].avgY <= maxGap
        ) {
          endIdx++;
          continue;
        }
        break;
      }

      const candidateRows = rows.slice(idx, endIdx);
      const multiRows = candidateRows.filter((r) => r.cells.length >= 2);
      if (multiRows.length >= 2) {
        const cols = buildColumnIntervals(multiRows.map((r) => r.cells));
        if (cols.length >= 2) {
          const tableRows = candidateRows.map((r) => {
            const rowCells: Array<{ text: string; spans: PositionedSpan[]; isNumeric: boolean }> =
              Array.from({ length: cols.length }, () => ({
                text: '',
                spans: [],
                isNumeric: false,
              }));
            for (const c of r.cells) {
              const ci = matchCellToColumn(c, cols);
              const existing = rowCells[ci];
              existing.text = existing.text ? `${existing.text} ${c.text}` : c.text;
              existing.spans.push(...c.spans);
              existing.isNumeric = /^[$(£€₹৳+\-]?[\d,]+(\.\d+)?%?\)?$/.test(existing.text.trim());
            }
            return rowCells;
          });

          const totalSpanW = Math.max(120, cols[cols.length - 1].right - cols[0].left);
          const colWidths = cols.map((c) =>
            Math.max(0.08, (Math.max(24, c.right - c.left) / totalSpanW))
          );

          blocks.push({
            kind: 'table',
            topY: candidateRows[0].topY,
            bottomY: candidateRows[candidateRows.length - 1].avgY + 4,
            left: cols[0].left,
            right: cols[cols.length - 1].right,
            colWidths,
            rows: tableRows,
          });
          idx = endIdx;
          continue;
        }
      }
    }

    // Build reflowed paragraph from consecutive compatible text lines
    const paraRows: ClusteredRow[] = [rows[idx]];
    let j = idx + 1;
    while (j < rows.length) {
      const prev = paraRows[paraRows.length - 1];
      const next = rows[j];
      // Stop before starting a multi-row table
      if (
        next.cells.length >= 2 &&
        j + 1 < rows.length &&
        rows[j + 1].cells.length >= 2
      ) {
        break;
      }
      if (next.cells.length >= 3) break;

      const yGap = next.avgY - prev.avgY;
      const fs = Math.max(prev.avgFontSize, next.avgFontSize);
      const prevText = prev.cells.map((c) => c.text).join('  ').trim();
      const nextText = next.cells.map((c) => c.text).join('  ').trim();

      const sameFontScale = Math.abs(prev.avgFontSize - next.avgFontSize) <= 1.6;
      const closeLineGap = yGap <= fs * 1.65;
      const similarIndentOrCentered =
        (prev.align === 'center' && next.align === 'center') ||
        Math.abs(prev.left - next.left) <= 22;
      const endsWithTerminal = /[.!?:।]$/.test(prevText);
      const nextIsBullet = isBulletOrNumberedLine(nextText);
      const prevWasWideLine = prev.right >= pageWidth * 0.72;

      if (
        sameFontScale &&
        closeLineGap &&
        similarIndentOrCentered &&
        !nextIsBullet &&
        (!endsWithTerminal || prevWasWideLine) &&
        prev.cells.length === 1 &&
        next.cells.length === 1
      ) {
        paraRows.push(next);
        j++;
      } else {
        break;
      }
    }

    const combinedSpans: PositionedSpan[] = [];
    paraRows.forEach((pr, rIdx) => {
      if (rIdx > 0 && pr.spans.length > 0 && combinedSpans.length > 0) {
        const last = combinedSpans[combinedSpans.length - 1];
        const first = pr.spans[0];
        if (!last.str.endsWith(' ') && !first.str.startsWith(' ')) {
          combinedSpans.push({
            ...first,
            str: ' ',
            x: last.right,
            right: last.right + 2,
            width: 2,
          });
        }
      }
      combinedSpans.push(...pr.spans);
    });

    const runs = mergeSpansIntoStyledRuns(combinedSpans);
    const fullText = runs.map((r) => r.text).join('').trim();
    const maxFs = paraRows.reduce((m, r) => Math.max(m, r.avgFontSize), 10);
    const minLeft = paraRows.reduce((m, r) => Math.min(m, r.left), pageWidth);
    const maxRight = paraRows.reduce((m, r) => Math.max(m, r.right), 0);

    blocks.push({
      kind: 'paragraph',
      topY: paraRows[0].topY,
      bottomY: paraRows[paraRows.length - 1].avgY + 4,
      left: minLeft,
      right: maxRight,
      fontSize: maxFs,
      align: paraRows[0].align,
      isList: isBulletOrNumberedLine(fullText),
      runs,
    });
    idx = j;
  }

  return blocks;
}

function mapToneToWordFont(tone: 'sans' | 'serif' | 'mono'): string {
  if (tone === 'serif') return 'Times New Roman';
  if (tone === 'mono') return 'Courier New';
  return 'Calibri';
}

function uint8ArrayFromDataUrl(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function pdfToDocxBytes(
  pdfBytes: ArrayBuffer,
  title: string,
  options?: PdfToDocxOptions
): Promise<{ buffer: ArrayBuffer; extractedChars: number; ocrUsed: boolean }> {
  const includeVisualOnScanned = options?.includeVisualOnScanned ?? true;
  const useOcr = options?.useOcr ?? false;
  const preservePageBreaks = options?.preservePageBreaks ?? true;

  const pages = await extractVisualSpansPerPage(pdfBytes);

  // Estimate dominant body font size across document for heading classification
  const allFontSizes: number[] = [];
  let extractedChars = 0;
  let ocrUsed = false;
  for (const pg of pages) {
    for (const sp of pg.spans) {
      extractedChars += sp.str.trim().length;
      allFontSizes.push(Math.round(sp.fontSize * 2) / 2);
    }
  }
  allFontSizes.sort((a, b) => a - b);
  const bodySize =
    allFontSizes.length > 0 ? allFontSizes[Math.floor(allFontSizes.length * 0.5)] : 11;

  const children: Array<Paragraph | Table> = [];
  const cleanDocTitle = title.replace(/\.pdf$/i, '');

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (pageIdx > 0 && preservePageBreaks) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }

    const rows = clusterSpansIntoRows(page.spans, page.width);
    if (rows.length === 0) {
      // Scanned or image-only PDF page: embed high-res visual image + optional OCR text
      if (useOcr) {
        try {
          const canvas = document.createElement('canvas');
          await renderPageToCanvas(pdfBytes, page.pageNumber, canvas, 2);
          const ocrText = await runOnDeviceOcr(canvas, 'eng+ben');
          if (ocrText.trim()) {
            ocrUsed = true;
            extractedChars += ocrText.trim().length;
            ocrText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .forEach((line) => {
                children.push(
                  new Paragraph({
                    spacing: { after: 120, line: 276 },
                    children: [
                      new TextRun({
                        text: line,
                        font: 'Calibri',
                        size: 22,
                      }),
                    ],
                  })
                );
              });
          }
        } catch {
          // ignore OCR error on page
        }
      }

      if (includeVisualOnScanned) {
        try {
          const imgUrl = await renderPageToDataUrl(pdfBytes, page.pageNumber, 2, 'image/jpeg');
          const { width, height } = await measureImageDataUrlSize(imgUrl);
          const targetW = 580;
          const targetH = Math.min(760, Math.round((height / Math.max(1, width)) * targetW));
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new ImageRun({
                  data: uint8ArrayFromDataUrl(imgUrl),
                  transformation: { width: targetW, height: targetH },
                  type: 'jpg',
                }),
              ],
            })
          );
        } catch {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `(Page ${page.pageNumber}: Scanned graphic page)`,
                  italics: true,
                  color: '64748B',
                }),
              ],
            })
          );
        }
      } else if (!useOcr) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `(Page ${page.pageNumber}: No extractable text — enable OCR or visual fallback for scanned pages)`,
                italics: true,
                color: '64748B',
              }),
            ],
          })
        );
      }
      continue;
    }

    const blocks = analyzePageBlocks(rows, page.width);
    if (pageIdx === 0 && blocks.length > 0 && blocks[0].kind === 'paragraph' && blocks[0].fontSize < bodySize * 1.35) {
      children.push(
        new Paragraph({
          text: cleanDocTitle,
          heading: HeadingLevel.HEADING_1,
          spacing: { after: 180 },
        })
      );
    }

    for (const blk of blocks) {
      if (blk.kind === 'table') {
        const totalDxa = 9360;
        const colSum = blk.colWidths.reduce((s, w) => s + w, 0) || 1;
        const dxaWidths = blk.colWidths.map((w) => Math.max(600, Math.round((w / colSum) * totalDxa)));

        const tableRows = blk.rows.map((r, rIdx) => {
          const isHeader = rIdx === 0;
          const fillColor = isHeader ? 'EFF6FF' : rIdx % 2 === 1 ? 'FFFFFF' : 'F8FAFC';

          return new TableRow({
            tableHeader: isHeader,
            children: r.map((cell, cIdx) => {
              const cellRuns = cell.spans.length
                ? mergeSpansIntoStyledRuns(cell.spans).map(
                    (run) =>
                      new TextRun({
                        text: run.text,
                        bold: isHeader || run.bold,
                        italics: run.italics,
                        font: mapToneToWordFont(run.fontTone),
                        size: Math.max(16, Math.min(28, Math.round(run.fontSize * 2))),
                        color: isHeader ? '142B4A' : '1E293B',
                      })
                  )
                : [
                    new TextRun({
                      text: cell.text || ' ',
                      bold: isHeader,
                      font: 'Calibri',
                      size: 20,
                      color: isHeader ? '142B4A' : '1E293B',
                    }),
                  ];

              return new TableCell({
                width: { size: dxaWidths[cIdx] || 1500, type: WidthType.DXA },
                shading: { fill: fillColor, type: ShadingType.CLEAR },
                margins: { top: 80, bottom: 80, left: 110, right: 110 },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                  left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                  right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                },
                children: [
                  new Paragraph({
                    alignment: cell.isNumeric && !isHeader ? AlignmentType.RIGHT : AlignmentType.LEFT,
                    spacing: { after: 0, before: 0 },
                    children: cellRuns,
                  }),
                ],
              });
            }),
          });
        });

        children.push(
          new Table({
            width: { size: totalDxa, type: WidthType.DXA },
            rows: tableRows,
          })
        );
        children.push(new Paragraph({ spacing: { after: 100 }, text: '' }));
        continue;
      }

      const plainText = blk.runs.map((r) => r.text).join('').trim();
      if (!plainText) continue;

      const alignEnum =
        blk.align === 'center'
          ? AlignmentType.CENTER
          : blk.align === 'right'
          ? AlignmentType.RIGHT
          : AlignmentType.LEFT;

      const allBold = blk.runs.every((r) => r.bold || !r.text.trim());
      const isMajorHeading = blk.fontSize >= bodySize * 1.48 && plainText.length <= 130;
      const isSubHeading =
        (blk.fontSize >= bodySize * 1.18 || (allBold && plainText.length <= 85 && !blk.isList)) &&
        plainText.length <= 130;

      if (isMajorHeading) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            alignment: alignEnum,
            spacing: { before: 160, after: 100 },
            children: blk.runs.map(
              (r) =>
                new TextRun({
                  text: r.text,
                  bold: true,
                  italics: r.italics,
                  font: mapToneToWordFont(r.fontTone),
                  size: Math.max(24, Math.min(48, Math.round(r.fontSize * 2))),
                  color: '142B4A',
                })
            ),
          })
        );
      } else if (isSubHeading) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            alignment: alignEnum,
            spacing: { before: 120, after: 80 },
            children: blk.runs.map(
              (r) =>
                new TextRun({
                  text: r.text,
                  bold: true,
                  italics: r.italics,
                  font: mapToneToWordFont(r.fontTone),
                  size: Math.max(20, Math.min(36, Math.round(r.fontSize * 2))),
                  color: '1E293B',
                })
            ),
          })
        );
      } else {
        children.push(
          new Paragraph({
            alignment: alignEnum,
            indent: blk.isList ? { left: 360, hanging: 180 } : undefined,
            spacing: { after: 110, line: 276 },
            children: blk.runs.map(
              (r) =>
                new TextRun({
                  text: r.text,
                  bold: r.bold,
                  italics: r.italics,
                  font: mapToneToWordFont(r.fontTone),
                  size: Math.max(16, Math.min(32, Math.round(r.fontSize * 2))),
                  color: '1E293B',
                })
            ),
          })
        );
      }
    }
  }

  const docx = new Document({
    title: cleanDocTitle,
    creator: 'PDF MASTER',
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
          },
        },
        children,
      },
    ],
  });
  const blob = await Packer.toBlob(docx);
  return { buffer: await blob.arrayBuffer(), extractedChars, ocrUsed };
}

interface ParsedExcelCell {
  value: string | number;
  numFmt?: string;
}

function parseExcelCellValue(raw: string): ParsedExcelCell {
  const trimmed = raw.trim();
  if (!trimmed) return { value: '' };

  // Preserve phone numbers / IDs with leading zeros like "017123456" as text
  if (/^0\d+$/.test(trimmed)) return { value: trimmed };

  // Percentage: e.g. "12.5%" or "-4%"
  const pctMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const n = Number(pctMatch[1]);
    if (Number.isFinite(n)) return { value: n / 100, numFmt: '0.0%' };
  }

  // Parenthesized accounting negative e.g. "(1,234.50)" or "($1,234.50)"
  const parenNeg = trimmed.match(/^\(\s*([$€£₹৳])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*\)$/);
  if (parenNeg) {
    const n = Number(parenNeg[2].replace(/,/g, ''));
    if (Number.isFinite(n)) {
      return {
        value: -n,
        numFmt: parenNeg[1] ? `${parenNeg[1]}#,##0.00` : '#,##0.00',
      };
    }
  }

  // Currency values e.g. "$1,200.50", "৳ 500", "-$45.00"
  const curMatch = trimmed.match(/^(-?)\s*([$€£₹৳])\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)$/);
  if (curMatch) {
    const sign = curMatch[1] === '-' || curMatch[3].startsWith('-') ? -1 : 1;
    const rawNum = curMatch[3].replace(/^-/, '').replace(/,/g, '');
    const n = Number(rawNum);
    if (Number.isFinite(n)) {
      return {
        value: sign * n,
        numFmt: `${curMatch[2]}#,##0.00`,
      };
    }
  }

  // Comma-grouped integers/decimals
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(n)) return { value: n, numFmt: trimmed.includes('.') ? '#,##0.00' : '#,##0' };
  }

  // Plain integer/decimal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return { value: n };
  }

  return { value: trimmed };
}

function buildSheetFromRows(
  parsedRows: Array<Array<ParsedExcelCell>>
): XLSX.WorkSheet {
  const aoa = parsedRows.length > 0
    ? parsedRows.map((r) => r.map((c) => c.value))
    : [['No tabular text detected']];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Apply number/currency/percentage formatting cleanly to individual cells
  parsedRows.forEach((row, rIdx) => {
    row.forEach((cell, cIdx) => {
      if (cell.numFmt && typeof cell.value === 'number') {
        const ref = XLSX.utils.encode_cell({ r: rIdx, c: cIdx });
        if (ws[ref]) {
          ws[ref].z = cell.numFmt;
        }
      }
    });
  });

  const maxCols = Math.max(...aoa.map((r) => r.length), 1);
  ws['!cols'] = Array.from({ length: maxCols }, (_, cIdx) => {
    const longest = aoa.reduce(
      (max, r) => Math.max(max, String(r[cIdx] ?? '').length),
      8
    );
    return { wch: Math.min(52, Math.max(11, longest + 3)) };
  });

  // Enable Excel AutoFilter when tabular rows have >= 2 columns & >= 2 rows
  if (maxCols >= 2 && aoa.length >= 2) {
    const headerIdx = aoa.findIndex((r) => r.filter((v) => v !== '').length >= 2);
    if (headerIdx >= 0 && headerIdx < aoa.length - 1) {
      ws['!autofilter'] = {
        ref: XLSX.utils.encode_range({
          s: { r: headerIdx, c: 0 },
          e: { r: aoa.length - 1, c: maxCols - 1 },
        }),
      };
    }
  }
  return ws;
}

export async function pdfToXlsxBytes(
  pdfBytes: ArrayBuffer,
  options?: PdfToXlsxOptions
): Promise<{ buffer: ArrayBuffer; extractedChars: number; ocrUsed: boolean }> {
  const mergeSheets = options?.mergeSheets ?? false;
  const useOcr = options?.useOcr ?? false;

  const pages = await extractVisualSpansPerPage(pdfBytes);
  const wb = XLSX.utils.book_new();
  let extractedChars = 0;
  let ocrUsed = false;

  const combinedRows: Array<Array<ParsedExcelCell>> = [];

  for (const page of pages) {
    const rows = clusterSpansIntoRows(page.spans, page.width);
    let pageParsedRows: Array<Array<ParsedExcelCell>> = [];

    if (rows.length > 0) {
      rows.forEach((r) =>
        r.cells.forEach((c) => {
          extractedChars += c.text.length;
        })
      );

      // Build stable column intervals ONLY from multi-cell rows so centered titles/headers never shift columns
      const multiCellRows = rows.filter((r) => r.cells.length >= 2).map((r) => r.cells);
      const colIntervals = buildColumnIntervals(multiCellRows);

      pageParsedRows = rows.map((row) => {
        if (colIntervals.length <= 1 || row.cells.length === 1) {
          if (row.cells.length === 1 && colIntervals.length > 1) {
            const ci = matchCellToColumn(row.cells[0], colIntervals);
            const arr: ParsedExcelCell[] = Array.from({ length: ci + 1 }, () => ({ value: '' }));
            // Place wide full-width headings at column 0; place aligned single values in their matched column
            const targetIdx =
              row.cells[0].right - row.cells[0].x > page.width * 0.45 ? 0 : ci;
            arr[targetIdx] = parseExcelCellValue(row.cells[0].text);
            return arr;
          }
          return row.cells.map((c) => parseExcelCellValue(c.text));
        }

        const rowArr: Array<{ raw: string }> = Array.from(
          { length: colIntervals.length },
          () => ({ raw: '' })
        );
        for (const cell of row.cells) {
          const ci = matchCellToColumn(cell, colIntervals);
          rowArr[ci].raw = rowArr[ci].raw ? `${rowArr[ci].raw} ${cell.text}` : cell.text;
        }
        const parsed = rowArr.map((c) => parseExcelCellValue(c.raw));
        while (parsed.length > 1 && parsed[parsed.length - 1].value === '') {
          parsed.pop();
        }
        return parsed;
      });
    } else if (useOcr) {
      // Scanned page fallback via on-device OCR splitting multi-space gaps into columns
      try {
        const canvas = document.createElement('canvas');
        await renderPageToCanvas(pdfBytes, page.pageNumber, canvas, 2);
        const ocrText = await runOnDeviceOcr(canvas, 'eng+ben');
        if (ocrText.trim()) {
          ocrUsed = true;
          extractedChars += ocrText.trim().length;
          pageParsedRows = ocrText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) =>
              line
                .split(/\s{2,}|\t+/)
                .map((col) => parseExcelCellValue(col))
            );
        }
      } catch {
        // leave empty fallback message
      }
    }

    if (mergeSheets) {
      if (pages.length > 1) {
        combinedRows.push([{ value: `--- Page ${page.pageNumber} ---` }]);
      }
      if (pageParsedRows.length > 0) {
        combinedRows.push(...pageParsedRows);
      } else {
        combinedRows.push([{ value: `(Page ${page.pageNumber}: No tabular text detected)` }]);
      }
      combinedRows.push([]);
    } else {
      const ws = buildSheetFromRows(pageParsedRows);
      XLSX.utils.book_append_sheet(wb, ws, `Page_${page.pageNumber}`.slice(0, 31));
    }
  }

  if (mergeSheets) {
    const ws = buildSheetFromRows(combinedRows);
    XLSX.utils.book_append_sheet(wb, ws, 'All_Pages');
  }

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return { buffer, extractedChars, ocrUsed };
}

function measureImageDataUrlSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth || 1200,
        height: img.naturalHeight || 900,
      });
    img.onerror = () => resolve({ width: 1200, height: 900 });
    img.src = dataUrl;
  });
}

function escapeXmlAttr(str: string): string {
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlText(str: string): string {
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mapToneToPptxFont(tone: 'sans' | 'serif' | 'mono'): string {
  if (tone === 'serif') return 'Georgia';
  if (tone === 'mono') return 'Courier New';
  return 'Calibri';
}

export async function pdfToPptxBytes(
  pdfBytes: ArrayBuffer,
  options?: PdfToPptxOptions
): Promise<{ buffer: ArrayBuffer; slideCount: number; editableBlocks: number }> {
  const mode = options?.mode ?? 'editable';
  const useOcr = options?.useOcr ?? false;

  const pages = await extractVisualSpansPerPage(pdfBytes);
  const firstPage = pages[0] || { pageNumber: 1, width: 792, height: 612, spans: [] };
  const isFirstLandscape = firstPage.width >= firstPage.height;
  const slideW = isFirstLandscape ? 12192000 : 6858000;
  const slideH = Math.max(
    4572000,
    Math.min(13716000, Math.round((firstPage.height / Math.max(1, firstPage.width)) * slideW))
  );

  const zip = new JSZip();
  const slideCount = Math.max(1, pages.length);
  let editableBlocks = 0;

  if (mode === 'visual') {
    const { previewImages } = await pdfToImagesZip(pdfBytes, 'image/jpeg', 2.2);
    const dimsList = await Promise.all(previewImages.map((url) => measureImageDataUrlSize(url)));

    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${previewImages
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join('\n  ')}
</Types>`
    );

    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
    );

    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    ${previewImages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="${slideW}" cy="${slideH}" type="custom"/>
  <p:notesSz cx="${slideH}" cy="${slideW}"/>
</p:presentation>`
    );

    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${previewImages
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
    )
    .join('\n  ')}
</Relationships>`
    );

    previewImages.forEach((imgDataUrl, i) => {
      const idx = i + 1;
      const b64 = imgDataUrl.split(',')[1];
      const { width, height } = dimsList[i] || { width: 1200, height: 900 };
      const ratio = Math.min(slideW / Math.max(1, width), slideH / Math.max(1, height));
      const drawCx = Math.max(1, Math.round(width * ratio));
      const drawCy = Math.max(1, Math.round(height * ratio));
      const offX = Math.max(0, Math.round((slideW - drawCx) / 2));
      const offY = Math.max(0, Math.round((slideH - drawCy) / 2));

      zip.file(`ppt/media/image${idx}.jpg`, b64, { base64: true });
      zip.file(
        `ppt/slides/slide${idx}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="SlideImage${idx}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${drawCx}" cy="${drawCy}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`
      );
      zip.file(
        `ppt/slides/_rels/slide${idx}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${idx}.jpg"/>
</Relationships>`
      );
    });

    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    return { buffer, slideCount: previewImages.length, editableBlocks: 0 };
  }

  // Editable Slides Mode: real positioned DrawingML text shapes + native PowerPoint tables + scanned visual fallback
  let hasAnyImage = false;

  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const page = pages[pIdx];
    const slideIdx = pIdx + 1;
    const rows = clusterSpansIntoRows(page.spans, page.width);
    const scaleToSlide = Math.min(slideW / Math.max(1, page.width), slideH / Math.max(1, page.height));
    const offsetX = Math.round((slideW - page.width * scaleToSlide) / 2);
    const offsetY = Math.round((slideH - page.height * scaleToSlide) / 2);

    const shapesXml: string[] = [];
    let relXml = '';
    let nextShapeId = 2;

    if (rows.length === 0) {
      // Scanned page: embed crisp slide picture + optional OCR editable box
      hasAnyImage = true;
      const imgUrl = await renderPageToDataUrl(pdfBytes, page.pageNumber, 2, 'image/jpeg');
      const { width, height } = await measureImageDataUrlSize(imgUrl);
      const b64 = imgUrl.split(',')[1];
      zip.file(`ppt/media/image${slideIdx}.jpg`, b64, { base64: true });
      relXml = `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${slideIdx}.jpg"/>`;

      const ratio = Math.min(slideW / Math.max(1, width), slideH / Math.max(1, height));
      const drawCx = Math.max(1, Math.round(width * ratio));
      const drawCy = Math.max(1, Math.round(height * ratio));
      const picX = Math.max(0, Math.round((slideW - drawCx) / 2));
      const picY = Math.max(0, Math.round((slideH - drawCy) / 2));

      shapesXml.push(`
      <p:pic>
        <p:nvPicPr><p:cNvPr id="${nextShapeId++}" name="ScannedSlide${slideIdx}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="${picX}" y="${picY}"/><a:ext cx="${drawCx}" cy="${drawCy}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>`);

      if (useOcr) {
        try {
          const canvas = document.createElement('canvas');
          await renderPageToCanvas(pdfBytes, page.pageNumber, canvas, 2);
          const ocrText = await runOnDeviceOcr(canvas, 'eng+ben');
          if (ocrText.trim()) {
            editableBlocks++;
            const paras = ocrText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .map(
                (l) =>
                  `<a:p><a:r><a:rPr lang="en-US" sz="1200"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill></a:rPr><a:t>${escapeXmlText(l)}</a:t></a:r></a:p>`
              )
              .join('');
            shapesXml.push(`
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${nextShapeId++}" name="OcrTextBox${slideIdx}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="457200"/><a:ext cx="${Math.max(914400, slideW - 914400)}" cy="${Math.max(914400, slideH - 914400)}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="88000"/></a:srgbClr></a:solidFill>
        </p:spPr>
        <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paras}</p:txBody>
      </p:sp>`);
          }
        } catch {
          // ignore OCR error
        }
      }
    } else {
      const blocks = analyzePageBlocks(rows, page.width);
      for (const blk of blocks) {
        editableBlocks++;
        if (blk.kind === 'table') {
          const tblX = Math.max(180000, Math.round(offsetX + blk.left * scaleToSlide));
          const tblY = Math.max(180000, Math.round(offsetY + blk.topY * scaleToSlide));
          const tblW = Math.max(914400, Math.min(slideW - tblX - 180000, Math.round((blk.right - blk.left) * scaleToSlide + 260000)));
          const rowH = Math.max(290000, Math.round(((blk.bottomY - blk.topY) * scaleToSlide) / Math.max(1, blk.rows.length)));
          const tblH = Math.min(slideH - tblY - 120000, rowH * blk.rows.length);

          const colSum = blk.colWidths.reduce((s, w) => s + w, 0) || 1;
          const gridColsXml = blk.colWidths
            .map((w) => `<a:gridCol w="${Math.max(360000, Math.round((w / colSum) * tblW))}"/>`)
            .join('');

          const trXml = blk.rows
            .map((r, rIdx) => {
              const isHeader = rIdx === 0;
              const fillHex = isHeader ? '142B4A' : rIdx % 2 === 1 ? 'FFFFFF' : 'F8FAFC';
              const textHex = isHeader ? 'FFFFFF' : '1E293B';
              const cellsXml = r
                .map(
                  (c) => `<a:tc>
                    <a:txBody>
                      <a:bodyPr wrap="square"/>
                      <a:lstStyle/>
                      <a:p>
                        <a:pPr algn="${c.isNumeric && !isHeader ? 'r' : 'l'}"/>
                        <a:r>
                          <a:rPr lang="en-US" sz="1100"${isHeader ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${textHex}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr>
                          <a:t>${escapeXmlText(c.text || ' ')}</a:t>
                        </a:r>
                      </a:p>
                    </a:txBody>
                    <a:tcPr marL="72000" marR="72000" marT="45720" marB="45720">
                      <a:lnL w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnL>
                      <a:lnR w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnR>
                      <a:lnT w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnT>
                      <a:lnB w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnB>
                      <a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>
                    </a:tcPr>
                  </a:tc>`
                )
                .join('');
              return `<a:tr h="${Math.round(tblH / Math.max(1, blk.rows.length))}">${cellsXml}</a:tr>`;
            })
            .join('');

          shapesXml.push(`
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="${nextShapeId++}" name="${escapeXmlAttr(`Table${slideIdx}_${nextShapeId}`)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="${tblX}" y="${tblY}"/><a:ext cx="${tblW}" cy="${Math.max(360000, tblH)}"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gridColsXml}</a:tblGrid>${trXml}</a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>`);
          continue;
        }

        const algn = blk.align === 'center' ? 'ctr' : blk.align === 'right' ? 'r' : 'l';
        const boxLeftPt = blk.align === 'center' ? Math.max(20, blk.left - 30) : blk.left;
        const boxRightPt = blk.align === 'center' ? Math.min(page.width - 20, blk.right + 30) : Math.max(blk.right + 32, Math.min(page.width - 16, blk.left + 260));
        const spX = Math.max(91440, Math.round(offsetX + boxLeftPt * scaleToSlide));
        const spY = Math.max(91440, Math.round(offsetY + blk.topY * scaleToSlide));
        const spW = Math.max(914400, Math.min(slideW - spX - 91440, Math.round((boxRightPt - boxLeftPt) * scaleToSlide)));
        const spH = Math.max(260000, Math.round((blk.bottomY - blk.topY) * scaleToSlide + blk.fontSize * 12700 * 0.9));

        const runsXml = blk.runs
          .map((r) => {
            const ptScaled = Math.max(8, Math.min(48, Math.round(r.fontSize * (scaleToSlide / 12700))));
            const sz = ptScaled * 100;
            const colHex = blk.fontSize >= 14 ? '142B4A' : '1E293B';
            return `<a:r><a:rPr lang="en-US" sz="${sz}"${r.bold ? ' b="1"' : ''}${r.italics ? ' i="1"' : ''}><a:solidFill><a:srgbClr val="${colHex}"/></a:solidFill><a:latin typeface="${mapToneToPptxFont(r.fontTone)}"/></a:rPr><a:t>${escapeXmlText(r.text)}</a:t></a:r>`;
          })
          .join('');

        shapesXml.push(`
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${nextShapeId++}" name="TextBox${slideIdx}_${nextShapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${spX}" y="${spY}"/><a:ext cx="${spW}" cy="${spH}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="36000" rIns="36000" tIns="18000" bIns="18000"/>
          <a:lstStyle/>
          <a:p><a:pPr algn="${algn}"/>${runsXml}</a:p>
        </p:txBody>
      </p:sp>`);
      }
    }

    zip.file(
      `ppt/slides/slide${slideIdx}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>${shapesXml.join('')}
    </p:spTree>
  </p:cSld>
</p:sld>`
    );

    if (relXml) {
      zip.file(
        `ppt/slides/_rels/slide${slideIdx}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relXml}
</Relationships>`
      );
    }
  }

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${hasAnyImage ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : ''}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${pages
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join('\n  ')}
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  );

  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    ${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="${slideW}" cy="${slideH}" type="custom"/>
  <p:notesSz cx="${slideH}" cy="${slideW}"/>
</p:presentation>`
  );

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${pages
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
    )
    .join('\n  ')}
</Relationships>`
  );

  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  return { buffer, slideCount, editableBlocks };
}

export async function docxFileToPdf(file: File): Promise<{ pdfBytes: ArrayBuffer; html: string }> {
  const buf = await file.arrayBuffer();
  const header = new Uint8Array(buf.slice(0, 4));
  const isZip = header[0] === 0x50 && header[1] === 0x4b;
  if (!isZip) {
    throw new Error(
      'Legacy binary .DOC files are not supported. Please save the file as .DOCX and try again.'
    );
  }
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  const html = result.value || '<p>(Empty document)</p>';
  const pdfBytes = await htmlDocumentToPdf(html, {
    paperSize: 'A4',
    orientation: 'portrait',
    customWidthMm: 210,
    customHeightMm: 297,
    marginTopMm: 20,
    marginBottomMm: 20,
    marginLeftMm: 20,
    marginRightMm: 20,
    backgroundColor: '#FFFFFF',
    borderEnabled: false,
    borderColor: '#CBD5E1',
    headerText: file.name,
    footerText: '',
    pageNumbering: true,
  });
  return { pdfBytes, html };
}

export async function xlsxFileToPdf(file: File): Promise<ArrayBuffer> {
  const isCsv = /\.csv$/i.test(file.name);
  const wb = isCsv
    ? XLSX.read(await file.text(), { type: 'string' })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' });
  let html = '';
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const tableHtml = XLSX.utils.sheet_to_html(sheet);
    html += `<h2 style="margin:12px 0 6px;font-size:16px;font-weight:700;color:#142B4A;">${sheetName}</h2>${tableHtml}`;
  }
  return htmlDocumentToPdf(html, {
    paperSize: 'A4',
    orientation: 'landscape',
    customWidthMm: 210,
    customHeightMm: 297,
    marginTopMm: 14,
    marginBottomMm: 14,
    marginLeftMm: 14,
    marginRightMm: 14,
    backgroundColor: '#FFFFFF',
    borderEnabled: false,
    borderColor: '#CBD5E1',
    headerText: file.name,
    footerText: '',
    pageNumbering: true,
  });
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function pptxFileToPdf(file: File): Promise<ArrayBuffer> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const nb = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return na - nb;
    });

  const sections: string[] = [];
  for (const sf of slideFiles) {
    const xml = await zip.files[sf].async('string');
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    // Group DrawingML text runs (<a:t>) by paragraph (<a:p>) so styled inline words remain on one line
    const pNodes = Array.from(doc.getElementsByTagNameNS('*', 'p'));
    const paragraphs = pNodes
      .map((pEl) =>
        Array.from(pEl.getElementsByTagNameNS('*', 't'))
          .map((tEl) => tEl.textContent || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean);

    const bodyHtml = paragraphs.length
      ? paragraphs
          .map((para, idx) =>
            idx === 0
              ? `<h2>${escapeHtmlText(para)}</h2>`
              : `<p style="font-size:13.5px;line-height:1.55;">${escapeHtmlText(para)}</p>`
          )
          .join('')
      : '<p>(Slide with graphic content)</p>';

    sections.push(
      `<div>
        <div style="font-size:11px;color:#64748b;margin-bottom:8px;">Slide ${sections.length + 1} of ${slideFiles.length}</div>
        ${bodyHtml}
      </div>${sections.length + 1 < slideFiles.length ? '<hr class="pdf-page-break"/>' : ''}`
    );
  }
  return htmlDocumentToPdf(sections.join('') || '<p>No slides found</p>', {
    paperSize: 'A4',
    orientation: 'landscape',
    customWidthMm: 210,
    customHeightMm: 297,
    marginTopMm: 16,
    marginBottomMm: 16,
    marginLeftMm: 16,
    marginRightMm: 16,
    backgroundColor: '#FFFFFF',
    borderEnabled: false,
    borderColor: '#CBD5E1',
    headerText: file.name,
    footerText: '',
    pageNumbering: true,
  });
}

function inferFontFamilyFromStyle(styleStr: string): 'sans' | 'serif' | 'mono' {
  const s = styleStr.toLowerCase();
  if (s.includes('courier') || s.includes('mono') || s.includes('consolas')) return 'mono';
  if (s.includes('times') || s.includes('cambria') || s.includes('georgia') || s.includes('garamond') || s.includes('serif')) {
    return 'serif';
  }
  return 'sans';
}

function normalizeCssColorToHex(raw: string): string | undefined {
  const c = raw.trim();
  if (/^#[0-9a-f]{3,6}$/i.test(c)) return c;
  const m = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (m) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
  }
  return undefined;
}

/**
 * Renders rich HTML (English + Bengali Unicode, tables with dynamic wrapped rows, ordered/unordered lists,
 * font families, colors, images, borders, headers, footers) into clean paginated multi-page PDF bytes.
 */
export async function htmlDocumentToPdf(
  htmlContent: string,
  settings: WordPageSettings
): Promise<ArrayBuffer> {
  const mmToPt = 2.83464567;
  const baseDim = PAPER_DIMENSIONS[settings.paperSize];
  let pageWidthPt =
    settings.paperSize === 'Custom' ? Math.max(40, settings.customWidthMm) * mmToPt : baseDim.widthPt;
  let pageHeightPt =
    settings.paperSize === 'Custom' ? Math.max(40, settings.customHeightMm) * mmToPt : baseDim.heightPt;

  if (settings.orientation === 'landscape' && pageWidthPt < pageHeightPt) {
    [pageWidthPt, pageHeightPt] = [pageHeightPt, pageWidthPt];
  } else if (settings.orientation === 'portrait' && pageWidthPt > pageHeightPt) {
    [pageWidthPt, pageHeightPt] = [pageHeightPt, pageWidthPt];
  }

  const mTopPt = Math.max(12, settings.marginTopMm * mmToPt);
  const mBotPt = Math.max(12, settings.marginBottomMm * mmToPt);
  const mLeftPt = Math.max(12, settings.marginLeftMm * mmToPt);
  const mRightPt = Math.max(12, settings.marginRightMm * mmToPt);

  const contentW = Math.max(100, pageWidthPt - mLeftPt - mRightPt);
  const contentH = Math.max(100, pageHeightPt - mTopPt - mBotPt);

  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${htmlContent}</div>`, 'text/html');
  const rootEl = parsed.body.firstElementChild || parsed.body;

  interface RenderBlock {
    kind: 'heading' | 'paragraph' | 'list-item' | 'table' | 'image' | 'page-break';
    text?: string;
    fontSize?: number;
    fontTone?: 'sans' | 'serif' | 'mono';
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: string;
    align?: 'left' | 'center' | 'right';
    rows?: string[][];
    imgSrc?: string;
  }

  const blocks: RenderBlock[] = [];
  const extractMetaFromEl = (node: Element) => {
    const styleAttr = node.getAttribute('style') || '';
    const alignMatch = styleAttr.match(/text-align:\s*(left|center|right)/i);
    const fontMatch = styleAttr.match(/font-family:\s*([^;]+)/i);
    const colorMatch = styleAttr.match(/(?:^|;)\s*color:\s*([^;]+)/i);
    const attrColor = node.getAttribute('color');
    return {
      align: (alignMatch?.[1]?.toLowerCase() as 'left' | 'center' | 'right') || 'left',
      fontTone: inferFontFamilyFromStyle(fontMatch?.[1] || styleAttr),
      color: normalizeCssColorToHex(colorMatch?.[1] || attrColor || ''),
    };
  };

  const walkChildNodes = (parent: Node) => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const txt = (child.textContent || '').trim();
        if (txt) blocks.push({ kind: 'paragraph', text: txt, fontSize: 11.5 });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child as Element);
      }
    });
  };
  const walk = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'hr' || node.classList.contains('pdf-page-break')) {
      blocks.push({ kind: 'page-break' });
      return;
    }
    if (tag === 'br') {
      return;
    }
    if (tag === 'img') {
      const src = node.getAttribute('src');
      if (src) blocks.push({ kind: 'image', imgSrc: src });
      return;
    }
    if (tag === 'table') {
      const rows: string[][] = [];
      node.querySelectorAll('tr').forEach((tr) => {
        const cols: string[] = [];
        tr.querySelectorAll('th,td').forEach((cell) =>
          cols.push((cell.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (cols.length) rows.push(cols);
      });
      if (rows.length) blocks.push({ kind: 'table', rows });
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === 'li');
      items.forEach((li, idx) => {
        const txt = (li.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) return;
        const prefix = tag === 'ol' ? `${idx + 1}. ` : '• ';
        const meta = extractMetaFromEl(li);
        blocks.push({
          kind: 'list-item',
          text: `${prefix}${txt}`,
          fontSize: 11.5,
          fontTone: meta.fontTone,
          color: meta.color,
          bold: Boolean(li.querySelector('b,strong')),
          italic: Boolean(li.querySelector('i,em')),
        });
      });
      return;
    }
    if (tag === 'li') {
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) blocks.push({ kind: 'list-item', text: `• ${txt}`, fontSize: 11.5 });
      return;
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) {
        const meta = extractMetaFromEl(node);
        blocks.push({
          kind: 'heading',
          text: txt,
          fontSize: tag === 'h1' ? 20 : tag === 'h2' ? 15.5 : 13.5,
          fontTone: meta.fontTone,
          bold: true,
          color: meta.color || '#142B4A',
          align: meta.align,
        });
      }
      return;
    }
    if (tag === 'p' || tag === 'div' || tag === 'blockquote') {
      const hasBlocks = Array.from(node.children).some((c) =>
        ['p', 'div', 'h1', 'h2', 'h3', 'table', 'ul', 'ol', 'hr', 'img'].includes(
          c.tagName.toLowerCase()
        )
      );
      if (hasBlocks) {
        walkChildNodes(node);
      } else {
        const lines = (node.innerHTML || '')
          .split(/<br\s*\/?>/i)
          .map((frag) => {
            const tmp = parser.parseFromString(`<span>${frag}</span>`, 'text/html');
            return (tmp.body.textContent || '').replace(/\s+/g, ' ').trim();
          })
          .filter(Boolean);
        const meta = extractMetaFromEl(node);
        const bold = Boolean(node.querySelector('b,strong'));
        const italic = Boolean(node.querySelector('i,em'));
        const underline = Boolean(node.querySelector('u'));
        for (const txt of lines) {
          blocks.push({
            kind: 'paragraph',
            text: txt,
            fontSize: 11.5,
            fontTone: meta.fontTone,
            color: meta.color,
            bold,
            italic,
            underline,
            align: meta.align,
          });
        }
      }
      return;
    }
    if (['span', 'b', 'strong', 'i', 'em', 'u', 'a', 'font', 'sub', 'sup'].includes(tag)) {
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) {
        const meta = extractMetaFromEl(node);
        blocks.push({
          kind: 'paragraph',
          text: txt,
          fontSize: 11.5,
          fontTone: meta.fontTone,
          color: meta.color,
          bold: tag === 'b' || tag === 'strong' || Boolean(node.querySelector('b,strong')),
          italic: tag === 'i' || tag === 'em' || Boolean(node.querySelector('i,em')),
          underline: tag === 'u' || Boolean(node.querySelector('u')),
        });
      }
      return;
    }
    walkChildNodes(node);
  };

  walkChildNodes(rootEl);
  if (blocks.length === 0 && (rootEl.textContent || '').trim()) {
    blocks.push({ kind: 'paragraph', text: (rootEl.textContent || '').trim(), fontSize: 11.5 });
  }

  const pdfDoc = await PDFDocument.create();
  const fonts = {
    sans: {
      reg: await pdfDoc.embedFont(StandardFonts.Helvetica),
      bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
      italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
    },
    serif: {
      reg: await pdfDoc.embedFont(StandardFonts.TimesRoman),
      bold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
      italic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
      boldItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic),
    },
    mono: {
      reg: await pdfDoc.embedFont(StandardFonts.Courier),
      bold: await pdfDoc.embedFont(StandardFonts.CourierBold),
      italic: await pdfDoc.embedFont(StandardFonts.CourierOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.CourierBoldOblique),
    },
  };

  const pickFont = (
    tone: 'sans' | 'serif' | 'mono' = 'sans',
    bold?: boolean,
    italic?: boolean
  ): PDFFont => {
    const f = fonts[tone];
    if (bold && italic) return f.boldItalic;
    if (bold) return f.bold;
    if (italic) return f.italic;
    return f.reg;
  };

  const isWinAnsiSafe = (font: PDFFont, text: string): boolean => {
    if (hasNonWinAnsiChars(text)) return false;
    try {
      font.encodeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d')!;

  const measureWidth = (
    text: string,
    font: PDFFont,
    fontSize: number,
    tone: 'sans' | 'serif' | 'mono',
    bold?: boolean,
    italic?: boolean
  ) => {
    if (isWinAnsiSafe(font, text)) {
      return font.widthOfTextAtSize(text, fontSize);
    }
    const familyCss =
      tone === 'serif'
        ? "'Times New Roman', Georgia, 'Noto Sans Bengali', serif"
        : tone === 'mono'
        ? "'Courier New', monospace"
        : "'DM Sans', Arial, 'Noto Sans Bengali', sans-serif";
    mCtx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px ${familyCss}`;
    return mCtx.measureText(text).width;
  };

  const wrapWordsToWidth = (
    text: string,
    maxW: number,
    font: PDFFont,
    fontSize: number,
    tone: 'sans' | 'serif' | 'mono',
    bold?: boolean,
    italic?: boolean
  ): string[] => {
    const out: string[] = [];
    const words = text.split(/\s+/).filter(Boolean);
    let cur = '';

    const pushTokenChars = (tok: string) => {
      let chunk = '';
      for (const ch of tok) {
        const test = chunk + ch;
        if (measureWidth(test, font, fontSize, tone, bold, italic) > maxW && chunk) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk = test;
        }
      }
      cur = chunk;
    };

    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (measureWidth(test, font, fontSize, tone, bold, italic) > maxW) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
        if (measureWidth(w, font, fontSize, tone, bold, italic) > maxW) {
          pushTokenChars(w);
        } else {
          cur = w;
        }
      } else {
        cur = test;
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };

  const createdPages: ReturnType<typeof pdfDoc.addPage>[] = [];
  const addNewPage = () => {
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    const bgHex = settings.backgroundColor || '#FFFFFF';
    if (bgHex.toUpperCase() !== '#FFFFFF') {
      page.drawRectangle({ x: 0, y: 0, width: pageWidthPt, height: pageHeightPt, color: hexToRgb(bgHex) });
    }
    if (settings.borderEnabled) {
      page.drawRectangle({
        x: mLeftPt * 0.55,
        y: mBotPt * 0.55,
        width: pageWidthPt - (mLeftPt + mRightPt) * 0.55,
        height: pageHeightPt - (mTopPt + mBotPt) * 0.55,
        borderColor: hexToRgb(settings.borderColor || '#CBD5E1'),
        borderWidth: 1.5,
      });
    }
    createdPages.push(page);
    return page;
  };

  let currentPage = addNewPage();
  let cursorTopOffset = mTopPt;

  const ensureSpace = (neededH: number) => {
    if (cursorTopOffset + neededH > mTopPt + contentH) {
      currentPage = addNewPage();
      cursorTopOffset = mTopPt;
    }
  };

  for (const blk of blocks) {
    if (blk.kind === 'page-break') {
      currentPage = addNewPage();
      cursorTopOffset = mTopPt;
      continue;
    }

    if (blk.kind === 'image' && blk.imgSrc) {
      try {
        const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = blk.imgSrc!;
        });
        const c = document.createElement('canvas');
        c.width = imgEl.naturalWidth || 400;
        c.height = imgEl.naturalHeight || 300;
        c.getContext('2d')!.drawImage(imgEl, 0, 0);
        const pngData = c.toDataURL('image/png').split(',')[1];
        const bin = atob(pngData);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const embedded = await pdfDoc.embedPng(bytes);

        const drawW = Math.min(contentW, (imgEl.naturalWidth || 300) * 0.75);
        const drawH = ((imgEl.naturalHeight || 200) / Math.max(1, imgEl.naturalWidth || 300)) * drawW;
        ensureSpace(drawH + 10);
        currentPage.drawImage(embedded, {
          x: mLeftPt,
          y: pageHeightPt - cursorTopOffset - drawH,
          width: drawW,
          height: drawH,
        });
        cursorTopOffset += drawH + 10;
      } catch {
        // skip invalid inline image
      }
      continue;
    }

    if (blk.kind === 'table' && blk.rows) {
      const colCount = Math.max(...blk.rows.map((r) => r.length));
      const colW = contentW / Math.max(1, colCount);
      const cellFs = 9.5;
      const cellLineH = 12.5;
      const innerCellW = Math.max(20, colW - 10);

      for (let rIdx = 0; rIdx < blk.rows.length; rIdx++) {
        const row = blk.rows[rIdx];
        const isHeader = rIdx === 0;
        const cellFont = pickFont('sans', isHeader, false);
        const wrappedCells = row.map((rawCell) =>
          wrapWordsToWidth(rawCell, innerCellW, cellFont, cellFs, 'sans', isHeader, false)
        );
        const maxLines = Math.max(...wrappedCells.map((lines) => lines.length), 1);
        const rowH = Math.max(22, maxLines * cellLineH + 10);
        ensureSpace(rowH);

        const fillHex = isHeader ? '#EFF6FF' : rIdx % 2 === 0 ? '#F8FAFC' : '#FFFFFF';
        const rowBottomY = pageHeightPt - cursorTopOffset - rowH;
        currentPage.drawRectangle({
          x: mLeftPt,
          y: rowBottomY,
          width: contentW,
          height: rowH,
          color: hexToRgb(fillHex),
          borderColor: hexToRgb('#CBD5E1'),
          borderWidth: 0.75,
        });

        for (let cIdx = 0; cIdx < row.length; cIdx++) {
          if (cIdx > 0) {
            currentPage.drawLine({
              start: { x: mLeftPt + cIdx * colW, y: rowBottomY },
              end: { x: mLeftPt + cIdx * colW, y: rowBottomY + rowH },
              thickness: 0.5,
              color: hexToRgb('#CBD5E1'),
            });
          }
          const cellText = row[cIdx];
          const cellX = mLeftPt + cIdx * colW + 5;
          if (!cellText) continue;

          if (isWinAnsiSafe(cellFont, cellText)) {
            wrappedCells[cIdx].forEach((lineStr, lIdx) => {
              if (!lineStr) return;
              const y = rowBottomY + rowH - 5 - cellFs * 0.85 - lIdx * cellLineH;
              currentPage.drawText(lineStr, {
                x: cellX,
                y,
                size: cellFs,
                font: cellFont,
                color: hexToRgb('#1E293B'),
              });
            });
          } else {
            const rendered = await renderUnicodeTextPng({
              text: cellText,
              fontSize: cellFs,
              fontFamily: 'sans',
              color: '#1E293B',
              bold: isHeader,
              italic: false,
              underline: false,
              align: 'left',
              maxWidth: innerCellW,
            });
            const img = await pdfDoc.embedPng(rendered.pngBytes);
            const drawH = Math.min(rowH - 4, rendered.heightPt);
            const drawW =
              rendered.heightPt > rowH - 4
                ? Math.min(innerCellW, rendered.widthPt * (drawH / rendered.heightPt))
                : Math.min(innerCellW, rendered.widthPt);
            currentPage.drawImage(img, {
              x: cellX - 1,
              y: rowBottomY + rowH - 3 - drawH,
              width: drawW,
              height: drawH,
            });
          }
        }
        cursorTopOffset += rowH;
      }
      cursorTopOffset += 10;
      continue;
    }

    const fontSize = blk.fontSize || 11.5;
    const tone = blk.fontTone || 'sans';
    const lineH = fontSize * 1.48;
    const font = pickFont(tone, blk.bold, blk.italic);
    const lines = wrapWordsToWidth(
      blk.text || '',
      contentW,
      font,
      fontSize,
      tone,
      blk.bold,
      blk.italic
    );

    if (blk.kind === 'heading') cursorTopOffset += 6;

    const unicodeFontFamily: PdfFontFamily =
      tone === 'serif' ? 'times' : tone === 'mono' ? 'courier' : 'arial';

    for (const line of lines) {
      ensureSpace(lineH);
      const colorHex = blk.color || '#1E293B';
      if (isWinAnsiSafe(font, line)) {
        const lw = font.widthOfTextAtSize(line, fontSize);
        let x = mLeftPt;
        if (blk.align === 'center') x = mLeftPt + Math.max(0, (contentW - lw) / 2);
        if (blk.align === 'right') x = mLeftPt + Math.max(0, contentW - lw);
        const baselineY = pageHeightPt - cursorTopOffset - fontSize * 0.9;
        currentPage.drawText(line, {
          x,
          y: baselineY,
          size: fontSize,
          font,
          color: hexToRgb(colorHex),
        });
        if (blk.underline && lw > 0) {
          currentPage.drawLine({
            start: { x, y: baselineY - 2 },
            end: { x: x + lw, y: baselineY - 2 },
            thickness: Math.max(0.7, fontSize * 0.06),
            color: hexToRgb(colorHex),
          });
        }
      } else {
        const rendered = await renderUnicodeTextPng({
          text: line,
          fontSize,
          fontFamily: unicodeFontFamily,
          color: colorHex,
          bold: Boolean(blk.bold),
          italic: Boolean(blk.italic),
          underline: Boolean(blk.underline),
          align: blk.align || 'left',
          maxWidth: contentW,
        });
        const img = await pdfDoc.embedPng(rendered.pngBytes);
        let x = mLeftPt - 4;
        if (blk.align === 'center') x = mLeftPt + Math.max(0, (contentW - rendered.widthPt) / 2);
        if (blk.align === 'right') x = mLeftPt + Math.max(0, contentW - rendered.widthPt);
        currentPage.drawImage(img, {
          x,
          y: pageHeightPt - cursorTopOffset - rendered.heightPt + 2,
          width: rendered.widthPt,
          height: rendered.heightPt,
        });
      }
      cursorTopOffset += lineH;
    }

    cursorTopOffset += blk.kind === 'heading' ? 8 : 6;
  }

  // Draw Header, Footer & Page Numbers
  const totalPages = createdPages.length;
  const fontReg = fonts.sans.reg;
  for (let i = 0; i < totalPages; i++) {
    const page = createdPages[i];
    const headerStr = settings.headerText.trim();
    const footerStr = settings.footerText.trim();

    if (headerStr) {
      if (isWinAnsiSafe(fontReg, headerStr)) {
        page.drawText(headerStr, {
          x: mLeftPt,
          y: pageHeightPt - mTopPt * 0.55,
          size: 9,
          font: fontReg,
          color: rgb(0.39, 0.45, 0.55),
        });
      } else {
        const rendered = await renderUnicodeTextPng({
          text: headerStr,
          fontSize: 9,
          fontFamily: 'sans',
          color: '#64748B',
          bold: false,
          italic: false,
          underline: false,
          align: 'left',
          maxWidth: contentW,
        });
        const img = await pdfDoc.embedPng(rendered.pngBytes);
        page.drawImage(img, {
          x: mLeftPt,
          y: pageHeightPt - mTopPt * 0.55 - 4,
          width: rendered.widthPt,
          height: rendered.heightPt,
        });
      }
    }

    if (footerStr) {
      if (isWinAnsiSafe(fontReg, footerStr)) {
        page.drawText(footerStr, {
          x: mLeftPt,
          y: mBotPt * 0.5,
          size: 9,
          font: fontReg,
          color: rgb(0.39, 0.45, 0.55),
        });
      } else {
        const rendered = await renderUnicodeTextPng({
          text: footerStr,
          fontSize: 9,
          fontFamily: 'sans',
          color: '#64748B',
          bold: false,
          italic: false,
          underline: false,
          align: 'left',
          maxWidth: contentW,
        });
        const img = await pdfDoc.embedPng(rendered.pngBytes);
        page.drawImage(img, {
          x: mLeftPt,
          y: mBotPt * 0.45,
          width: rendered.widthPt,
          height: rendered.heightPt,
        });
      }
    }

    if (settings.pageNumbering) {
      const pn = `${i + 1} / ${totalPages}`;
      const pw = fontReg.widthOfTextAtSize(pn, 9);
      page.drawText(pn, {
        x: pageWidthPt - mRightPt - pw,
        y: mBotPt * 0.5,
        size: 9,
        font: fontReg,
        color: rgb(0.39, 0.45, 0.55),
      });
    }
  }

  pdfDoc.setProducer('PDF MASTER Document Creator');
  const out = await pdfDoc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
