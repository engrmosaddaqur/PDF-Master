import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import type { WordPageSettings } from '../types';
import {
  PAPER_DIMENSIONS,
  cloneBuffer,
  extractDocumentPagesText,
  renderPageToDataUrl,
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
  format: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<{ zipBuffer: ArrayBuffer; previewImages: string[] }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pdfBytes)) });
  const pdf = await loadingTask.promise;
  const count = pdf.numPages;
  await loadingTask.destroy();

  const zip = new JSZip();
  const previewImages: string[] = [];
  const ext = format === 'image/png' ? 'png' : 'jpg';

  for (let p = 1; p <= count; p++) {
    const dataUrl = await renderPageToDataUrl(pdfBytes, p, 2, format);
    previewImages.push(dataUrl);
    const base64 = dataUrl.split(',')[1];
    zip.file(`page-${String(p).padStart(3, '0')}.${ext}`, base64, { base64: true });
  }

  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return { zipBuffer, previewImages };
}

export async function pdfToDocxBytes(pdfBytes: ArrayBuffer, title: string): Promise<ArrayBuffer> {
  const pages = await extractDocumentPagesText(pdfBytes);
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
  return blob.arrayBuffer();
}

export async function pdfToXlsxBytes(pdfBytes: ArrayBuffer): Promise<ArrayBuffer> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneBuffer(pdfBytes)) });
  const pdf = await loadingTask.promise;
  const wb = XLSX.utils.book_new();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const rowsMap = new Map<number, Array<{ x: number; str: string }>>();

    for (const item of tc.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const yBucket = Math.round((item.transform?.[5] ?? 0) / 6) * 6;
      const x = item.transform?.[4] ?? 0;
      const existing = rowsMap.get(yBucket) || [];
      existing.push({ x, str: item.str.trim() });
      rowsMap.set(yBucket, existing);
    }

    const sortedRows = Array.from(rowsMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.str));

    const ws = XLSX.utils.aoa_to_sheet(sortedRows.length > 0 ? sortedRows : [['No tabular text detected']]);
    XLSX.utils.book_append_sheet(wb, ws, `Page_${p}`);
  }
  await loadingTask.destroy();

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

