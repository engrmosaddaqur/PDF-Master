import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Download,
  FileUp,
  Lock,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord, PaperSizeKey } from '../types';
import {
  PAPER_DIMENSIONS,
  addHeaderFooterToPdf,
  addPageNumbersToPdf,
  addWatermarkToPdf,
  cloneBuffer,
  compressPdfBytes,
  encryptVaultBytes,
  extractDocumentPagesText,
  getPdfDocumentInfo,
  mergePdfs,
  renderPageThumbnail,
  repairPdfBytes,
  resizePdfPages,
  rotateAllPages,
  splitPdfByRanges,
  unlockPasswordProtectedPdf,
  updatePdfMetadata,
} from '../services/pdfEngine';
import {
  docxFileToPdf,
  imagesToPdf,
  pdfToDocxBytes,
  pdfToImagesZip,
  pdfToPptxBytes,
  pdfToXlsxBytes,
  pptxFileToPdf,
  xlsxFileToPdf,
} from '../services/conversionService';
import { downloadArrayBuffer, formatBytes } from '../services/storageService';

interface ToolRunnerModalProps {
  toolId: string;
  language: AppLanguage;
  docs: DocumentRecord[];
  preselectedDocId?: string;
  onClose: () => void;
  onSaveResultDoc: (newDoc: DocumentRecord) => Promise<void>;
  onUpdateExistingDoc: (updated: DocumentRecord) => Promise<void>;
}

const TOOL_TITLES: Record<string, string> = {
  merge: 'Merge PDFs',
  split: 'Split PDF',
  compress: 'Compress PDF',
  rotate: 'Rotate PDF',
  pageSetup: 'Page Size & Orientation',
  watermark: 'Add Watermark',
  pageNumbers: 'Add Page Numbers',
  headerFooter: 'Add Header & Footer',
  protectVault: 'Protect PDF (AES-256 Vault)',
  unlockPdf: 'Remove PDF Password',
  extractImages: 'PDF to Images / Extract Images',
  extractText: 'Extract PDF Text (.TXT)',
  editMetadata: 'Edit PDF Metadata',
  repairPdf: 'Repair Damaged PDF',
  imagesToPdf: 'Images to PDF',
  pdfToDocx: 'PDF to Word (.DOCX)',
  pdfToXlsx: 'PDF to Excel (.XLSX)',
  pdfToPptx: 'PDF to PowerPoint (.PPTX)',
  wordToPdf: 'Word (.DOCX) to PDF',
  excelToPdf: 'Excel (.XLSX) to PDF',
  pptToPdf: 'PowerPoint (.PPTX) to PDF',
};

