import React, { useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  Download,
  HardDrive,
  Info,
  Languages,
  Monitor,
  Moon,
  Shield,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AppSettings, DocumentRecord, PaperSizeKey } from '../types';
import { getT } from '../i18n/translations';
import { PAPER_DIMENSIONS } from '../services/pdfEngine';
import {
  base64ToArrayBuffer,
  formatBytes,
} from '../services/storageService';
import { saveBufferToDeviceStorage } from '../services/deviceFileActions';
import { PdfMasterLogo } from './Logo';

interface SettingsTabProps {
  settings: AppSettings;
  docs: DocumentRecord[];
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onEmptyTrash: () => Promise<void>;
  onDeleteAllFiles: () => Promise<void>;
  onRestoreBackupDocs: (docs: DocumentRecord[]) => Promise<void>;
}

const DEFAULT_PAPER_CHOICES: PaperSizeKey[] = [
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'Letter',
  'Legal',
  'Executive',
];

export const SettingsTab: React.FC<SettingsTabProps> = ({
  settings,
  docs,
  onUpdateSettings,
  onEmptyTrash,
  onDeleteAllFiles,
  onRestoreBackupDocs,
}) => {
  const t = getT(settings.language);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const totalBytes = docs.reduce((sum, d) => sum + d.sizeBytes, 0);
  const trashedCount = docs.filter((d) => d.isTrashed).length;

  const handleExportBackup = async () => {
    try {
      const zip = new JSZip();
      const manifestDocs = docs.map((d) => {
        const mainPath = `pdfs/${d.id}.pdf`;
        zip.file(mainPath, d.pdfBytes.slice(0));
        let basePdfPath: string | undefined;
        if (d.basePdfBytes) {
          basePdfPath = `pdfs/${d.id}_base.pdf`;
          zip.file(basePdfPath, d.basePdfBytes.slice(0));
        }
        const versionMetas = (d.versions || []).map((v, i) => {
          const vPath = `versions/${d.id}_v${i}.pdf`;
          zip.file(vPath, v.pdfBytes.slice(0));
          return {
            id: v.id,
            timestamp: v.timestamp,
            note: v.note,
            sizeBytes: v.sizeBytes,
            pdfPath: vPath,
            editorState: v.editorState,
          };
        });
        return {
          ...d,
          pdfBytes: undefined,
          basePdfBytes: undefined,
          pdfPath: mainPath,
          basePdfPath,
          versions: versionMetas,
        };
      });
      zip.file(
        'manifest.json',
        JSON.stringify({ exportedAt: Date.now(), app: 'PDF MASTER', format: 'zip-v2', documents: manifestDocs })
      );
      const zipBuf = await zip.generateAsync({ type: 'arraybuffer' });
      await saveBufferToDeviceStorage(
        zipBuf,
        `PDF-Master-Backup-${new Date().toISOString().slice(0, 10)}.zip`,
        'application/zip'
      );
      setBackupNotice(
        settings.language === 'bn' ? 'ZIP ভল্ট ব্যাকআপ এক্সপোর্ট হয়েছে।' : 'ZIP Vault backup exported.'
      );
    } catch {
      setBackupNotice(
        settings.language === 'bn' ? 'ব্যাকআপ এক্সপোর্ট ব্যর্থ হয়েছে।' : 'Failed to export backup.'
      );
    }
    setTimeout(() => setBackupNotice(null), 2600);
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const isZip =
        file.name.toLowerCase().endsWith('.zip') ||
        (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b);

      let restored: DocumentRecord[] = [];
      if (isZip) {
        const zip = await JSZip.loadAsync(buf);
        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) throw new Error('Missing manifest.json');
        const parsed = JSON.parse(await manifestFile.async('string'));
        if (!Array.isArray(parsed.documents)) throw new Error('Invalid backup format');

        for (const d of parsed.documents) {
          const pdfEntry = d.pdfPath ? zip.file(d.pdfPath) : null;
          if (!pdfEntry) continue;
          const mainBuf = await pdfEntry.async('arraybuffer');
          const baseEntry = d.basePdfPath ? zip.file(d.basePdfPath) : null;
          const baseBuf = baseEntry ? await baseEntry.async('arraybuffer') : undefined;
          const restoredVersions: DocumentRecord['versions'] = [];
          for (const v of d.versions || []) {
            const vEntry = v.pdfPath ? zip.file(v.pdfPath) : null;
            if (!vEntry) continue;
            const vBuf = await vEntry.async('arraybuffer');
            restoredVersions.push({
              id: v.id,
              timestamp: v.timestamp,
              note: v.note,
              sizeBytes: v.sizeBytes,
              pdfBytes: vBuf,
              editorState: v.editorState,
            });
          }
          restored.push({
            ...d,
            pdfBytes: mainBuf,
            basePdfBytes: baseBuf,
            versions: restoredVersions,
          });
        }
      } else {
        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed.documents)) throw new Error('Invalid backup format');
        restored = parsed.documents.map(
          (
            d: Omit<DocumentRecord, 'pdfBytes' | 'versions'> & {
              pdfBase64: string;
              versions?: Array<{
                pdfBase64: string;
                id: string;
                timestamp: number;
                note: string;
                sizeBytes: number;
              }>;
            }
          ) => ({
            ...d,
            pdfBytes: base64ToArrayBuffer(d.pdfBase64),
            versions: (d.versions || []).map((v) => ({
              id: v.id,
              timestamp: v.timestamp,
              note: v.note,
              sizeBytes: v.sizeBytes,
              pdfBytes: base64ToArrayBuffer(v.pdfBase64),
            })),
          })
        );
      }

      await onRestoreBackupDocs(restored);
      setBackupNotice(
        settings.language === 'bn'
          ? `${restored.length}টি ডকুমেন্ট পুনরুদ্ধার হয়েছে।`
          : `Restored ${restored.length} document(s).`
      );
    } catch {
      setBackupNotice(
        settings.language === 'bn'
          ? 'ব্যাকআপ ফাইল পুনরুদ্ধার করা যায়নি।'
          : 'Failed to restore backup file.'
      );
    }
    setTimeout(() => setBackupNotice(null), 3000);
  };

  return (
    <div className="space-y-4 pb-8 max-w-2xl mx-auto">
      <h1 className="font-display text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        {t.settings.title}
      </h1>

      {/* Language Card */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Languages className="w-4 h-4 text-[#3B82F6]" />
          {t.settings.language}
        </h2>
        <div className="grid grid-cols-2 gap-2.5">
          {(
            [
              { id: 'en', label: 'English' },
              { id: 'bn', label: 'বাংলা' },
            ] as const
          ).map((item) => {
            const active = settings.language === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onUpdateSettings({ language: item.id })}
                className={`min-h-[46px] rounded-full border text-sm font-bold transition-all ${
                  active
                    ? 'border-[#3B82F6] bg-[#2563EB]/15 text-[#2563EB] dark:text-[#60A5FA]'
                    : 'border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-slate-700 dark:text-slate-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Appearance Card (Light | Dark | Automatic) */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Sun className="w-4 h-4 text-[#3B82F6]" />
          {t.settings.appearance}
        </h2>
        <div className="grid grid-cols-3 gap-2.5">
          {(
            [
              { id: 'light', label: t.settings.light, icon: <Sun className="w-4 h-4" /> },
              { id: 'dark', label: t.settings.dark, icon: <Moon className="w-4 h-4" /> },
              { id: 'auto', label: t.settings.auto, icon: <Monitor className="w-4 h-4" /> },
            ] as const
          ).map((item) => {
            const active = settings.theme === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onUpdateSettings({ theme: item.id })}
                className={`min-h-[68px] px-2 rounded-2xl border flex flex-col items-center justify-center gap-1.5 text-xs font-bold transition-all ${
                  active
                    ? 'border-[#3B82F6] bg-[#2563EB]/15 text-[#2563EB] dark:text-[#60A5FA]'
                    : 'border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-slate-700 dark:text-slate-300'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Viewer Card */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 space-y-4">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Monitor className="w-4 h-4 text-[#3B82F6]" />
          {t.settings.preferences}
        </h2>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {t.settings.defaultView}
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: 'continuous', label: settings.language === 'bn' ? 'ধারাবাহিক' : 'Continuous' },
                { id: 'single', label: settings.language === 'bn' ? 'একক পৃষ্ঠা' : 'Single page' },
              ] as const
            ).map((item) => {
              const active = settings.defaultViewMode === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onUpdateSettings({ defaultViewMode: item.id })}
                  className={`min-h-[40px] px-5 rounded-full border text-xs font-bold transition-all ${
                    active
                      ? 'border-[#3B82F6] bg-[#2563EB]/15 text-[#2563EB] dark:text-[#60A5FA]'
                      : 'border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {t.settings.defaultPaper}
          </p>
          <div className="flex flex-wrap gap-2">
            {DEFAULT_PAPER_CHOICES.filter((k) => PAPER_DIMENSIONS[k]).map((key) => {
              const active = settings.defaultPageSize === key;
              return (
                <button
                  key={key}
                  onClick={() => onUpdateSettings({ defaultPageSize: key })}
                  className={`min-h-[38px] px-4 rounded-full border text-xs font-bold transition-all ${
                    active
                      ? 'border-[#3B82F6] bg-[#2563EB]/15 text-[#2563EB] dark:text-[#60A5FA]'
                      : 'border-slate-200 dark:border-[#1E293B] bg-slate-50 dark:bg-[#0D1322] text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {key}
                </button>
              );
            })}
          </div>
        </div>

        <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer min-h-[40px]">
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {t.settings.autoCrop}
          </span>
          <input
            type="checkbox"
            checked={settings.scannerAutoCrop}
            onChange={(e) => onUpdateSettings({ scannerAutoCrop: e.target.checked })}
            className="w-5 h-5 accent-[#3B82F6]"
          />
        </label>
      </section>

      {/* Storage Card */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-[#3B82F6]" />
          {t.settings.storageTitle}
        </h2>

        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-white font-mono-nums">
            {docs.length} {settings.language === 'bn' ? 'টি ফাইল সংরক্ষিত' : 'files stored'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono-nums">
            {formatBytes(totalBytes)}{' '}
            {settings.language === 'bn' ? 'এই ডিভাইসে ব্যবহৃত' : 'used on this device'}
          </p>
        </div>

        {backupNotice && (
          <p className="text-xs text-[#3B82F6] font-semibold">{backupNotice}</p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleExportBackup}
            className="min-h-[42px] rounded-2xl bg-slate-100 dark:bg-[#0D1322] border border-slate-200 dark:border-[#1E293B] text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            {t.settings.exportBackup}
          </button>
          <button
            onClick={() => backupInputRef.current?.click()}
            className="min-h-[42px] rounded-2xl bg-slate-100 dark:bg-[#0D1322] border border-slate-200 dark:border-[#1E293B] text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Upload className="w-4 h-4" />
            {t.settings.importBackup}
          </button>
        </div>
        <input
          ref={backupInputRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          onChange={handleImportBackup}
          className="hidden"
        />

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {docs.length > 0 && (
            <button
              onClick={() => setConfirmDeleteAll(true)}
              className="min-h-[40px] px-2 text-xs font-bold text-rose-500 hover:text-rose-400 flex items-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              <span>{t.settings.deleteAllFiles}</span>
            </button>
          )}
          {trashedCount > 0 && (
            <button
              onClick={onEmptyTrash}
              className="min-h-[40px] px-2 text-xs font-bold text-amber-500 hover:text-amber-400 flex items-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              <span>
                {t.settings.emptyTrash} ({trashedCount})
              </span>
            </button>
          )}
        </div>
      </section>

      {/* Privacy Card */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#3B82F6]" />
          {t.settings.privacyTitle}
        </h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          {settings.language === 'bn'
            ? 'আপনার ফাইলগুলো কেবল আপনার ডিভাইসেই প্রক্রিয়াজাত ও সংরক্ষিত হয়। অনুমতি ছাড়া কিছুই আপলোড করা হয় না।'
            : 'Your files are processed and stored only on this device. Nothing is uploaded.'}
        </p>

        <label className="flex items-center justify-between gap-3 cursor-pointer min-h-[40px]">
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
            {t.settings.localOnly}
          </span>
          <input
            type="checkbox"
            checked={settings.localOnlyMode}
            onChange={(e) => onUpdateSettings({ localOnlyMode: e.target.checked })}
            className="w-5 h-5 accent-[#3B82F6]"
          />
        </label>
      </section>

      {/* About Card */}
      <section className="rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Info className="w-4 h-4 text-[#3B82F6]" />
          {t.settings.aboutTitle}
        </h2>
        <div className="flex items-center gap-3">
          <PdfMasterLogo
            size={48}
            showWordmark
            showTagline
            tagline={t.tagline}
          />
        </div>
        <div className="pt-2 border-t border-slate-100 dark:border-[#1E293B]/70 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
          <span>
            {settings.language === 'bn' ? 'তৈরি করেছেন:' : 'Developed by'}{' '}
            <strong className="font-semibold text-slate-900 dark:text-white">Mosaddaq</strong>
          </span>
          <span className="font-mono-nums text-slate-500 dark:text-slate-400">
            Version 1.1
          </span>
        </div>
      </section>

      {/* In-App Delete All Files Confirmation Modal (No window.confirm) */}
      {confirmDeleteAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-[#1E293B] p-5 shadow-2xl space-y-4">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {settings.language === 'bn' ? 'সব ফাইল মুছে ফেলবেন?' : 'Delete all files?'}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {settings.language === 'bn'
                ? 'এই ডিভাইস থেকে সংরক্ষিত সব পিডিএফ স্থায়ীভাবে মুছে যাবে। আগে ব্যাকআপ এক্সপোর্ট করে নিতে পারেন।'
                : 'This permanently removes all documents stored on this device. Export a backup first if you want to keep a copy.'}
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => setConfirmDeleteAll(false)}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-[#1A243B] text-xs font-semibold"
              >
                {settings.language === 'bn' ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                onClick={async () => {
                  await onDeleteAllFiles();
                  setConfirmDeleteAll(false);
                }}
                className="min-h-[44px] rounded-xl bg-rose-600 text-white text-xs font-bold"
              >
                {settings.language === 'bn' ? 'সব মুছুন' : 'Delete all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