export async function pdfToPptxBytes(pdfBytes: ArrayBuffer): Promise<ArrayBuffer> {
  const { previewImages } = await pdfToImagesZip(pdfBytes, 'image/jpeg');
  const zip = new JSZip();

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
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:notesSz cx="6858000" cy="9144000"/>
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
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="6858000"/></a:xfrm>
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
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
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
 * into clean paginated multi-page PDF bytes with exact paper size & orientation.
 */
export async function htmlDocumentToPdf(
  htmlContent: string,
  settings: WordPageSettings
): Promise<ArrayBuffer> {
  const mmToPt = 2.83464567;
  const baseDim = PAPER_DIMENSIONS[settings.paperSize];
  let pageWidthPt =
    settings.paperSize === 'Custom' ? settings.customWidthMm * mmToPt : baseDim.widthPt;
  let pageHeightPt =
    settings.paperSize === 'Custom' ? settings.customHeightMm * mmToPt : baseDim.heightPt;

  if (settings.orientation === 'landscape' && pageWidthPt < pageHeightPt) {
    [pageWidthPt, pageHeightPt] = [pageHeightPt, pageWidthPt];
  } else if (settings.orientation === 'portrait' && pageWidthPt > pageHeightPt) {
    [pageWidthPt, pageHeightPt] = [pageHeightPt, pageWidthPt];
  }

  // Render onto high-res paginated canvas blocks
  const pxScale = 2; // 144 DPI crisp text
  const pageW = Math.round(pageWidthPt * pxScale);
  const pageH = Math.round(pageHeightPt * pxScale);
  const mTop = Math.round(settings.marginTopMm * mmToPt * pxScale);
  const mBot = Math.round(settings.marginBottomMm * mmToPt * pxScale);
  const mLeft = Math.round(settings.marginLeftMm * mmToPt * pxScale);
  const mRight = Math.round(settings.marginRightMm * mmToPt * pxScale);

  const contentW = Math.max(200, pageW - mLeft - mRight);
  const contentH = Math.max(200, pageH - mTop - mBot);

  // Parse HTML into structured blocks for crisp Unicode & Bengali pagination
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
  const walk = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'hr' || node.classList.contains('pdf-page-break')) {
      blocks.push({ kind: 'page-break' });
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
        blocks.push({
          kind: 'heading',
          text: txt,
          fontSize: tag === 'h1' ? 22 : tag === 'h2' ? 18 : 15,
          bold: true,
          color: '#142B4A',
        });
      }
      return;
    }
    if (tag === 'li') {
      const txt = (node.textContent || '').trim();
      if (txt) blocks.push({ kind: 'list-item', text: `• ${txt}`, fontSize: 12.5 });
      return;
    }
    if (tag === 'p' || tag === 'div' || tag === 'blockquote') {
      // Check if it contains nested block tags
      const hasBlocks = Array.from(node.children).some((c) =>
        ['p', 'div', 'h1', 'h2', 'h3', 'table', 'ul', 'ol', 'hr', 'img'].includes(
          c.tagName.toLowerCase()
        )
      );
      if (hasBlocks) {
        Array.from(node.children).forEach(walk);
      } else {
        const txt = (node.textContent || '').trim();
        const styleAttr = node.getAttribute('style') || '';
        const alignMatch = styleAttr.match(/text-align:\s*(left|center|right)/i);
        const align = (alignMatch?.[1]?.toLowerCase() as 'left' | 'center' | 'right') || 'left';
        const bold = Boolean(node.querySelector('b,strong'));
        const italic = Boolean(node.querySelector('i,em'));
        if (txt) {
          blocks.push({
            kind: 'paragraph',
            text: txt,
            fontSize: 12.5,
            bold,
            italic,
            align,
          });
        }
      }
      return;
    }
    Array.from(node.children).forEach(walk);
  };

  Array.from(rootEl.children).forEach(walk);
  if (blocks.length === 0 && (rootEl.textContent || '').trim()) {
    blocks.push({ kind: 'paragraph', text: (rootEl.textContent || '').trim(), fontSize: 12.5 });
  }

  const pageCanvases: HTMLCanvasElement[] = [];
  const createPageCanvas = () => {
    const c = document.createElement('canvas');
    c.width = pageW;
    c.height = pageH;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = settings.backgroundColor || '#FFFFFF';
    ctx.fillRect(0, 0, pageW, pageH);
    if (settings.borderEnabled) {
      ctx.strokeStyle = settings.borderColor || '#CBD5E1';
      ctx.lineWidth = 3;
      ctx.strokeRect(mLeft * 0.55, mTop * 0.55, pageW - (mLeft + mRight) * 0.55, pageH - (mTop + mBot) * 0.55);
    }
    return { c, ctx };
  };

  let current = createPageCanvas();
  pageCanvases.push(current.c);
  let cursorY = mTop;

  const ensureSpace = (neededH: number) => {
    if (cursorY + neededH > mTop + contentH) {
      current = createPageCanvas();
      pageCanvases.push(current.c);
      cursorY = mTop;
    }
  };

  for (const blk of blocks) {
    if (blk.kind === 'page-break') {
      current = createPageCanvas();
      pageCanvases.push(current.c);
      cursorY = mTop;
      continue;
    }

    if (blk.kind === 'image' && blk.imgSrc) {
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = blk.imgSrc!;
        });
        const drawW = Math.min(contentW, img.naturalWidth * 1.5);
        const drawH = (img.naturalHeight / img.naturalWidth) * drawW;
        ensureSpace(drawH + 16);
        current.ctx.drawImage(img, mLeft, cursorY, drawW, drawH);
        cursorY += drawH + 16;
      } catch {
        // skip broken inline image
      }
      continue;
    }

    if (blk.kind === 'table' && blk.rows) {
      const colCount = Math.max(...blk.rows.map((r) => r.length));
      const colW = contentW / Math.max(1, colCount);
      const rowH = 26 * pxScale;
      for (let rIdx = 0; rIdx < blk.rows.length; rIdx++) {
        ensureSpace(rowH);
        const row = blk.rows[rIdx];
        current.ctx.fillStyle = rIdx === 0 ? '#EFF6FF' : rIdx % 2 === 0 ? '#F8FAFC' : '#FFFFFF';
        current.ctx.fillRect(mLeft, cursorY, contentW, rowH);
        current.ctx.strokeStyle = '#CBD5E1';
        current.ctx.lineWidth = 1.5;
        current.ctx.strokeRect(mLeft, cursorY, contentW, rowH);

        current.ctx.font = `${rIdx === 0 ? '700 ' : '400 '}${11 * pxScale}px 'DM Sans', 'Noto Sans Bengali', sans-serif`;
        current.ctx.fillStyle = '#1E293B';
        current.ctx.textBaseline = 'middle';
        row.forEach((cellText, cIdx) => {
          current.ctx.fillText(cellText.slice(0, 42), mLeft + cIdx * colW + 10, cursorY + rowH / 2, colW - 20);
        });
        cursorY += rowH;
      }
      cursorY += 16;
      continue;
    }

    const fontSizePx = (blk.fontSize || 12.5) * pxScale;
    const lineH = fontSizePx * 1.45;
    const fontStr = `${blk.italic ? 'italic ' : ''}${blk.bold ? '700 ' : '400 '}${fontSizePx}px 'DM Sans', 'Noto Sans Bengali', sans-serif`;
    current.ctx.font = fontStr;

    const words = (blk.text || '').split(/\s+/);
    const lines: string[] = [];
    let curLine = '';
    for (const w of words) {
      const test = curLine ? `${curLine} ${w}` : w;
      if (current.ctx.measureText(test).width > contentW && curLine) {
        lines.push(curLine);
        curLine = w;
      } else {
        curLine = test;
      }
    }
    if (curLine) lines.push(curLine);

    if (blk.kind === 'heading') cursorY += 10;

    for (const line of lines) {
      ensureSpace(lineH);
      current.ctx.font = fontStr;
      current.ctx.fillStyle = blk.color || '#1E293B';
      current.ctx.textBaseline = 'top';
      let x = mLeft;
      const lw = current.ctx.measureText(line).width;
      if (blk.align === 'center') x = mLeft + (contentW - lw) / 2;
      if (blk.align === 'right') x = mLeft + contentW - lw;
      current.ctx.fillText(line, x, cursorY);
      cursorY += lineH;
    }
    cursorY += blk.kind === 'heading' ? 12 : 10;
  }

  // Draw Header, Footer & Page Numbers
  const totalPages = pageCanvases.length;
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < totalPages; i++) {
    const c = pageCanvases[i];
    const ctx = c.getContext('2d')!;
    ctx.font = `500 ${9.5 * pxScale}px 'DM Sans', 'Noto Sans Bengali', sans-serif`;
    ctx.fillStyle = '#64748B';
    ctx.textBaseline = 'middle';

    if (settings.headerText.trim()) {
      ctx.fillText(settings.headerText.trim(), mLeft, mTop * 0.5);
    }
    if (settings.footerText.trim()) {
      ctx.fillText(settings.footerText.trim(), mLeft, pageH - mBot * 0.5);
    }
    if (settings.pageNumbering) {
      const pn = `${i + 1} / ${totalPages}`;
      const pw = ctx.measureText(pn).width;
      ctx.fillText(pn, pageW - mRight - pw, pageH - mBot * 0.5);
    }

    const jpgUrl = c.toDataURL('image/jpeg', 0.92);
    const bin = atob(jpgUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    const img = await pdfDoc.embedJpg(bytes);
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    page.drawImage(img, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });
  }

  pdfDoc.setProducer('PDF MASTER Document Creator');
  const out = await pdfDoc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