export const ToolRunnerModal: React.FC<ToolRunnerModalProps> = ({
  toolId,
  docs,
  preselectedDocId,
  onClose,
  onSaveResultDoc,
  onUpdateExistingDoc,
}) => {
  const available = docs.filter((d) => !d.isTrashed && !d.isVaultLocked);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    preselectedDocId ? [preselectedDocId] : available[0] ? [available[0].id] : []
  );
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Tool parameters
  const [splitRange, setSplitRange] = useState('1');
  const [compressMode, setCompressMode] = useState<'object-streams' | 'raster-medium' | 'raster-compact'>('raster-medium');
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
    'unlockPdf',
  ].includes(toolId);

  const toggleMultiDoc = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
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
    setPreviewUrls([]);

    try {
      if (toolId === 'merge') {
        if (selectedIds.length < 2) throw new Error('Select at least 2 PDFs to merge.');
        const buffers = selectedIds
          .map((id) => available.find((d) => d.id === id)?.pdfBytes)
          .filter(Boolean) as ArrayBuffer[];
        const merged = await mergePdfs(buffers);
        await saveNewPdf(merged, `Merged_${Date.now().toString().slice(-4)}.pdf`, 'edited', 'Merged PDFs');
        setResultMsg(`Merged ${buffers.length} PDFs successfully (${formatBytes(merged.byteLength)}).`);
      } else if (toolId === 'split') {
        if (!primaryDoc) throw new Error('Select a PDF to split.');
        const pagesToKeep: number[] = [];
        splitRange.split(',').forEach((part) => {
          const trimmed = part.trim();
          if (trimmed.includes('-')) {
            const [s, e] = trimmed.split('-').map((n) => parseInt(n, 10));
            if (s && e) {
              for (let p = Math.min(s, e); p <= Math.max(s, e); p++) pagesToKeep.push(p);
            }
          } else {
            const n = parseInt(trimmed, 10);
            if (n) pagesToKeep.push(n);
          }
        });
        if (!pagesToKeep.length) throw new Error('Enter valid page numbers like 1-2, 4.');
        const splitBytes = await splitPdfByRanges(primaryDoc.pdfBytes, pagesToKeep);
        await saveNewPdf(
          splitBytes,
          primaryDoc.name.replace(/\.pdf$/i, `_pages_${splitRange.replace(/\s+/g, '')}.pdf`),
          'edited',
          `Split pages: ${splitRange}`
        );
        setResultMsg(`Created split PDF with ${pagesToKeep.length} page(s).`);
      } else if (toolId === 'compress') {
        if (!primaryDoc) throw new Error('Select a PDF to compress.');
        const compressed = await compressPdfBytes(primaryDoc.pdfBytes, compressMode);
        await saveNewPdf(
          compressed,
          primaryDoc.name.replace(/\.pdf$/i, '_compressed.pdf'),
          'edited',
          `Compressed (${compressMode})`
        );
        const pct = Math.max(
          0,
          Math.round(((primaryDoc.sizeBytes - compressed.byteLength) / primaryDoc.sizeBytes) * 100)
        );
        setResultMsg(
          `Compressed from ${formatBytes(primaryDoc.sizeBytes)} to ${formatBytes(compressed.byteLength)} (${pct}% smaller).`
        );
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
        setResultMsg('Document encrypted with AES-256-GCM inside your local Vault.');
      } else if (toolId === 'unlockPdf') {
        const file = uploadedFiles[0];
        if (!file) throw new Error('Upload a password-protected PDF file.');
        const buf = await file.arrayBuffer();
        const unlocked = await unlockPasswordProtectedPdf(buf, passwordInput);
        await saveNewPdf(
          unlocked,
          file.name.replace(/\.pdf$/i, '_unlocked.pdf'),
          'edited',
          'Unlocked password PDF'
        );
        setResultMsg('Unlocked PDF saved to your Document Vault.');
      } else if (toolId === 'extractImages') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const { zipBuffer, previewImages } = await pdfToImagesZip(primaryDoc.pdfBytes, 'image/png');
        setPreviewUrls(previewImages);
        downloadArrayBuffer(
          zipBuffer,
          primaryDoc.name.replace(/\.pdf$/i, '_pages.zip'),
          'application/zip'
        );
        setResultMsg(`Exported ${previewImages.length} PNG page image(s) as ZIP.`);
      } else if (toolId === 'extractText') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const pages = await extractDocumentPagesText(primaryDoc.pdfBytes);
        const fullText = pages
          .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
          .join('\n\n');
        const buf = new TextEncoder().encode(fullText).buffer;
        downloadArrayBuffer(
          buf,
          primaryDoc.name.replace(/\.pdf$/i, '.txt'),
          'text/plain;charset=utf-8'
        );
        setResultMsg(`Extracted text from ${pages.length} page(s).`);
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
          updatedAt: Date.now(),
        });
        setResultMsg('PDF metadata updated.');
      } else if (toolId === 'repairPdf') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const out = await repairPdfBytes(primaryDoc.pdfBytes);
        await saveNewPdf(out, primaryDoc.name.replace(/\.pdf$/i, '_repaired.pdf'), 'edited', 'Rebuilt PDF structure');
        setResultMsg('PDF structure & cross-reference table rebuilt cleanly.');
      } else if (toolId === 'imagesToPdf') {
        if (!uploadedFiles.length) throw new Error('Select one or more images.');
        const pdfBytes = await imagesToPdf(uploadedFiles);
        await saveNewPdf(pdfBytes, `Images_${Date.now().toString().slice(-4)}.pdf`, 'converted', 'Converted from images');
        setResultMsg(`Converted ${uploadedFiles.length} image(s) into a PDF.`);
      } else if (toolId === 'pdfToDocx') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const docxBuf = await pdfToDocxBytes(primaryDoc.pdfBytes, primaryDoc.name);
        downloadArrayBuffer(
          docxBuf,
          primaryDoc.name.replace(/\.pdf$/i, '.docx'),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        setResultMsg('Converted and downloaded Word (.DOCX) file.');
      } else if (toolId === 'pdfToXlsx') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const xlsxBuf = await pdfToXlsxBytes(primaryDoc.pdfBytes);
        downloadArrayBuffer(
          xlsxBuf,
          primaryDoc.name.replace(/\.pdf$/i, '.xlsx'),
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        setResultMsg('Extracted tabular data to Excel (.XLSX) workbook.');
      } else if (toolId === 'pdfToPptx') {
        if (!primaryDoc) throw new Error('Select a PDF.');
        const pptxBuf = await pdfToPptxBytes(primaryDoc.pdfBytes);
        downloadArrayBuffer(
          pptxBuf,
          primaryDoc.name.replace(/\.pdf$/i, '.pptx'),
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        );
        setResultMsg('Converted PDF pages into PowerPoint (.PPTX) presentation.');
      } else if (toolId === 'wordToPdf') {
        const file = uploadedFiles[0];
        if (!file) throw new Error('Select a .DOCX file.');
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
          {TOOL_TITLES[toolId] || 'PDF Tool'}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-2xl w-full mx-auto space-y-4">
        {/* Input Selection */}
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          {needsExternalFile ? (
            <label className="flex flex-col items-center justify-center gap-2 p-6 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 cursor-pointer hover:border-[#2563EB]">
              <FileUp className="w-7 h-7 text-[#2563EB]" />
              <span className="text-sm font-semibold">
                {uploadedFiles.length > 0
                  ? `${uploadedFiles.length} file(s) selected`
                  : 'Tap to choose file(s)'}
              </span>
              <span className="text-xs text-slate-500">
                {toolId === 'imagesToPdf'
                  ? 'PNG, JPG, WEBP'
                  : toolId === 'wordToPdf'
                  ? '.DOCX'
                  : toolId === 'excelToPdf'
                  ? '.XLSX, .XLS, .CSV'
                  : toolId === 'pptToPdf'
                  ? '.PPTX'
                  : 'Password-protected .PDF'}
              </span>
              <input
                type="file"
                multiple={toolId === 'imagesToPdf'}
                accept={
                  toolId === 'imagesToPdf'
                    ? 'image/*'
                    : toolId === 'wordToPdf'
                    ? '.docx'
                    : toolId === 'excelToPdf'
                    ? '.xlsx,.xls,.csv'
                    : toolId === 'pptToPdf'
                    ? '.pptx'
                    : '.pdf'
                }
                onChange={(e) => setUploadedFiles(Array.from(e.target.files || []))}
                className="hidden"
              />
            </label>
          ) : toolId === 'merge' ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-500">
                Select 2 or more PDFs in merge order ({selectedIds.length} selected)
              </p>
              <div className="max-h-56 overflow-y-auto space-y-1.5">
                {available.map((d) => {
                  const active = selectedIds.includes(d.id);
                  return (
                    <button
                      key={d.id}
                      onClick={() => toggleMultiDoc(d.id)}
                      className={`w-full min-h-[46px] px-3 rounded-xl border text-left flex items-center justify-between text-xs font-medium ${
                        active
                          ? 'border-[#2563EB] bg-[#2563EB]/10 text-[#142B4A] dark:text-white'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <span className="truncate">{d.name}</span>
                      <span className="font-mono-nums text-slate-500 ml-2 shrink-0">
                        {d.pageCount}p · {active ? <Check className="w-4 h-4 inline text-[#2563EB]" /> : formatBytes(d.sizeBytes)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                Select Document
              </label>
              <select
                value={selectedIds[0] || ''}
                onChange={(e) => setSelectedIds([e.target.value])}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              >
                {available.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.pageCount}p · {formatBytes(d.sizeBytes)})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Tool-specific controls */}
          {toolId === 'split' && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Pages to Extract (e.g. 1-2, 4)
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
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'object-streams', label: 'Lossless' },
                  { id: 'raster-medium', label: 'Balanced' },
                  { id: 'raster-compact', label: 'Maximum' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setCompressMode(m.id)}
                  className={`min-h-[42px] rounded-xl text-xs font-semibold border ${
                    compressMode === m.id
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {m.label}
                </button>
              ))}
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
                <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
                  <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#2563EB]" />
                  <span>
                    Uses Web Crypto AES-256-GCM with PBKDF2 (100,000 iterations) to lock the document inside your device Vault.
                  </span>
                </p>
              )}
              {toolId === 'unlockPdf' && (
                <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
                  <Unlock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#2563EB]" />
                  <span>
                    Only unlock documents you are legally authorized to access.
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
                placeholder="Document Title"
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={metaAuthor}
                onChange={(e) => setMetaAuthor(e.target.value)}
                placeholder="Author"
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={metaSubject}
                onChange={(e) => setMetaSubject(e.target.value)}
                placeholder="Subject"
                className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
              <input
                type="text"
                value={metaKeywords}
                onChange={(e) => setMetaKeywords(e.target.value)}
                placeholder="Keywords (comma separated)"
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
            <span>{running ? 'Processing...' : `Run ${TOOL_TITLES[toolId] || 'Tool'}`}</span>
          </button>

          {resultMsg && (
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>{resultMsg}</span>
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
