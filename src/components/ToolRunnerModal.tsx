import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Clock,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FolderOpen,
  Lock,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord, PaperSizeKey } from '../types';
import {
  PAPER_DIMENSIONS,
  type PageNumberPosition,
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
  type ImageToPdfFitMode,
  docxFileToPdf,
  htmlDocumentToPdf,
  imagesToPdf,
  pdfToDocxBytes,
  pdfToImagesZip,
  pdfToPptxBytes,
  pdfToXlsxBytes,
  pptxFileToPdf,
  splitPdfPagesAsZip,
  xlsxFileToPdf,
} from '../services/conversionService';
import { formatBytes, formatRelativeTime } from '../services/storageService';
import { saveBufferToDeviceStorage, shareBufferNativeOrWeb } from '../services/deviceFileActions';
import { PdfSourcePicker } from './PdfSourcePicker';

interface ToolRunnerModalProps {
  toolId: string;
  language: AppLanguage;
  docs: DocumentRecord[];
  preselectedDocId?: string;
  onClose: () => void;
  onSaveResultDoc: (newDoc: DocumentRecord) => Promise<void>;
  onUpdateExistingDoc: (updated: DocumentRecord) => Promise<void>;
  onOpenResultDoc?: (doc: DocumentRecord, target: 'viewer' | 'editor') => void;
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

function parsePageRanges(input: string, maxPages: number): number[] {
  const pages: number[] = [];
  const seen = new Set<number>();
  input.split(',').forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    if (trimmed.includes('-')) {
      const [s, e] = trimmed.split('-').map((n) => parseInt(n, 10));
      if (Number.isFinite(s) && Number.isFinite(e)) {
        const step = s <= e ? 1 : -1;
        for (let p = s; step > 0 ? p <= e : p >= e; p += step) {
          if (p >= 1 && p <= maxPages && !seen.has(p)) {
            seen.add(p);
            pages.push(p);
          }
        }
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n) && n >= 1 && n <= maxPages && !seen.has(n)) {
        seen.add(n);
        pages.push(n);
      }
    }
  });
  return pages;
}

