import React from 'react';
import {
  Camera,
  FilePlus2,
  FileText,
  Image as ImageIcon,
  ScanText,
} from 'lucide-react';
import type { ActiveWorkspace, AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import { formatBytes } from '../services/storageService';

interface CreateTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
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
  onOpenWorkspace,
  onStartFromTemplate,
}) => {
  const t = getT(language);
  const createdDrafts = docs.filter(
    (d) => !d.isTrashed && d.origin === 'created' && d.editableHtml
  );

  return (
    <div className="space-y-6 pb-8">
      {/* Primary Creation Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onClick={() => onOpenWorkspace({ type: 'wordCreator' })}
          className="flex items-center gap-4 p-5 rounded-3xl bg-[#142B4A] dark:bg-[#2563EB] text-white text-left shadow-md active:scale-[0.99] transition-transform"
        >
          <div className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
            <FilePlus2 className="w-6 h-6" />
          </div>
          <div>
            <h2 className="font-display text-base font-bold">{t.creator.newBlank}</h2>
            <p className="text-xs text-slate-200 mt-0.5">
              A0–A6, Letter, Legal · Rich Word-like Editor
            </p>
          </div>
        </button>

        <button
          onClick={() => onOpenWorkspace({ type: 'scanner' })}
          className="flex items-center gap-4 p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-left active:scale-[0.99] transition-transform"
        >
          <div className="w-12 h-12 rounded-2xl bg-[#06B6D4]/15 text-[#0891B2] dark:text-[#22D3EE] flex items-center justify-center shrink-0">
            <Camera className="w-6 h-6" />
          </div>
          <div>
            <h2 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
              {t.home.actions.scanDoc}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Camera capture, auto-crop &amp; multi-page PDF
            </p>
          </div>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <button
          onClick={() => onOpenWorkspace({ type: 'toolRunner', toolId: 'imagesToPdf' })}
          className="flex items-center gap-3 p-3.5 min-h-[60px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-left"
        >
          <ImageIcon className="w-5 h-5 text-emerald-600 shrink-0" />
          <span className="text-xs font-semibold">Images to PDF</span>
        </button>
        <button
          onClick={() => onOpenWorkspace({ type: 'ocr' })}
          className="flex items-center gap-3 p-3.5 min-h-[60px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-left"
        >
          <ScanText className="w-5 h-5 text-[#2563EB] shrink-0" />
          <span className="text-xs font-semibold">OCR Image to Doc</span>
        </button>
      </div>

      {/* Templates */}
      <section className="space-y-3">
        <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
          {t.creator.templates}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => onStartFromTemplate(tpl.html)}
              className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-[#2563EB]/50 text-left space-y-1.5"
            >
              <p className="text-sm font-bold text-[#142B4A] dark:text-white">
                {tpl.title}
              </p>
              <p className="text-xs text-slate-500">{tpl.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Saved Editable Drafts */}
      {createdDrafts.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
            Editable Drafts
          </h3>
          <div className="space-y-2">
            {createdDrafts.map((d) => (
              <button
                key={d.id}
                onClick={() => onOpenWorkspace({ type: 'wordCreator', docId: d.id })}
                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-5 h-5 text-[#2563EB] shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{d.name}</p>
                    <p className="text-xs text-slate-500 font-mono-nums">
                      {formatBytes(d.sizeBytes)} · {new Date(d.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <span className="text-xs font-semibold text-[#2563EB] shrink-0 ml-2">
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
