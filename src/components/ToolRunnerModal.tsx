import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Clock,
  Download,
  FolderOpen,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord, PaperSizeKey } from '../types';
import {
  PAPER_DIMENSIONS,
  addHeaderFooterToPdf,
  addPageNumbersToPdf,
  addWatermarkToPdf,
  cloneBuffer,
  compressPdfWithReport,
  encryptVaultBytes,
  extractDocumentPagesText,
  getPdfDocumentInfo,
  mergePdfs,
  renderPageThumbnail,
  renderPageToDataUrl,
  repairPdfBytes,
  resizePdfPages,
  rotateAllPages,
  splitPdfByRanges,
  unlockPasswordProtectedPdf,
  updatePdfMetadata,
} from '../services/pdfEngine';
import {
  docxFileToPdf,
  htmlDocumentToPdf,
  imagesToPdf,
  pdfToDocxBytes,
  pdfToImagesZip,
  pdfToPptxBytes,
  pdfToXlsxBytes,
  pptxFileToPdf,
  xlsxFileToPdf,
} from '../services/conversionService';
import { formatBytes, formatRelativeTime } from '../services/storageService';
import { saveBufferToDeviceStorage } from '../services/deviceFileActions';
import { PdfSourcePicker } from './PdfSourcePicker';

interface ToolRunnerModalProps {
  toolId: string;
  language: AppLanguage;
  docs: DocumentRecord[];
  preselectedDocId?: string;
  onClose: () => void;
  onSaveResultDoc: (newDoc: DocumentRecord) => Promise<void>;
  onUpdateExistingDoc: (updated: DocumentRecord) => Promise<void>;
}

const TOOL_TITLES: Record<string, { en: string; bn: string }> = {
  merge: { en: 'Merge PDFs', bn: 'পিডিএফ মার্জ' },
  split: { en: 'Split PDF', bn: 'পিডিএফ স্প্লিট' },
  compress: { en: 'Compress PDF', bn: 'পিডিএফ কমপ্রেস' },
  rotate: { en: 'Rotate PDF', bn: 'পিডিএফ ঘোরান' },
  pageSetup: { en: 'Page Size & Orientation', bn: 'পেজ সাইজ ও দিক' },
  watermark: { en: 'Add Watermark', bn: 'ওয়াটারমার্ক যোগ' },
  pageNumbers: { en: 'Add Page Numbers', bn: 'পেজ নম্বর যোগ' },
  headerFooter: { en: 'Add Header & Footer', bn: 'হেডার ও ফুটার যোগ' },
  protectVault: { en: 'Protect PDF (AES-256 Vault)', bn: 'ভল্ট পাসওয়ার্ড সুরক্ষা (AES-256)' },
  unlockPdf: { en: 'Remove PDF Password', bn: 'পাসওয়ার্ড সরান' },
  extractImages: { en: 'PDF to Images', bn: 'পিডিএফ থেকে ছবি' },
  extractText: { en: 'Extract PDF Text (.TXT)', bn: 'টেক্সট এক্সট্র্যাক্ট (.TXT)' },
  editMetadata: { en: 'Edit PDF Metadata', bn: 'মেটাডাটা সম্পাদনা' },
  repairPdf: { en: 'Repair Damaged PDF', bn: 'ক্ষতিগ্রস্ত পিডিএফ মেরামত' },
  imagesToPdf: { en: 'Images to PDF', bn: 'ছবি থেকে পিডিএফ' },
  pdfToDocx: { en: 'PDF to Word (.DOCX)', bn: 'পিডিএফ থেকে ওয়ার্ড (.DOCX)' },
  pdfToXlsx: { en: 'PDF to Excel (.XLSX)', bn: 'পিডিএফ থেকে এক্সেল (.XLSX)' },
  pdfToPptx: { en: 'PDF to PowerPoint (.PPTX)', bn: 'পিডিএফ থেকে পাওয়ারপয়েন্ট (.PPTX)' },
  wordToPdf: { en: 'Word (.DOCX) to PDF', bn: 'ওয়ার্ড থেকে পিডিএফ' },
  excelToPdf: { en: 'Excel (.XLSX) to PDF', bn: 'এক্সেল থেকে পিডিএফ' },
  pptToPdf: { en: 'PowerPoint (.PPTX) to PDF', bn: 'পাওয়ারপয়েন্ট থেকে পিডিএফ' },
};

function getToolTitle(toolId: string, lang: AppLanguage): string {
  const entry = TOOL_TITLES[toolId];
  if (!entry) return lang === 'bn' ? 'পিডিএফ টুল' : 'PDF Tool';
  return entry[lang];
}

interface MergeSourceItem {
  id: string;
  name: string;
  pageCount: number;
  sizeBytes: number;
  pdfBytes: ArrayBuffer;
  source: 'recent' | 'device';
}

