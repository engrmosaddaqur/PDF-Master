import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Copy,
  Download,
  FileText,
  ImagePlus,
  ScanText,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import {
  cloneBuffer,
  createSearchablePdfFromOcr,
  renderPageThumbnail,
  renderPageToDataUrl,
} from '../services/pdfEngine';
import { runAiVisionOcr, runOnDeviceOcr, type OcrLanguage } from '../services/ocrService';
import { downloadArrayBuffer } from '../services/storageService';

interface OcrViewProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  initialDocId?: string;
  aiConsentGranted: boolean;
  localOnlyMode: boolean;
  onGrantAiConsent: () => void;
  onClose: () => void;
  onSaveSearchablePdf: (doc: DocumentRecord) => Promise<void>;
  onOpenInWordCreator: (initialHtml: string) => void;
}

export const OcrView: React.FC<OcrViewProps> = ({
  language,
  docs,
  initialDocId,
  aiConsentGranted,
  localOnlyMode,
  onGrantAiConsent,
  onClose,
  onSaveSearchablePdf,
  onOpenInWordCreator,
}) => {
  const t = getT(language);
  const [sourceType, setSourceType] = useState<'pdf' | 'image'>(initialDocId ? 'pdf' : 'image');
  const [selectedDocId, setSelectedDocId] = useState<string>(
    initialDocId || docs.find((d) => !d.isTrashed && !d.isVaultLocked)?.id || ''
  );
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [ocrLang, setOcrLang] = useState<OcrLanguage>('eng+ben');
  const [engine, setEngine] = useState<'device' | 'ai'>('device');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [extractedPages, setExtractedPages] = useState<Array<{ imageDataUrl: string; ocrText: string }>>([]);
  const [combinedText, setCombinedText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedDoc = docs.find((d) => d.id === selectedDocId);

  useEffect(() => {
    if (sourceType !== 'pdf' || !selectedDoc) return;
    let active = true;
    const loadPreview = async () => {
      const imgs: string[] = [];
      const limit = Math.min(selectedDoc.pageCount, 8);
      for (let p = 1; p <= limit; p++) {
        const url = await renderPageToDataUrl(selectedDoc.pdfBytes, p, 1.8, 'image/jpeg');
        imgs.push(url);
      }
      if (active) setPageImages(imgs);
    };
    loadPreview().catch(() => {});
    return () => {
      active = false;
    };
  }, [sourceType, selectedDocId]);

  const handleUploadImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    Promise.all(
      files.map(
        (file) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          })
      )
    ).then((urls) => {
      setSourceType('image');
      setPageImages(urls);
      setExtractedPages([]);
      setCombinedText('');
    });
    e.target.value = '';
  };

  const handleRunOcr = async () => {
    if (pageImages.length === 0) return;
    if (engine === 'ai' && (localOnlyMode || !aiConsentGranted)) {
      return;
    }

    setRunning(true);
    setErrorMsg(null);
    setProgress(0);
    const outPages: Array<{ imageDataUrl: string; ocrText: string }> = [];

    try {
      for (let i = 0; i < pageImages.length; i++) {
        setStatusText(`Processing page ${i + 1} of ${pageImages.length}...`);
        let text = '';
        if (engine === 'ai') {
          text = await runAiVisionOcr(pageImages[i], ocrLang);
          setProgress(Math.round(((i + 1) / pageImages.length) * 100));
        } else {
          text = await runOnDeviceOcr(pageImages[i], ocrLang, (pct, st) => {
            const overall = Math.round(((i + pct / 100) / pageImages.length) * 100);
            setProgress(overall);
            setStatusText(`Page ${i + 1}/${pageImages.length}: ${st}`);
          });
        }
        outPages.push({ imageDataUrl: pageImages[i], ocrText: text });
      }
      setExtractedPages(outPages);
      setCombinedText(
        outPages
          .map((p, idx) => (outPages.length > 1 ? `--- Page ${idx + 1} ---\n${p.ocrText}` : p.ocrText))
          .join('\n\n')
      );
      setStatusText('OCR completed');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'OCR processing failed');
    } finally {
      setRunning(false);
    }
  };

  const handleSaveSearchable = async () => {
    if (extractedPages.length === 0) return;
    const pdfBytes = await createSearchablePdfFromOcr(extractedPages);
    const thumb = await renderPageThumbnail(pdfBytes, 1, 200).catch(() => extractedPages[0].imageDataUrl);
    const now = Date.now();
    const baseName =
      sourceType === 'pdf' && selectedDoc
        ? selectedDoc.name.replace(/\.pdf$/i, '_searchable.pdf')
        : `OCR_Searchable_${new Date(now).toISOString().slice(0, 10)}.pdf`;

    await onSaveSearchablePdf({
      id: `doc_ocr_${now}`,
      name: baseName,
      origin: 'scanned',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      sizeBytes: pdfBytes.byteLength,
      pageCount: extractedPages.length,
      isStarred: false,
      isShared: false,
      isTrashed: false,
      folderId: null,
      thumbnailDataUrl: thumb,
      pdfBytes: cloneBuffer(pdfBytes),
      versions: [
        {
          id: `ver_${now}`,
          timestamp: now,
          note: `OCR Searchable PDF (${ocrLang})`,
          sizeBytes: pdfBytes.byteLength,
          pdfBytes: cloneBuffer(pdfBytes),
        },
      ],
    });
    onClose();
  };

  const matchCount =
    searchQuery.trim() && combinedText
      ? combinedText.toLowerCase().split(searchQuery.trim().toLowerCase()).length - 1
      : 0;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120]">
      <header className="flex items-center justify-between px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="font-display text-sm font-bold text-[#142B4A] dark:text-white">
              {t.ocr.title}
            </h1>
            <p className="text-[11px] text-slate-500">English &amp; বাংলা Recognition</p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-3xl w-full mx-auto space-y-4">
        {/* Source Picker */}
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            <button
              onClick={() => setSourceType('pdf')}
              className={`min-h-[40px] rounded-lg text-xs font-semibold ${
                sourceType === 'pdf'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              Scanned PDF from Vault
            </button>
            <button
              onClick={() => setSourceType('image')}
              className={`min-h-[40px] rounded-lg text-xs font-semibold ${
                sourceType === 'image'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              Image / Photo
            </button>
          </div>

          {sourceType === 'pdf' ? (
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            >
              {docs
                .filter((d) => !d.isTrashed && !d.isVaultLocked)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.pageCount} pages)
                  </option>
                ))}
            </select>
          ) : (
            <label className="flex items-center justify-center gap-2 min-h-[56px] rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 cursor-pointer hover:border-[#2563EB] text-sm font-semibold text-[#2563EB]">
              <ImagePlus className="w-5 h-5" />
              <span>Select Photo or Scanned Image</span>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleUploadImage}
                className="hidden"
              />
            </label>
          )}

          {pageImages.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-1">
              {pageImages.map((img, i) => (
                <img
                  key={i}
                  src={img}
                  alt={`Page ${i + 1}`}
                  className="h-24 w-auto rounded-lg border border-slate-200 dark:border-slate-700 shrink-0"
                />
              ))}
            </div>
          )}
        </div>

        {/* Language & Engine Configuration */}
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
              {t.ocr.language}
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'eng', label: t.ocr.langEn },
                  { id: 'ben', label: t.ocr.langBn },
                  { id: 'eng+ben', label: t.ocr.langBoth },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  onClick={() => setOcrLang(item.id)}
                  className={`min-h-[42px] rounded-xl text-xs font-semibold border transition-colors ${
                    ocrLang === item.id
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
              OCR Engine
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={() => setEngine('device')}
                className={`min-h-[46px] px-3 rounded-xl text-xs font-semibold border text-left flex items-center gap-2 ${
                  engine === 'device'
                    ? 'bg-[#142B4A] text-white border-[#142B4A]'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <ScanText className="w-4 h-4 shrink-0" />
                <span>{t.ocr.engineDevice}</span>
              </button>
              <button
                onClick={() => setEngine('ai')}
                disabled={localOnlyMode}
                className={`min-h-[46px] px-3 rounded-xl text-xs font-semibold border text-left flex items-center gap-2 disabled:opacity-40 ${
                  engine === 'ai'
                    ? 'bg-[#2563EB] text-white border-[#2563EB]'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Sparkles className="w-4 h-4 shrink-0" />
                <span>{t.ocr.engineAi}</span>
              </button>
            </div>
          </div>

          {engine === 'ai' && !aiConsentGranted && !localOnlyMode && (
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs space-y-2">
              <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  AI Vision OCR sends the page image securely to our Gemini server endpoint for high-accuracy Bengali/English layout extraction.
                </span>
              </div>
              <button
                onClick={onGrantAiConsent}
                className="min-h-[38px] px-3 rounded-lg bg-[#2563EB] text-white font-semibold"
              >
                Allow AI Vision OCR
              </button>
            </div>
          )}

          <button
            onClick={handleRunOcr}
            disabled={running || pageImages.length === 0 || (engine === 'ai' && !aiConsentGranted)}
            className="w-full min-h-[48px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-sm font-semibold flex items-center justify-center gap-2"
          >
            <ScanText className="w-4 h-4" />
            <span>{running ? `${statusText} (${progress}%)` : t.ocr.startOcr}</span>
          </button>

          {running && (
            <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-[#06B6D4] transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {errorMsg && (
            <p className="text-xs text-rose-600 dark:text-rose-400">{errorMsg}</p>
          )}
        </div>

        {/* Recognized Text Output */}
        {combinedText && (
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 bg-slate-100 dark:bg-slate-800 rounded-xl px-3 min-h-[40px]">
                <Search className="w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search recognized text..."
                  className="bg-transparent text-xs flex-1 focus:outline-none"
                />
                {searchQuery && (
                  <span className="text-[11px] font-mono-nums text-[#2563EB]">
                    {matchCount} hits
                  </span>
                )}
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(combinedText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="min-h-[40px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center gap-1.5"
              >
                <Copy className="w-3.5 h-3.5" />
                {copied ? 'Copied' : t.ocr.copyAll}
              </button>
            </div>

            <textarea
              value={combinedText}
              onChange={(e) => setCombinedText(e.target.value)}
              rows={10}
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                onClick={() => {
                  const buf = new TextEncoder().encode(combinedText).buffer;
                  downloadArrayBuffer(buf, 'ocr-extracted.txt', 'text/plain;charset=utf-8');
                }}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                {t.ocr.exportTxt}
              </button>
              <button
                onClick={() => {
                  const html = combinedText
                    .split('\n\n')
                    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
                    .join('');
                  onOpenInWordCreator(html);
                }}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <FileText className="w-4 h-4 text-[#2563EB]" />
                {t.ocr.exportDocx}
              </button>
              <button
                onClick={handleSaveSearchable}
                className="min-h-[44px] rounded-xl bg-[#142B4A] dark:bg-[#2563EB] text-white text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <ScanText className="w-4 h-4" />
                {t.ocr.makeSearchablePdf}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
