import React, { useMemo, useState } from 'react';
import {
  Camera,
  ChevronRight,
  Combine,
  Edit3,
  FilePlus2,
  FileText,
  FolderOpen,
  Minimize2,
  RefreshCw,
  ScanText,
  Search,
  Sparkles,
  Star,
} from 'lucide-react';
import type {
  ActiveWorkspace,
  AppLanguage,
  DocumentCategory,
  DocumentRecord,
} from '../types';
import { getT } from '../i18n/translations';
import { formatBytes } from '../services/storageService';

interface HomeTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  onImportPdf: () => void;
  onOpenWorkspace: (ws: ActiveWorkspace) => void;
  onNavigateFiles: (cat: DocumentCategory) => void;
  onNavigateTools: () => void;
}

export const HomeTab: React.FC<HomeTabProps> = ({
  language,
  docs,
  onImportPdf,
  onOpenWorkspace,
  onNavigateFiles,
  onNavigateTools,
}) => {
  const t = getT(language);
  const [search, setSearch] = useState('');

  const activeDocs = useMemo(
    () => docs.filter((d) => !d.isTrashed).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [docs]
  );

  const filteredDocs = useMemo(() => {
    if (!search.trim()) return activeDocs.slice(0, 6);
    const q = search.toLowerCase();
    return activeDocs.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 8);
  }, [activeDocs, search]);

  const firstEditableDoc = activeDocs.find((d) => !d.isVaultLocked);

  const quickActions = [
    {
      id: 'edit',
      label: t.home.actions.editPdf,
      icon: <Edit3 className="w-5 h-5" />,
      tint: 'bg-[#2563EB]/10 text-[#2563EB] dark:bg-[#2563EB]/20 dark:text-[#60A5FA]',
      onClick: () => {
        if (firstEditableDoc) {
          onOpenWorkspace({ type: 'editor', docId: firstEditableDoc.id });
        } else {
          onImportPdf();
        }
      },
    },
    {
      id: 'scan',
      label: t.home.actions.scanDoc,
      icon: <Camera className="w-5 h-5" />,
      tint: 'bg-[#06B6D4]/12 text-[#0891B2] dark:bg-[#06B6D4]/20 dark:text-[#22D3EE]',
      onClick: () => onOpenWorkspace({ type: 'scanner' }),
    },
    {
      id: 'create',
      label: t.home.actions.createDoc,
      icon: <FilePlus2 className="w-5 h-5" />,
      tint: 'bg-[#142B4A]/10 text-[#142B4A] dark:bg-slate-800 dark:text-slate-100',
      onClick: () => onOpenWorkspace({ type: 'wordCreator' }),
    },
    {
      id: 'merge',
      label: t.home.actions.mergePdf,
      icon: <Combine className="w-5 h-5" />,
      tint: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'merge' }),
    },
    {
      id: 'convert',
      label: t.home.actions.convertPdf,
      icon: <RefreshCw className="w-5 h-5" />,
      tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
      onClick: () => onNavigateTools(),
    },
    {
      id: 'compress',
      label: t.home.actions.compressPdf,
      icon: <Minimize2 className="w-5 h-5" />,
      tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'compress' }),
    },
    {
      id: 'ocr',
      label: t.home.actions.ocrText,
      icon: <ScanText className="w-5 h-5" />,
      tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
      onClick: () => onOpenWorkspace({ type: 'ocr' }),
    },
    {
      id: 'ai',
      label: t.home.actions.aiAssistant,
      icon: <Sparkles className="w-5 h-5" />,
      tint: 'bg-[#2563EB] text-white',
      onClick: () =>
        onOpenWorkspace({ type: 'aiAssistant', docId: firstEditableDoc?.id }),
    },
  ];

  const collections: Array<{
    id: DocumentCategory;
    label: string;
    count: number;
    icon: React.ReactNode;
  }> = [
    {
      id: 'my',
      label: t.home.myDocs,
      count: activeDocs.length,
      icon: <FolderOpen className="w-4 h-4 text-[#2563EB]" />,
    },
    {
      id: 'scanned',
      label: t.home.scannedDocs,
      count: activeDocs.filter((d) => d.origin === 'scanned').length,
      icon: <Camera className="w-4 h-4 text-[#06B6D4]" />,
    },
    {
      id: 'created',
      label: t.home.createdDocs,
      count: activeDocs.filter((d) => d.origin === 'created').length,
      icon: <FilePlus2 className="w-4 h-4 text-emerald-600" />,
    },
    {
      id: 'starred',
      label: t.home.starredDocs,
      count: activeDocs.filter((d) => d.isStarred).length,
      icon: <Star className="w-4 h-4 text-amber-500" />,
    },
  ];

  return (
    <div className="space-y-6 pb-8">
      {/* Search Bar */}
      <div className="flex items-center gap-2 min-h-[48px] px-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.home.searchPlaceholder}
          className="flex-1 bg-transparent text-sm text-slate-900 dark:text-white focus:outline-none"
        />
        <button
          onClick={onImportPdf}
          className="min-h-[36px] px-3 rounded-xl bg-[#142B4A] dark:bg-[#2563EB] text-white text-xs font-semibold whitespace-nowrap shrink-0"
        >
          {t.home.importPdf}
        </button>
      </div>

      {/* Quick Actions Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
            {t.home.quickActions}
          </h2>
          <button
            onClick={onNavigateTools}
            className="min-h-[36px] px-2 text-xs font-semibold text-[#2563EB] flex items-center gap-0.5"
          >
            <span>{t.home.allTools}</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          {quickActions.map((act) => (
            <button
              key={act.id}
              onClick={act.onClick}
              className="flex flex-col items-center justify-center gap-2 p-2.5 min-h-[86px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-[#2563EB]/50 active:scale-[0.97] transition-all"
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${act.tint}`}>
                {act.icon}
              </div>
              <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 text-center leading-tight line-clamp-2">
                {act.label}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Recent Documents */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
            {t.home.recentDocs}
          </h2>
          <button
            onClick={() => onNavigateFiles('recent')}
            className="min-h-[36px] px-2 text-xs font-semibold text-[#2563EB] flex items-center gap-0.5"
          >
            <span>{t.home.viewAll}</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {filteredDocs.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 text-center text-sm text-slate-500">
            {t.home.noDocs}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {filteredDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-3 p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-[#2563EB]/40 transition-colors"
              >
                <button
                  onClick={() => onOpenWorkspace({ type: 'viewer', docId: doc.id })}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left min-h-[56px]"
                >
                  <div className="w-11 h-14 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                    {doc.thumbnailDataUrl ? (
                      <img
                        src={doc.thumbnailDataUrl}
                        alt={doc.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <FileText className="w-5 h-5 text-slate-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#142B4A] dark:text-white truncate">
                      {doc.name}
                    </p>
                    <p className="text-xs text-slate-500 font-mono-nums mt-0.5 truncate">
                      {doc.pageCount}p · {formatBytes(doc.sizeBytes)} ·{' '}
                      {new Date(doc.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => onOpenWorkspace({ type: 'editor', docId: doc.id })}
                  aria-label="Edit PDF"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:text-[#2563EB] hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Document Collections */}
      <section className="space-y-3">
        <h2 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
          {t.home.collections}
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {collections.map((col) => (
            <button
              key={col.id}
              onClick={() => onNavigateFiles(col.id)}
              className="flex items-center justify-between p-3.5 min-h-[60px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-[#2563EB]/40 text-left transition-colors"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0">
                  {col.icon}
                </div>
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                  {col.label}
                </span>
              </div>
              <span className="text-sm font-bold font-mono-nums text-slate-500 ml-2">
                {col.count}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
