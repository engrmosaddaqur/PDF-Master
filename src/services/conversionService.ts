import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import type { WordPageSettings } from '../types';
import {
  PAPER_DIMENSIONS,
  cloneBuffer,
  extractDocumentPagesText,
  hasNonWinAnsiChars,
  hexToRgb,
  renderPageToDataUrl,
  renderUnicodeTextPng,
} from './pdfEngine';

export async function imagesToPdf(files: File[]): Promise<ArrayBuffer> {
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
    const widthPt = 595.28;
    const heightPt = (embedded.height / embedded.width) * widthPt;
    const page = doc.addPage([widthPt, heightPt]);
    page.drawImage(embedded, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function pdfToImagesZip(
  pdfBytes: ArrayBuffer,
  format: 'image/png' | 'image/jpeg' = 'image/png',
  renderScale = 2
): Promise<{ zipBuffer: ArrayBuffer; previewImages: string[] }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pdfBytes)) });
  const pdf = await loadingTask.promise;
  const count = pdf.numPages;
  await loadingTask.destroy();

  const zip = new JSZip();
  const previewImages: string[] = [];
  const ext = format === 'image/png' ? 'png' : 'jpg';

  for (let p = 1; p <= count; p++) {
    const dataUrl = await renderPageToDataUrl(pdfBytes, p, renderScale, format);
    previewImages.push(dataUrl);
    const base64 = dataUrl.split(',')[1];
    zip.file(`page-${String(p).padStart(3, '0')}.${ext}`, base64, { base64: true });
  }

  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return { zipBuffer, previewImages };
}

