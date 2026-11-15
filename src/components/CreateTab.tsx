import React, { useState } from 'react';
import {
  Camera,
  FilePlus2,
  FileText,
  Image as ImageIcon,
  Loader2,
  ScanLine,
} from 'lucide-react';
import type {
  ActiveWorkspace,
  AppLanguage,
  DocumentRecord,
  PaperSizeKey,
} from '../types';
import { getT } from '../i18n/translations';
import { PAPER_DIMENSIONS } from '../services/pdfEngine';
import { formatBytes } from '../services/storageService';

interface CreateTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  defaultPageSize: PaperSizeKey;
  onCreateBlankPdf: (options: {
    paperSize: PaperSizeKey;
    orientation: 'portrait' | 'landscape';
    pageCount: number;
    fileName: string;
    customWidthMm?: number;
    customHeightMm?: number;
  }) => Promise<void>;
  onOpenWorkspace: (ws: ActiveWorkspace) => void;
  onStartFromTemplate: (html: string) => void;
}

const TEMPLATES = [
  {
    id: 'proposal',
    title: 'Business Proposal',
    desc: 'A4 executive summary, milestones & pricing table',
    html: `<h1>Business Proposal 2026</h1><p><strong>Prepared For:</strong> Client Operations</p><h2>1. Executive Overview</h2><p>Outline your project scope, deliverables, and timeline here.</p><h2>2. Investment Breakdown</h2><table style="width:100%;border-collapse:collapse;"><tr><th style="border:1px solid #cbd5e1;padding:6px;background:#eff6ff;">Phase</th><th style="border:1px solid #cbd5e1;padding:6px;background:#eff6ff;">Timeline</th><th style="border:1px solid #cbd5e1;padding:6px;background:#eff6ff;">Amount</th></tr><tr><td style="border:1px solid #cbd5e1;padding:6px;">Discovery &amp; Design</td><td style="border:1px solid #cbd5e1;padding:6px;">2 Weeks</td><td style="border:1px solid #cbd5e1;padding:6px;">$2,400</td></tr><tr><td style="border:1px solid #cbd5e1;padding:6px;">Delivery</td><td style="border:1px solid #cbd5e1;padding:6px;">4 Weeks</td><td style="border:1px solid #cbd5e1;padding:6px;">$4,800</td></tr></table>`,
  },
  {
    id: 'bengali_letter',
    title: 'বাংলা আবেদনপত্র / Notice',
    desc: 'Formal Bengali Unicode template ready for A4 PDF',
    html: `<h1>দাপ্তরিক আবেদনপত্র</h1><p>তারিখ: ১৪ নভেম্বর ২০২৬</p><p>বরাবর,<br/>প্রধান নির্বাহী কর্মকর্তা<br/>প্রতিষ্ঠানের নাম</p><p><strong>বিষয়: প্রয়োজনীয় নথিপত্র অনুমোদনের আবেদন।</strong></p><p>মহোদয়,<br/>সবিনয় নিবেদন এই যে, আমাদের চলমান প্রকল্পের কাজের জন্য প্রয়োজনীয় দলিলপত্র পর্যালোচনা ও স্বাক্ষরের জন্য সংযুক্ত করা হলো।</p><p>বিনীত,<br/>আপনার নাম ও পদবি</p>`,
  },
  {
    id: 'report',
    title: 'Academic / Field Report',
    desc: 'Structured headings, findings & bulleted takeaways',
    html: `<h1>Field Inspection Report</h1><p>Date: November 2026 · Location: Regional Facility</p><h2>Key Findings</h2><ul><li>Primary equipment calibration verified within tolerance.</li><li>Safety compliance checklist completed across all stations.</li></ul><h2>Recommendations</h2><p>Schedule follow-up review in 30 days.</p>`,
  },
];

