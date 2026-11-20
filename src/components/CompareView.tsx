import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  GitCompare,
  Loader2,
  Minus,
  Plus,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import { extractDocumentPagesText, renderPageToDataUrl } from '../services/pdfEngine';
import {
  comparePdfPagesText,
  formatDiffReportText,
  type PageComparisonResult,
} from '../services/diffEngine';
import { saveBufferToDeviceStorage } from '../services/deviceFileActions';
import { formatBytes } from '../services/storageService';
import { PdfSourcePicker } from './PdfSourcePicker';

interface CompareViewProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  initialDocA?: string;
  initialDocB?: string;
  onImportDoc?: (doc: DocumentRecord) => Promise<void>;
  onClose: () => void;
}

export const CompareView: React.FC<CompareViewProps> = ({
  language,
  docs,
  initialDocA,
  initialDocB,
  onImportDoc,
  onClose,
}) => {
  const t = getT(language);
  const available = docs.filter((d) => !d.isTrashed && !d.isVaultLocked);
  const recentSorted = [...available].sort(
    (a, b) => (b.lastOpenedAt || b.updatedAt) - (a.lastOpenedAt || a.updatedAt)
  );
  const [docAId, setDocAId] = useState(initialDocA || recentSorted[0]?.id || '');
  const [docBId, setDocBId] = useState(
    initialDocB || recentSorted[1]?.id || recentSorted[0]?.id || ''
  );
  const [pickerSlot, setPickerSlot] = useState<'a' | 'b' | null>('a');
  const [running, setRunning] = useState(false);
  const [loadingMoreSide, setLoadingMoreSide] = useState(false);
  const [mode, setMode] = useState<'diff' | 'sideBySide'>('diff');
  const [diffFilter, setDiffFilter] = useState<'all' | 'changes'>('all');
  const [changedPagesOnly, setChangedPagesOnly] = useState(false);
  const [summary, setSummary] = useState<{
    pages: PageComparisonResult[];
    totalAdded: number;
    totalDeleted: number;
    totalUnchanged: number;
  } | null>(null);
  const [sideImages, setSideImages] = useState<Array<{ a?: string; b?: string; page: number }>>([]);
  const [comparedPair, setComparedPair] = useState<{ a: DocumentRecord; b: DocumentRecord } | null>(
    null
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const docAObj = available.find((d) => d.id === docAId);
  const docBObj = available.find((d) => d.id === docBId);

  const renderSideRange = async (
    docA: DocumentRecord,
    docB: DocumentRecord,
    startPage: number,
    endPage: number
  ) => {
    const imgs: Array<{ a?: string; b?: string; page: number }> = [];
    for (let p = startPage; p <= endPage; p++) {
      const aUrl =
        p <= docA.pageCount
          ? await renderPageToDataUrl(docA.pdfBytes, p, 1.0, 'image/jpeg')
          : undefined;
      const bUrl =
        p <= docB.pageCount
          ? await renderPageToDataUrl(docB.pdfBytes, p, 1.0, 'image/jpeg')
          : undefined;
      imgs.push({ a: aUrl, b: bUrl, page: p });
    }
    return imgs;
  };

  const runComparison = async () => {
    const docA = available.find((d) => d.id === docAId);
    const docB = available.find((d) => d.id === docBId);
    if (!docA || !docB) return;
    setPickerSlot(null);
    setRunning(true);
    setErrorMsg(null);
    try {
      const [pagesA, pagesB] = await Promise.all([
        extractDocumentPagesText(docA.pdfBytes),
        extractDocumentPagesText(docB.pdfBytes),
      ]);
      const result = comparePdfPagesText(pagesA, pagesB);
      setSummary(result);
      setComparedPair({ a: docA, b: docB });

      const initialMax = Math.min(6, Math.max(docA.pageCount, docB.pageCount));
      const imgs = await renderSideRange(docA, docB, 1, initialMax);
      setSideImages(imgs);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to compare selected PDFs.');
    } finally {
      setRunning(false);
    }
  };

  const handleLoadMoreSide = async (loadAll = false) => {
    if (!comparedPair || loadingMoreSide) return;
    const totalMax = Math.max(comparedPair.a.pageCount, comparedPair.b.pageCount);
    const nextStart = sideImages.length + 1;
    if (nextStart > totalMax) return;
    const nextEnd = loadAll ? totalMax : Math.min(totalMax, sideImages.length + 6);
    setLoadingMoreSide(true);
    try {
      const more = await renderSideRange(comparedPair.a, comparedPair.b, nextStart, nextEnd);
      setSideImages((prev) => [...prev, ...more]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to render additional pages.');
    } finally {
      setLoadingMoreSide(false);
    }
  };

  const handleSwapDocs = () => {
    setDocAId(docBId);
    setDocBId(docAId);
  };

  const handleExportReport = async () => {
    if (!summary || !comparedPair) return;
    const report = formatDiffReportText(comparedPair.a.name, comparedPair.b.name, summary);
    const buf = new TextEncoder().encode(report).buffer;
    const baseA = comparedPair.a.name.replace(/\.pdf$/i, '');
    const baseB = comparedPair.b.name.replace(/\.pdf$/i, '');
    await saveBufferToDeviceStorage(buf, `Compare_${baseA}_vs_${baseB}.txt`, 'text/plain;charset=utf-8');
  };

  const totalSidePages = comparedPair
    ? Math.max(comparedPair.a.pageCount, comparedPair.b.pageCount)
    : 0;

  const visibleDiffPages = summary
    ? summary.pages.filter((pg) => !changedPagesOnly || pg.addedCount > 0 || pg.deletedCount > 0)
    : [];

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
          <h1 className="font-display text-sm font-bold text-[#142B4A] dark:text-white">
            {t.compare.title}
          </h1>
        </div>
        {summary && (
          <button
            type="button"
            onClick={() => void handleExportReport()}
            className="min-h-[38px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>{language === 'bn' ? 'রিপোর্ট (.TXT)' : 'Export .TXT'}</span>
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-4xl w-full mx-auto space-y-4">
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-stretch gap-2.5">
            {/* Slot A Summary Toggle */}
            <button
              type="button"
              onClick={() => setPickerSlot((cur) => (cur === 'a' ? null : 'a'))}
              className={`p-3 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                pickerSlot === 'a'
                  ? 'border-[#2563EB] bg-[#2563EB]/10'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70'
              }`}
            >
              <div className="min-w-0">
                <span className="block text-[10.5px] font-bold uppercase tracking-wider text-[#2563EB]">
                  {t.compare.selectFirst}
                </span>
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#142B4A] dark:text-white truncate mt-0.5">
                  <FileText className="w-3.5 h-3.5 shrink-0 text-[#2563EB]" />
                  <span className="truncate">
                    {docAObj?.name || (language === 'bn' ? 'পিডিএফ A বাছুন' : 'Choose PDF A')}
                  </span>
                </span>
                {docAObj && (
                  <span className="block text-[10.5px] font-mono-nums text-slate-500 mt-0.5">
                    {docAObj.pageCount}p · {formatBytes(docAObj.sizeBytes)}
                  </span>
                )}
              </div>
              {pickerSlot === 'a' ? (
                <ChevronUp className="w-4 h-4 text-[#2563EB] shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
              )}
            </button>

            <button
              type="button"
              onClick={handleSwapDocs}
              disabled={!docAId || !docBId}
              aria-label="Swap A and B"
              title={language === 'bn' ? 'A এবং B অদলবদল করুন' : 'Swap A and B'}
              className="min-h-[40px] sm:min-w-[44px] px-3 sm:px-0 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span className="sm:hidden">{language === 'bn' ? 'অদলবদল' : 'Swap A ↔ B'}</span>
            </button>

            {/* Slot B Summary Toggle */}
            <button
              type="button"
              onClick={() => setPickerSlot((cur) => (cur === 'b' ? null : 'b'))}
              className={`p-3 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                pickerSlot === 'b'
                  ? 'border-[#06B6D4] bg-[#06B6D4]/10'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70'
              }`}
            >
              <div className="min-w-0">
                <span className="block text-[10.5px] font-bold uppercase tracking-wider text-[#06B6D4]">
                  {t.compare.selectSecond}
                </span>
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#142B4A] dark:text-white truncate mt-0.5">
                  <FileText className="w-3.5 h-3.5 shrink-0 text-[#06B6D4]" />
                  <span className="truncate">
                    {docBObj?.name || (language === 'bn' ? 'পিডিএফ B বাছুন' : 'Choose PDF B')}
                  </span>
                </span>
                {docBObj && (
                  <span className="block text-[10.5px] font-mono-nums text-slate-500 mt-0.5">
                    {docBObj.pageCount}p · {formatBytes(docBObj.sizeBytes)}
                  </span>
                )}
              </div>
              {pickerSlot === 'b' ? (
                <ChevronUp className="w-4 h-4 text-[#06B6D4] shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
              )}
            </button>
          </div>

          {pickerSlot && (
            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700">
              <PdfSourcePicker
                language={language}
                docs={docs}
                selectedDocId={pickerSlot === 'a' ? docAId : docBId}
                compact
                maxListHeightClass="max-h-40"
                label={
                  pickerSlot === 'a'
                    ? `${t.compare.selectFirst} — ${language === 'bn' ? 'ডিভাইস স্টোরেজ বা রিসেন্ট ফাইল' : 'Device Storage or Recent Files'}`
                    : `${t.compare.selectSecond} — ${language === 'bn' ? 'ডিভাইস স্টোরেজ বা রিসেন্ট ফাইল' : 'Device Storage or Recent Files'}`
                }
                onImportDoc={onImportDoc}
                onSelectDoc={(d) => {
                  if (pickerSlot === 'a') {
                    setDocAId(d.id);
                    setPickerSlot('b');
                  } else {
                    setDocBId(d.id);
                    setPickerSlot(null);
                  }
                }}
              />
            </div>
          )}

          {docAId && docBId && docAId === docBId && (
            <p className="text-xs text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2">
              {language === 'bn'
                ? 'দুটি আলাদা ডকুমেন্ট নির্বাচন করলে পরিবর্তনগুলো দেখা যাবে (বর্তমানে একই ফাইল নির্বাচিত)।'
                : 'Tip: Pick two different documents above to highlight differences (currently comparing the same file).'}
            </p>
          )}

          {errorMsg && (
            <p className="text-xs text-rose-700 dark:text-rose-200 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl px-3 py-2">
              {errorMsg}
            </p>
          )}

          <button
            onClick={runComparison}
            disabled={running || !docAObj || !docBObj}
            className="w-full min-h-[46px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-sm font-semibold flex items-center justify-center gap-2"
          >
            <GitCompare className="w-4 h-4" />
            <span>
              {running
                ? language === 'bn'
                  ? 'তুলনা হচ্ছে...'
                  : 'Comparing...'
                : t.compare.runCompare}
            </span>
          </button>
        </div>

        {summary && (
          <>
            {/* Summary Metrics */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 p-3 text-center">
                <p className="text-xl font-bold font-mono-nums text-emerald-700 dark:text-emerald-300">
                  +{summary.totalAdded}
                </p>
                <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  {t.compare.added}
                </p>
              </div>
              <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-3 text-center">
                <p className="text-xl font-bold font-mono-nums text-rose-700 dark:text-rose-300">
                  -{summary.totalDeleted}
                </p>
                <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                  {t.compare.deleted}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-100 dark:bg-slate-800 p-3 text-center">
                <p className="text-xl font-bold font-mono-nums text-slate-800 dark:text-slate-200">
                  {summary.totalUnchanged}
                </p>
                <p className="text-[11px] font-semibold text-slate-500">
                  {t.compare.unchanged}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800">
              <button
                onClick={() => setMode('diff')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold ${
                  mode === 'diff'
                    ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {t.compare.textDiff}
              </button>
              <button
                onClick={() => setMode('sideBySide')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold ${
                  mode === 'sideBySide'
                    ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {t.compare.sideBySide}
              </button>
            </div>

            {mode === 'diff' ? (
              <div className="space-y-3">
                {/* Diff Filter Controls */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDiffFilter('all')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                        diffFilter === 'all'
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {language === 'bn' ? 'সব লাইন' : 'All Lines'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiffFilter('changes')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                        diffFilter === 'changes'
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {language === 'bn' ? 'শুধু পরিবর্তন' : 'Differences Only'}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setChangedPagesOnly((v) => !v)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                      changedPagesOnly
                        ? 'bg-[#06B6D4] text-white border-[#06B6D4]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {language === 'bn' ? 'শুধু পরিবর্তিত পৃষ্ঠা' : 'Changed Pages Only'}
                  </button>
                </div>

                {visibleDiffPages.length === 0 ? (
                  <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 text-center text-xs text-slate-500">
                    {language === 'bn'
                      ? 'উভয় ডকুমেন্টের টেক্সট একই রয়েছে।'
                      : 'No text differences detected between the two documents.'}
                  </div>
                ) : (
                  visibleDiffPages.map((pg) => {
                    const linesToShow =
                      diffFilter === 'changes'
                        ? pg.lines.filter((l) => l.type !== 'equal')
                        : pg.lines;
                    return (
                      <div
                        key={pg.pageNumber}
                        className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-2"
                      >
                        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 border-b border-slate-100 dark:border-slate-800 pb-2">
                          <span>
                            {t.viewer.page} {pg.pageNumber}
                          </span>
                          <span className="font-mono-nums">
                            +{pg.addedCount} / -{pg.deletedCount}
                          </span>
                        </div>
                        {linesToShow.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            {pg.lines.length === 0
                              ? language === 'bn'
                                ? 'এই পৃষ্ঠায় কোনো টেক্সট পাওয়া যায়নি।'
                                : 'No text extracted on this page.'
                              : language === 'bn'
                              ? 'এই পৃষ্ঠায় কোনো পরিবর্তন নেই।'
                              : 'No differences on this page.'}
                          </p>
                        ) : (
                          <div className="space-y-1 font-mono text-xs leading-relaxed">
                            {linesToShow.map((line, idx) => (
                              <div
                                key={idx}
                                className={`flex items-start gap-2 px-2 py-1 rounded-lg ${
                                  line.type === 'added'
                                    ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200'
                                    : line.type === 'deleted'
                                    ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 line-through'
                                    : 'text-slate-600 dark:text-slate-400'
                                }`}
                              >
                                <span className="shrink-0 mt-0.5">
                                  {line.type === 'added' ? (
                                    <Plus className="w-3.5 h-3.5" />
                                  ) : line.type === 'deleted' ? (
                                    <Minus className="w-3.5 h-3.5" />
                                  ) : (
                                    <span className="inline-block w-3.5" />
                                  )}
                                </span>
                                <span className="break-words">{line.text}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {sideImages.map((item) => (
                  <div
                    key={item.page}
                    className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 space-y-2"
                  >
                    <p className="text-xs font-semibold text-slate-500">
                      {t.viewer.page} {item.page}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
                        {item.a ? (
                          <img src={item.a} alt={`A Page ${item.page}`} className="w-full rounded-lg" />
                        ) : (
                          <div className="h-40 flex items-center justify-center text-xs text-slate-400">
                            {language === 'bn' ? 'পৃষ্ঠা নেই' : 'No page'}
                          </div>
                        )}
                      </div>
                      <div className="rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
                        {item.b ? (
                          <img src={item.b} alt={`B Page ${item.page}`} className="w-full rounded-lg" />
                        ) : (
                          <div className="h-40 flex items-center justify-center text-xs text-slate-400">
                            {language === 'bn' ? 'পৃষ্ঠা নেই' : 'No page'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {sideImages.length < totalSidePages && (
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={loadingMoreSide}
                      onClick={() => void handleLoadMoreSide(false)}
                      className="min-h-[42px] px-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {loadingMoreSide && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>
                        {language === 'bn'
                          ? `আরও পৃষ্ঠা লোড করুন (${sideImages.length}/${totalSidePages})`
                          : `Load More Pages (${sideImages.length}/${totalSidePages})`}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={loadingMoreSide}
                      onClick={() => void handleLoadMoreSide(true)}
                      className="min-h-[42px] px-4 rounded-xl bg-[#2563EB] text-white text-xs font-semibold disabled:opacity-50"
                    >
                      {language === 'bn'
                        ? `বাকি সব (${totalSidePages - sideImages.length})`
                        : `Load All Remaining (${totalSidePages - sideImages.length})`}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

