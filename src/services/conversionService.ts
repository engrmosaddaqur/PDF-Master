import { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } from 'docx';
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
  renderPageToDataUrl,
  renderUnicodeTextPng,
  splitPdfByRanges,
} from './pdfEngine';

export type ImageToPdfFitMode = 'a4-fit' | 'a4-fill' | 'auto';

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
  baselineY: number;
  width: number;
  fontSize: number;
  isBold: boolean;
}

async function extractVisualSpansPerPage(pdfBytes: ArrayBuffer): Promise<
  Array<{ pageNumber: number; width: number; height: number; spans: PositionedSpan[] }>
> {
  const pdf = await getSharedPdfDocument(pdfBytes);
  const pages: Array<{ pageNumber: number; width: number; height: number; spans: PositionedSpan[] }> = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
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
      const fname = (item.fontName || '').toLowerCase();
      const isBold = fname.includes('bold') || fname.includes('black') || fname.includes('heavy');

      spans.push({
        str: item.str,
        x,
        baselineY,
        width,
        fontSize,
        isBold,
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

function clusterSpansIntoRows(spans: PositionedSpan[]) {
  const sorted = [...spans].sort((a, b) => a.baselineY - b.baselineY || a.x - b.x);
  const rows: Array<{ avgY: number; avgFontSize: number; spans: PositionedSpan[] }> = [];

  for (const sp of sorted) {
    const last = rows[rows.length - 1];
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
      rows.push({ avgY: sp.baselineY, avgFontSize: sp.fontSize, spans: [sp] });
    }
  }

  rows.forEach((r) => r.spans.sort((a, b) => a.x - b.x));
  return rows;
}

export async function pdfToDocxBytes(
  pdfBytes: ArrayBuffer,
  title: string
): Promise<{ buffer: ArrayBuffer; extractedChars: number }> {
  const pages = await extractVisualSpansPerPage(pdfBytes);

  // Estimate dominant body font size across document for accurate heading classification
  const allFontSizes: number[] = [];
  let extractedChars = 0;
  for (const pg of pages) {
    for (const sp of pg.spans) {
      extractedChars += sp.str.trim().length;
      allFontSizes.push(Math.round(sp.fontSize * 2) / 2);
    }
  }
  allFontSizes.sort((a, b) => a - b);
  const bodySize =
    allFontSizes.length > 0 ? allFontSizes[Math.floor(allFontSizes.length * 0.5)] : 11;

  const children: Paragraph[] = [
    new Paragraph({
      text: title.replace(/\.pdf$/i, ''),
      heading: HeadingLevel.HEADING_1,
    }),
  ];

  pages.forEach((page, pageIdx) => {
    if (pageIdx > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }

    const rows = clusterSpansIntoRows(page.spans);
    if (rows.length === 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `(Page ${page.pageNumber}: No extractable text — use OCR for scanned pages)`,
              italics: true,
              color: '64748B',
            }),
          ],
        })
      );
      return;
    }

    for (const row of rows) {
      let lineText = '';
      let lastRight = -Infinity;
      let boldCount = 0;
      let maxFs = 0;

      for (const sp of row.spans) {
        const gap = lastRight === -Infinity ? 0 : sp.x - lastRight;
        if (lineText) {
          if (gap > sp.fontSize * 1.8) {
            lineText += '    ';
          } else if (gap > sp.fontSize * 0.16 && !lineText.endsWith(' ') && !sp.str.startsWith(' ')) {
            lineText += ' ';
          }
        }
        lineText += sp.str;
        lastRight = Math.max(lastRight, sp.x + sp.width);
        if (sp.isBold) boldCount++;
        maxFs = Math.max(maxFs, sp.fontSize);
      }

      const clean = lineText.trim();
      if (!clean) continue;

      const mostlyBold = boldCount >= Math.ceil(row.spans.length * 0.65);
      if (maxFs >= bodySize * 1.38 && clean.length <= 120) {
        children.push(new Paragraph({ text: clean, heading: HeadingLevel.HEADING_2 }));
      } else if ((maxFs >= bodySize * 1.16 || (mostlyBold && clean.length <= 90)) && clean.length <= 120) {
        children.push(new Paragraph({ text: clean, heading: HeadingLevel.HEADING_3 }));
      } else {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: clean,
                bold: mostlyBold,
              }),
            ],
          })
        );
      }
    }
  });

  const docx = new Document({
    sections: [{ children }],
  });
  const blob = await Packer.toBlob(docx);
  return { buffer: await blob.arrayBuffer(), extractedChars };
}

function parseExcelCellValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Preserve phone numbers / IDs with leading zeros like "017123456" as text
  if (/^0\d+$/.test(trimmed)) return trimmed;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed;
}

export async function pdfToXlsxBytes(
  pdfBytes: ArrayBuffer
): Promise<{ buffer: ArrayBuffer; extractedChars: number }> {
  const pages = await extractVisualSpansPerPage(pdfBytes);
  const wb = XLSX.utils.book_new();
  let extractedChars = 0;

  for (const page of pages) {
    const rows = clusterSpansIntoRows(page.spans);
    const mergedRowCells: Array<Array<{ x: number; text: string }>> = [];
    const allCellX: number[] = [];

    for (const row of rows) {
      const cells: Array<{ x: number; right: number; fontSize: number; text: string }> = [];
      for (const sp of row.spans) {
        const clean = sp.str.trim();
        if (!clean) continue;
        extractedChars += clean.length;

        const prev = cells[cells.length - 1];
        const gap = prev ? sp.x - prev.right : Infinity;
        // Join tokens in the same phrase/column cell (only split columns on wide horizontal gaps)
        if (prev && gap <= Math.max(prev.fontSize, sp.fontSize) * 1.1) {
          prev.text = `${prev.text} ${clean}`.replace(/\s+/g, ' ').trim();
          prev.right = Math.max(prev.right, sp.x + sp.width);
          prev.fontSize = Math.max(prev.fontSize, sp.fontSize);
        } else {
          cells.push({
            x: sp.x,
            right: sp.x + sp.width,
            fontSize: sp.fontSize,
            text: clean,
          });
        }
      }
      if (cells.length > 0) {
        mergedRowCells.push(cells.map((c) => ({ x: c.x, text: c.text })));
        cells.forEach((c) => allCellX.push(c.x));
      }
    }

    // Build column anchors by clustering X positions within 18pt
    allCellX.sort((a, b) => a - b);
    const colAnchors: number[] = [];
    for (const x of allCellX) {
      if (colAnchors.length === 0 || x - colAnchors[colAnchors.length - 1] > 18) {
        colAnchors.push(x);
      }
    }

    const sheetRows: Array<Array<string | number>> = mergedRowCells.map((rowCells) => {
      if (colAnchors.length <= 1) {
        return rowCells.map((c) => parseExcelCellValue(c.text));
      }
      const rowArr: Array<string | number> = new Array(colAnchors.length).fill('');
      for (const cell of rowCells) {
        let bestCol = 0;
        let bestDist = Infinity;
        for (let ci = 0; ci < colAnchors.length; ci++) {
          const d = Math.abs(cell.x - colAnchors[ci]);
          if (d < bestDist) {
            bestDist = d;
            bestCol = ci;
          }
        }
        const existing = rowArr[bestCol];
        const combined = existing ? `${existing} ${cell.text}` : cell.text;
        rowArr[bestCol] = parseExcelCellValue(combined);
      }
      while (rowArr.length > 1 && rowArr[rowArr.length - 1] === '') {
        rowArr.pop();
      }
      return rowArr;
    });

    const sheetData = sheetRows.length > 0 ? sheetRows : [['No tabular text detected']];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    const maxCols = Math.max(...sheetData.map((r) => r.length), 1);
    const colWidths = Array.from({ length: maxCols }, (_, cIdx) => {
      const longest = sheetData.reduce(
        (max, r) => Math.max(max, String(r[cIdx] ?? '').length),
        8
      );
      return { wch: Math.min(48, Math.max(12, longest + 3)) };
    });
    ws['!cols'] = colWidths;
    XLSX.utils.book_append_sheet(wb, ws, `Page_${page.pageNumber}`.slice(0, 31));
  }

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return { buffer, extractedChars };
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

export async function pdfToPptxBytes(pdfBytes: ArrayBuffer): Promise<ArrayBuffer> {
  const { previewImages } = await pdfToImagesZip(pdfBytes, 'image/jpeg', 2);
  const dimsList = await Promise.all(previewImages.map((url) => measureImageDataUrlSize(url)));
  const zip = new JSZip();

  // Match PowerPoint slide size to first PDF page aspect ratio so slides fill crisply without letterbox bars
  const firstDim = dimsList[0] || { width: 1200, height: 900 };
  const isFirstLandscape = firstDim.width >= firstDim.height;
  const slideW = isFirstLandscape ? 12192000 : 6858000;
  const slideH = Math.max(
    4572000,
    Math.min(13716000, Math.round((firstDim.height / Math.max(1, firstDim.width)) * slideW))
  );

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

  return zip.generateAsync({ type: 'arraybuffer' });
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
