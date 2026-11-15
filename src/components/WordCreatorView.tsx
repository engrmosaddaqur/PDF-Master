import React, { useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  Bold,
  Download,
  FileDown,
  ImagePlus,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Outdent,
  Printer,
  Redo2,
  Save,
  Settings2,
  ScissorsLineDashed,
  Subscript,
  Superscript,
  Table2,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import type {
  AppLanguage,
  DocumentRecord,
  PaperSizeKey,
  WordPageSettings,
} from '../types';
import { getT } from '../i18n/translations';
import { htmlDocumentToPdf } from '../services/conversionService';
import { cloneBuffer, PAPER_DIMENSIONS, renderPageThumbnail } from '../services/pdfEngine';
import { downloadArrayBuffer } from '../services/storageService';

interface WordCreatorViewProps {
  language: AppLanguage;
  defaultPageSize: PaperSizeKey;
  existingDoc?: DocumentRecord;
  initialHtml?: string;
  onClose: () => void;
  onSaveDocument: (doc: DocumentRecord) => Promise<void>;
}

const DEFAULT_HTML = `<h1>Project Brief &amp; Executive Notes</h1><p>Start writing in English or বাংলা. Format headings, tables, lists, images, headers, footers, and export to standard A-series or Letter PDF.</p><p>বাংলা এবং ইংরেজি উভয় ভাষাতেই ডকুমেন্ট তৈরি ও পিডিএফ এক্সপোর্ট করতে পারবেন।</p>`;

export const WordCreatorView: React.FC<WordCreatorViewProps> = ({
  language,
  defaultPageSize,
  existingDoc,
  initialHtml,
  onClose,
  onSaveDocument,
}) => {
  const t = getT(language);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const [docTitle, setDocTitle] = useState(
    existingDoc ? existingDoc.name.replace(/\.pdf$/i, '') : 'Untitled Document'
  );
  const [settings, setSettings] = useState<WordPageSettings>(
    existingDoc?.wordSettings || {
      paperSize: defaultPageSize || 'A4',
      orientation: 'portrait',
      customWidthMm: 210,
      customHeightMm: 297,
      marginTopMm: 20,
      marginBottomMm: 20,
      marginLeftMm: 20,
      marginRightMm: 20,
      backgroundColor: '#FFFFFF',
      borderEnabled: false,
      borderColor: '#CBD5E1',
      headerText: '',
      footerText: '',
      pageNumbering: true,
    }
  );
  const [fontFamily, setFontFamily] = useState("'DM Sans', 'Noto Sans Bengali', sans-serif");
  const [fontSize, setFontSize] = useState('3');
  const [lineSpacing, setLineSpacing] = useState('1.6');
  const [showPageSettings, setShowPageSettings] = useState(false);
  const [showOutline, setShowOutline] = useState(false);
  const [headings, setHeadings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState('https://');
  const savedRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = existingDoc?.editableHtml || initialHtml || DEFAULT_HTML;
      refreshOutline();
    }
  }, [existingDoc?.id, initialHtml]);

  const refreshOutline = () => {
    if (!editorRef.current) return;
    const h = Array.from(editorRef.current.querySelectorAll('h1,h2,h3')).map(
      (el) => (el.textContent || '').trim()
    );
    setHeadings(h.filter(Boolean));
  };

  const exec = (cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    refreshOutline();
  };

  const insertTable = () => {
    const html = `<table style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr><th style="border:1px solid #cbd5e1;padding:6px;background:#eff6ff;">Column 1</th><th style="border:1px solid #cbd5e1;padding:6px;background:#eff6ff;">Column 2</th><th style="border:1px solid #cbd5e1;padding:6px;background:#eff6ff;">Column 3</th></tr>
      <tr><td style="border:1px solid #cbd5e1;padding:6px;">Data A</td><td style="border:1px solid #cbd5e1;padding:6px;">Data B</td><td style="border:1px solid #cbd5e1;padding:6px;">Data C</td></tr>
    </table><p><br/></p>`;
    exec('insertHTML', html);
  };

  const insertPageBreak = () => {
    exec(
      'insertHTML',
      '<hr class="pdf-page-break" style="border:none;border-top:2px dashed #94a3b8;margin:18px 0;" /><p><br/></p>'
    );
  };

  const handleInsertImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      exec(
        'insertHTML',
        `<img src="${reader.result as string}" style="max-width:100%;border-radius:8px;margin:8px 0;" /><p><br/></p>`
      );
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSaveAndExport = async (action: 'saveVault' | 'downloadPdf' | 'downloadDocx' | 'print') => {
    const html = editorRef.current?.innerHTML || '';
    setSaving(true);
    try {
      if (action === 'downloadDocx') {
        const plainLines = (editorRef.current?.innerText || '').split('\n');
        const docx = new Document({
          sections: [
            {
              children: plainLines.map(
                (line) => new Paragraph({ children: [new TextRun(line)] })
              ),
            },
          ],
        });
        const blob = await Packer.toBlob(docx);
        const buf = await blob.arrayBuffer();
        downloadArrayBuffer(
          buf,
          `${docTitle.trim() || 'document'}.docx`,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        return;
      }

      const pdfBytes = await htmlDocumentToPdf(html, settings);
      if (action === 'downloadPdf') {
        downloadArrayBuffer(pdfBytes, `${docTitle.trim() || 'document'}.pdf`);
        return;
      }

      if (action === 'print') {
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        iframe.onload = () => {
          iframe.contentWindow?.print();
          setTimeout(() => {
            iframe.remove();
            URL.revokeObjectURL(url);
          }, 60000);
        };
        return;
      }

      const thumb = await renderPageThumbnail(pdfBytes, 1, 200).catch(() => undefined);
      const { getPdfDocumentInfo } = await import('../services/pdfEngine');
      const info = await getPdfDocumentInfo(pdfBytes).catch(() => ({ pageCount: 1 }));
      const now = Date.now();
      const fileName = `${docTitle.trim() || 'Untitled Document'}.pdf`;

      const record: DocumentRecord = existingDoc
        ? {
            ...existingDoc,
            name: fileName,
            updatedAt: now,
            sizeBytes: pdfBytes.byteLength,
            pageCount: info.pageCount,
            thumbnailDataUrl: thumb,
            pdfBytes: cloneBuffer(pdfBytes),
            editableHtml: html,
            wordSettings: settings,
            versions: [
              {
                id: `ver_${now}`,
                timestamp: now,
                note: 'Updated in Document Creator',
                sizeBytes: pdfBytes.byteLength,
                pdfBytes: cloneBuffer(pdfBytes),
              },
              ...existingDoc.versions,
            ],
          }
        : {
            id: `doc_created_${now}`,
            name: fileName,
            origin: 'created',
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
            wordSettings: settings,
            versions: [
              {
                id: `ver_${now}`,
                timestamp: now,
                note: 'Created in Document Creator',
                sizeBytes: pdfBytes.byteLength,
                pdfBytes: cloneBuffer(pdfBytes),
              },
            ],
          };

      await onSaveDocument(record);
      setSavedNotice('Saved to Created Documents');
      setTimeout(() => setSavedNotice(null), 2200);
    } finally {
      setSaving(false);
    }
  };

  const basePaperDim = PAPER_DIMENSIONS[settings.paperSize];
  const rawWidthMm =
    settings.paperSize === 'Custom'
      ? Math.max(40, settings.customWidthMm || 210)
      : basePaperDim.widthMm;
  const rawHeightMm =
    settings.paperSize === 'Custom'
      ? Math.max(40, settings.customHeightMm || 297)
      : basePaperDim.heightMm;
  const pageWidthMm =
    settings.orientation === 'portrait'
      ? Math.min(rawWidthMm, rawHeightMm)
      : Math.max(rawWidthMm, rawHeightMm);
  const pageHeightMm =
    settings.orientation === 'portrait'
      ? Math.max(rawWidthMm, rawHeightMm)
      : Math.min(rawWidthMm, rawHeightMm);
  const aspectRatio = `${pageWidthMm} / ${pageHeightMm}`;
  const maxPagePx = settings.orientation === 'portrait' ? 595 : 842;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#E2E8F0] dark:bg-[#0B1120]">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <input
            type="text"
            value={docTitle}
            onChange={(e) => setDocTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-display text-sm font-bold text-[#142B4A] dark:text-white focus:outline-none truncate"
          />
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowOutline((v) => !v)}
            className="min-h-[40px] px-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold hidden sm:block"
          >
            Outline ({headings.length})
          </button>
          <button
            onClick={() => setShowPageSettings(true)}
            aria-label="Page settings"
            className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            <Settings2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleSaveAndExport('downloadPdf')}
            disabled={saving}
            aria-label="Export PDF"
            className="min-h-[42px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center gap-1"
          >
            <FileDown className="w-4 h-4 text-[#2563EB]" />
            <span className="hidden sm:inline">PDF</span>
          </button>
          <button
            onClick={() => handleSaveAndExport('saveVault')}
            disabled={saving}
            className="min-h-[42px] px-3.5 rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? '...' : 'Save'}</span>
          </button>
        </div>
      </header>

      {/* Rich Text Formatting Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar shrink-0">
        <button onClick={() => exec('undo')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Undo">
          <Undo2 className="w-4 h-4" />
        </button>
        <button onClick={() => exec('redo')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Redo">
          <Redo2 className="w-4 h-4" />
        </button>

        <select
          value={fontFamily}
          onChange={(e) => {
            setFontFamily(e.target.value);
            exec('fontName', e.target.value);
          }}
          className="h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs shrink-0"
        >
          <option value="'DM Sans', 'Noto Sans Bengali', sans-serif">DM Sans + বাংলা</option>
          <option value="Georgia, 'Noto Sans Bengali', serif">Georgia Serif</option>
          <option value="'JetBrains Mono', monospace">Monospace</option>
        </select>

        <select
          value={fontSize}
          onChange={(e) => {
            setFontSize(e.target.value);
            exec('fontSize', e.target.value);
          }}
          className="h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs shrink-0"
        >
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="4">Medium</option>
          <option value="5">Large</option>
          <option value="6">Title</option>
        </select>

        <button onClick={() => exec('formatBlock', '<h1>')} className="h-9 px-2 rounded-lg text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0">H1</button>
        <button onClick={() => exec('formatBlock', '<h2>')} className="h-9 px-2 rounded-lg text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0">H2</button>
        <button onClick={() => exec('bold')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Bold"><Bold className="w-4 h-4" /></button>
        <button onClick={() => exec('italic')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Italic"><Italic className="w-4 h-4" /></button>
        <button onClick={() => exec('underline')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Underline"><Underline className="w-4 h-4" /></button>
        <button onClick={() => exec('superscript')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Superscript"><Superscript className="w-4 h-4" /></button>
        <button onClick={() => exec('subscript')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Subscript"><Subscript className="w-4 h-4" /></button>

        <input
          type="color"
          title="Text color"
          onChange={(e) => exec('foreColor', e.target.value)}
          defaultValue="#1E293B"
          className="w-8 h-8 rounded cursor-pointer border-0 shrink-0"
        />
        <input
          type="color"
          title="Highlight color"
          onChange={(e) => exec('hiliteColor', e.target.value)}
          defaultValue="#FEF08A"
          className="w-8 h-8 rounded cursor-pointer border-0 shrink-0"
        />

        <button onClick={() => exec('justifyLeft')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Align left"><AlignLeft className="w-4 h-4" /></button>
        <button onClick={() => exec('justifyCenter')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Align center"><AlignCenter className="w-4 h-4" /></button>
        <button onClick={() => exec('justifyRight')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Align right"><AlignRight className="w-4 h-4" /></button>
        <button onClick={() => exec('justifyFull')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Justify"><AlignJustify className="w-4 h-4" /></button>
        <button onClick={() => exec('insertUnorderedList')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Bullets"><List className="w-4 h-4" /></button>
        <button onClick={() => exec('insertOrderedList')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Numbering"><ListOrdered className="w-4 h-4" /></button>
        <button onClick={() => exec('indent')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Indent"><IndentIncrease className="w-4 h-4" /></button>
        <button onClick={() => exec('outdent')} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Outdent"><Outdent className="w-4 h-4" /></button>
        <button onClick={insertTable} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Insert Table"><Table2 className="w-4 h-4" /></button>
        <button onClick={() => imageInputRef.current?.click()} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Insert Image"><ImagePlus className="w-4 h-4" /></button>
        <button
          onClick={() => {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              savedRangeRef.current = sel.getRangeAt(0).cloneRange();
            } else {
              savedRangeRef.current = null;
            }
            setLinkUrl('https://');
            setShowLinkModal(true);
          }}
          className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          aria-label="Insert Link"
        >
          <Link2 className="w-4 h-4" />
        </button>
        <button onClick={insertPageBreak} className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0" aria-label="Page Break"><ScissorsLineDashed className="w-4 h-4" /></button>
      </div>

      {/* Paper Canvas & Optional Outline */}
      <div className="flex-1 overflow-auto p-3 sm:p-6 flex justify-center items-start gap-6">
        {showOutline && (
          <aside className="hidden md:block w-56 shrink-0 bg-white dark:bg-slate-900 rounded-2xl p-4 h-fit border border-slate-200 dark:border-slate-800">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Document Outline
            </h3>
            {headings.length === 0 ? (
              <p className="text-xs text-slate-400">Add H1 or H2 headings to build an outline.</p>
            ) : (
              <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
                {headings.map((h, i) => (
                  <li key={i} className="truncate font-medium">
                    {h}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}

        <div className="w-full flex flex-col items-center shrink-0" style={{ maxWidth: `${maxPagePx}px` }}>
          {savedNotice && (
            <div className="mb-3 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold shadow">
              {savedNotice}
            </div>
          )}

          <div
            className="w-full rounded-md shadow-xl transition-colors flex flex-col justify-between box-border"
            style={{
              backgroundColor: settings.backgroundColor,
              aspectRatio,
              paddingTop: `${(settings.marginTopMm / pageWidthMm) * 100}%`,
              paddingBottom: `${(settings.marginBottomMm / pageWidthMm) * 100}%`,
              paddingLeft: `${(settings.marginLeftMm / pageWidthMm) * 100}%`,
              paddingRight: `${(settings.marginRightMm / pageWidthMm) * 100}%`,
              border: settings.borderEnabled ? `2px solid ${settings.borderColor}` : '1px solid #cbd5e1',
            }}
          >
            {settings.headerText && (
              <div className="text-[11px] text-slate-400 border-b border-slate-100 pb-2 mb-3">
                {settings.headerText}
              </div>
            )}

            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={refreshOutline}
              style={{ fontFamily, lineHeight: lineSpacing }}
              className="flex-1 text-[#1E293B] text-[15px] focus:outline-none [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-[#142B4A] [&_h1]:mb-3 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-[#142B4A] [&_h2]:my-2 [&_p]:mb-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
            />

            {(settings.footerText || settings.pageNumbering) && (
              <div className="text-[11px] text-slate-400 border-t border-slate-100 pt-2 mt-3 flex items-center justify-between">
                <span>{settings.footerText}</span>
                {settings.pageNumbering && <span className="font-mono-nums">Page 1</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Export Dock */}
      <footer className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-3 py-2 pb-safe flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] font-mono-nums text-slate-500">
          {settings.paperSize} · {settings.orientation}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleSaveAndExport('print')}
            className="min-h-[40px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center gap-1.5"
          >
            <Printer className="w-3.5 h-3.5" />
            {t.creator.print}
          </button>
          <button
            onClick={() => handleSaveAndExport('downloadDocx')}
            className="min-h-[40px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            DOCX
          </button>
          <button
            onClick={() => handleSaveAndExport('downloadPdf')}
            className="min-h-[40px] px-3 rounded-xl bg-[#142B4A] dark:bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1.5"
          >
            <FileDown className="w-3.5 h-3.5" />
            {t.creator.exportPdf}
          </button>
        </div>
      </footer>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleInsertImage}
        className="hidden"
      />

      {/* Page Settings Sheet */}
      {showPageSettings && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl max-h-[85vh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Page Setup (A0–A6, Letter, Legal)
              </h3>
              <button onClick={() => setShowPageSettings(false)} className="min-h-[40px] min-w-[40px]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">{t.creator.paperSize}</label>
                <select
                  value={settings.paperSize}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, paperSize: e.target.value as PaperSizeKey }))
                  }
                  className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                >
                  {Object.values(PAPER_DIMENSIONS).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {settings.paperSize === 'Custom' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-semibold mb-1">Width (mm)</label>
                    <input
                      type="number"
                      value={settings.customWidthMm}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, customWidthMm: Number(e.target.value) || 210 }))
                      }
                      className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold mb-1">Height (mm)</label>
                    <input
                      type="number"
                      value={settings.customHeightMm}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, customHeightMm: Number(e.target.value) || 297 }))
                      }
                      className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-semibold mb-1">{t.creator.orientation}</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['portrait', 'landscape'] as const).map((ori) => (
                    <button
                      key={ori}
                      onClick={() => setSettings((s) => ({ ...s, orientation: ori }))}
                      className={`min-h-[40px] rounded-xl font-semibold capitalize border ${
                        settings.orientation === ori
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {ori}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Line Spacing</label>
                  <select
                    value={lineSpacing}
                    onChange={(e) => setLineSpacing(e.target.value)}
                    className="w-full min-h-[40px] px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                  >
                    <option value="1.2">Compact (1.2)</option>
                    <option value="1.6">Standard (1.6)</option>
                    <option value="2.0">Double (2.0)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Page Margin (mm)</label>
                  <input
                    type="number"
                    min={5}
                    max={50}
                    value={settings.marginLeftMm}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 20;
                      setSettings((s) => ({
                        ...s,
                        marginTopMm: v,
                        marginBottomMm: v,
                        marginLeftMm: v,
                        marginRightMm: v,
                      }));
                    }}
                    className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2">
                  <span>Page Bg:</span>
                  <input
                    type="color"
                    value={settings.backgroundColor}
                    onChange={(e) => setSettings((s) => ({ ...s, backgroundColor: e.target.value }))}
                  />
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.borderEnabled}
                    onChange={(e) => setSettings((s) => ({ ...s, borderEnabled: e.target.checked }))}
                    className="accent-[#2563EB]"
                  />
                  <span>Page Border</span>
                </label>
              </div>

              <input
                type="text"
                placeholder="Header text..."
                value={settings.headerText}
                onChange={(e) => setSettings((s) => ({ ...s, headerText: e.target.value }))}
                className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
              />
              <input
                type="text"
                placeholder="Footer text..."
                value={settings.footerText}
                onChange={(e) => setSettings((s) => ({ ...s, footerText: e.target.value }))}
                className="w-full min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
              />
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.pageNumbering}
                  onChange={(e) => setSettings((s) => ({ ...s, pageNumbering: e.target.checked }))}
                  className="accent-[#2563EB]"
                />
                <span>Automatic Page Numbering</span>
              </label>
            </div>

            <button
              onClick={() => setShowPageSettings(false)}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              Apply Page Settings
            </button>
          </div>
        </div>
      )}

      {/* Insert Hyperlink Modal */}
      {showLinkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3">
            <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
              Insert Hyperlink
            </h3>
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://example.com"
              autoFocus
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setShowLinkModal(false)}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (linkUrl.trim()) {
                    editorRef.current?.focus();
                    const sel = window.getSelection();
                    if (sel && savedRangeRef.current) {
                      sel.removeAllRanges();
                      sel.addRange(savedRangeRef.current);
                    }
                    document.execCommand('createLink', false, linkUrl.trim());
                    refreshOutline();
                  }
                  setShowLinkModal(false);
                }}
                disabled={!linkUrl.trim()}
                className="min-h-[44px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-xs font-semibold"
              >
                Insert Link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