function formatPagesListAsRange(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(', ');
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export const ToolRunnerModal: React.FC<ToolRunnerModalProps> = ({
  toolId,
  language,
  docs,
  preselectedDocId,
  onClose,
  onSaveResultDoc,
  onUpdateExistingDoc,
  onOpenResultDoc,
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
  const [resultDoc, setResultDoc] = useState<DocumentRecord | null>(null);
  const [resultZip, setResultZip] = useState<{ bytes: ArrayBuffer; name: string } | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Tool parameters
  const [splitRange, setSplitRange] = useState('1');
  const [splitMode, setSplitMode] = useState<'custom' | 'odd' | 'even' | 'each-zip'>('custom');
  const [compressMode, setCompressMode] = useState<'object-streams' | 'raster-medium' | 'raster-compact' | 'target-size'>('raster-medium');
  const [targetKb, setTargetKb] = useState(500);
  const [exportImgFormat, setExportImgFormat] = useState<'image/png' | 'image/jpeg'>('image/png');
  const [exportDpi, setExportDpi] = useState<150 | 300>(150);
  const [rotateAngle, setRotateAngle] = useState(90);
  const [rotateScope, setRotateScope] = useState<'all' | 'specific'>('all');
  const [rotatePagesInput, setRotatePagesInput] = useState('1');
  const [targetPaperSize, setTargetPaperSize] = useState<PaperSizeKey>('A4');
  const [targetOrientation, setTargetOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [customWidthMm, setCustomWidthMm] = useState(210);
  const [customHeightMm, setCustomHeightMm] = useState(297);
  const [watermarkText, setWatermarkText] = useState('CONFIDENTIAL');
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.25);
  const [watermarkColor, setWatermarkColor] = useState('#2563EB');
  const [watermarkFontSize, setWatermarkFontSize] = useState(46);
  const [watermarkAngle, setWatermarkAngle] = useState(45);
  const [pageNumPos, setPageNumPos] = useState<PageNumberPosition>('bottom-center');
  const [pageNumFormat, setPageNumFormat] = useState<'pageOfTotal' | 'slash' | 'number'>('pageOfTotal');
  const [pageNumStart, setPageNumStart] = useState(1);
  const [pageNumFontSize, setPageNumFontSize] = useState(10);
  const [pageNumSkipFirst, setPageNumSkipFirst] = useState(false);
  const [headerTxt, setHeaderTxt] = useState('');
  const [footerTxt, setFooterTxt] = useState('PDF MASTER Document');
  const [headerFooterAlign, setHeaderFooterAlign] = useState<'left' | 'center' | 'right'>('left');
  const [headerFooterFontSize, setHeaderFooterFontSize] = useState(9.5);
  const [headerFooterColor, setHeaderFooterColor] = useState('#475569');
  const [imageFitMode, setImageFitMode] = useState<ImageToPdfFitMode>('a4-fit');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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

  const moveUploadedFile = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= uploadedFiles.length) return;
    setUploadedFiles((prev) => {
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
  ): Promise<DocumentRecord> => {
    const info = await getPdfDocumentInfo(bytes).catch(() => ({ pageCount: 1 }));
    const thumb = await renderPageThumbnail(bytes, 1, 200).catch(() => undefined);
    const now = Date.now();
    const record: DocumentRecord = {
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
    };
    await onSaveResultDoc(record);
    setResultDoc(record);
    return record;
  };

  const handleRun = async () => {
    setRunning(true);
    setErrorMsg(null);
    setResultMsg(null);
    setResultDoc(null);
    setResultZip(null);
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
        const totalPages = mergeQueue.reduce((acc, m) => acc + m.pageCount, 0);
        setResultMsg(
          language === 'bn'
            ? `${buffers.length}টি পিডিএফ (${totalPages} পৃষ্ঠা) সফলভাবে মার্জ ও সেভ হয়েছে (${formatBytes(merged.byteLength)})।`
            : `Merged ${buffers.length} PDFs (${totalPages} pages) successfully (${formatBytes(merged.byteLength)}).`
        );
      } else if (toolId === 'split') {
        if (!primaryDoc) {
          throw new Error(language === 'bn' ? 'স্প্লিট করতে একটি পিডিএফ বাছুন।' : 'Select a PDF to split.');
        }
        if (splitMode === 'each-zip') {
          const allPages = Array.from({ length: primaryDoc.pageCount }, (_, i) => i + 1);
          const zipBytes = await splitPdfPagesAsZip(primaryDoc.pdfBytes, allPages, primaryDoc.name);
          const zipName = primaryDoc.name.replace(/\.pdf$/i, '_split_pages.zip');
          await saveBufferToDeviceStorage(zipBytes, zipName, 'application/zip');
          setResultZip({ bytes: zipBytes, name: zipName });
          setResultMsg(
            language === 'bn'
              ? `${primaryDoc.pageCount}টি আলাদা পিডিএফ পৃষ্ঠা ZIP হিসেবে তৈরি ও সেভ হয়েছে।`
              : `Split all ${primaryDoc.pageCount} page(s) into individual PDFs inside ${zipName}.`
          );
        } else {
          const pagesToKeep =
            splitMode === 'odd'
              ? Array.from({ length: primaryDoc.pageCount }, (_, i) => i + 1).filter((p) => p % 2 === 1)
              : splitMode === 'even'
              ? Array.from({ length: primaryDoc.pageCount }, (_, i) => i + 1).filter((p) => p % 2 === 0)
              : parsePageRanges(splitRange, primaryDoc.pageCount);
          if (!pagesToKeep.length) {
            throw new Error(
              language === 'bn'
                ? `1 থেকে ${primaryDoc.pageCount} এর মধ্যে সঠিক পৃষ্ঠা নম্বর লিখুন।`
                : `Enter valid page numbers between 1 and ${primaryDoc.pageCount}.`
            );
          }
          const splitBytes = await splitPdfByRanges(primaryDoc.pdfBytes, pagesToKeep);
          const suffix =
            splitMode === 'odd'
              ? '_odd_pages.pdf'
              : splitMode === 'even'
              ? '_even_pages.pdf'
              : `_pages_${splitRange.replace(/\s+/g, '')}.pdf`;
          await saveNewPdf(
            splitBytes,
            primaryDoc.name.replace(/\.pdf$/i, suffix),
            'edited',
            `Split ${pagesToKeep.length} page(s)`
          );
          setResultMsg(
            language === 'bn'
              ? `${pagesToKeep.length}টি পৃষ্ঠা আলাদা করে নতুন পিডিএফ সেভ হয়েছে।`
              : `Created split PDF with ${pagesToKeep.length} page(s).`
          );
        }
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
        if (!primaryDoc) {
          throw new Error(language === 'bn' ? 'ঘোরাতে একটি পিডিএফ বাছুন।' : 'Select a PDF to rotate.');
        }
        const targetPages =
          rotateScope === 'specific'
            ? parsePageRanges(rotatePagesInput, primaryDoc.pageCount)
            : undefined;
        if (rotateScope === 'specific' && (!targetPages || targetPages.length === 0)) {
          throw new Error(
            language === 'bn'
              ? `1 থেকে ${primaryDoc.pageCount} এর মধ্যে সঠিক পৃষ্ঠা নম্বর লিখুন।`
              : `Enter valid page numbers between 1 and ${primaryDoc.pageCount}.`
          );
        }
        const out = await rotateAllPages(primaryDoc.pdfBytes, rotateAngle, targetPages);
        await saveNewPdf(
          out,
          primaryDoc.name.replace(/\.pdf$/i, `_rot${rotateAngle}.pdf`),
          'edited',
          targetPages
            ? `Rotated ${targetPages.length} page(s) by ${rotateAngle}°`
            : `Rotated all pages ${rotateAngle}°`
        );
        setResultMsg(
          language === 'bn'
            ? `${targetPages ? `${targetPages.length}টি পৃষ্ঠা` : 'সব পৃষ্ঠা'} ${rotateAngle}° ঘোরানো ও সেভ হয়েছে।`
            : `Saved rotated PDF (${rotateAngle}°${targetPages ? `, ${targetPages.length} page(s)` : ''}).`
        );
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
          fontSize: watermarkFontSize,
          color: watermarkColor,
          angle: watermarkAngle,
        });
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_watermarked.pdf'), 'edited', 'Added watermark');
        setResultMsg(
          language === 'bn'
            ? 'ওয়াটারমার্ক যোগ করে নতুন পিডিএফ সেভ হয়েছে।'
            : 'Watermark applied and saved as new PDF.'
        );
      } else if (toolId === 'pageNumbers') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await addPageNumbersToPdf(primaryDoc.pdfBytes, pageNumPos, pageNumFormat, {
          startNumber: pageNumStart,
          skipFirstPage: pageNumSkipFirst,
          fontSize: pageNumFontSize,
        });
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_numbered.pdf'), 'edited', 'Added page numbers');
        setResultMsg(
          language === 'bn'
            ? 'পৃষ্ঠা নম্বর সফলভাবে যোগ ও সেভ হয়েছে।'
            : 'Page numbers added and saved.'
        );
      } else if (toolId === 'headerFooter') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await addHeaderFooterToPdf(primaryDoc.pdfBytes, headerTxt, footerTxt, {
          align: headerFooterAlign,
          fontSize: headerFooterFontSize,
          color: headerFooterColor,
        });
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_headers.pdf'), 'edited', 'Added header/footer');
        setResultMsg(
          language === 'bn'
            ? 'হেডার ও ফুটার সফলভাবে যোগ ও সেভ হয়েছে।'
            : 'Header and footer applied and saved.'
        );
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
        const zipName = primaryDoc.name.replace(/\.pdf$/i, '_pages.zip');
        setPreviewUrls(previewImages);
        setResultZip({ bytes: zipBuffer, name: zipName });
        await saveBufferToDeviceStorage(
          zipBuffer,
          zipName,
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
          const pdfBytes = await imagesToPdf(uploadedFiles, { fitMode: imageFitMode });
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
          const pdfBytes = await imagesToPdf(imgFiles, { fitMode: imageFitMode });
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
            const record: DocumentRecord = {
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
            };
            await onSaveResultDoc(record);
            setResultDoc(record);
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
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {uploadedFiles.map((f, idx) => (
                    <div
                      key={`${f.name}_${idx}`}
                      className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate font-medium">
                        {idx + 1}. {f.name} ({formatBytes(f.size)})
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {toolId === 'imagesToPdf' && uploadedFiles.length > 1 && (
                          <>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveUploadedFile(idx, -1)}
                              aria-label="Move image up"
                              className="p-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 disabled:opacity-30"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === uploadedFiles.length - 1}
                              onClick={() => moveUploadedFile(idx, 1)}
                              aria-label="Move image down"
                              className="p-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 disabled:opacity-30"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
                          }
                          aria-label="Remove file"
                          className="p-1 rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {toolId === 'imagesToPdf' && (
                <div className="space-y-1.5 pt-1">
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-300">
                    {language === 'bn' ? 'পেজ ফিট ও লেআউট' : 'Page Fit & Layout'}
                  </label>
                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    {(
                      [
                        { id: 'a4-fit', label: language === 'bn' ? 'A4 মার্জিনসহ' : 'A4 Fit (Margin)' },
                        { id: 'a4-fill', label: language === 'bn' ? 'A4 ফুল পেজ' : 'A4 Fill Page' },
                        { id: 'auto', label: language === 'bn' ? 'ছবির মাপ' : 'Match Image' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setImageFitMode(opt.id)}
                        className={`min-h-[38px] px-2 rounded-xl font-semibold border ${
                          imageFitMode === opt.id
                            ? 'bg-[#2563EB] text-white border-[#2563EB]'
                            : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-[#06B6D4]" />
                      {language === 'bn' ? 'রিসেন্ট ফাইলস' : 'Recent Files'}
                    </span>
                    {(() => {
                      const filteredRecent = recentSorted.filter((d) =>
                        mergeSearch.trim()
                          ? d.name.toLowerCase().includes(mergeSearch.toLowerCase())
                          : true
                      );
                      const allRecentAdded =
                        filteredRecent.length > 0 &&
                        filteredRecent.every((d) => mergeQueue.some((item) => item.id === d.id));
                      return filteredRecent.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (allRecentAdded) {
                              const ids = new Set(filteredRecent.map((d) => d.id));
                              setMergeQueue((prev) => prev.filter((item) => !ids.has(item.id)));
                            } else {
                              setMergeQueue((prev) => {
                                const existingIds = new Set(prev.map((x) => x.id));
                                const toAdd = filteredRecent
                                  .filter((d) => !existingIds.has(d.id))
                                  .map((d) => ({
                                    id: d.id,
                                    name: d.name,
                                    pageCount: d.pageCount,
                                    sizeBytes: d.sizeBytes,
                                    pdfBytes: d.pdfBytes,
                                    source: 'recent' as const,
                                  }));
                                return [...prev, ...toAdd];
                              });
                            }
                          }}
                          className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                            allRecentAdded
                              ? 'bg-emerald-600 text-white'
                              : 'bg-[#2563EB]/10 text-[#2563EB] hover:bg-[#2563EB]/20'
                          }`}
                        >
                          {allRecentAdded
                            ? language === 'bn'
                              ? 'সব বাদ দিন'
                              : 'Deselect All'
                            : language === 'bn'
                            ? 'সব নির্বাচন'
                            : 'Select All'}
                        </button>
                      ) : null;
                    })()}
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 flex-1 max-w-[180px]">
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
            <div className="space-y-2.5 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {(
                  [
                    { id: 'custom', label: language === 'bn' ? 'কাস্টম রেঞ্জ' : 'Custom Range' },
                    { id: 'odd', label: language === 'bn' ? 'বিজোড় পৃষ্ঠা' : 'Odd Pages' },
                    { id: 'even', label: language === 'bn' ? 'জোড় পৃষ্ঠা' : 'Even Pages' },
                    { id: 'each-zip', label: language === 'bn' ? 'প্রতি পৃষ্ঠা ZIP' : 'Each Page ZIP' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSplitMode(m.id)}
                    className={`min-h-[38px] px-2 rounded-xl font-semibold border ${
                      splitMode === m.id
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {splitMode === 'custom' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="block font-semibold text-slate-500">
                      {language === 'bn'
                        ? `পৃষ্ঠা নম্বর (যেমন 1-2, 4${primaryDoc ? ` · সর্বোচ্চ ${primaryDoc.pageCount}` : ''})`
                        : `Pages to Extract (e.g. 1-2, 4${primaryDoc ? ` · max ${primaryDoc.pageCount}` : ''})`}
                    </label>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {primaryDoc && (
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[11px] font-mono-nums font-bold text-slate-600 dark:text-slate-300">
                          {parsePageRanges(splitRange, primaryDoc.pageCount).length}/{primaryDoc.pageCount}
                        </span>
                      )}
                      {primaryDoc && (
                        <button
                          type="button"
                          onClick={() => setSplitRange(`1-${primaryDoc.pageCount}`)}
                          className="px-2 py-0.5 rounded-md bg-[#2563EB]/10 text-[#2563EB] text-[11px] font-bold"
                        >
                          {language === 'bn' ? 'সব' : 'All'}
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    type="text"
                    value={splitRange}
                    onChange={(e) => setSplitRange(e.target.value)}
                    placeholder="1-3, 5"
                    className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono-nums"
                  />
                  {primaryDoc && primaryDoc.pageCount <= 36 && (
                    <div className="flex flex-wrap gap-1 pt-0.5 max-h-28 overflow-y-auto">
                      {Array.from({ length: primaryDoc.pageCount }, (_, i) => i + 1).map((pNum) => {
                        const selected = parsePageRanges(splitRange, primaryDoc.pageCount);
                        const isSel = selected.includes(pNum);
                        return (
                          <button
                            key={pNum}
                            type="button"
                            onClick={() => {
                              const next = isSel
                                ? selected.filter((x) => x !== pNum)
                                : [...selected, pNum];
                              setSplitRange(formatPagesListAsRange(next));
                            }}
                            className={`min-w-[32px] h-7 px-1.5 rounded-lg text-[11px] font-mono-nums font-bold border transition-colors ${
                              isSel
                                ? 'bg-[#2563EB] text-white border-[#2563EB]'
                                : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {pNum}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {splitMode !== 'custom' && primaryDoc && (
                <p className="text-[11px] text-slate-500">
                  {splitMode === 'each-zip'
                    ? language === 'bn'
                      ? `মোট ${primaryDoc.pageCount}টি পৃষ্ঠা আলাদা PDF হয়ে একটি ZIP ফাইলে সংরক্ষিত হবে।`
                      : `Exports all ${primaryDoc.pageCount} page(s) as separate PDFs inside a single ZIP file.`
                    : language === 'bn'
                    ? `${splitMode === 'odd' ? 'বিজোড়' : 'জোড়'} পৃষ্ঠাগুলো নিয়ে নতুন পিডিএফ তৈরি হবে।`
                    : `Extracts all ${splitMode} page numbers from 1 to ${primaryDoc.pageCount}.`}
                </p>
              )}
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
              <p className="text-[11px] text-slate-500">
                {compressMode === 'object-streams'
                  ? language === 'bn'
                    ? 'টেক্সট ও ভেক্টর কোয়ালিটি ১০০% ঠিক রেখে ফাইল হালকা করে।'
                    : 'Keeps crisp vector text & lossless structure while trimming overhead.'
                  : compressMode === 'raster-medium'
                  ? language === 'bn'
                    ? 'ছবিযুক্ত ও স্ক্যান পিডিএফের জন্য ভারসাম্যপূর্ণ সাইজ ও স্পষ্টতা।'
                    : 'Balances clarity and strong size reduction; never bloats clean vector PDFs.'
                  : compressMode === 'raster-compact'
                  ? language === 'bn'
                    ? 'সর্বোচ্চ মেমোরি সাশ্রয়ের জন্য ছোট ফাইল সাইজ।'
                    : 'Aggressive size reduction ideal for email or portal uploads.'
                  : language === 'bn'
                  ? 'নির্দিষ্ট কিলোবাইট সীমার কাছাকাছি আনতে স্বয়ংক্রিয়ভাবে প্রিসেট চেষ্টা করে।'
                  : 'Automatically searches quality presets to fit under your KB limit.'}
              </p>

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
            <div className="space-y-2.5 text-xs">
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { deg: 90, label: language === 'bn' ? '৯০° ডান ↻' : '90° Right ↻' },
                  { deg: 180, label: language === 'bn' ? '১৮০° উল্টো ⇅' : '180° Flip ⇅' },
                  { deg: 270, label: language === 'bn' ? '২৭০° বাম ↺' : '270° Left ↺' },
                ].map((opt) => (
                  <button
                    key={opt.deg}
                    type="button"
                    onClick={() => setRotateAngle(opt.deg)}
                    className={`min-h-[42px] rounded-xl font-semibold border ${
                      rotateAngle === opt.deg
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setRotateScope('all')}
                  className={`min-h-[38px] rounded-xl font-semibold border ${
                    rotateScope === 'all'
                      ? 'bg-[#2563EB]/10 text-[#2563EB] border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {language === 'bn' ? 'সব পৃষ্ঠা' : 'All Pages'}
                </button>
                <button
                  type="button"
                  onClick={() => setRotateScope('specific')}
                  className={`min-h-[38px] rounded-xl font-semibold border ${
                    rotateScope === 'specific'
                      ? 'bg-[#2563EB]/10 text-[#2563EB] border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {language === 'bn' ? 'নির্দিষ্ট পৃষ্ঠা' : 'Specific Pages'}
                </button>
              </div>
              {rotateScope === 'specific' && (
                <input
                  type="text"
                  value={rotatePagesInput}
                  onChange={(e) => setRotatePagesInput(e.target.value)}
                  placeholder={
                    primaryDoc
                      ? `e.g. 1, 3-5 (max ${primaryDoc.pageCount})`
                      : 'e.g. 1, 3-5'
                  }
                  className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono-nums"
                />
              )}
            </div>
          )}

          {toolId === 'pageSetup' && (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-500 mb-1">
                  {language === 'bn' ? 'পেজের মাপ' : 'Paper Size'}
                </label>
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
                <label className="block font-semibold text-slate-500 mb-1">
                  {language === 'bn' ? 'দিক (ওরিয়েন্টেশন)' : 'Orientation'}
                </label>
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
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap gap-1.5">
                {['CONFIDENTIAL', 'DRAFT', 'COPY', 'URGENT'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setWatermarkText(preset)}
                    className={`px-2.5 py-1 rounded-lg font-bold border ${
                      watermarkText === preset
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={watermarkText}
                onChange={(e) => setWatermarkText(e.target.value)}
                placeholder={language === 'bn' ? 'ওয়াটারমার্ক টেক্সট (English বা বাংলা)' : 'Watermark text (English or বাংলা)'}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  {language === 'bn' ? 'স্বচ্ছতা' : 'Opacity'} ({Math.round(watermarkOpacity * 100)}%)
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
                <label className="block">
                  {language === 'bn' ? 'ফন্ট সাইজ' : 'Font Size'} ({watermarkFontSize}pt)
                  <input
                    type="range"
                    min={20}
                    max={84}
                    step={2}
                    value={watermarkFontSize}
                    onChange={(e) => setWatermarkFontSize(Number(e.target.value))}
                    className="w-full accent-[#2563EB]"
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {[-45, 0, 30, 45, 90].map((ang) => (
                    <button
                      key={ang}
                      type="button"
                      onClick={() => setWatermarkAngle(ang)}
                      className={`px-2 py-1 rounded-lg font-mono-nums font-semibold border ${
                        watermarkAngle === ang
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {ang}°
                    </button>
                  ))}
                </div>
                <input
                  type="color"
                  value={watermarkColor}
                  onChange={(e) => setWatermarkColor(e.target.value)}
                  className="w-10 h-9 rounded-xl shrink-0"
                />
              </div>
              {/* Compact Live Watermark Preview */}
              <div className="h-24 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-center overflow-hidden relative">
                <span
                  style={{
                    color: watermarkColor,
                    opacity: watermarkOpacity,
                    fontSize: Math.max(12, Math.min(28, watermarkFontSize * 0.45)),
                    transform: `rotate(${-watermarkAngle}deg)`,
                  }}
                  className="font-bold tracking-wider select-none pointer-events-none whitespace-nowrap"
                >
                  {watermarkText.trim() || 'CONFIDENTIAL'}
                </span>
              </div>
            </div>
          )}

          {toolId === 'pageNumbers' && (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-500 mb-1.5">
                  {language === 'bn' ? 'অবস্থান (Position)' : 'Position'}
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'top-left', label: language === 'bn' ? 'উপরে বাম' : 'Top Left' },
                      { id: 'top-center', label: language === 'bn' ? 'উপরে মাঝ' : 'Top Center' },
                      { id: 'top-right', label: language === 'bn' ? 'উপরে ডান' : 'Top Right' },
                      { id: 'bottom-left', label: language === 'bn' ? 'নিচে বাম' : 'Bottom Left' },
                      { id: 'bottom-center', label: language === 'bn' ? 'নিচে মাঝ' : 'Bottom Center' },
                      { id: 'bottom-right', label: language === 'bn' ? 'নিচে ডান' : 'Bottom Right' },
                    ] as const
                  ).map((pos) => (
                    <button
                      key={pos.id}
                      type="button"
                      onClick={() => setPageNumPos(pos.id)}
                      className={`min-h-[38px] px-2 rounded-xl font-semibold border ${
                        pageNumPos === pos.id
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {pos.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-500 mb-1.5">
                  {language === 'bn' ? 'নম্বর ফরম্যাট' : 'Number Format'}
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'pageOfTotal', label: 'Page 1 of N' },
                      { id: 'slash', label: '1 / N' },
                      { id: 'number', label: '1, 2, 3' },
                    ] as const
                  ).map((fmt) => (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => setPageNumFormat(fmt.id)}
                      className={`min-h-[38px] px-2 rounded-xl font-mono-nums font-semibold border ${
                        pageNumFormat === fmt.id
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {fmt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="block font-semibold text-slate-500 mb-1">
                    {language === 'bn' ? 'শুরুর নম্বর' : 'Start Number'}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={pageNumStart}
                    onChange={(e) => setPageNumStart(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full min-h-[38px] px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono-nums"
                  />
                </label>
                <label className="block">
                  <span className="block font-semibold text-slate-500 mb-1">
                    {language === 'bn' ? 'ফন্ট সাইজ (pt)' : 'Font Size (pt)'}
                  </span>
                  <input
                    type="number"
                    min={7}
                    max={20}
                    value={pageNumFontSize}
                    onChange={(e) =>
                      setPageNumFontSize(Math.max(7, Math.min(20, Number(e.target.value) || 10)))
                    }
                    className="w-full min-h-[38px] px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono-nums"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={pageNumSkipFirst}
                  onChange={(e) => setPageNumSkipFirst(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB] rounded"
                />
                <span className="font-semibold text-slate-600 dark:text-slate-300">
                  {language === 'bn'
                    ? 'প্রথম পৃষ্ঠায় (কভার পেজ) নম্বর বাদ দিন'
                    : 'Skip first page (Cover page)'}
                </span>
              </label>
            </div>
          )}

          {toolId === 'headerFooter' && (
            <div className="space-y-2.5 text-xs">
              <input
                type="text"
                value={headerTxt}
                onChange={(e) => setHeaderTxt(e.target.value)}
                placeholder={language === 'bn' ? 'হেডার টেক্সট (English বা বাংলা)' : 'Header text (English or বাংলা)'}
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={footerTxt}
                onChange={(e) => setFooterTxt(e.target.value)}
                placeholder={language === 'bn' ? 'ফুটার টেক্সট (English বা বাংলা)' : 'Footer text (English or বাংলা)'}
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <div className="flex items-center gap-2">
                <div className="grid grid-cols-3 gap-1 flex-1">
                  {(['left', 'center', 'right'] as const).map((al) => (
                    <button
                      key={al}
                      type="button"
                      onClick={() => setHeaderFooterAlign(al)}
                      className={`min-h-[38px] rounded-xl font-semibold capitalize border ${
                        headerFooterAlign === al
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {al}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={7}
                  max={18}
                  step={0.5}
                  value={headerFooterFontSize}
                  onChange={(e) =>
                    setHeaderFooterFontSize(Math.max(7, Math.min(18, Number(e.target.value) || 9.5)))
                  }
                  aria-label="Header Footer Font Size"
                  className="w-16 min-h-[38px] px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono-nums text-center"
                />
                <input
                  type="color"
                  value={headerFooterColor}
                  onChange={(e) => setHeaderFooterColor(e.target.value)}
                  className="w-10 h-9 rounded-xl shrink-0"
                />
              </div>
              <p className="text-[11px] text-slate-500">
                {language === 'bn'
                  ? 'ইংরেজি ও বাংলা ইউনিকোড টেক্সট সঠিকভাবে যুক্ত হয়।'
                  : 'Supports both English and Unicode (Bengali/other scripts).'}
              </p>
            </div>
          )}

          {(toolId === 'protectVault' || toolId === 'unlockPdf') && (
            <div className="space-y-2">
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !running) {
                      void handleRun();
                    }
                  }}
                  placeholder={
                    toolId === 'protectVault'
                      ? language === 'bn'
                        ? 'ভল্ট এনক্রিপশন পাসওয়ার্ড দিন (সর্বনিম্ন ৪ অক্ষর)...'
                        : 'Enter Vault encryption password (min 4 chars)...'
                      : language === 'bn'
                      ? 'বর্তমান পিডিএফ পাসওয়ার্ড দিন...'
                      : 'Enter current PDF password...'
                  }
                  className="w-full min-h-[44px] pl-3 pr-11 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-white"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
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
                : toolId === 'merge' && mergeQueue.length >= 2
                ? `${language === 'bn' ? 'মার্জ করুন:' : 'Merge'} ${mergeQueue.length} ${
                    language === 'bn' ? 'ফাইল' : 'PDFs'
                  } (${mergeQueue.reduce((s, m) => s + m.pageCount, 0)}p · ${formatBytes(
                    mergeQueue.reduce((s, m) => s + m.sizeBytes, 0)
                  )})`
                : `${language === 'bn' ? 'চালান:' : 'Run'} ${getToolTitle(toolId, language)}`}
            </span>
          </button>

          {resultMsg && (
            <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 space-y-2.5">
              <div className="flex items-center gap-2 font-semibold">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>{resultMsg}</span>
              </div>
              {resultDoc && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {onOpenResultDoc && (
                    <>
                      <button
                        type="button"
                        onClick={() => onOpenResultDoc(resultDoc, 'viewer')}
                        className="min-h-[38px] px-2 rounded-xl bg-[#2563EB] text-white font-semibold flex items-center justify-center gap-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{language === 'bn' ? 'ভিউ' : 'View'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenResultDoc(resultDoc, 'editor')}
                        className="min-h-[38px] px-2 rounded-xl bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 text-[#142B4A] dark:text-white font-semibold flex items-center justify-center gap-1"
                      >
                        <Edit3 className="w-3.5 h-3.5 text-[#2563EB]" />
                        <span>{language === 'bn' ? 'এডিট' : 'Edit'}</span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void saveBufferToDeviceStorage(
                        resultDoc.pdfBytes,
                        resultDoc.name,
                        'application/pdf'
                      )
                    }
                    className="min-h-[38px] px-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex items-center justify-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{language === 'bn' ? 'ডাউনলোড' : 'Download'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void shareBufferNativeOrWeb(
                        resultDoc.pdfBytes,
                        resultDoc.name,
                        'application/pdf'
                      )
                    }
                    className="min-h-[38px] px-2 rounded-xl bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 text-[#142B4A] dark:text-white font-semibold flex items-center justify-center gap-1"
                  >
                    <Share2 className="w-3.5 h-3.5 text-[#06B6D4]" />
                    <span>{language === 'bn' ? 'শেয়ার' : 'Share'}</span>
                  </button>
                </div>
              )}
              {resultZip && (
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      void saveBufferToDeviceStorage(
                        resultZip.bytes,
                        resultZip.name,
                        'application/zip'
                      )
                    }
                    className="min-h-[38px] px-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex items-center justify-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{language === 'bn' ? 'ZIP ডাউনলোড' : 'Download ZIP'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void shareBufferNativeOrWeb(
                        resultZip.bytes,
                        resultZip.name,
                        'application/zip'
                      )
                    }
                    className="min-h-[38px] px-2 rounded-xl bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 text-[#142B4A] dark:text-white font-semibold flex items-center justify-center gap-1"
                  >
                    <Share2 className="w-3.5 h-3.5 text-[#06B6D4]" />
                    <span>{language === 'bn' ? 'শেয়ার ZIP' : 'Share ZIP'}</span>
                  </button>
                </div>
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
            {previewUrls.map((url, idx) => {
              const ext = exportImgFormat === 'image/jpeg' ? 'jpg' : 'png';
              const base = primaryDoc?.name.replace(/\.pdf$/i, '') || 'page';
              return (
                <div
                  key={idx}
                  className="rounded-xl bg-white dark:bg-slate-900 p-2 border border-slate-200 dark:border-slate-800 space-y-1.5"
                >
                  <img src={url} alt={`Page ${idx + 1}`} className="w-full rounded-lg" />
                  <button
                    type="button"
                    onClick={() =>
                      void saveBufferToDeviceStorage(
                        dataUrlToArrayBuffer(url),
                        `${base}_page_${idx + 1}.${ext}`,
                        exportImgFormat
                      )
                    }
                    className="w-full min-h-[34px] rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-[#2563EB] hover:text-white text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    <span>
                      {language === 'bn'
                        ? `পৃষ্ঠা ${idx + 1} ডাউনলোড`
                        : `Save Page ${idx + 1}`}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
