import React, { useMemo, useState } from 'react';
import {
  Bot,
  Camera,
  Combine,
  Edit3,
  FileSpreadsheet,
  FileText,
  GitCompare,
  Hash,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Lock,
  Minimize2,
  PenTool,
  Presentation,
  RotateCw,
  Scaling,
  ScanText,
  Scissors,
  Search,
  Stamp,
  Type,
  Unlock,
  Wrench,
} from 'lucide-react';
import type { ActiveWorkspace, AppLanguage, DocumentRecord } from '../types';

interface ToolsTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  onOpenWorkspace: (ws: ActiveWorkspace) => void;
  onPickDocForWorkspace: (mode: 'editor' | 'organizer') => void;
}

type ToolGroupId = 'organize' | 'convert' | 'edit' | 'security' | 'smart';

interface ToolCardItem {
  id: string;
  name: string;
  desc: string;
  group: ToolGroupId;
  icon: React.ReactNode;
  iconBg: string;
  onClick: () => void;
}

export const ToolsTab: React.FC<ToolsTabProps> = ({
  language,
  docs,
  onOpenWorkspace,
  onPickDocForWorkspace,
}) => {
  const [query, setQuery] = useState('');

  const firstDoc = docs.find((d) => !d.isTrashed && !d.isVaultLocked);

  const tools: ToolCardItem[] = [
    // ORGANIZE
    {
      id: 'merge',
      name: language === 'bn' ? 'মার্জ পিডিএফ' : 'Merge PDF',
      desc: language === 'bn' ? 'একাধিক পিডিএফ একটি ফাইলে যোগ করুন' : 'Combine several PDFs into one',
      group: 'organize',
      icon: <Combine className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'merge' }),
    },
    {
      id: 'split',
      name: language === 'bn' ? 'স্প্লিট ও এক্সট্র্যাক্ট' : 'Split & Extract',
      desc: language === 'bn' ? 'প্রয়োজনীয় পৃষ্ঠা বেছে আলাদা করুন' : 'Pick pages to keep or split every page',
      group: 'organize',
      icon: <Scissors className="w-5 h-5 text-rose-500" />,
      iconBg: 'bg-rose-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'split' }),
    },
    {
      id: 'rotate',
      name: language === 'bn' ? 'রোটেট পিডিএফ' : 'Rotate PDF',
      desc: language === 'bn' ? 'সব পৃষ্ঠা বামে বা ডানে ঘোরান' : 'Turn all pages left or right',
      group: 'organize',
      icon: <RotateCw className="w-5 h-5 text-[#06B6D4]" />,
      iconBg: 'bg-[#06B6D4]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'rotate' }),
    },
    {
      id: 'organize',
      name: language === 'bn' ? 'পৃষ্ঠা সাজান' : 'Organize pages',
      desc: language === 'bn' ? 'পৃষ্ঠা ক্রম পরিবর্তন, ডিলিট ও ডুপ্লিকেট' : 'Reorder, delete and duplicate pages',
      group: 'organize',
      icon: <LayoutGrid className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onPickDocForWorkspace('organizer'),
    },
    {
      id: 'pageSetup',
      name: language === 'bn' ? 'পেজ সাইজ ও দিক' : 'Page Size & Orientation',
      desc: language === 'bn' ? 'A0–A6, Letter, Legal ও Portrait/Landscape' : 'Resize pages and switch orientation',
      group: 'organize',
      icon: <Scaling className="w-5 h-5 text-indigo-400" />,
      iconBg: 'bg-indigo-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pageSetup' }),
    },
    {
      id: 'compare',
      name: language === 'bn' ? 'পিডিএফ তুলনা' : 'Compare PDFs',
      desc: language === 'bn' ? 'দুটি ফাইলের পার্থক্য দেখুন' : 'Spot differences between two files',
      group: 'organize',
      icon: <GitCompare className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
      onClick: () => onOpenWorkspace({ type: 'compare' }),
    },

    // CONVERT
    {
      id: 'imagesToPdf',
      name: language === 'bn' ? 'ছবি থেকে পিডিএফ' : 'Images to PDF',
      desc: language === 'bn' ? 'JPG ও PNG ছবি পিডিএফ বানান' : 'Turn JPG and PNG photos into a PDF',
      group: 'convert',
      icon: <ImageIcon className="w-5 h-5 text-emerald-500" />,
      iconBg: 'bg-emerald-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'imagesToPdf' }),
    },
    {
      id: 'extractText',
      name: language === 'bn' ? 'পিডিএফ থেকে টেক্সট' : 'PDF to Text',
      desc: language === 'bn' ? 'সব লেখা .TXT হিসেবে বের করুন' : 'Pull out all the text in a PDF',
      group: 'convert',
      icon: <FileText className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'extractText' }),
    },
    {
      id: 'extractImages',
      name: language === 'bn' ? 'পিডিএফ থেকে ছবি' : 'PDF to Images',
      desc: language === 'bn' ? 'প্রতিটি পৃষ্ঠা ছবি হিসেবে সেভ' : 'Save each page as a picture',
      group: 'convert',
      icon: <ImageIcon className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'extractImages' }),
    },
    {
      id: 'pdfToDocx',
      name: language === 'bn' ? 'পিডিএফ থেকে ওয়ার্ড' : 'PDF to Word',
      desc: language === 'bn' ? 'সম্পাদনাযোগ্য DOCX ফাইলে নিন' : 'Convert to an editable DOCX',
      group: 'convert',
      icon: <FileText className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pdfToDocx' }),
    },
    {
      id: 'wordToPdf',
      name: 'Word / Excel / PPT to PDF',
      desc: 'Convert Office files into paginated PDF',
      group: 'convert',
      icon: <Presentation className="w-5 h-5 text-rose-500" />,
      iconBg: 'bg-rose-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'wordToPdf' }),
    },
    {
      id: 'compress',
      name: language === 'bn' ? 'কমপ্রেস পিডিএফ' : 'Compress PDF',
      desc: language === 'bn' ? 'পিডিএফের ফাইল সাইজ ছোট করুন' : 'Make a PDF smaller cleanly',
      group: 'convert',
      icon: <Minimize2 className="w-5 h-5 text-[#06B6D4]" />,
      iconBg: 'bg-[#06B6D4]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'compress' }),
    },
    {
      id: 'pdfToXlsx',
      name: 'PDF to Excel (.XLSX)',
      desc: 'Extract tables into Excel spreadsheets',
      group: 'convert',
      icon: <FileSpreadsheet className="w-5 h-5 text-emerald-500" />,
      iconBg: 'bg-emerald-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pdfToXlsx' }),
    },
    {
      id: 'pdfToPptx',
      name: 'PDF to PowerPoint',
      desc: 'Convert pages into .PPTX slide decks',
      group: 'convert',
      icon: <Presentation className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pdfToPptx' }),
    },

    // EDIT & ANNOTATE
    {
      id: 'watermark',
      name: language === 'bn' ? 'ওয়াটারমার্ক যোগ' : 'Add Watermark',
      desc: language === 'bn' ? 'সব পৃষ্ঠায় জলছাপ বসান' : 'Stamp text across every page',
      group: 'edit',
      icon: <Stamp className="w-5 h-5 text-[#06B6D4]" />,
      iconBg: 'bg-[#06B6D4]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'watermark' }),
    },
    {
      id: 'pageNumbers',
      name: language === 'bn' ? 'পেজ নম্বর' : 'Page Numbers',
      desc: language === 'bn' ? 'প্রতিটি পৃষ্ঠায় নম্বর বসান' : 'Number every page automatically',
      group: 'edit',
      icon: <Hash className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pageNumbers' }),
    },
    {
      id: 'editMetadata',
      name: language === 'bn' ? 'মেটাডাটা এডিট' : 'Edit Metadata',
      desc: language === 'bn' ? 'শিরোনাম, লেখক ও কিওয়ার্ড বদলান' : 'Change title, author and keywords',
      group: 'edit',
      icon: <Info className="w-5 h-5 text-emerald-500" />,
      iconBg: 'bg-emerald-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'editMetadata' }),
    },
    {
      id: 'editPdf',
      name: language === 'bn' ? 'পিডিএফ টেক্সট এডিট' : 'Edit PDF text',
      desc: language === 'bn' ? 'পিডিএফের লেখা, ছবি ও নোট বদলান' : 'Change the words inside a PDF',
      group: 'edit',
      icon: <Edit3 className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onPickDocForWorkspace('editor'),
    },
    {
      id: 'signature',
      name: language === 'bn' ? 'স্বাক্ষর যোগ করুন' : 'Sign PDF',
      desc: language === 'bn' ? 'হাতে এঁকে বা ছবি থেকে স্বাক্ষর' : 'Draw and place your signature',
      group: 'edit',
      icon: <PenTool className="w-5 h-5 text-indigo-400" />,
      iconBg: 'bg-indigo-500/15',
      onClick: () => onPickDocForWorkspace('editor'),
    },
    {
      id: 'headerFooter',
      name: language === 'bn' ? 'হেডার ও ফুটার' : 'Header & Footer',
      desc: language === 'bn' ? 'উপরে ও নিচে লেখা যোগ করুন' : 'Apply top and bottom margin labels',
      group: 'edit',
      icon: <Type className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'headerFooter' }),
    },

    // SECURITY
    {
      id: 'protectVault',
      name: language === 'bn' ? 'পাসওয়ার্ড সুরক্ষা' : 'Protect with password',
      desc: language === 'bn' ? 'AES-256 দিয়ে পিডিএফ লক করুন' : 'Lock a PDF with a password',
      group: 'security',
      icon: <Lock className="w-5 h-5 text-rose-500" />,
      iconBg: 'bg-rose-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'protectVault' }),
    },
    {
      id: 'unlockPdf',
      name: language === 'bn' ? 'পাসওয়ার্ড সরান' : 'Remove password',
      desc: language === 'bn' ? 'আপনার পিডিএফ আনলক করুন' : 'Unlock a PDF you own',
      group: 'security',
      icon: <Unlock className="w-5 h-5 text-emerald-500" />,
      iconBg: 'bg-emerald-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'unlockPdf' }),
    },
    {
      id: 'repairPdf',
      name: language === 'bn' ? 'রিপেয়ার পিডিএফ' : 'Repair PDF',
      desc: language === 'bn' ? 'ক্ষতিগ্রস্ত পিডিএফ ঠিক করুন' : 'Rebuild damaged PDF structure',
      group: 'security',
      icon: <Wrench className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'repairPdf' }),
    },

    // SMART TOOLS
    {
      id: 'scanner',
      name: language === 'bn' ? 'ডকুমেন্ট স্ক্যানার' : 'Document scanner',
      desc: language === 'bn' ? 'ক্যামেরা দিয়ে কাগজ স্ক্যান করুন' : 'Scan paper with your camera',
      group: 'smart',
      icon: <Camera className="w-5 h-5 text-[#06B6D4]" />,
      iconBg: 'bg-[#06B6D4]/15',
      onClick: () => onOpenWorkspace({ type: 'scanner' }),
    },
    {
      id: 'ocr',
      name: 'OCR – Image & PDF to text',
      desc: 'Read text from scans (English & বাংলা)',
      group: 'smart',
      icon: <ScanText className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-500/15',
      onClick: () => onOpenWorkspace({ type: 'ocr' }),
    },
    {
      id: 'aiAssistant',
      name: language === 'bn' ? 'এআই পিডিএফ অ্যাসিস্ট্যান্ট' : 'AI PDF Assistant',
      desc: language === 'bn' ? 'সারসংক্ষেপ ও প্রশ্নোত্তর' : 'Summarize and ask questions',
      group: 'smart',
      icon: <Bot className="w-5 h-5 text-[#3B82F6]" />,
      iconBg: 'bg-[#2563EB]/15',
      onClick: () => onOpenWorkspace({ type: 'aiAssistant', docId: firstDoc?.id }),
    },
  ];

  const groups: Array<{ id: ToolGroupId; label: string }> = [
    { id: 'organize', label: language === 'bn' ? 'সাজান' : 'ORGANIZE' },
    { id: 'convert', label: language === 'bn' ? 'কনভার্ট' : 'CONVERT' },
    { id: 'edit', label: language === 'bn' ? 'এডিট ও টীকা' : 'EDIT & ANNOTATE' },
    { id: 'security', label: language === 'bn' ? 'সুরক্ষা' : 'SECURITY' },
    { id: 'smart', label: language === 'bn' ? 'স্মার্ট টুলস' : 'SMART TOOLS' },
  ];

  const filteredTools = useMemo(() => {
    if (!query.trim()) return tools;
    const q = query.toLowerCase();
    return tools.filter(
      (item) =>
        item.name.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)
    );
  }, [query, firstDoc?.id, language]);

  return (
    <div className="space-y-6 pb-8">
      {/* Page Title */}
      <h1 className="font-display text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        {language === 'bn' ? 'পিডিএফ টুলস' : 'PDF Tools'}
      </h1>

      {/* Search Pill */}
      <div className="flex items-center gap-2.5 min-h-[46px] px-4 rounded-full bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B]">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={language === 'bn' ? 'টুল খুঁজুন' : 'Search tools'}
          className="flex-1 bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
        />
      </div>

      {/* Categorized Sections matching Screenshot */}
      {groups.map((grp) => {
        const items = filteredTools.filter((item) => item.group === grp.id);
        if (items.length === 0) return null;
        return (
          <section key={grp.id} className="space-y-3">
            <h2 className="text-[11px] font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400">
              {grp.label}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {items.map((tool) => (
                <button
                  key={tool.id}
                  onClick={tool.onClick}
                  className="rounded-2xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] hover:border-[#3B82F6]/50 p-4 text-left flex flex-col justify-between gap-3 min-h-[136px] active:scale-[0.98] transition-all"
                >
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tool.iconBg}`}
                  >
                    {tool.icon}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 dark:text-white leading-snug">
                      {tool.name}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                      {tool.desc}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
