import React, { useState } from 'react';
import { ArrowLeft, GitCompare, Minus, Plus } from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import { extractDocumentPagesText, renderPageToDataUrl } from '../services/pdfEngine';
import { comparePdfPagesText, type PageComparisonResult } from '../services/diffEngine';

interface CompareViewProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  initialDocA?: string;
  initialDocB?: string;
  onClose: () => void;
}

export const CompareView: React.FC<CompareViewProps> = ({
  language,
  docs,
  initialDocA,
  initialDocB,
  onClose,
}) => {
  const t = getT(language);
  const available = docs.filter((d) => !d.isTrashed && !d.isVaultLocked);
  const [docAId, setDocAId] = useState(initialDocA || available[0]?.id || '');
  const [docBId, setDocBId] = useState(initialDocB || available[1]?.id || available[0]?.id || '');
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<'diff' | 'sideBySide'>('diff');
  const [summary, setSummary] = useState<{
    pages: PageComparisonResult[];
    totalAdded: number;
    totalDeleted: number;
    totalUnchanged: number;
  } | null>(null);
  const [sideImages, setSideImages] = useState<Array<{ a?: string; b?: string; page: number }>>([]);

  const runComparison = async () => {
    const docA = available.find((d) => d.id === docAId);
    const docB = available.find((d) => d.id === docBId);
    if (!docA || !docB) return;
    setRunning(true);
    try {
      const [pagesA, pagesB] = await Promise.all([
        extractDocumentPagesText(docA.pdfBytes),
        extractDocumentPagesText(docB.pdfBytes),
      ]);
      const result = comparePdfPagesText(pagesA, pagesB);
      setSummary(result);

      const maxP = Math.min(6, Math.max(docA.pageCount, docB.pageCount));
      const imgs: Array<{ a?: string; b?: string; page: number }> = [];
      for (let p = 1; p <= maxP; p++) {
        const aUrl = p <= docA.pageCount ? await renderPageToDataUrl(docA.pdfBytes, p, 1.0, 'image/jpeg') : undefined;
        const bUrl = p <= docB.pageCount ? await renderPageToDataUrl(docB.pdfBytes, p, 1.0, 'image/jpeg') : undefined;
        imgs.push({ a: aUrl, b: bUrl, page: p });
      }
      setSideImages(imgs);
    } finally {
      setRunning(false);
    }
  };

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
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-4xl w-full mx-auto space-y-4">
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                {t.compare.selectFirst}
              </label>
              <select
                value={docAId}
                onChange={(e) => setDocAId(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              >
                {available.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.pageCount}p)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                {t.compare.selectSecond}
              </label>
              <select
                value={docBId}
                onChange={(e) => setDocBId(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              >
                {available.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.pageCount}p)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={runComparison}
            disabled={running || available.length === 0}
            className="w-full min-h-[46px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-sm font-semibold flex items-center justify-center gap-2"
          >
            <GitCompare className="w-4 h-4" />
            <span>{running ? 'Comparing...' : t.compare.runCompare}</span>
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
                {summary.pages.map((pg) => (
                  <div
                    key={pg.pageNumber}
                    className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-500 border-b border-slate-100 dark:border-slate-800 pb-2">
                      <span>Page {pg.pageNumber}</span>
                      <span className="font-mono-nums">
                        +{pg.addedCount} / -{pg.deletedCount}
                      </span>
                    </div>
                    {pg.lines.length === 0 ? (
                      <p className="text-xs text-slate-400">No text extracted on this page.</p>
                    ) : (
                      <div className="space-y-1 font-mono text-xs leading-relaxed">
                        {pg.lines.map((line, idx) => (
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
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {sideImages.map((item) => (
                  <div
                    key={item.page}
                    className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 space-y-2"
                  >
                    <p className="text-xs font-semibold text-slate-500">Page {item.page}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
                        {item.a ? (
                          <img src={item.a} alt={`A Page ${item.page}`} className="w-full rounded-lg" />
                        ) : (
                          <div className="h-40 flex items-center justify-center text-xs text-slate-400">
                            No page
                          </div>
                        )}
                      </div>
                      <div className="rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
                        {item.b ? (
                          <img src={item.b} alt={`B Page ${item.page}`} className="w-full rounded-lg" />
                        ) : (
                          <div className="h-40 flex items-center justify-center text-xs text-slate-400">
                            No page
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