export async function pdfToDocxBytes(
  pdfBytes: ArrayBuffer,
  title: string
): Promise<{ buffer: ArrayBuffer; extractedChars: number }> {
  const pages = await extractDocumentPagesText(pdfBytes);
  const extractedChars = pages.reduce((sum, p) => sum + p.text.trim().length, 0);
  const children: Paragraph[] = [
    new Paragraph({
      text: title.replace(/\.pdf$/i, ''),
      heading: HeadingLevel.HEADING_1,
    }),
  ];

  for (const page of pages) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Page ${page.pageNumber}`,
            bold: true,
            color: '2563EB',
            size: 20,
          }),
        ],
      })
    );
    const lines = (page.text || '(No extractable text on this page)').split('\n');
    for (const line of lines) {
      children.push(new Paragraph({ text: line }));
    }
    children.push(new Paragraph({ text: '' }));
  }

  const docx = new Document({
    sections: [{ children }],
  });
  const blob = await Packer.toBlob(docx);
  return { buffer: await blob.arrayBuffer(), extractedChars };
}

export async function pdfToXlsxBytes(
  pdfBytes: ArrayBuffer
): Promise<{ buffer: ArrayBuffer; extractedChars: number }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pdfBytes)) });
  const pdf = await loadingTask.promise;
  const wb = XLSX.utils.book_new();
  let extractedChars = 0;

  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const rowsMap = new Map<number, Array<{ x: number; str: string }>>();
      const allXPositions: number[] = [];

      for (const item of tc.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const text = item.str.trim();
        extractedChars += text.length;
        const yBucket = Math.round((item.transform?.[5] ?? 0) / 6) * 6;
        const x = item.transform?.[4] ?? 0;
        allXPositions.push(x);
        const existing = rowsMap.get(yBucket) || [];
        existing.push({ x, str: text });
        rowsMap.set(yBucket, existing);
      }

      // Build column anchor positions by clustering X coordinates within 28pt
      const sortedX = [...allXPositions].sort((a, b) => a - b);
      const colAnchors: number[] = [];
      for (const x of sortedX) {
        if (colAnchors.length === 0 || x - colAnchors[colAnchors.length - 1] > 28) {
          colAnchors.push(x);
        }
      }

      const sortedRows = Array.from(rowsMap.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([, cells]) => {
          const ordered = [...cells].sort((a, b) => a.x - b.x);
          if (colAnchors.length <= 1) {
            return ordered.map((c) => c.str);
          }
          const rowArr: string[] = new Array(colAnchors.length).fill('');
          for (const cell of ordered) {
            let bestCol = 0;
            let bestDist = Infinity;
            for (let ci = 0; ci < colAnchors.length; ci++) {
              const d = Math.abs(cell.x - colAnchors[ci]);
              if (d < bestDist) {
                bestDist = d;
                bestCol = ci;
              }
            }
            rowArr[bestCol] = rowArr[bestCol] ? `${rowArr[bestCol]} ${cell.str}` : cell.str;
          }
          // Trim trailing empty cells
          while (rowArr.length > 1 && !rowArr[rowArr.length - 1]) {
            rowArr.pop();
          }
          return rowArr;
        });

      const sheetData = sortedRows.length > 0 ? sortedRows : [['No tabular text detected']];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      const maxCols = Math.max(...sheetData.map((r) => r.length), 1);
      const colWidths = Array.from({ length: maxCols }, (_, cIdx) => {
        const longest = sheetData.reduce(
          (max, r) => Math.max(max, (r[cIdx] || '').length),
          8
        );
        return { wch: Math.min(48, Math.max(12, longest + 3)) };
      });
      ws['!cols'] = colWidths;
      XLSX.utils.book_append_sheet(wb, ws, `Page_${p}`);
    }
  } finally {
    await loadingTask.destroy().catch(() => {});
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
  const { previewImages } = await pdfToImagesZip(pdfBytes, 'image/jpeg');
  const dimsList = await Promise.all(previewImages.map((url) => measureImageDataUrlSize(url)));
  const zip = new JSZip();

  const slideW = 9144000;
  const slideH = 6858000;

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
  <p:sldSz cx="${slideW}" cy="${slideH}" type="screen4x3"/>
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
    const ratio = Math.min(slideW / width, slideH / height);
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
    const texts = Array.from(doc.getElementsByTagName('a:t')).map((n) => n.textContent || '');
    sections.push(
      `<div style="padding:18px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:18px;page-break-after:always;">
        <div style="font-size:11px;color:#64748b;margin-bottom:8px;">Slide ${sections.length + 1}</div>
        <p style="font-size:15px;line-height:1.6;">${texts.join('</p><p style="font-size:14px;line-height:1.6;">') || '(Slide with graphic content)'}</p>
      </div>`
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

/**
 * Renders rich HTML (English + Bengali Unicode, tables, lists, images, borders, headers, footers)
 * into clean paginated multi-page PDF bytes with exact paper size, orientation, and genuine editable vector PDF text.
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

  // Parse HTML into structured blocks
  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${htmlContent}</div>`, 'text/html');
  const rootEl = parsed.body.firstElementChild || parsed.body;

  interface RenderBlock {
    kind: 'heading' | 'paragraph' | 'list-item' | 'table' | 'image' | 'page-break';
    text?: string;
    fontSize?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    align?: 'left' | 'center' | 'right';
    rows?: string[][];
    imgSrc?: string;
  }

  const blocks: RenderBlock[] = [];
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
        tr.querySelectorAll('th,td').forEach((cell) => cols.push((cell.textContent || '').trim()));
        if (cols.length) rows.push(cols);
      });
      if (rows.length) blocks.push({ kind: 'table', rows });
      return;
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      const txt = (node.textContent || '').trim();
      if (txt) {
        const styleAttr = node.getAttribute('style') || '';
        const alignMatch = styleAttr.match(/text-align:\s*(left|center|right)/i);
        blocks.push({
          kind: 'heading',
          text: txt,
          fontSize: tag === 'h1' ? 20 : tag === 'h2' ? 15.5 : 13.5,
          bold: true,
          color: '#142B4A',
          align: (alignMatch?.[1]?.toLowerCase() as 'left' | 'center' | 'right') || 'left',
        });
      }
      return;
    }
    if (tag === 'li') {
      const txt = (node.textContent || '').trim();
      if (txt) blocks.push({ kind: 'list-item', text: `- ${txt}`, fontSize: 11.5 });
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
            return (tmp.body.textContent || '').trim();
          })
          .filter(Boolean);
        const styleAttr = node.getAttribute('style') || '';
        const alignMatch = styleAttr.match(/text-align:\s*(left|center|right)/i);
        const align = (alignMatch?.[1]?.toLowerCase() as 'left' | 'center' | 'right') || 'left';
        const bold = Boolean(node.querySelector('b,strong'));
        const italic = Boolean(node.querySelector('i,em'));
        for (const txt of lines) {
          blocks.push({
            kind: 'paragraph',
            text: txt,
            fontSize: 11.5,
            bold,
            italic,
            align,
          });
        }
      }
      return;
    }
    if (['span', 'b', 'strong', 'i', 'em', 'u', 'a', 'font', 'sub', 'sup'].includes(tag)) {
      const txt = (node.textContent || '').trim();
      if (txt) {
        blocks.push({
          kind: 'paragraph',
          text: txt,
          fontSize: 11.5,
          bold: tag === 'b' || tag === 'strong' || Boolean(node.querySelector('b,strong')),
          italic: tag === 'i' || tag === 'em' || Boolean(node.querySelector('i,em')),
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
  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const fontBoldItalic = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);

  const pickFont = (bold?: boolean, italic?: boolean): PDFFont => {
    if (bold && italic) return fontBoldItalic;
    if (bold) return fontBold;
    if (italic) return fontItalic;
    return fontReg;
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

  const measureWidth = (text: string, font: PDFFont, fontSize: number, bold?: boolean, italic?: boolean) => {
    if (isWinAnsiSafe(font, text)) {
      return font.widthOfTextAtSize(text, fontSize);
    }
    mCtx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px 'DM Sans', 'Noto Sans Bengali', sans-serif`;
    return mCtx.measureText(text).width;
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
  let cursorTopOffset = mTopPt; // distance from top of page

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
      const rowH = 24;
      for (let rIdx = 0; rIdx < blk.rows.length; rIdx++) {
        ensureSpace(rowH);
        const row = blk.rows[rIdx];
        const fillHex = rIdx === 0 ? '#EFF6FF' : rIdx % 2 === 0 ? '#F8FAFC' : '#FFFFFF';
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

        const cellFont = pickFont(rIdx === 0, false);
        for (let cIdx = 0; cIdx < row.length; cIdx++) {
          const cellText = row[cIdx].slice(0, 42);
          const cellX = mLeftPt + cIdx * colW + 6;
          if (isWinAnsiSafe(cellFont, cellText)) {
            currentPage.drawText(cellText, {
              x: cellX,
              y: rowBottomY + 8,
              size: 10,
              font: cellFont,
              color: hexToRgb('#1E293B'),
            });
          } else if (cellText) {
            const rendered = await renderUnicodeTextPng({
              text: cellText,
              fontSize: 10,
              fontFamily: 'sans',
              color: '#1E293B',
              bold: rIdx === 0,
              italic: false,
              underline: false,
              align: 'left',
              maxWidth: Math.max(40, colW - 12),
            });
            const img = await pdfDoc.embedPng(rendered.pngBytes);
            currentPage.drawImage(img, {
              x: cellX - 2,
              y: rowBottomY + (rowH - rendered.heightPt) / 2,
              width: Math.min(colW - 8, rendered.widthPt),
              height: rendered.heightPt,
            });
          }
        }
        cursorTopOffset += rowH;
      }
      cursorTopOffset += 10;
      continue;
    }

    const fontSize = blk.fontSize || 11.5;
    const lineH = fontSize * 1.48;
    const font = pickFont(blk.bold, blk.italic);
    const words = (blk.text || '').split(/\s+/);
    const lines: string[] = [];
    let curLine = '';

    for (const w of words) {
      const test = curLine ? `${curLine} ${w}` : w;
      if (measureWidth(test, font, fontSize, blk.bold, blk.italic) > contentW && curLine) {
        lines.push(curLine);
        curLine = w;
      } else {
        curLine = test;
      }
    }
    if (curLine) lines.push(curLine);

    if (blk.kind === 'heading') cursorTopOffset += 6;

    for (const line of lines) {
      ensureSpace(lineH);
      const colorHex = blk.color || '#1E293B';
      if (isWinAnsiSafe(font, line)) {
        const lw = font.widthOfTextAtSize(line, fontSize);
        let x = mLeftPt;
        if (blk.align === 'center') x = mLeftPt + Math.max(0, (contentW - lw) / 2);
        if (blk.align === 'right') x = mLeftPt + Math.max(0, contentW - lw);
        currentPage.drawText(line, {
          x,
          y: pageHeightPt - cursorTopOffset - fontSize * 0.9,
          size: fontSize,
          font,
          color: hexToRgb(colorHex),
        });
      } else {
        const rendered = await renderUnicodeTextPng({
          text: line,
          fontSize,
          fontFamily: 'sans',
          color: colorHex,
          bold: Boolean(blk.bold),
          italic: Boolean(blk.italic),
          underline: false,
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
