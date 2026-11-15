import React, { useMemo, useState } from 'react';
import { Check, Clock, FileText, FolderOpen, Loader2, Search } from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { cloneBuffer, getPdfDocumentInfo, renderPageThumbnail } from '../services/pdfEngine';
import { formatBytes, formatRelativeTime } from '../services/storageService';

interface PdfSourcePickerProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  selectedDocId?: string;
  excludeDocId?: string;
  /** Called when user picks an existing Vault / Recent document */
  onSelectDoc: (doc: DocumentRecord) => void;
  /** Called when user imports a PDF from device storage and we persist it as a DocumentRecord */
  onImportDoc?: (doc: DocumentRecord) => Promise<void>;
  /**
   * Optional raw-file handler (used e.g. for Unlock Password-Protected PDF where
   * unencrypted parsing shouldn't fail import before password entry).
   */
  onRawPdfFile?: (file: File) => void;
  rawFileLabel?: string;
  label?: string;
  compact?: boolean;
  maxListHeightClass?: string;
}

export const PdfSourcePicker: React.FC<PdfSourcePickerProps> = ({
  language,
  docs,
  selectedDocId,
  excludeDocId,
  onSelectDoc,
  onImportDoc,
  onRawPdfFile,
  rawFileLabel,
  label,
  compact = false,
  maxListHeightClass = 'max-h-48',
}) => {
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const recentDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs
      .filter((d) => !d.isTrashed && !d.isVaultLocked && d.id !== excludeDocId)
      .sort((a, b) => (b.lastOpenedAt || b.updatedAt) - (a.lastOpenedAt || a.updatedAt))
      .filter((d) => (q ? d.name.toLowerCase().includes(q) : true));
  }, [docs, excludeDocId, search]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);

    if (onRawPdfFile) {
      onRawPdfFile(file);
      return;
    }

    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const info = await getPdfDocumentInfo(buf).catch(() => ({ pageCount: 1 }));
      const thumb = await renderPageThumbnail(buf, 1, 200).catch(() => undefined);
      const now = Date.now();
      const record: DocumentRecord = {
        id: `doc_imp_${now}_${Math.random().toString(36).slice(2, 6)}`,
        name: file.name,
        origin: 'imported',
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        sizeBytes: buf.byteLength,
        pageCount: info.pageCount,
        isStarred: false,
        isShared: false,
        isTrashed: false,
        folderId: null,
        thumbnailDataUrl: thumb,
        pdfBytes: cloneBuffer(buf),
        versions: [
          {
            id: `ver_${now}`,
            timestamp: now,
            note: 'Imported from device storage',
            sizeBytes: buf.byteLength,
            pdfBytes: cloneBuffer(buf),
          },
        ],
      };
      if (onImportDoc) {
        await onImportDoc(record);
      }
      onSelectDoc(record);
    } catch {
      setImportError(
        language === 'bn'
          ? 'নির্বাচিত পিডিএফ ফাইলটি পড়া যায়নি।'
          : 'Could not read the selected PDF file.'
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {label && (
        <div className="text-xs font-bold text-[#142B4A] dark:text-slate-200">{label}</div>
      )}

      {/* Import from Device Storage */}
      <label
        className={`flex items-center justify-center gap-2.5 ${
          compact ? 'px-3 py-2.5' : 'p-3.5'
        } rounded-2xl border-2 border-dashed border-[#2563EB]/45 bg-[#2563EB]/5 hover:bg-[#2563EB]/10 cursor-pointer transition-colors`}
      >
        {importing ? (
          <Loader2 className="w-4 h-4 text-[#2563EB] animate-spin shrink-0" />
        ) : (
          <FolderOpen className="w-4 h-4 text-[#2563EB] shrink-0" />
        )}
        <div className="min-w-0 text-left">
          <p className="text-xs font-bold text-[#142B4A] dark:text-white truncate">
            {rawFileLabel
              ? rawFileLabel
              : language === 'bn'
              ? 'ডিভাইস স্টোরেজ থেকে পিডিএফ ইমপোর্ট করুন'
              : 'Import PDF from Device Storage'}
          </p>
          {!compact && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {language === 'bn'
                ? 'ফোন বা কম্পিউটার থেকে .PDF ফাইল বাছুন'
                : 'Pick a .PDF file from your phone or computer'}
            </p>
          )}
        </div>
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={handleFileChange}
          className="hidden"
        />
      </label>

      {importError && (
        <p className="text-[11px] text-rose-500 font-medium">{importError}</p>
      )}

      {/* Searchable Recent Files */}
      <div className="space-y-1.5 pt-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-[#06B6D4]" />
            {language === 'bn' ? 'রিসেন্ট ফাইলস' : 'Recent Files'}
          </span>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 flex-1 max-w-[180px]">
            <Search className="w-3 h-3 text-slate-400 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={language === 'bn' ? 'খুঁজুন...' : 'Filter recent...'}
              className="w-full bg-transparent text-[11px] focus:outline-none"
            />
          </div>
        </div>

        {recentDocs.length === 0 ? (
          <p className="text-[11px] text-slate-400 text-center py-3 px-2 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-200 dark:border-slate-700">
            {language === 'bn'
              ? 'কোনো রিসেন্ট ফাইল পাওয়া যায়নি। ডিভাইস স্টোরেজ থেকে ইমপোর্ট করুন।'
              : 'No recent files found. Import a PDF from device storage above.'}
          </p>
        ) : (
          <div className={`${maxListHeightClass} overflow-y-auto space-y-1.5 pr-0.5`}>
            {recentDocs.map((d) => {
              const active = d.id === selectedDocId;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onSelectDoc(d)}
                  className={`w-full min-h-[46px] px-2.5 py-1.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                    active
                      ? 'border-[#2563EB] bg-[#2563EB]/10 text-[#142B4A] dark:text-white'
                      : 'border-slate-200 dark:border-slate-700 hover:border-[#2563EB]/40 bg-white dark:bg-slate-900/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden shrink-0 flex items-center justify-center border border-slate-200 dark:border-slate-700">
                      {d.thumbnailDataUrl ? (
                        <img
                          src={d.thumbnailDataUrl}
                          alt={d.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <FileText className="w-4 h-4 text-[#2563EB]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{d.name}</p>
                      <p className="text-[10.5px] font-mono-nums text-slate-500">
                        {d.pageCount}p · {formatBytes(d.sizeBytes)} ·{' '}
                        {formatRelativeTime(d.lastOpenedAt || d.updatedAt, language)}
                      </p>
                    </div>
                  </div>
                  {active && (
                    <span className="w-5 h-5 rounded-full bg-[#2563EB] text-white flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