export const CreateTab: React.FC<CreateTabProps> = ({
  language,
  docs,
  defaultPageSize,
  onCreateBlankPdf,
  onOpenWorkspace,
  onStartFromTemplate,
}) => {
  const t = getT(language);
  const [paperSize, setPaperSize] = useState<PaperSizeKey>(defaultPageSize || 'A4');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [pageCount, setPageCount] = useState<number>(1);
  const [fileName, setFileName] = useState<string>('Untitled');
  const [customWidthMm, setCustomWidthMm] = useState<number>(210);
  const [customHeightMm, setCustomHeightMm] = useState<number>(297);
  const [creating, setCreating] = useState(false);

  const createdDrafts = docs.filter(
    (d) => !d.isTrashed && d.origin === 'created' && d.editableHtml
  );

  const handleBlankSubmit = async () => {
    setCreating(true);
    try {
      await onCreateBlankPdf({
        paperSize,
        orientation,
        pageCount: Math.max(1, Math.min(200, pageCount || 1)),
        fileName: fileName.trim() || `Untitled ${paperSize}`,
        customWidthMm,
        customHeightMm,
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5 pb-8 max-w-3xl mx-auto">
      {/* Header matching Create Screenshot */}
      <div>
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
          {t.nav.create}
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {language === 'bn' ? 'নতুন কিছু তৈরি শুরু করুন' : 'Start something new'}
        </p>
      </div>

      {/* Top 3 Quick Action Tiles matching Screenshot */}
      <div className="grid grid-cols-3 gap-2.5">
        <button
          onClick={() => onOpenWorkspace({ type: 'toolRunner', toolId: 'imagesToPdf' })}
          className="rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-emerald-500/40 p-3.5 flex flex-col items-center justify-center gap-2.5 min-h-[116px] text-center active:scale-[0.98] transition-all"
        >
          <div className="w-11 h-11 rounded-full bg-emerald-500/15 text-emerald-500 flex items-center justify-center">
            <ImageIcon className="w-5 h-5" />
          </div>
          <span className="text-xs font-bold text-slate-900 dark:text-white leading-tight">
            {language === 'bn' ? 'ছবি থেকে পিডিএফ' : 'Images to PDF'}
          </span>
        </button>

        <button
          onClick={() => onOpenWorkspace({ type: 'scanner' })}
          className="rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#06B6D4]/40 p-3.5 flex flex-col items-center justify-center gap-2.5 min-h-[116px] text-center active:scale-[0.98] transition-all"
        >
          <div className="w-11 h-11 rounded-full bg-[#06B6D4]/15 text-[#06B6D4] flex items-center justify-center">
            <ScanLine className="w-5 h-5" />
          </div>
          <span className="text-xs font-bold text-slate-900 dark:text-white leading-tight">
            {language === 'bn' ? 'ডকুমেন্ট স্ক্যান' : 'Scan document'}
          </span>
        </button>

        <button
          onClick={() => onOpenWorkspace({ type: 'wordCreator' })}
          className="rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#3B82F6]/40 p-3.5 flex flex-col items-center justify-center gap-2.5 min-h-[116px] text-center active:scale-[0.98] transition-all"
        >
          <div className="w-11 h-11 rounded-full bg-[#2563EB]/15 text-[#3B82F6] flex items-center justify-center">
            <FileText className="w-5 h-5" />
          </div>
          <span className="text-xs font-bold text-slate-900 dark:text-white leading-tight">
            {language === 'bn' ? 'ওয়ার্ড ডকুমেন্ট' : 'Word-style document'}
          </span>
        </button>
      </div>

      {/* Main Blank PDF Builder Card */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 sm:p-5 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-[#2563EB]/15 text-[#3B82F6] flex items-center justify-center shrink-0">
            <FilePlus2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {language === 'bn' ? 'ফাঁকা পিডিএফ' : 'Blank PDF'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {language === 'bn'
                ? 'যেকোনো কাগজের মাপে খালি পৃষ্ঠা তৈরি করুন'
                : 'Empty pages in any paper size'}
            </p>
          </div>
        </div>

        {/* Page Size Chip Grid */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {language === 'bn' ? 'কাগজের মাপ' : 'Page size'}
          </p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PAPER_DIMENSIONS) as PaperSizeKey[]).map((key) => {
              const selected = paperSize === key;
              return (
                <button
                  key={key}
                  onClick={() => setPaperSize(key)}
                  className={`min-h-[40px] px-4 rounded-full text-xs font-bold border transition-all ${
                    selected
                      ? 'border-[#3B82F6] bg-[#2563EB]/15 text-[#2563EB] dark:text-[#60A5FA] shadow-xs'
                      : 'border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {key}
                </button>
              );
            })}
          </div>
        </div>

        {paperSize === 'Custom' && (
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Width (mm)
              </span>
              <input
                type="number"
                min={40}
                max={2000}
                value={customWidthMm}
                onChange={(e) => setCustomWidthMm(Number(e.target.value) || 210)}
                className="w-full min-h-[44px] px-3.5 rounded-2xl border border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-sm font-mono-nums"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Height (mm)
              </span>
              <input
                type="number"
                min={40}
                max={2000}
                value={customHeightMm}
                onChange={(e) => setCustomHeightMm(Number(e.target.value) || 297)}
                className="w-full min-h-[44px] px-3.5 rounded-2xl border border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-sm font-mono-nums"
              />
            </label>
          </div>
        )}

        {/* Orientation Toggle Pills */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {t.creator.orientation}
          </p>
          <div className="flex flex-wrap gap-2">
            {(['portrait', 'landscape'] as const).map((ori) => {
              const selected = orientation === ori;
              return (
                <button
                  key={ori}
                  onClick={() => setOrientation(ori)}
                  className={`min-h-[40px] px-5 rounded-full text-xs font-bold border transition-all ${
                    selected
                      ? 'border-[#3B82F6] bg-[#2563EB]/15 text-[#2563EB] dark:text-[#60A5FA]'
                      : 'border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {ori === 'portrait' ? t.creator.portrait : t.creator.landscape}
                </button>
              );
            })}
          </div>
        </div>

        {/* Page Count & File Name Inputs */}
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 block">
              {language === 'bn' ? 'পৃষ্ঠা সংখ্যা' : 'Number of pages'}
            </span>
            <input
              type="number"
              min={1}
              max={200}
              value={pageCount}
              onChange={(e) => setPageCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
              className="w-full min-h-[46px] px-4 rounded-full border border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-sm font-mono-nums text-slate-900 dark:text-white focus:outline-none focus:border-[#3B82F6]"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 block">
              {language === 'bn' ? 'ফাইলের নাম' : 'File name'}
            </span>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="Untitled"
              className="w-full min-h-[46px] px-4 rounded-full border border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-sm text-slate-900 dark:text-white focus:outline-none focus:border-[#3B82F6]"
            />
          </label>
        </div>
      </section>

      {/* Primary Gradient CTA */}
      <button
        onClick={handleBlankSubmit}
        disabled={creating}
        className="w-full min-h-[52px] rounded-full bg-gradient-to-r from-[#3B82F6] to-[#06B6D4] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-xl shadow-blue-500/25 active:scale-[0.99] transition-transform disabled:opacity-60"
      >
        {creating ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <FilePlus2 className="w-5 h-5" />
        )}
        <span>{language === 'bn' ? 'ফাঁকা পিডিএফ তৈরি করুন' : 'Create blank PDF'}</span>
      </button>

      {/* Word-Style Document Templates */}
      <section className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
            {t.creator.templates}
          </h3>
          <button
            onClick={() => onOpenWorkspace({ type: 'wordCreator' })}
            className="text-xs font-semibold text-[#3B82F6]"
          >
            {language === 'bn' ? 'খালি ওয়ার্ড ডক' : 'Blank Word Doc'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => onStartFromTemplate(tpl.html)}
              className="p-4 rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#3B82F6]/50 text-left space-y-1.5 active:scale-[0.99]"
            >
              <p className="text-sm font-bold text-slate-900 dark:text-white">
                {tpl.title}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{tpl.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Saved Editable Drafts */}
      {createdDrafts.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
            {language === 'bn' ? 'সংরক্ষিত ড্রাফট' : 'Editable Drafts'}
          </h3>
          <div className="space-y-2">
            {createdDrafts.map((d) => (
              <button
                key={d.id}
                onClick={() => onOpenWorkspace({ type: 'wordCreator', docId: d.id })}
                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Camera className="hidden" />
                  <FileText className="w-5 h-5 text-[#3B82F6] shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{d.name}</p>
                    <p className="text-xs text-slate-500 font-mono-nums">
                      {formatBytes(d.sizeBytes)} · {new Date(d.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <span className="text-xs font-semibold text-[#3B82F6] shrink-0 ml-2">
                  Edit Draft
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
