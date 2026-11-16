import React, { useMemo, useState } from 'react';
import {
  Bot,
  Camera,
  ChevronRight,
  Combine,
  Edit3,
  FilePlus2,
  FileText,
  Folder,
  Image as ImageIcon,
  LayoutGrid,
  Minimize2,
  RefreshCw,
  RotateCw,
  Scissors,
  Search,
  Star,
} from 'lucide-react';
import type {
  ActiveWorkspace,
  AppLanguage,
  DocumentCategory,
  DocumentRecord,
} from '../types';
import { getT } from '../i18n/translations';
import { formatRelativeTime } from '../services/storageService';
import { PdfMasterLogo } from './Logo';

interface HomeTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  onImportPdf: () => void;
  onOpenWorkspace: (ws: ActiveWorkspace) => void;
  onPickDocForWorkspace: (mode: 'editor' | 'organizer') => void;
  onNavigateFiles: (cat: DocumentCategory) => void;
  onNavigateTools: () => void;
}

export const HomeTab: React.FC<HomeTabProps> = ({
  language,
  docs,
  onImportPdf,
  onOpenWorkspace,
  onPickDocForWorkspace,
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
    if (!search.trim()) return activeDocs.slice(0, 10);
    const q = search.toLowerCase();
    return activeDocs.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 12);
  }, [activeDocs, search]);

  const firstEditableDoc = activeDocs.find((d) => !d.isVaultLocked);

  const quickActions = [
    {
      id: 'edit',
      label: language === 'bn' ? 'এডিট পিডিএফ' : 'Edit PDF',
      icon: <Edit3 className="w-5 h-5" />,
      tint: 'bg-[#172542] text-[#3B82F6] dark:bg-[#172542] dark:text-[#60A5FA]',
      onClick: () => onPickDocForWorkspace('editor'),
    },
    {
      id: 'scan',
      label: language === 'bn' ? 'স্ক্যান' : 'Scan',
      icon: <Camera className="w-5 h-5" />,
      tint: 'bg-[#0F2A3A] text-[#06B6D4] dark:bg-[#0F2A3A] dark:text-[#22D3EE]',
      onClick: () => onOpenWorkspace({ type: 'scanner' }),
    },
    {
      id: 'create',
      label: language === 'bn' ? 'নতুন ডকুমেন্ট' : 'New document',
      icon: <FilePlus2 className="w-5 h-5" />,
      tint: 'bg-[#112A27] text-emerald-500 dark:bg-[#112A27] dark:text-emerald-400',
      onClick: () => onOpenWorkspace({ type: 'wordCreator' }),
    },
    {
      id: 'merge',
      label: language === 'bn' ? 'মার্জ পিডিএফ' : 'Merge PDF',
      icon: <Combine className="w-5 h-5" />,
      tint: 'bg-[#2C1826] text-rose-500 dark:bg-[#2C1826] dark:text-rose-400',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'merge' }),
    },
    {
      id: 'convert',
      label: language === 'bn' ? 'কনভার্ট' : 'Convert',
      icon: <RefreshCw className="w-5 h-5" />,
      tint: 'bg-[#2B2214] text-amber-500 dark:bg-[#2B2214] dark:text-amber-400',
      onClick: () => onNavigateTools(),
    },
    {
      id: 'compress',
      label: language === 'bn' ? 'কমপ্রেস' : 'Compress',
      icon: <Minimize2 className="w-5 h-5" />,
      tint: 'bg-[#172542] text-indigo-400 dark:bg-[#172542] dark:text-indigo-300',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'compress' }),
    },
    {
      id: 'ai',
      label: language === 'bn' ? 'এআই অ্যাসিস্ট্যান্ট' : 'AI Assistant',
      icon: <Bot className="w-5 h-5" />,
      tint: 'bg-[#172542] text-[#3B82F6] dark:bg-[#172542] dark:text-[#60A5FA]',
      onClick: () =>
        onOpenWorkspace({ type: 'aiAssistant', docId: firstEditableDoc?.id }),
    },
    {
      id: 'tools',
      label: language === 'bn' ? 'টুলস' : 'Tools',
      icon: <LayoutGrid className="w-5 h-5" />,
      tint: 'bg-[#0F2A3A] text-[#06B6D4] dark:bg-[#0F2A3A] dark:text-[#22D3EE]',
      onClick: () => onNavigateTools(),
    },
  ];

  const collections: Array<{
    id: DocumentCategory;
    label: string;
    count: number;
    icon: React.ReactNode;
    iconBg: string;
  }> = [
    {
      id: 'my',
      label: language === 'bn' ? 'আমার ডকুমেন্ট' : 'My documents',
      count: activeDocs.length,
      icon: <Folder className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
    },
    {
      id: 'scanned',
      label: language === 'bn' ? 'স্ক্যান করা' : 'Scanned',
      count: activeDocs.filter((d) => d.origin === 'scanned').length,
      icon: <Camera className="w-5 h-5 text-[#06B6D4]" />,
      iconBg: 'bg-[#06B6D4]/15',
    },
    {
      id: 'created',
      label: language === 'bn' ? 'তৈরি করা' : 'Created',
      count: activeDocs.filter((d) => d.origin === 'created').length,
      icon: <FilePlus2 className="w-5 h-5 text-emerald-500" />,
      iconBg: 'bg-emerald-500/15',
    },
    {
      id: 'starred',
      label: language === 'bn' ? 'তারকাচিহ্নিত' : 'Starred',
      count: activeDocs.filter((d) => d.isStarred).length,
      icon: <Star className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
    },
  ];

  const featuredTools = [
    {
      id: 'merge',
      name: language === 'bn' ? 'মার্জ পিডিএফ' : 'Merge PDF',
      desc: language === 'bn' ? 'একাধিক পিডিএফ একত্রিত করুন' : 'Combine several PDFs into one',
      icon: <Combine className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
    },
    {
      id: 'split',
      name: language === 'bn' ? 'স্প্লিট ও এক্সট্র্যাক্ট' : 'Split & Extract',
      desc: language === 'bn' ? 'প্রয়োজনীয় পৃষ্ঠা আলাদা করুন' : 'Pick pages to keep or split every page',
      icon: <Scissors className="w-5 h-5 text-rose-500" />,
      iconBg: 'bg-rose-500/15',
    },
    {
      id: 'rotate',
      name: language === 'bn' ? 'রোটেট পিডিএফ' : 'Rotate PDF',
      desc: language === 'bn' ? 'সব পৃষ্ঠা বামে বা ডানে ঘোরান' : 'Turn all pages left or right',
      icon: <RotateCw className="w-5 h-5 text-[#06B6D4]" />,
      iconBg: 'bg-[#06B6D4]/15',
    },
    {
      id: 'imagesToPdf',
      name: language === 'bn' ? 'ছবি থেকে পিডিএফ' : 'Images to PDF',
      desc: language === 'bn' ? 'JPG ও PNG ছবি পিডিএফ করুন' : 'Turn JPG and PNG photos into a PDF',
      icon: <ImageIcon className="w-5 h-5 text-emerald-500" />,
      iconBg: 'bg-emerald-500/15',
    },
    {
      id: 'extractText',
      name: language === 'bn' ? 'পিডিএফ থেকে টেক্সট' : 'PDF to Text',
      desc: language === 'bn' ? 'পিডিএফ থেকে সব টেক্সট বের করুন' : 'Pull out all the text in a PDF',
      icon: <FileText className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
    },
  ];

  return (
    <div className="space-y-6 pb-8">
      {/* Top Hero Header (Blue-to-Navy Gradient Banner matching Screenshot) */}
      <section className="-mx-4 md:mx-0 px-5 pt-5 pb-6 md:rounded-3xl bg-gradient-to-b from-[#1E40AF] via-[#15285A] to-[#0A0F1A] dark:from-[#1B3A7A] dark:via-[#111E3F] dark:to-[#0A0F1A] text-white space-y-5 shadow-lg shadow-blue-950/20">
        <PdfMasterLogo
          size={44}
          showWordmark
          showTagline
          inverse
          tagline={t.tagline}
        />

        <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight leading-snug max-w-md">
          {language === 'bn'
            ? 'আপনার সব ডকুমেন্ট, এক জায়গায়'
            : 'Your documents, all in one place'}
        </h1>

        <div className="flex items-center gap-2.5 min-h-[48px] px-4 rounded-full bg-[#0A0F1A]/75 border border-white/15 backdrop-blur-md">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              language === 'bn' ? 'আপনার ডকুমেন্ট খুঁজুন' : 'Search your documents'
            }
            className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-400 focus:outline-none"
          />
        </div>
      </section>

      {/* Quick Actions 4x2 Circular Grid */}
      <section className="space-y-3">
        <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
          {language === 'bn' ? 'দ্রুত কাজ' : 'Quick actions'}
        </h2>

        <div className="grid grid-cols-4 lg:grid-cols-8 gap-y-4 gap-x-2">
          {quickActions.map((act) => (
            <button
              key={act.id}
              onClick={act.onClick}
              className="flex flex-col items-center gap-2 min-h-[76px] active:scale-95 transition-transform group"
            >
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center shadow-sm border border-slate-200/70 dark:border-white/5 ${act.tint}`}
              >
                {act.icon}
              </div>
              <span className="text-[11.5px] font-semibold text-slate-700 dark:text-slate-200 text-center leading-tight line-clamp-2">
                {act.label}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Recent Documents Portrait Carousel / Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            {language === 'bn' ? 'সাম্প্রতিক ডকুমেন্ট' : 'Recent documents'}
          </h2>
          <button
            onClick={() => onNavigateFiles('recent')}
            className="min-h-[36px] px-2 text-xs font-semibold text-[#3B82F6] hover:text-[#60A5FA]"
          >
            {language === 'bn' ? 'সব দেখুন' : 'See all'}
          </button>
        </div>

        {filteredDocs.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {t.home.noDocs}
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1 md:grid md:grid-cols-4 lg:grid-cols-5">
            {filteredDocs.map((doc) => (
              <button
                key={doc.id}
                onClick={() => onOpenWorkspace({ type: 'viewer', docId: doc.id })}
                className="w-40 md:w-auto shrink-0 rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#3B82F6]/50 p-2.5 text-left transition-colors active:scale-[0.98]"
              >
                <div className="aspect-[3/4] w-full rounded-xl bg-white border border-slate-200 dark:border-slate-700/60 overflow-hidden relative flex items-center justify-center mb-2.5">
                  {doc.thumbnailDataUrl ? (
                    <img
                      src={doc.thumbnailDataUrl}
                      alt={doc.name}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <FileText className="w-8 h-8 text-slate-300" />
                  )}
                  <span className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-rose-500 text-white text-[9.5px] font-extrabold tracking-wide shadow-xs">
                    PDF
                  </span>
                </div>
                <p className="text-xs font-bold text-slate-900 dark:text-white truncate">
                  {doc.name}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {formatRelativeTime(doc.updatedAt, language)}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Collections 2x2 Grid */}
      <section className="space-y-3">
        <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
          {language === 'bn' ? 'সংগ্রহ' : 'Collections'}
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {collections.map((col) => (
            <button
              key={col.id}
              onClick={() => onNavigateFiles(col.id)}
              className="flex items-center gap-3 p-3.5 min-h-[68px] rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#3B82F6]/40 text-left transition-colors active:scale-[0.98]"
            >
              <div
                className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${col.iconBg}`}
              >
                {col.icon}
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white truncate">
                  {col.label}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-nums mt-0.5">
                  {col.count} {language === 'bn' ? 'টি ফাইল' : 'files'}
                </p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* All PDF Tools Vertical Stacked List */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            {language === 'bn' ? 'সকল পিডিএফ টুলস' : 'All PDF tools'}
          </h2>
          <button
            onClick={onNavigateTools}
            className="min-h-[36px] px-2 text-xs font-semibold text-[#3B82F6] hover:text-[#60A5FA]"
          >
            {language === 'bn' ? 'সব দেখুন' : 'See all'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {featuredTools.map((tool) => (
            <button
              key={tool.id}
              onClick={() => onOpenWorkspace({ type: 'toolRunner', toolId: tool.id })}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 min-h-[68px] rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#3B82F6]/40 text-left transition-colors active:scale-[0.99]"
            >
              <div className="flex items-center gap-3.5 min-w-0">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${tool.iconBg}`}
                >
                  {tool.icon}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900 dark:text-white truncate">
                    {tool.name}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    {tool.desc}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