export const ToolRunnerModal: React.FC<ToolRunnerModalProps> = ({
  toolId,
  language,
  docs,
  preselectedDocId,
  onClose,
  onSaveResultDoc,
  onUpdateExistingDoc,
}) => {
  const available = docs.filter((d) => !d.isTrashed && !d.isVaultLocked);
  const recentSorted = [...available].sort(
    (a, b) => (b.lastOpenedAt || b.updatedAt) - (a.lastOpenedAt || a.updatedAt)
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(
    preselectedDocId ? [preselectedDocId] : available[0] ? [available[0].id] : []
  );
  const [mergeQueue, setMergeQueue] = useState<MergeSourceItem[]>(() => {
    if (toolId === 'merge' && preselectedDocId) {
      const found = available.find((d) => d.id === preselectedDocId);
      if (found) {
        return [
          {
            id: found.id,
            name: found.name,
            pageCount: found.pageCount,
            sizeBytes: found.sizeBytes,
            pdfBytes: found.pdfBytes,
            source: 'recent',
          },
        ];
      }
    }
    return [];
  });
  const [mergeSearch, setMergeSearch] = useState('');
  const [lastMergedResult, setLastMergedResult] = useState<{
    bytes: ArrayBuffer;
    name: string;
  } | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Tool parameters
  const [splitRange, setSplitRange] = useState('1');
  const [compressMode, setCompressMode] = useState<'object-streams' | 'raster-medium' | 'raster-compact' | 'target-size'>('raster-medium');
  const [targetKb, setTargetKb] = useState(500);
  const [exportImgFormat, setExportImgFormat] = useState<'image/png' | 'image/jpeg'>('image/png');
  const [exportDpi, setExportDpi] = useState<150 | 300>(150);
  const [rotateAngle, setRotateAngle] = useState(90);
  const [targetPaperSize, setTargetPaperSize] = useState<PaperSizeKey>('A4');
  const [targetOrientation, setTargetOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [customWidthMm, setCustomWidthMm] = useState(210);
  const [customHeightMm, setCustomHeightMm] = useState(297);
  const [watermarkText, setWatermarkText] = useState('CONFIDENTIAL');
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.25);
  const [watermarkColor, setWatermarkColor] = useState('#2563EB');
  const [pageNumPos, setPageNumPos] = useState<'bottom-center' | 'bottom-right' | 'top-right'>('bottom-center');
  const [headerTxt, setHeaderTxt] = useState('');
  const [footerTxt, setFooterTxt] = useState('PDF MASTER Document');
  const [passwordInput, setPasswordInput] = useState('');
  const [metaTitle, setMetaTitle] = useState('');
  const [metaAuthor, setMetaAuthor] = useState('');
  const [metaSubject, setMetaSubject] = useState('');
  const [metaKeywords, setMetaKeywords] = useState('');
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  const primaryDoc = available.find((d) => d.id === selectedIds[0]);

  useEffect(() => {
    if (toolId === 'editMetadata' && primaryDoc) {
      getPdfDocumentInfo(primaryDoc.pdfBytes)
        .then((info) => {
          setMetaTitle(info.title || primaryDoc.name.replace(/\.pdf$/i, ''));
          setMetaAuthor(info.author || '');
          setMetaSubject(info.subject || '');
          setMetaKeywords(info.keywords || '');
        })
        .catch(() => {});
    }
  }, [toolId, primaryDoc?.id]);

  const needsExternalFile = [
    'imagesToPdf',
    'wordToPdf',
    'excelToPdf',
    'pptToPdf',
  ].includes(toolId);

  const [recentExternalDocId, setRecentExternalDocId] = useState<string>('');

  const handleImportMergePdfs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setErrorMsg(null);
    const added: MergeSourceItem[] = [];
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const info = await getPdfDocumentInfo(buf).catch(() => ({ pageCount: 1 }));
        added.push({
          id: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          pageCount: info.pageCount,
          sizeBytes: buf.byteLength,
          pdfBytes: cloneBuffer(buf),
          source: 'device',
        });
      } catch {
        setErrorMsg(`Could not read ${file.name} as a PDF.`);
      }
    }
    if (added.length > 0) {
      setMergeQueue((prev) => [...prev, ...added]);
    }
    e.target.value = '';
  };

  const toggleRecentInMerge = (d: DocumentRecord) => {
    setMergeQueue((prev) => {
      const exists = prev.some((item) => item.id === d.id);
      if (exists) {
        return prev.filter((item) => item.id !== d.id);
      }
      return [
        ...prev,
        {
          id: d.id,
          name: d.name,
          pageCount: d.pageCount,
          sizeBytes: d.sizeBytes,
          pdfBytes: d.pdfBytes,
          source: 'recent',
        },
      ];
    });
  };

  const moveMergeItem = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= mergeQueue.length) return;
    setMergeQueue((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const saveNewPdf = async (
    bytes: ArrayBuffer,
    name: string,
    origin: DocumentRecord['origin'],
    note: string
  ) => {
    const info = await getPdfDocumentInfo(bytes).catch(() => ({ pageCount: 1 }));
    const thumb = await renderPageThumbnail(bytes, 1, 200).catch(() => undefined);
    const now = Date.now();
    await onSaveResultDoc({
      id: `doc_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      origin,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      sizeBytes: bytes.byteLength,
      pageCount: info.pageCount,
      isStarred: false,
      isShared: false,
      isTrashed: false,
      folderId: null,
      thumbnailDataUrl: thumb,
      pdfBytes: cloneBuffer(bytes),
      versions: [
        {
          id: `ver_${now}`,
          timestamp: now,
          note,
          sizeBytes: bytes.byteLength,
          pdfBytes: cloneBuffer(bytes),
        },
      ],
    });
  };

  const handleRun = async () => {
    setRunning(true);
    setErrorMsg(null);
    setResultMsg(null);
    setLastMergedResult(null);
    setPreviewUrls([]);

    try {
      if (toolId === 'merge') {
        if (mergeQueue.length < 2) {
          throw new Error(
            language === 'bn'
              ? 'মার্জ করতে কমপক্ষে ২টি পিডিএফ (ডিভাইস বা রিসেন্ট ফাইল থেকে) নির্বাচন করুন।'
              : 'Add at least 2 PDFs from Device Storage or Recent Files to merge.'
          );
        }
        const buffers = mergeQueue.map((item) => item.pdfBytes);
        const merged = await mergePdfs(buffers);
        const outName = `Merged_${Date.now().toString().slice(-4)}.pdf`;
        await saveNewPdf(merged, outName, 'edited', `Merged ${buffers.length} PDFs`);
        setLastMergedResult({ bytes: merged, name: outName });
        const totalPages = mergeQueue.reduce((acc, m) => acc + m.pageCount, 0);
        setResultMsg(
          language === 'bn'
            ? `${buffers.length}টি পিডিএফ (${totalPages} পৃষ্ঠা) সফলভাবে মার্জ ও সেভ হয়েছে (${formatBytes(merged.byteLength)})।`
            : `Merged ${buffers.length} PDFs (${totalPages} pages) successfully (${formatBytes(merged.byteLength)}).`
        );
      } else if (toolId === 'split') {
        if (!primaryDoc) throw new Error('Select a PDF to split.');
        const pagesToKeep: number[] = [];
        const seen = new Set<number>();
        splitRange.split(',').forEach((part) => {
          const trimmed = part.trim();
          if (!trimmed) return;
          if (trimmed.includes('-')) {
            const [s, e] = trimmed.split('-').map((n) => parseInt(n, 10));
            if (Number.isFinite(s) && Number.isFinite(e)) {
              for (let p = Math.min(s, e); p <= Math.max(s, e); p++) {
                if (p >= 1 && p <= primaryDoc.pageCount && !seen.has(p)) {
                  seen.add(p);
                  pagesToKeep.push(p);
                }
              }
            }
          } else {
            const n = parseInt(trimmed, 10);
            if (Number.isFinite(n) && n >= 1 && n <= primaryDoc.pageCount && !seen.has(n)) {
              seen.add(n);
              pagesToKeep.push(n);
            }
          }
        });
        if (!pagesToKeep.length) {
          throw new Error(`Enter valid page numbers between 1 and ${primaryDoc.pageCount}.`);
        }
        const splitBytes = await splitPdfByRanges(primaryDoc.pdfBytes, pagesToKeep);
        await saveNewPdf(
          splitBytes,
          primaryDoc.name.replace(/\.pdf$/i, `_pages_${splitRange.replace(/\s+/g, '')}.pdf`),
          'edited',
          `Split pages: ${splitRange}`
        );
        setResultMsg(`Created split PDF with ${pagesToKeep.length} page(s).`);
      } else if (toolId === 'compress') {
        if (!primaryDoc) {
          throw new Error(language === 'bn' ? 'কমপ্রেস করতে একটি পিডিএফ বাছুন।' : 'Select a PDF to compress.');
        }
        const safeTargetKb = Math.max(40, Math.min(25000, Number(targetKb) || 500));
        const { bytes: compressed, achievedTarget } = await compressPdfWithReport(
          primaryDoc.pdfBytes,
          compressMode,
          compressMode === 'target-size' ? safeTargetKb * 1024 : undefined
        );
        await saveNewPdf(
          compressed,
          primaryDoc.name.replace(/\.pdf$/i, '_compressed.pdf'),
          'edited',
          compressMode === 'target-size' ? `Target <= ${safeTargetKb} KB` : `Compressed (${compressMode})`
        );
        const pct = Math.max(
          0,
          Math.round(((primaryDoc.sizeBytes - compressed.byteLength) / primaryDoc.sizeBytes) * 100)
        );
        if (compressMode === 'target-size' && !achievedTarget) {
          setResultMsg(
            language === 'bn'
              ? `সর্বোচ্চ কমপ্রেস করে ${formatBytes(primaryDoc.sizeBytes)} থেকে ${formatBytes(compressed.byteLength)} করা হয়েছে (টার্গেট ${safeTargetKb} KB-এর চেয়ে কিছু বড়)।`
              : `Compressed from ${formatBytes(primaryDoc.sizeBytes)} to ${formatBytes(compressed.byteLength)} (closest achievable above ${safeTargetKb} KB target).`
          );
        } else {
          setResultMsg(
            language === 'bn'
              ? `${formatBytes(primaryDoc.sizeBytes)} থেকে ${formatBytes(compressed.byteLength)} হয়েছে (${pct}% কমেছে)।`
              : `Compressed from ${formatBytes(primaryDoc.sizeBytes)} to ${formatBytes(compressed.byteLength)} (${pct}% smaller).`
          );
        }
      } else if (toolId === 'rotate') {
        if (!primaryDoc) throw new Error('Select a PDF to rotate.');
        const out = await rotateAllPages(primaryDoc.pdfBytes, rotateAngle);
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, `_rot${rotateAngle}.pdf`), 'edited', `Rotated ${rotateAngle}°`);
        setResultMsg(`Saved rotated PDF (${rotateAngle}°).`);
      } else if (toolId === 'pageSetup') {
        if (!primaryDoc) throw new Error('Select a PDF to resize.');
        const out = await resizePdfPages(
          primaryDoc.pdfBytes,
          targetPaperSize,
          targetOrientation,
          customWidthMm,
          customHeightMm
        );
        await saveNewPdf(
          out,
          primaryDoc.name.replace(/\.pdf$/i, `_${targetPaperSize}_${targetOrientation}.pdf`),
          'edited',
          `Changed page size to ${targetPaperSize} (${targetOrientation})`
        );
        setResultMsg(`Saved resized PDF (${targetPaperSize} · ${targetOrientation}).`);
      } else if (toolId === 'watermark') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await addWatermarkToPdf(primaryDoc.pdfBytes, {
          text: watermarkText,
          opacity: watermarkOpacity,
          fontSize: 46,
          color: watermarkColor,
          angle: 42,
        });
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_watermarked.pdf'), 'edited', 'Added watermark');
        setResultMsg('Watermark applied and saved as new PDF.');
      } else if (toolId === 'pageNumbers') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await addPageNumbersToPdf(primaryDoc.pdfBytes, pageNumPos, 'pageOfTotal');
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_numbered.pdf'), 'edited', 'Added page numbers');
        setResultMsg('Page numbers added.');
      } else if (toolId === 'headerFooter') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await addHeaderFooterToPdf(primaryDoc.pdfBytes, headerTxt, footerTxt);
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_headers.pdf'), 'edited', 'Added header/footer');
        setResultMsg('Header and footer applied.');
      } else if (toolId === 'protectVault') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        if (passwordInput.length < 4) throw new Error('Enter a password (min 4 characters).');
        const { encrypted, saltB64, ivB64 } = await encryptVaultBytes(
          primaryDoc.pdfBytes,
          passwordInput
        );
        await onUpdateExistingDoc({
          ...primaryDoc,
          isVaultLocked: true,
          vaultSalt: saltB64,
          vaultIv: ivB64,
          pdfBytes: encrypted,
          updatedAt: Date.now(),
        });
        setPasswordInput('');
        const nextUnlocked = available.find((d) => d.id !== primaryDoc.id);
        setSelectedIds(nextUnlocked ? [nextUnlocked.id] : []);
        setResultMsg('Document encrypted with AES-256-GCM inside your local Vault.');
      } else if (toolId === 'unlockPdf') {
        const file = uploadedFiles[0];
        const sourceBytes = file ? await file.arrayBuffer() : primaryDoc?.pdfBytes;
        const sourceName = file ? file.name : primaryDoc?.name;
        if (!sourceBytes || !sourceName) {
          throw new Error(
            language === 'bn'
              ? 'আনলক করতে ডিভাইস বা রিসেন্ট ফাইল থেকে একটি পিডিএফ বাছুন।'
              : 'Select a password-protected PDF from Device Storage or Recent Files.'
          );
        }
        const unlocked = await unlockPasswordProtectedPdf(sourceBytes, passwordInput);
        await saveNewPdf(
          unlocked,
          sourceName.replace(/\.pdf$/i, '_unlocked.pdf'),
          'edited',
          'Unlocked password PDF'
        );
        setResultMsg('Unlocked PDF saved to your Document Vault.');
      } else if (toolId === 'extractImages') {
        if (!primaryDoc) {
          throw new Error(language === 'bn' ? 'একটি পিডিএফ নির্বাচন করুন।' : 'Select a PDF.');
        }
        const renderScale = exportDpi === 300 ? 3.2 : 2;
        const { zipBuffer, previewImages } = await pdfToImagesZip(
          primaryDoc.pdfBytes,
          exportImgFormat,
          renderScale
        );
        setPreviewUrls(previewImages);
        await saveBufferToDeviceStorage(
          zipBuffer,
          primaryDoc.name.replace(/\.pdf$/i, '_pages.zip'),
          'application/zip'
        );
        const fmtLabel = exportImgFormat === 'image/jpeg' ? 'JPG' : 'PNG';
        setResultMsg(
          language === 'bn'
            ? `${previewImages.length}টি ${fmtLabel} ছবি (${exportDpi} DPI) ZIP হিসেবে এক্সপোর্ট হয়েছে।`
            : `Exported ${previewImages.length} ${fmtLabel} page image(s) at ${exportDpi} DPI as ZIP.`
        );
      } else if (toolId === 'extractText') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const pages = await extractDocumentPagesText(primaryDoc.pdfBytes);
        const totalChars = pages.reduce((sum, p) => sum + p.text.trim().length, 0);
        const fullText = pages
          .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
          .join('\n\n');
        const buf = new TextEncoder().encode(fullText).buffer;
        await saveBufferToDeviceStorage(
          buf,
          primaryDoc.name.replace(/\.pdf$/i, '.txt'),
          'text/plain;charset=utf-8'
        );
        setResultMsg(
          totalChars === 0
            ? `Exported .TXT (${pages.length} page(s)), but no selectable text was found. Use the OCR Text tool for scanned pages.`
            : `Extracted text from ${pages.length} page(s).`
        );
      } else if (toolId === 'editMetadata') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await updatePdfMetadata(primaryDoc.pdfBytes, {
          title: metaTitle,
          author: metaAuthor,
          subject: metaSubject,
          keywords: metaKeywords,
        });
        await onUpdateExistingDoc({
          ...primaryDoc,
          pdfBytes: cloneBuffer(out),
          sizeBytes: out.byteLength,
          updatedAt: Date.now(),
        });
        setResultMsg('PDF metadata updated.');
      } else if (toolId === 'repairPdf') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await repairPdfBytes(primaryDoc.pdfBytes);
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_repaired.pdf'), 'edited', 'Rebuilt PDF structure');
        setResultMsg('PDF structure & cross-reference table rebuilt cleanly.');
      } else if (toolId === 'imagesToPdf') {
        if (uploadedFiles.length > 0) {
          const pdfBytes = await imagesToPdf(uploadedFiles);
          await saveNewPdf(pdfBytes, `Images_${Date.now().toString().slice(-4)}.pdf`, 'converted', 'Converted from images');
          setResultMsg(`Converted ${uploadedFiles.length} image(s) into a PDF.`);
        } else if (recentExternalDocId) {
          const rDoc = available.find((d) => d.id === recentExternalDocId);
          if (!rDoc) throw new Error('Select images from Device Storage or a Recent file.');
          const maxP = Math.min(rDoc.pageCount, 20);
          const imgFiles: File[] = [];
          for (let p = 1; p <= maxP; p++) {
            const url = await renderPageToDataUrl(rDoc.pdfBytes, p, 1.5, 'image/jpeg');
            const blob = await fetch(url).then((r) => r.blob());
            imgFiles.push(new File([blob], `page_${p}.jpg`, { type: 'image/jpeg' }));
          }
          const pdfBytes = await imagesToPdf(imgFiles);
          await saveNewPdf(
            pdfBytes,
            rDoc.name.replace(/\.pdf$/i, '_images.pdf'),
            'converted',
            `Converted ${imgFiles.length} pages to image PDF`
          );
          setResultMsg(`Created PDF from ${imgFiles.length} page image(s) of ${rDoc.name}.`);
        } else {
          throw new Error('Select image(s) from Device Storage or choose a Recent file.');
        }
      } else if (toolId === 'pdfToDocx') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const { buffer: docxBuf, extractedChars } = await pdfToDocxBytes(
          primaryDoc.pdfBytes,
          primaryDoc.name
        );
        await saveBufferToDeviceStorage(
          docxBuf,
          primaryDoc.name.replace(/\.pdf$/i, '.docx'),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        setResultMsg(
          extractedChars === 0
            ? 'Converted Word (.DOCX) file saved, but no embedded text was found (use OCR Text for scanned PDFs).'
            : 'Converted and saved Word (.DOCX) file.'
        );
      } else if (toolId === 'pdfToXlsx') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const { buffer: xlsxBuf, extractedChars } = await pdfToXlsxBytes(primaryDoc.pdfBytes);
        await saveBufferToDeviceStorage(
          xlsxBuf,
          primaryDoc.name.replace(/\.pdf$/i, '.xlsx'),
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        setResultMsg(
          extractedChars === 0
            ? 'Excel (.XLSX) workbook saved, but no embedded text was found (use OCR Text for scanned PDFs).'
            : 'Extracted tabular data to Excel (.XLSX) workbook.'
        );
      } else if (toolId === 'pdfToPptx') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const pptxBuf = await pdfToPptxBytes(primaryDoc.pdfBytes);
        await saveBufferToDeviceStorage(
          pptxBuf,
          primaryDoc.name.replace(/\.pdf$/i, '.pptx'),
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        );
        setResultMsg('Converted PDF pages into PowerPoint (.PPTX) presentation.');
      } else if (toolId === 'wordToPdf') {
        const file = uploadedFiles[0];
        if (!file && recentExternalDocId) {
          const rDoc = available.find((d) => d.id === recentExternalDocId);
          if (!rDoc) throw new Error('Select a .DOCX, .XLSX, or .PPTX file.');
          const escapeHtml = (s: string) =>
            s
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          let htmlToRender = rDoc.editableHtml;
          if (!htmlToRender) {
            const pages = await extractDocumentPagesText(rDoc.pdfBytes);
            const blocks = pages
              .map((pg) =>
                pg.text
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .map((l) => `<p>${escapeHtml(l)}</p>`)
                  .join('')
              )
              .filter(Boolean)
              .join('<hr class="pdf-page-break"/>');
            if (!blocks) {
              throw new Error(
                'Selected file has no editable Word HTML or selectable text layer. Use OCR Text first or pick a .DOCX file.'
              );
            }
            htmlToRender = blocks;
          }
          const outBytes = await htmlDocumentToPdf(
            htmlToRender,
            rDoc.wordSettings || {
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
              headerText: '',
              footerText: '',
              pageNumbering: true,
            }
          );
          await saveNewPdf(
            outBytes,
            rDoc.name.replace(/\.pdf$/i, '_converted.pdf'),
            'converted',
            'Converted from Recent Document'
          );
          setResultMsg(`Converted ${rDoc.name} to PDF and saved to Vault.`);
        } else {
          if (!file) throw new Error('Select a .DOCX, .XLSX, or .PPTX file.');
          if (/\.(xlsx?|csv)$/i.test(file.name)) {
            const pdfBytes = await xlsxFileToPdf(file);
            await saveNewPdf(pdfBytes, file.name.replace(/\.(xlsx?|csv)$/i, '.pdf'), 'converted', 'Converted from Excel');
            setResultMsg('Converted Excel spreadsheet to PDF and saved to Vault.');
          } else if (/\.pptx?$/i.test(file.name)) {
            const pdfBytes = await pptxFileToPdf(file);
            await saveNewPdf(pdfBytes, file.name.replace(/\.pptx?$/i, '.pdf'), 'converted', 'Converted from PowerPoint');
            setResultMsg('Converted PowerPoint presentation to PDF and saved to Vault.');
          } else {
            const { pdfBytes, html } = await docxFileToPdf(file);
            const thumb = await renderPageThumbnail(pdfBytes, 1, 200).catch(() => undefined);
            const info = await getPdfDocumentInfo(pdfBytes).catch(() => ({ pageCount: 1 }));
            const now = Date.now();
            await onSaveResultDoc({
              id: `doc_${now}`,
              name: file.name.replace(/\.docx?$/i, '.pdf'),
              origin: 'converted',
              createdAt: now,
              updatedAt: now,
              lastOpenedAt: now,
              sizeBytes: pdfBytes.byteLength,
              pageCount: info.pageCount,
              isStarred: false,
              isShared: false,
              isTrashed: false,
              folderId: null,
              thumbnailDataUrl: thumb,
              pdfBytes: cloneBuffer(pdfBytes),
              editableHtml: html,
              versions: [
                {
                  id: `ver_${now}`,
                  timestamp: now,
                  note: 'Converted from Word (.docx)',
                  sizeBytes: pdfBytes.byteLength,
                  pdfBytes: cloneBuffer(pdfBytes),
                },
              ],
            });
            setResultMsg('Converted Word document to PDF and saved to Vault.');
          }
        }
      } else if (toolId === 'excelToPdf') {
        const file = uploadedFiles[0];
        if (!file) throw new Error('Select an .XLSX or .CSV file.');
        const pdfBytes = await xlsxFileToPdf(file);
        await saveNewPdf(pdfBytes, file.name.replace(/\.(xlsx?|csv)$/i, '.pdf'), 'converted', 'Converted from Excel');
        setResultMsg('Converted Excel spreadsheet to PDF.');
      } else if (toolId === 'pptToPdf') {
        const file = uploadedFiles[0];
        if (!file) throw new Error('Select a .PPTX file.');
        const pdfBytes = await pptxFileToPdf(file);
        await saveNewPdf(pdfBytes, file.name.replace(/\.pptx?$/i, '.pdf'), 'converted', 'Converted from PowerPoint');
        setResultMsg('Converted PowerPoint presentation to PDF.');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Operation failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120]">
      <header className="flex items-center gap-2 px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <button
          onClick={onClose}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="font-display text-sm font-bold text-[#142B4A] dark:text-white">
          {getToolTitle(toolId, language)}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-2xl w-full mx-auto space-y-4">
        {/* Input Selection */}
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          {needsExternalFile ? (
            <div className="space-y-3">
              <label className="flex flex-col items-center justify-center gap-2 p-5 rounded-2xl border-2 border-dashed border-[#2563EB]/45 bg-[#2563EB]/5 hover:bg-[#2563EB]/10 cursor-pointer transition-colors">
                <FolderOpen className="w-6 h-6 text-[#2563EB]" />
                <span className="text-sm font-bold text-[#142B4A] dark:text-white">
                  {uploadedFiles.length > 0
                    ? `${uploadedFiles.length} file(s) selected from Device`
                    : language === 'bn'
                    ? 'ডিভাইস স্টোরেজ থেকে ফাইল ইমপোর্ট করুন'
                    : 'Import from Device Storage'}
                </span>
                <span className="text-xs text-slate-500">
                  {toolId === 'imagesToPdf'
                    ? 'PNG, JPG, WEBP'
                    : toolId === 'wordToPdf'
                    ? '.DOCX, .XLSX, .XLS, .CSV, .PPTX'
                    : toolId === 'excelToPdf'
                    ? '.XLSX, .XLS, .CSV'
                    : '.PPTX'}
                </span>
                <input
                  type="file"
                  multiple={toolId === 'imagesToPdf'}
                  accept={
                    toolId === 'imagesToPdf'
                      ? 'image/*'
                      : toolId === 'wordToPdf'
                      ? '.docx,.xlsx,.xls,.csv,.pptx'
                      : toolId === 'excelToPdf'
                      ? '.xlsx,.xls,.csv'
                      : '.pptx'
                  }
                  onChange={(e) => {
                    const picked = Array.from(e.target.files || []);
                    if (picked.length > 0) {
                      setUploadedFiles((prev) =>
                        toolId === 'imagesToPdf' ? [...prev, ...picked] : picked
                      );
                      setRecentExternalDocId('');
                    }
                    e.target.value = '';
                  }}
                  className="hidden"
                />
              </label>

              {uploadedFiles.length > 0 && (
                <div className="space-y-1.5 max-h-36 overflow-y-auto">
                  {uploadedFiles.map((f, idx) => (
                    <div
                      key={`${f.name}_${idx}`}
                      className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate font-medium">
                        {idx + 1}. {f.name} ({formatBytes(f.size)})
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="p-1 rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Recent Files option for external tools */}
              {recentSorted.length > 0 && (
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-[#06B6D4]" />
                    {language === 'bn'
                      ? 'অথবা রিসেন্ট ফাইল থেকে বাছুন'
                      : 'Or pick from Recent Files'}
                  </span>
                  <div className="max-h-36 overflow-y-auto space-y-1.5">
                    {recentSorted.slice(0, 8).map((d) => {
                        const active = recentExternalDocId === d.id && uploadedFiles.length === 0;
                        return (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => {
                              setUploadedFiles([]);
                              setRecentExternalDocId(active ? '' : d.id);
                            }}
                            className={`w-full px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                              active
                                ? 'border-[#2563EB] bg-[#2563EB]/10 text-[#142B4A] dark:text-white'
                                : 'border-slate-200 dark:border-slate-700 hover:border-[#2563EB]/40'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="font-semibold truncate">{d.name}</p>
                              <p className="text-[10.5px] font-mono-nums text-slate-500">
                                {d.pageCount}p · {formatBytes(d.sizeBytes)} ·{' '}
                                {formatRelativeTime(d.lastOpenedAt || d.updatedAt, language)}
                              </p>
                            </div>
                            {active && <Check className="w-4 h-4 text-[#2563EB] shrink-0" />}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          ) : toolId === 'merge' ? (
            <div className="space-y-4">
              {/* 1. Import from Device Storage */}
              <label className="flex items-center justify-center gap-2.5 p-4 rounded-2xl border-2 border-dashed border-[#2563EB]/50 bg-[#2563EB]/5 hover:bg-[#2563EB]/10 cursor-pointer transition-colors">
                <FolderOpen className="w-5 h-5 text-[#2563EB] shrink-0" />
                <div className="text-left">
                  <p className="text-sm font-bold text-[#142B4A] dark:text-white">
                    {language === 'bn'
                      ? 'ডিভাইস স্টোরেজ থেকে পিডিএফ ইমপোর্ট করুন'
                      : 'Import PDFs from Device Storage'}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {language === 'bn'
                      ? 'ফোন বা কম্পিউটার থেকে এক বা একাধিক .PDF ফাইল যোগ করুন'
                      : 'Pick one or multiple .PDF files from your phone or computer'}
                  </p>
                </div>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  onChange={handleImportMergePdfs}
                  className="hidden"
                />
              </label>

              {/* 2. Ordered Merge Queue */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-[#142B4A] dark:text-slate-200">
                    {language === 'bn'
                      ? `মার্জ কিউ (${mergeQueue.length}টি ফাইল নির্বাচিত)`
                      : `Merge Order (${mergeQueue.length} selected)`}
                  </span>
                  {mergeQueue.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setMergeQueue([])}
                      className="text-[11px] font-semibold text-rose-500 hover:underline"
                    >
                      {language === 'bn' ? 'সব মুছুন' : 'Clear all'}
                    </button>
                  )}
                </div>

                {mergeQueue.length === 0 ? (
                  <p className="text-xs text-slate-400 py-3 px-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-center">
                    {language === 'bn'
                      ? 'উপরে ডিভাইস স্টোরেজ বা নিচের রিসেন্ট ফাইল থেকে ২ বা তার বেশি পিডিএফ যোগ করুন।'
                      : 'Add 2 or more PDFs from Device Storage above or Recent Files below.'}
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {mergeQueue.map((item, idx) => (
                      <div
                        key={item.id}
                        className="min-h-[46px] px-3 py-1.5 rounded-xl border border-[#2563EB]/40 bg-[#2563EB]/5 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-5 h-5 rounded-full bg-[#2563EB] text-white text-[10px] font-mono-nums font-bold flex items-center justify-center shrink-0">
                            {idx + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-[#142B4A] dark:text-white truncate">
                              {item.name}
                            </p>
                            <p className="text-[10.5px] font-mono-nums text-slate-500">
                              {item.pageCount}p · {formatBytes(item.sizeBytes)} ·{' '}
                              {item.source === 'device' ? 'Device' : 'Recent'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => moveMergeItem(idx, -1)}
                            aria-label="Move up"
                            className="p-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 disabled:opacity-30"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === mergeQueue.length - 1}
                            onClick={() => moveMergeItem(idx, 1)}
                            aria-label="Move down"
                            className="p-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 disabled:opacity-30"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setMergeQueue((prev) => prev.filter((x) => x.id !== item.id))
                            }
                            aria-label="Remove from merge"
                            className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. Recent Files Section */}
              <div className="space-y-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-[#06B6D4]" />
                    {language === 'bn' ? 'রিসেন্ট ফাইলস' : 'Recent Files'}
                  </span>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 flex-1 max-w-[200px]">
                    <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <input
                      type="text"
                      value={mergeSearch}
                      onChange={(e) => setMergeSearch(e.target.value)}
                      placeholder={language === 'bn' ? 'খুঁজুন...' : 'Filter recent...'}
                      className="w-full bg-transparent text-xs focus:outline-none"
                    />
                  </div>
                </div>

                <div className="max-h-52 overflow-y-auto space-y-1.5">
                  {recentSorted
                    .filter((d) =>
                      mergeSearch.trim()
                        ? d.name.toLowerCase().includes(mergeSearch.toLowerCase())
                        : true
                    )
                    .map((d) => {
                      const inQueue = mergeQueue.some((item) => item.id === d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => toggleRecentInMerge(d)}
                          className={`w-full min-h-[46px] px-3 py-1.5 rounded-xl border text-left flex items-center justify-between gap-2 text-xs font-medium transition-colors ${
                            inQueue
                              ? 'border-[#2563EB] bg-[#2563EB]/10 text-[#142B4A] dark:text-white'
                              : 'border-slate-200 dark:border-slate-700 hover:border-[#2563EB]/40'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{d.name}</p>
                            <p className="text-[10.5px] font-mono-nums text-slate-500">
                              {d.pageCount}p · {formatBytes(d.sizeBytes)} ·{' '}
                              {formatRelativeTime(d.lastOpenedAt || d.updatedAt)}
                            </p>
                          </div>
                          <span
                            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 shrink-0 ${
                              inQueue
                                ? 'bg-[#2563EB] text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {inQueue ? (
                              <>
                                <Check className="w-3 h-3" /> {language === 'bn' ? 'যোগ হয়েছে' : 'Added'}
                              </>
                            ) : (
                              <>
                                <Plus className="w-3 h-3" /> {language === 'bn' ? 'যোগ' : 'Add'}
                              </>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  {recentSorted.length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-3">
                      {language === 'bn'
                        ? 'কোনো রিসেন্ট ফাইল নেই। ডিভাইস স্টোরেজ থেকে ইমপোর্ট করুন।'
                        : 'No recent files found. Import PDFs from device storage above.'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : toolId === 'unlockPdf' ? (
            <div className="space-y-2.5">
              {uploadedFiles[0] && (
                <div className="px-3 py-2 rounded-xl bg-[#2563EB]/10 border border-[#2563EB]/40 text-xs flex items-center justify-between gap-2">
                  <span className="font-semibold truncate">
                    {uploadedFiles[0].name} ({formatBytes(uploadedFiles[0].size)})
                  </span>
                  <button
                    type="button"
                    onClick={() => setUploadedFiles([])}
                    className="p-1 text-rose-500"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <PdfSourcePicker
                language={language}
                docs={docs}
                selectedDocId={uploadedFiles[0] ? '' : selectedIds[0]}
                rawFileLabel={
                  language === 'bn'
                    ? 'ডিভাইস স্টোরেজ থেকে পাসওয়ার্ডযুক্ত পিডিএফ বাছুন'
                    : 'Import Password-Protected PDF from Device Storage'
                }
                onRawPdfFile={(file) => {
                  setUploadedFiles([file]);
                  setSelectedIds([]);
                }}
                onSelectDoc={(d) => {
                  setUploadedFiles([]);
                  setSelectedIds([d.id]);
                }}
              />
            </div>
          ) : (
            <PdfSourcePicker
              language={language}
              docs={docs}
              selectedDocId={selectedIds[0]}
              label={language === 'bn' ? 'ডকুমেন্ট নির্বাচন করুন' : 'Select Document'}
              onImportDoc={onSaveResultDoc}
              onSelectDoc={(d) => setSelectedIds([d.id])}
            />
          )}

          {/* Tool-specific controls */}
          {toolId === 'split' && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                {language === 'bn'
                  ? `আলাদা করার পৃষ্ঠা নম্বর (যেমন 1-2, 4${primaryDoc ? ` · সর্বোচ্চ ${primaryDoc.pageCount}` : ''})`
                  : `Pages to Extract (e.g. 1-2, 4${primaryDoc ? ` · max ${primaryDoc.pageCount}` : ''})`}
              </label>
              <input
                type="text"
                value={splitRange}
                onChange={(e) => setSplitRange(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono-nums"
              />
            </div>
          )}

          {toolId === 'compress' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {(
                  [
                    { id: 'object-streams', label: language === 'bn' ? 'লসলেস' : 'Lossless' },
                    { id: 'raster-medium', label: language === 'bn' ? 'ব্যালান্সড' : 'Balanced' },
                    { id: 'raster-compact', label: language === 'bn' ? 'সর্বোচ্চ' : 'Maximum' },
                    { id: 'target-size', label: language === 'bn' ? 'টার্গেট সাইজ' : 'Target Size' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setCompressMode(m.id)}
                    className={`min-h-[42px] px-2 rounded-xl text-xs font-semibold border ${
                      compressMode === m.id
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {compressMode === 'target-size' && (
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 space-y-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[100, 200, 500, 1024].map((kb) => (
                      <button
                        key={kb}
                        type="button"
                        onClick={() => setTargetKb(kb)}
                        className={`px-2.5 py-1.5 rounded-lg font-mono-nums font-semibold border ${
                          targetKb === kb
                            ? 'bg-[#2563EB] text-white border-[#2563EB]'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        {kb >= 1024 ? '1 MB' : `${kb} KB`}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">
                      {language === 'bn' ? 'টার্গেট সাইজ (KB):' : 'Target Max Size (KB):'}
                    </span>
                    <input
                      type="number"
                      min={40}
                      max={25000}
                      value={targetKb}
                      onChange={(e) => setTargetKb(Number(e.target.value) || 200)}
                      className="w-28 min-h-[38px] px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono-nums text-right"
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {toolId === 'extractImages' && (
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div>
                <label className="block font-semibold text-slate-500 mb-1">
                  {language === 'bn' ? 'ছবির ফরম্যাট' : 'Image Format'}
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      { id: 'image/png', label: 'PNG' },
                      { id: 'image/jpeg', label: 'JPG' },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setExportImgFormat(f.id)}
                      className={`min-h-[40px] rounded-xl font-bold border ${
                        exportImgFormat === f.id
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-500 mb-1">
                  {language === 'bn' ? 'রেজোলিউশন (DPI)' : 'Resolution (DPI)'}
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  {([150, 300] as const).map((dpi) => (
                    <button
                      key={dpi}
                      type="button"
                      onClick={() => setExportDpi(dpi)}
                      className={`min-h-[40px] rounded-xl font-mono-nums font-bold border ${
                        exportDpi === dpi
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {dpi} DPI
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {toolId === 'rotate' && (
            <div className="grid grid-cols-3 gap-1.5">
              {[90, 180, 270].map((deg) => (
                <button
                  key={deg}
                  onClick={() => setRotateAngle(deg)}
                  className={`min-h-[42px] rounded-xl text-xs font-semibold border font-mono-nums ${
                    rotateAngle === deg
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {deg}°
                </button>
              ))}
            </div>
          )}

          {toolId === 'pageSetup' && (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-500 mb-1">Paper Size</label>
                <select
                  value={targetPaperSize}
                  onChange={(e) => setTargetPaperSize(e.target.value as PaperSizeKey)}
                  className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
                >
                  {Object.values(PAPER_DIMENSIONS).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {targetPaperSize === 'Custom' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-semibold text-slate-500 mb-1">Width (mm)</label>
                    <input
                      type="number"
                      min={40}
                      value={customWidthMm}
                      onChange={(e) => setCustomWidthMm(Number(e.target.value) || 210)}
                      className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-500 mb-1">Height (mm)</label>
                    <input
                      type="number"
                      min={40}
                      value={customHeightMm}
                      onChange={(e) => setCustomHeightMm(Number(e.target.value) || 297)}
                      className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                    />
                  </div>
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-500 mb-1">Orientation</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['portrait', 'landscape'] as const).map((ori) => (
                    <button
                      key={ori}
                      type="button"
                      onClick={() => setTargetOrientation(ori)}
                      className={`min-h-[42px] rounded-xl font-semibold capitalize border ${
                        targetOrientation === ori
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {ori}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {toolId === 'watermark' && (
            <div className="space-y-2.5 text-xs">
              <input
                type="text"
                value={watermarkText}
                onChange={(e) => setWatermarkText(e.target.value)}
                placeholder="Watermark text (English or বাংলা)"
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <div className="flex items-center justify-between gap-3">
                <label className="flex-1">
                  Opacity ({Math.round(watermarkOpacity * 100)}%)
                  <input
                    type="range"
                    min={0.1}
                    max={0.7}
                    step={0.05}
                    value={watermarkOpacity}
                    onChange={(e) => setWatermarkOpacity(Number(e.target.value))}
                    className="w-full accent-[#2563EB]"
                  />
                </label>
                <input
                  type="color"
                  value={watermarkColor}
                  onChange={(e) => setWatermarkColor(e.target.value)}
                  className="w-10 h-10 rounded-xl"
                />
              </div>
            </div>
          )}

          {toolId === 'pageNumbers' && (
            <select
              value={pageNumPos}
              onChange={(e) =>
                setPageNumPos(e.target.value as 'bottom-center' | 'bottom-right' | 'top-right')
              }
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            >
              <option value="bottom-center">Bottom Center</option>
              <option value="bottom-right">Bottom Right</option>
              <option value="top-right">Top Right</option>
            </select>
          )}

          {toolId === 'headerFooter' && (
            <div className="space-y-2">
              <input
                type="text"
                value={headerTxt}
                onChange={(e) => setHeaderTxt(e.target.value)}
                placeholder="Header text"
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={footerTxt}
                onChange={(e) => setFooterTxt(e.target.value)}
                placeholder="Footer text"
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
            </div>
          )}

          {(toolId === 'protectVault' || toolId === 'unlockPdf') && (
            <div className="space-y-2">
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={
                  toolId === 'protectVault'
                    ? 'Enter Vault encryption password...'
                    : 'Enter current PDF password...'
                }
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              {toolId === 'protectVault' && (
                <p className="text-[11px] text-slate-500 flex items-start gap-1.5 leading-relaxed">
                  <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#2563EB]" />
                  <span>
                    {language === 'bn'
                      ? 'এটি PDF MASTER-এর নিজস্ব লোকাল AES-256-GCM ভল্ট এনক্রিপশন (PBKDF2)। বাইরের রিডারে শেয়ার বা খোলার আগে ফাইলস ট্যাব থেকে ডিক্রিপ্ট করুন।'
                      : 'Locks the document inside PDF MASTER local Vault using Web Crypto AES-256-GCM (PBKDF2). Unlock it from Files before sharing to external PDF readers.'}
                  </span>
                </p>
              )}
              {toolId === 'unlockPdf' && (
                <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
                  <Unlock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#2563EB]" />
                  <span>
                    {language === 'bn'
                      ? 'শুধুমাত্র আপনার বৈধ অ্যাক্সেস থাকা ডকুমেন্টই আনলক করুন।'
                      : 'Only unlock documents you are legally authorized to access.'}
                  </span>
                </p>
              )}
            </div>
          )}

          {toolId === 'editMetadata' && (
            <div className="space-y-2">
              <input
                type="text"
                value={metaTitle}
                onChange={(e) => setMetaTitle(e.target.value)}
                placeholder={language === 'bn' ? 'ডকুমেন্ট শিরোনাম' : 'Document Title'}
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={metaAuthor}
                onChange={(e) => setMetaAuthor(e.target.value)}
                placeholder={language === 'bn' ? 'লেখক' : 'Author'}
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={metaSubject}
                onChange={(e) => setMetaSubject(e.target.value)}
                placeholder={language === 'bn' ? 'বিষয়' : 'Subject'}
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={metaKeywords}
                onChange={(e) => setMetaKeywords(e.target.value)}
                placeholder={language === 'bn' ? 'কীওয়ার্ড (কমা দিয়ে)' : 'Keywords (comma separated)'}
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
            </div>
          )}

          <button
            onClick={handleRun}
            disabled={running}
            className="w-full min-h-[48px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>
              {running
                ? language === 'bn'
                  ? 'কাজ চলছে...'
                  : 'Processing...'
                : `${language === 'bn' ? 'চালান:' : 'Run'} ${getToolTitle(toolId, language)}`}
            </span>
          </button>

          {resultMsg && (
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>{resultMsg}</span>
              </div>
              {lastMergedResult && (
                <button
                  type="button"
                  onClick={() =>
                    void saveBufferToDeviceStorage(
                      lastMergedResult.bytes,
                      lastMergedResult.name,
                      'application/pdf'
                    )
                  }
                  className="w-full min-h-[40px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex items-center justify-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {language === 'bn' ? 'মার্জ করা পিডিএফ ডাউনলোড করুন' : 'Download Merged PDF'}
                  </span>
                </button>
              )}
            </div>
          )}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-200">
              {errorMsg}
            </div>
          )}
        </div>

        {previewUrls.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {previewUrls.map((url, idx) => (
              <div key={idx} className="rounded-xl bg-white dark:bg-slate-900 p-2 border border-slate-200 dark:border-slate-800">
                <img src={url} alt={`Page ${idx + 1}`} className="w-full rounded-lg" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
