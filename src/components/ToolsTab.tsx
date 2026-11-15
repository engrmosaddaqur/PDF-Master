import React, { useMemo, useState } from 'react';
import {
  Camera,
  Combine,
  Edit3,
  FileSpreadsheet,
  FileText,
  GitCompare,
  Hash,
  Image as ImageIcon,
  Layers,
  Lock,
  Minimize2,
  PenTool,
  Presentation,
  RotateCw,
  Scaling,
  ScanText,
  Scissors,
  Search,
  Sparkles,
  Stamp,
  Type,
  Unlock,
  Wrench,
} from 'lucide-react';
import type { ActiveWorkspace, AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';

interface ToolsTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  onOpenWorkspace: (ws: ActiveWorkspace) => void;
}

type ToolCat = 'all' | 'edit' | 'convert' | 'security' | 'ai';

export const ToolsTab: React.FC<ToolsTabProps> = ({
  language,
  docs,
  onOpenWorkspace,
}) => {
  const t = getT(language);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<ToolCat>('all');

  const firstDoc = docs.find((d) => !d.isTrashed && !d.isVaultLocked);

  const tools: Array<{
    id: string;
    name: string;
    desc: string;
    category: Exclude<ToolCat, 'all'>;
    icon: React.ReactNode;
    onClick: () => void;
  }> = [
    {
      id: 'editPdf',
      name: 'Edit PDF',
      desc: 'Edit existing text, add text, images & annotations',
      category: 'edit',
      icon: <Edit3 className="w-5 h-5 text-[#2563EB]" />,
      onClick: () =>
        firstDoc
          ? onOpenWorkspace({ type: 'editor', docId: firstDoc.id })
          : onOpenWorkspace({ type: 'wordCreator' }),
    },
    {
      id: 'organize',
      name: 'Organize Pages',
      desc: 'Reorder, rotate, duplicate, insert & delete pages',
      category: 'edit',
      icon: <Layers className="w-5 h-5 text-[#2563EB]" />,
      onClick: () =>
        firstDoc && onOpenWorkspace({ type: 'organizer', docId: firstDoc.id }),
    },
    {
      id: 'merge',
      name: 'Merge PDF',
      desc: 'Combine multiple PDF documents into one',
      category: 'edit',
      icon: <Combine className="w-5 h-5 text-indigo-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'merge' }),
    },
    {
      id: 'split',
      name: 'Split PDF',
      desc: 'Extract specific page ranges into a new PDF',
      category: 'edit',
      icon: <Scissors className="w-5 h-5 text-indigo-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'split' }),
    },
    {
      id: 'compress',
      name: 'Compress PDF',
      desc: 'Reduce PDF file size cleanly',
      category: 'edit',
      icon: <Minimize2 className="w-5 h-5 text-amber-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'compress' }),
    },
    {
      id: 'rotate',
      name: 'Rotate PDF',
      desc: 'Rotate all pages 90°, 180°, or 270°',
      category: 'edit',
      icon: <RotateCw className="w-5 h-5 text-sky-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'rotate' }),
    },
    {
      id: 'pageSetup',
      name: 'Page Size & Orientation',
      desc: 'Change paper size (A0–A6, Letter, Legal) & Portrait/Landscape',
      category: 'edit',
      icon: <Scaling className="w-5 h-5 text-[#2563EB]" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pageSetup' }),
    },
    {
      id: 'watermark',
      name: 'Add Watermark',
      desc: 'Stamp custom English or বাংলা watermarks',
      category: 'edit',
      icon: <Stamp className="w-5 h-5 text-cyan-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'watermark' }),
    },
    {
      id: 'pageNumbers',
      name: 'Page Numbers',
      desc: 'Add automatic page numbering to PDFs',
      category: 'edit',
      icon: <Hash className="w-5 h-5 text-slate-700 dark:text-slate-300" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pageNumbers' }),
    },
    {
      id: 'headerFooter',
      name: 'Header & Footer',
      desc: 'Apply top and bottom margin labels across pages',
      category: 'edit',
      icon: <Type className="w-5 h-5 text-slate-700 dark:text-slate-300" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'headerFooter' }),
    },
    {
      id: 'editMetadata',
      name: 'Edit Metadata',
      desc: 'Modify Title, Author, Subject & Keywords',
      category: 'edit',
      icon: <FileText className="w-5 h-5 text-slate-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'editMetadata' }),
    },
    {
      id: 'repairPdf',
      name: 'Repair PDF',
      desc: 'Rebuild cross-reference tables & object streams',
      category: 'edit',
      icon: <Wrench className="w-5 h-5 text-orange-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'repairPdf' }),
    },
    // Convert tools
    {
      id: 'imagesToPdf',
      name: 'Images to PDF',
      desc: 'Convert PNG, JPG, or WEBP photos into PDF',
      category: 'convert',
      icon: <ImageIcon className="w-5 h-5 text-emerald-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'imagesToPdf' }),
    },
    {
      id: 'extractImages',
      name: 'PDF to Images',
      desc: 'Render every PDF page as PNG & export ZIP',
      category: 'convert',
      icon: <ImageIcon className="w-5 h-5 text-emerald-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'extractImages' }),
    },
    {
      id: 'extractText',
      name: 'PDF to Text',
      desc: 'Extract all embedded text into a .TXT file',
      category: 'convert',
      icon: <FileText className="w-5 h-5 text-emerald-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'extractText' }),
    },
    {
      id: 'pdfToDocx',
      name: 'PDF to Word (.DOCX)',
      desc: 'Convert PDF pages into editable Word document',
      category: 'convert',
      icon: <FileText className="w-5 h-5 text-[#2563EB]" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pdfToDocx' }),
    },
    {
      id: 'pdfToXlsx',
      name: 'PDF to Excel (.XLSX)',
      desc: 'Extract tabular rows into Excel spreadsheets',
      category: 'convert',
      icon: <FileSpreadsheet className="w-5 h-5 text-emerald-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pdfToXlsx' }),
    },
    {
      id: 'pdfToPptx',
      name: 'PDF to PowerPoint',
      desc: 'Export PDF pages into .PPTX presentation slides',
      category: 'convert',
      icon: <Presentation className="w-5 h-5 text-amber-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pdfToPptx' }),
    },
    {
      id: 'wordToPdf',
      name: 'Word (.DOCX) to PDF',
      desc: 'Convert Word files into crisp paginated PDFs',
      category: 'convert',
      icon: <FileText className="w-5 h-5 text-[#2563EB]" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'wordToPdf' }),
    },
    {
      id: 'excelToPdf',
      name: 'Excel (.XLSX) to PDF',
      desc: 'Convert spreadsheets and CSVs to PDF',
      category: 'convert',
      icon: <FileSpreadsheet className="w-5 h-5 text-emerald-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'excelToPdf' }),
    },
    {
      id: 'pptToPdf',
      name: 'PowerPoint to PDF',
      desc: 'Convert .PPTX slide decks into PDF',
      category: 'convert',
      icon: <Presentation className="w-5 h-5 text-amber-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'pptToPdf' }),
    },
    // Sign, Compare & Security
    {
      id: 'signature',
      name: 'Sign PDF',
      desc: 'Draw or upload signature with SHA-256 seal',
      category: 'security',
      icon: <PenTool className="w-5 h-5 text-[#2563EB]" />,
      onClick: () =>
        firstDoc && onOpenWorkspace({ type: 'editor', docId: firstDoc.id }),
    },
    {
      id: 'compare',
      name: 'Compare PDFs',
      desc: 'Side-by-side & line-by-line text difference check',
      category: 'security',
      icon: <GitCompare className="w-5 h-5 text-indigo-600" />,
      onClick: () => onOpenWorkspace({ type: 'compare' }),
    },
    {
      id: 'protectVault',
      name: 'Protect PDF (AES-256)',
      desc: 'Encrypt document in local Vault with password',
      category: 'security',
      icon: <Lock className="w-5 h-5 text-rose-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'protectVault' }),
    },
    {
      id: 'unlockPdf',
      name: 'Unlock PDF Password',
      desc: 'Remove password from authorized PDF documents',
      category: 'security',
      icon: <Unlock className="w-5 h-5 text-emerald-600" />,
      onClick: () => onOpenWorkspace({ type: 'toolRunner', toolId: 'unlockPdf' }),
    },
    // Scan, OCR & AI
    {
      id: 'scanner',
      name: 'Smart Doc Scanner',
      desc: 'Auto-crop, perspective warp & Magic Color filter',
      category: 'ai',
      icon: <Camera className="w-5 h-5 text-[#06B6D4]" />,
      onClick: () => onOpenWorkspace({ type: 'scanner' }),
    },
    {
      id: 'ocr',
      name: 'OCR (English + বাংলা)',
      desc: 'Extract editable text & create searchable PDFs',
      category: 'ai',
      icon: <ScanText className="w-5 h-5 text-[#2563EB]" />,
      onClick: () => onOpenWorkspace({ type: 'ocr' }),
    },
    {
      id: 'aiAssistant',
      name: 'AI PDF Assistant',
      desc: 'Summarize, translate, extract tables & Q&A',
      category: 'ai',
      icon: <Sparkles className="w-5 h-5 text-[#2563EB]" />,
      onClick: () => onOpenWorkspace({ type: 'aiAssistant', docId: firstDoc?.id }),
    },
  ];

  const filtered = useMemo(() => {
    return tools.filter((item) => {
      if (cat !== 'all' && item.category !== cat) return false;
      if (query.trim()) {
        const q = query.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          item.desc.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [cat, query, firstDoc?.id]);

  const tabs: Array<{ id: ToolCat; label: string }> = [
    { id: 'all', label: t.tools.categories.all },
    { id: 'edit', label: t.tools.categories.edit },
    { id: 'convert', label: t.tools.categories.convert },
    { id: 'security', label: t.tools.categories.security },
    { id: 'ai', label: t.tools.categories.ai },
  ];

  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-center gap-2 min-h-[46px] px-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.tools.searchPlaceholder}
          className="flex-1 bg-transparent text-sm focus:outline-none"
        />
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setCat(tb.id)}
            className={`min-h-[40px] px-3.5 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              cat === tb.id
                ? 'bg-[#142B4A] dark:bg-[#2563EB] text-white'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {filtered.map((tool) => (
          <button
            key={tool.id}
            onClick={tool.onClick}
            className="flex items-center gap-3.5 p-3.5 min-h-[74px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-[#2563EB]/50 text-left active:scale-[0.99] transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0">
              {tool.icon}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-[#142B4A] dark:text-white truncate">
                {tool.name}
              </p>
              <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">{tool.desc}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
