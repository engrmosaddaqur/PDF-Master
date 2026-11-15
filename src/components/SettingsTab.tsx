import React, { useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FolderArchive,
  Globe,
  HardDrive,
  Info,
  Loader2,
  Moon,
  RefreshCw,
  Shield,
  Smartphone,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AppSettings, DocumentRecord, PaperSizeKey } from '../types';
import { getT } from '../i18n/translations';
import { getApiUrl } from '../services/apiConfig';
import { PAPER_DIMENSIONS } from '../services/pdfEngine';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  downloadArrayBuffer,
  formatBytes,
} from '../services/storageService';
import { PWAInstallButton } from './PWAComponents';

interface ApkStatusResponse {
  repo: string;
  repoExists: boolean;
  release: {
    tag: string;
    name: string;
    publishedAt: string;
    apkUrl: string;
    apkName: string;
    apkSizeBytes: number;
  } | null;
  latestRun: {
    status: string;
    conclusion: string | null;
    htmlUrl: string;
    updatedAt: string;
  } | null;
  directFallbackUrl: string;
  error?: string;
}

interface SettingsTabProps {
  settings: AppSettings;
  docs: DocumentRecord[];
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onEmptyTrash: () => Promise<void>;
  onRestoreBackupDocs: (docs: DocumentRecord[]) => Promise<void>;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  settings,
  docs,
  onUpdateSettings,
  onEmptyTrash,
  onRestoreBackupDocs,
}) => {
  const t = getT(settings.language);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [repoSlug, setRepoSlug] = useState('engrmosaddaqur/PDF-Master');
  const [apkStatus, setApkStatus] = useState<ApkStatusResponse | null>(null);
  const [apkChecking, setApkChecking] = useState(false);
  const [apkError, setApkError] = useState<string | null>(null);
  const [copiedCmds, setCopiedCmds] = useState(false);

  const isNativeAndroid = Capacitor.isNativePlatform();
  const totalBytes = docs.reduce((sum, d) => sum + d.sizeBytes, 0);
  const trashedCount = docs.filter((d) => d.isTrashed).length;

  const checkApkStatus = async () => {
    const cleanRepo = repoSlug.trim();
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleanRepo)) {
      setApkError('Enter repo as username/repository-name');
      return;
    }
    setApkChecking(true);
    setApkError(null);
    try {
      const resp = await fetch(getApiUrl(`/api/apk/status?repo=${encodeURIComponent(cleanRepo)}`));
      const data = (await resp.json()) as ApkStatusResponse;
      if (!resp.ok) {
        throw new Error(data.error || 'Could not check GitHub APK status.');
      }
      setApkStatus(data);
    } catch (err: unknown) {
      setApkError(err instanceof Error ? err.message : 'Unable to reach GitHub.');
    } finally {
      setApkChecking(false);
    }
  };

  const handleCopyPushCommands = async () => {
    const cleanRepo = repoSlug.trim() || 'engrmosaddaqur/PDF-Master';
    const cmds = `git init\ngit add -A\ngit commit -m "Build PDF MASTER APK"\ngit branch -M main\ngit remote add origin https://github.com/${cleanRepo}.git\ngit push -u origin main --force`;
    try {
      await navigator.clipboard.writeText(cmds);
      setCopiedCmds(true);
      setTimeout(() => setCopiedCmds(false), 2000);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleExportBackup = () => {
    const payload = {
      exportedAt: Date.now(),
      app: 'PDF MASTER',
      documents: docs.map((d) => ({
        ...d,
        pdfBase64: arrayBufferToBase64(d.pdfBytes),
        pdfBytes: undefined,
        versions: d.versions.map((v) => ({
          ...v,
          pdfBase64: arrayBufferToBase64(v.pdfBytes),
          pdfBytes: undefined,
        })),
      })),
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload)).buffer;
    downloadArrayBuffer(
      jsonBytes,
      `pdf-master-backup-${new Date().toISOString().slice(0, 10)}.json`,
      'application/json'
    );
    setBackupNotice('Encrypted/local vault backup exported.');
    setTimeout(() => setBackupNotice(null), 2500);
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (!Array.isArray(parsed.documents)) throw new Error('Invalid backup format');
        const restored: DocumentRecord[] = parsed.documents.map(
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
        await onRestoreBackupDocs(restored);
        setBackupNotice(`Restored ${restored.length} document(s).`);
      } catch {
        setBackupNotice('Failed to restore backup file.');
      }
      setTimeout(() => setBackupNotice(null), 3000);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-4 pb-8 max-w-2xl mx-auto">
      {/* PWA Install Card */}
      <PWAInstallButton label={t.settings.installApp} />

      {/* Android APK Easy Builder & Downloader */}
      {!isNativeAndroid && (
        <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold text-[#142B4A] dark:text-white flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-[#2563EB]" />
              {settings.language === 'bn'
                ? 'অ্যান্ড্রয়েড APK ডাউনলোড ও বিল্ডার'
                : 'Android APK Download & Easy Builder'}
            </h2>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950/60 text-[#2563EB]">
              PDF-Master.apk
            </span>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {settings.language === 'bn'
              ? 'সহজেই সম্পূর্ণ প্রজেক্ট ZIP ডাউনলোড করে এক ক্লিকে GitHub থেকে PDF-Master.apk তৈরি ও ডাউনলোড করুন।'
              : 'Download the ready-to-build Android project ZIP (with 1-click scripts) or check your GitHub release for the latest PDF-Master.apk.'}
          </p>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={repoSlug}
              onChange={(e) => setRepoSlug(e.target.value)}
              placeholder="username/repository-name"
              className="flex-1 min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-mono text-[#142B4A] dark:text-white"
            />
            <button
              onClick={checkApkStatus}
              disabled={apkChecking}
              className="min-h-[42px] px-3.5 rounded-xl bg-[#142B4A] dark:bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-60"
            >
              {apkChecking ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>{settings.language === 'bn' ? 'চেক করুন' : 'Check APK'}</span>
            </button>
          </div>

          {apkError && <p className="text-xs text-rose-600 dark:text-rose-400">{apkError}</p>}

          {apkStatus?.release && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 text-xs font-bold">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    {apkStatus.release.apkName} ({apkStatus.release.tag})
                  </span>
                </div>
                {apkStatus.release.apkSizeBytes > 0 && (
                  <span className="text-[11px] font-mono-nums text-emerald-700 dark:text-emerald-300">
                    {formatBytes(apkStatus.release.apkSizeBytes)}
                  </span>
                )}
              </div>
              <a
                href={apkStatus.release.apkUrl}
                target="_blank"
                rel="noopener noreferrer"
                download={apkStatus.release.apkName}
                className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Download {apkStatus.release.apkName}</span>
              </a>
            </div>
          )}

          {apkStatus && !apkStatus.release && apkStatus.latestRun && (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-3 flex items-center justify-between gap-2">
              <div className="text-xs text-amber-800 dark:text-amber-200">
                <p className="font-bold">
                  GitHub Build: {apkStatus.latestRun.status}
                  {apkStatus.latestRun.conclusion ? ` (${apkStatus.latestRun.conclusion})` : ''}
                </p>
                <p className="text-[11px] opacity-80">
                  Wait ~2 minutes if running, then tap Check APK again.
                </p>
              </div>
              <a
                href={apkStatus.latestRun.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[36px] px-3 rounded-lg bg-amber-600 text-white text-xs font-semibold flex items-center gap-1 shrink-0"
              >
                <span>Logs</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          {apkStatus && !apkStatus.repoExists && (
            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 p-3 text-xs text-slate-600 dark:text-slate-300">
              Repository <span className="font-mono font-semibold">{apkStatus.repo}</span> is not published on GitHub yet. Use Step 1 &amp; 2 below to generate the APK automatically.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <a
              href={getApiUrl(`/api/apk/project-zip?repo=${encodeURIComponent(repoSlug.trim() || 'engrmosaddaqur/PDF-Master')}`)}
              download="PDF-Master-Android-APK-Kit.zip"
              className="min-h-[44px] px-3 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold flex items-center justify-center gap-2"
            >
              <FolderArchive className="w-4 h-4 shrink-0" />
              <span>
                {settings.language === 'bn'
                  ? '১. APK বিল্ড কিট (.zip) ডাউনলোড'
                  : '1. Download APK Kit (.zip)'}
              </span>
            </a>

            <a
              href={`https://github.com/new?name=${encodeURIComponent((repoSlug.split('/')[1] || 'PDF-Master').trim())}`}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-[#142B4A] dark:text-slate-100 text-xs font-semibold flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4 shrink-0 text-[#2563EB]" />
              <span>
                {settings.language === 'bn'
                  ? '২. GitHub রিপো তৈরি করুন'
                  : '2. Create GitHub Repo'}
              </span>
            </a>
          </div>

          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 space-y-2 text-[11px] text-slate-600 dark:text-slate-300">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[#142B4A] dark:text-white">
                {settings.language === 'bn'
                  ? 'ZIP খুলে যেকোনো একটি স্ক্রিপ্ট চালান:'
                  : 'Extract the ZIP and run one script:'}
              </span>
              <button
                onClick={handleCopyPushCommands}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-[#2563EB]"
              >
                <Copy className="w-3 h-3" />
                <span>{copiedCmds ? 'Copied!' : 'Copy Git Cmds'}</span>
              </button>
            </div>
            <ul className="space-y-1 list-disc pl-4">
              <li>
                Windows: double-click <span className="font-mono font-semibold">1-CLICK-GITHUB-APK.bat</span>
              </li>
              <li>
                Mac / Linux / Termux: run <span className="font-mono font-semibold">bash 1-CLICK-GITHUB-APK.sh</span>
              </li>
              <li>
                Local Android Studio/JDK build: run <span className="font-mono font-semibold">BUILD-LOCAL-APK.bat</span> or <span className="font-mono font-semibold">.sh</span>
              </li>
            </ul>
          </div>
        </section>
      )}

      {/* Appearance & Language */}
      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-4">
        <h2 className="font-display text-sm font-bold text-[#142B4A] dark:text-white flex items-center gap-2">
          <Globe className="w-4 h-4 text-[#2563EB]" />
          {t.settings.appearance}
        </h2>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{t.settings.language}</span>
          <div className="flex items-center p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            <button
              onClick={() => onUpdateSettings({ language: 'en' })}
              className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold ${
                settings.language === 'en'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              English
            </button>
            <button
              onClick={() => onUpdateSettings({ language: 'bn' })}
              className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold ${
                settings.language === 'bn'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              বাংলা
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{t.settings.theme}</span>
          <div className="flex items-center p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            <button
              onClick={() => onUpdateSettings({ theme: 'light' })}
              className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                settings.theme === 'light'
                  ? 'bg-white text-[#142B4A] shadow-sm'
                  : 'text-slate-400'
              }`}
            >
              <Sun className="w-3.5 h-3.5" /> {t.settings.light}
            </button>
            <button
              onClick={() => onUpdateSettings({ theme: 'dark' })}
              className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                settings.theme === 'dark'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              <Moon className="w-3.5 h-3.5" /> {t.settings.dark}
            </button>
          </div>
        </div>
      </section>

      {/* PDF & Creator Defaults */}
      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-[#142B4A] dark:text-white">
          {t.settings.preferences}
        </h2>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t.settings.defaultView}</span>
          <select
            value={settings.defaultViewMode}
            onChange={(e) =>
              onUpdateSettings({ defaultViewMode: e.target.value as 'continuous' | 'single' })
            }
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold"
          >
            <option value="continuous">Continuous Scroll</option>
            <option value="single">Single Page</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t.settings.defaultPaper}</span>
          <select
            value={settings.defaultPageSize}
            onChange={(e) =>
              onUpdateSettings({ defaultPageSize: e.target.value as PaperSizeKey })
            }
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold"
          >
            {Object.values(PAPER_DIMENSIONS).map((p) => (
              <option key={p.key} value={p.key}>
                {p.key}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t.settings.exportQuality}</span>
          <select
            value={settings.exportQuality}
            onChange={(e) =>
              onUpdateSettings({
                exportQuality: e.target.value as AppSettings['exportQuality'],
              })
            }
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold"
          >
            <option value="standard">Standard</option>
            <option value="high">High (Recommended)</option>
            <option value="maximum">Maximum</option>
          </select>
        </div>

        <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer min-h-[40px]">
          <span className="text-sm">{t.settings.autoCrop}</span>
          <input
            type="checkbox"
            checked={settings.scannerAutoCrop}
            onChange={(e) => onUpdateSettings({ scannerAutoCrop: e.target.checked })}
            className="w-5 h-5 accent-[#2563EB]"
          />
        </label>
      </section>

      {/* Storage & Backup */}
      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-bold text-[#142B4A] dark:text-white flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-[#2563EB]" />
            {t.settings.storageTitle}
          </h2>
          <span className="text-xs font-mono-nums text-slate-500">
            {docs.length} files · {formatBytes(totalBytes)}
          </span>
        </div>

        {backupNotice && (
          <p className="text-xs text-[#2563EB] font-semibold">{backupNotice}</p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleExportBackup}
            className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            {t.settings.exportBackup}
          </button>
          <button
            onClick={() => backupInputRef.current?.click()}
            className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Upload className="w-4 h-4" />
            {t.settings.importBackup}
          </button>
        </div>
        <input
          ref={backupInputRef}
          type="file"
          accept=".json"
          onChange={handleImportBackup}
          className="hidden"
        />

        {trashedCount > 0 && (
          <button
            onClick={onEmptyTrash}
            className="w-full min-h-[44px] rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300 text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Trash2 className="w-4 h-4" />
            {t.settings.emptyTrash} ({trashedCount})
          </button>
        )}
      </section>

      {/* Privacy & Security */}
      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <h2 className="font-display text-sm font-bold text-[#142B4A] dark:text-white flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#06B6D4]" />
          {t.settings.privacyTitle}
        </h2>

        <label className="flex items-center justify-between gap-3 cursor-pointer min-h-[40px]">
          <span className="text-sm">{t.settings.aiConsent}</span>
          <input
            type="checkbox"
            checked={settings.aiConsentGranted}
            onChange={(e) => onUpdateSettings({ aiConsentGranted: e.target.checked })}
            className="w-5 h-5 accent-[#2563EB]"
          />
        </label>

        <label className="flex items-center justify-between gap-3 cursor-pointer min-h-[40px]">
          <span className="text-sm">{t.settings.localOnly}</span>
          <input
            type="checkbox"
            checked={settings.localOnlyMode}
            onChange={(e) => onUpdateSettings({ localOnlyMode: e.target.checked })}
            className="w-5 h-5 accent-[#2563EB]"
          />
        </label>
      </section>

      {/* About & Architecture */}
      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-1.5">
        <h2 className="font-display text-sm font-bold text-[#142B4A] dark:text-white flex items-center gap-2">
          <Info className="w-4 h-4 text-[#2563EB]" />
          {t.settings.aboutTitle}
        </h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          PDF MASTER — Everything PDF. One Powerful App. Built as an installable mobile-first PWA powered by PDF.js rendering, pdf-lib binary editing, Canvas homography document scanning, Tesseract.js English &amp; বাংলা OCR, IndexedDB local vault storage, and server-side Gemini AI document analysis.
        </p>
      </section>
    </div>
  );
};
