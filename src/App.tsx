import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Edit3,
  FilePlus2,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  Home,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Plus,
  PlusCircle,
  Search,
  Settings as SettingsIcon,
  Share2,
  X,
} from 'lucide-react';
import type {
  ActiveWorkspace,
  AppSettings,
  DocumentCategory,
  DocumentRecord,
  FolderRecord,
  NavTab,
  PaperSizeKey,
} from './types';
import { getT } from './i18n/translations';
import {
  cloneBuffer,
  createBlankPdf,
  getPdfDocumentInfo,
  renderPageThumbnail,
} from './services/pdfEngine';
import {
  deleteAllDocuments,
  deleteDocumentForever,
  formatBytes,
  formatRelativeTime,
  getAllDocuments,
  getAllFolders,
  loadSettings,
  saveDocument,
  saveFolder,
  saveSettings,
  seedInitialDocumentsIfNeeded,
} from './services/storageService';
import { Directory, Filesystem } from '@capacitor/filesystem';
import {
  type AppToastDetail,
  base64ToArrayBuffer,
  emitAppToast,
  shareBufferNativeOrWeb,
} from './services/deviceFileActions';
import { PdfMasterLogo } from './components/Logo';
import { OfflineIndicator, PWAInstallButton } from './components/PWAComponents';
import { HomeTab } from './components/HomeTab';
import { FilesTab } from './components/FilesTab';
import { ToolsTab } from './components/ToolsTab';
import { CreateTab } from './components/CreateTab';
import { SettingsTab } from './components/SettingsTab';
import { PdfViewerView } from './components/PdfViewerView';
import { PdfEditorView } from './components/PdfEditorView';
import { PageOrganizerView } from './components/PageOrganizerView';
import { ScannerView } from './components/ScannerView';
import { OcrView } from './components/OcrView';
import { WordCreatorView } from './components/WordCreatorView';
import { CompareView } from './components/CompareView';
import { ToolRunnerModal } from './components/ToolRunnerModal';

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [filesInitialCat, setFilesInitialCat] = useState<DocumentCategory>('my');
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [workspace, setWorkspace] = useState<ActiveWorkspace>({ type: 'none' });
  const [creatorTemplateHtml, setCreatorTemplateHtml] = useState<string | undefined>(undefined);
  const [showFabSheet, setShowFabSheet] = useState(false);
  const [pendingPickMode, setPendingPickMode] = useState<'editor' | 'organizer' | null>(null);
  const [pickSearch, setPickSearch] = useState('');
  const [appToast, setAppToast] = useState<AppToastDetail | null>(null);
  const [loadingVault, setLoadingVault] = useState(true);
  const [externalDoc, setExternalDoc] = useState<DocumentRecord | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImportTargetRef = useRef<'viewer' | 'editor' | 'organizer'>('viewer');

  const t = getT(settings.language);

  // Sync light/dark/auto class on <html>
  useEffect(() => {
    const applyTheme = () => {
      const prefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      const isDark =
        settings.theme === 'dark' || (settings.theme === 'auto' && prefersDark);
      document.documentElement.classList.toggle('dark', isDark);
      document.documentElement.lang = settings.language;
    };

    applyTheme();
    if (settings.theme === 'auto' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', applyTheme);
      return () => mq.removeEventListener('change', applyTheme);
    }
  }, [settings.theme, settings.language]);

  // Load Vault documents & folders
  useEffect(() => {
    const init = async () => {
      await seedInitialDocumentsIfNeeded();
      const [loadedDocs, loadedFolders] = await Promise.all([
        getAllDocuments(),
        getAllFolders(),
      ]);
      setDocs(loadedDocs);
      setFolders(loadedFolders);
      setLoadingVault(false);
    };
    init().catch(() => setLoadingVault(false));
  }, []);

  // Global toast notifications for Download, Save, Share, Print feedback
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onToast = (e: Event) => {
      const custom = e as CustomEvent<AppToastDetail>;
      setAppToast(custom.detail);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setAppToast(null), 4500);
    };
    window.addEventListener('pm-app-toast', onToast);
    return () => {
      window.removeEventListener('pm-app-toast', onToast);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const updateSettings = (patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const upsertDoc = async (doc: DocumentRecord) => {
    await saveDocument(doc);
    setDocs((prev) => {
      const exists = prev.some((d) => d.id === doc.id);
      const next = exists ? prev.map((d) => (d.id === doc.id ? doc : d)) : [doc, ...prev];
      return next.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  };

  const openExternalPdfBuffer = async (name: string, buf: ArrayBuffer) => {
    try {
      const info = await getPdfDocumentInfo(buf).catch(() => ({ pageCount: 1 }));
      const now = Date.now();
      const normalizedName = name.trim() || 'document.pdf';
      const record: DocumentRecord = {
        id: `ext_${now}_${Math.random().toString(36).slice(2, 6)}`,
        name: normalizedName,
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
        pdfBytes: cloneBuffer(buf),
        versions: [
          {
            id: `ver_${now}`,
            timestamp: now,
            note: 'Opened from device storage',
            sizeBytes: buf.byteLength,
            pdfBytes: cloneBuffer(buf),
          },
        ],
      };
      setExternalDoc(record);
      setWorkspace({ type: 'viewer', docId: record.id });
    } catch (err) {
      console.error('Failed to open external PDF:', err);
      emitAppToast({
        message:
          settings.language === 'bn'
            ? 'ফাইলটি পিডিএফ হিসেবে খোলা যায়নি।'
            : 'Unable to open selected PDF file.',
        variant: 'error',
      });
    }
  };

  const promoteExternalDocToVault = async (doc: DocumentRecord): Promise<DocumentRecord> => {
    const thumb =
      doc.thumbnailDataUrl ||
      (await renderPageThumbnail(doc.pdfBytes, 1, 200).catch(() => undefined));
    const persisted: DocumentRecord = {
      ...doc,
      thumbnailDataUrl: thumb,
      updatedAt: Date.now(),
    };
    await upsertDoc(persisted);
    setExternalDoc(null);
    return persisted;
  };

  // Listen for external PDF launches (Android Intent, Windows .exe CLI/IPC, PWA launchQueue)
  useEffect(() => {
    const checkAndroidIntent = async () => {
      const bridge = (
        window as unknown as {
          AndroidPdfBridge?: { consumePendingPdf?: () => string | null };
        }
      ).AndroidPdfBridge;
      if (!bridge?.consumePendingPdf) return;
      const raw = bridge.consumePendingPdf();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as { name?: string; cacheFile?: string };
        if (parsed.cacheFile) {
          const readRes = await Filesystem.readFile({
            path: parsed.cacheFile,
            directory: Directory.Cache,
          });
          const buf =
            typeof readRes.data === 'string'
              ? base64ToArrayBuffer(readRes.data)
              : await readRes.data.arrayBuffer();
          await openExternalPdfBuffer(parsed.name || 'document.pdf', buf);
        }
      } catch (err) {
        console.error('Android external PDF open error:', err);
      }
    };

    void checkAndroidIntent();
    const onNativePdfEvent = () => {
      void checkAndroidIntent();
    };
    window.addEventListener('pm-open-external-pdf', onNativePdfEvent);

    const desktopBridge = (
      window as unknown as {
        desktopPdfBridge?: {
          consumePendingPdf?: () => Promise<{ name: string; bytes: Uint8Array } | null>;
          onOpenExternalPdf?: (
            cb: (payload: { name: string; bytes: Uint8Array }) => void
          ) => () => void;
        };
      }
    ).desktopPdfBridge;

    if (desktopBridge?.consumePendingPdf) {
      void desktopBridge.consumePendingPdf().then((payload) => {
        if (payload?.bytes) {
          const u8 = new Uint8Array(payload.bytes);
          void openExternalPdfBuffer(payload.name || 'document.pdf', u8.slice().buffer);
        }
      });
    }
    const unsubDesktop = desktopBridge?.onOpenExternalPdf?.((payload) => {
      if (payload?.bytes) {
        const u8 = new Uint8Array(payload.bytes);
        void openExternalPdfBuffer(payload.name || 'document.pdf', u8.slice().buffer);
      }
    });

    const winAny = window as unknown as {
      launchQueue?: {
        setConsumer: (
          cb: (params: { files?: Array<{ getFile: () => Promise<File> }> }) => void
        ) => void;
      };
    };
    winAny.launchQueue?.setConsumer(async (launchParams) => {
      const firstHandle = launchParams.files?.[0];
      if (!firstHandle) return;
      try {
        const file = await firstHandle.getFile();
        const buf = await file.arrayBuffer();
        await openExternalPdfBuffer(file.name || 'document.pdf', buf);
      } catch (err) {
        console.error('PWA launchQueue PDF open error:', err);
      }
    });

    return () => {
      window.removeEventListener('pm-open-external-pdf', onNativePdfEvent);
      unsubDesktop?.();
    };
  }, []);

  const handleImportPdfs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const targetWorkspace = pendingImportTargetRef.current;
    pendingImportTargetRef.current = 'viewer';
    if (!files.length) return;
    setShowFabSheet(false);

    for (const file of files) {
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
              note: 'Imported from device',
              sizeBytes: buf.byteLength,
              pdfBytes: cloneBuffer(buf),
            },
          ],
        };
        await upsertDoc(record);
        if (files.length === 1) {
          setWorkspace({ type: targetWorkspace, docId: record.id });
        }
        emitAppToast({
          message:
            settings.language === 'bn'
              ? `ইমপোর্ট হয়েছে: ${record.name}`
              : `Imported ${record.name}`,
          variant: 'success',
        });
      } catch (err) {
        console.error('Failed to import PDF:', err);
        emitAppToast({
          message:
            settings.language === 'bn'
              ? 'পিডিএফ ইমপোর্ট করা যায়নি।'
              : 'Failed to open selected PDF.',
          variant: 'error',
        });
      }
    }
    e.target.value = '';
  };

  const handleCreateBlankPdf = async (options: {
    paperSize: PaperSizeKey;
    orientation: 'portrait' | 'landscape';
    pageCount: number;
    fileName: string;
    customWidthMm?: number;
    customHeightMm?: number;
  }) => {
    const pdfBytes = await createBlankPdf(options);
    const thumb = await renderPageThumbnail(pdfBytes, 1, 200).catch(() => undefined);
    const now = Date.now();
    const baseName = options.fileName.trim() || `Untitled ${options.paperSize}`;
    const normalizedName = baseName.toLowerCase().endsWith('.pdf')
      ? baseName
      : `${baseName}.pdf`;
    const record: DocumentRecord = {
      id: `doc_blank_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name: normalizedName,
      origin: 'created',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      sizeBytes: pdfBytes.byteLength,
      pageCount: Math.max(1, Math.min(200, options.pageCount)),
      isStarred: false,
      isShared: false,
      isTrashed: false,
      folderId: null,
      thumbnailDataUrl: thumb,
      pdfBytes: cloneBuffer(pdfBytes),
      versions: [
        {
          id: `ver_${now}`,
          timestamp: now,
          note: `Blank ${options.paperSize} (${options.orientation})`,
          sizeBytes: pdfBytes.byteLength,
          pdfBytes: cloneBuffer(pdfBytes),
        },
      ],
    };
    await upsertDoc(record);
    emitAppToast({
      message:
        settings.language === 'bn'
          ? `তৈরি ও সেভ হয়েছে: ${record.name}`
          : `Saved ${record.name}`,
      variant: 'success',
      shareFile: {
        buf: record.pdfBytes,
        filename: record.name,
        mime: 'application/pdf',
      },
    });
    setWorkspace({ type: 'viewer', docId: record.id });
  };

  const handleDuplicateDoc = async (doc: DocumentRecord) => {
    const now = Date.now();
    const copy: DocumentRecord = {
      ...doc,
      id: `doc_dup_${now}`,
      name: doc.name.replace(/\.pdf$/i, '') + ' (Copy).pdf',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      pdfBytes: cloneBuffer(doc.pdfBytes),
      versions: [
        {
          id: `ver_${now}`,
          timestamp: now,
          note: 'Duplicated document',
          sizeBytes: doc.sizeBytes,
          pdfBytes: cloneBuffer(doc.pdfBytes),
        },
      ],
    };
    await upsertDoc(copy);
  };

  const handleDeleteForever = async (id: string) => {
    await deleteDocumentForever(id);
    setDocs((prev) => prev.filter((d) => d.id !== id));
  };

  const handleEmptyTrash = async () => {
    const trashed = docs.filter((d) => d.isTrashed);
    for (const d of trashed) {
      await deleteDocumentForever(d.id);
    }
    setDocs((prev) => prev.filter((d) => !d.isTrashed));
  };

  const handleDeleteAllFiles = async () => {
    await deleteAllDocuments();
    setDocs([]);
  };

  const handleCreateFolder = async (name: string) => {
    const folder: FolderRecord = {
      id: `fld_${Date.now()}`,
      name,
      createdAt: Date.now(),
      color: '#2563EB',
    };
    await saveFolder(folder);
    setFolders((prev) => [...prev, folder]);
  };

  const handleRestoreBackupDocs = async (restored: DocumentRecord[]) => {
    for (const d of restored) {
      await saveDocument(d);
    }
    const all = await getAllDocuments();
    setDocs(all);
  };

  const openDocumentInViewer = async (doc: DocumentRecord) => {
    const touched = { ...doc, lastOpenedAt: Date.now() };
    await upsertDoc(touched);
    setWorkspace({ type: 'viewer', docId: doc.id });
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: t.nav.home, icon: <Home className="w-5 h-5" /> },
    { id: 'files', label: t.nav.files, icon: <Folder className="w-5 h-5" /> },
    { id: 'tools', label: t.nav.tools, icon: <LayoutGrid className="w-5 h-5" /> },
    { id: 'create', label: t.nav.create, icon: <PlusCircle className="w-5 h-5" /> },
    { id: 'settings', label: t.nav.settings, icon: <SettingsIcon className="w-5 h-5" /> },
  ];

  const activeDocForWorkspace =
    'docId' in workspace && workspace.docId
      ? externalDoc && externalDoc.id === workspace.docId
        ? externalDoc
        : docs.find((d) => d.id === workspace.docId)
      : undefined;

  const isExternalViewerActive = Boolean(
    workspace.type === 'viewer' &&
      externalDoc &&
      activeDocForWorkspace &&
      externalDoc.id === activeDocForWorkspace.id
  );

  const recentEditableDocs = docs
    .filter((d) => !d.isTrashed && !d.isVaultLocked)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .filter((d) =>
      pickSearch.trim() ? d.name.toLowerCase().includes(pickSearch.toLowerCase()) : true
    );

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F7FB] dark:bg-[#0A0F1A] text-slate-900 dark:text-slate-100">
      <OfflineIndicator />

      {/* Desktop / Tablet Top App Bar (Hidden on mobile so screenshots match edge-to-edge mobile layout) */}
      <header className="hidden md:flex sticky top-0 z-30 h-14 px-5 bg-white/90 dark:bg-[#0D1322]/90 backdrop-blur-md border-b border-slate-200 dark:border-[#1E293B] items-center justify-between gap-4 pt-safe">
        <PdfMasterLogo size={34} />

        <nav className="flex items-center gap-6 text-sm font-semibold">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`min-h-[40px] px-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                activeTab === item.id
                  ? 'border-[#3B82F6] text-[#2563EB] dark:text-[#60A5FA]'
                  : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <PWAInstallButton compact label="Install" />
          <button
            onClick={() => {
              pendingImportTargetRef.current = 'viewer';
              importInputRef.current?.click();
            }}
            className="min-h-[40px] px-4 rounded-xl bg-gradient-to-r from-[#3B82F6] to-[#06B6D4] text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 shadow-md shadow-blue-500/20 active:scale-[0.98] transition-transform"
          >
            <FileUp className="w-4 h-4" />
            <span>{t.home.importPdf}</span>
          </button>
        </div>
      </header>

      {/* Main Scrollable Viewport */}
      <main
        className={`flex-1 w-full max-w-6xl mx-auto px-4 pb-24 md:pb-10 ${
          activeTab === 'home' ? 'pt-0 md:pt-5' : 'pt-4 md:pt-5'
        }`}
      >
        {loadingVault ? (
          <div className="py-24 text-center text-sm text-slate-500 dark:text-slate-400">
            Loading Document Vault...
          </div>
        ) : (
          <>
            {activeTab === 'home' && (
              <HomeTab
                language={settings.language}
                docs={docs}
                onImportPdf={() => {
                  pendingImportTargetRef.current = 'viewer';
                  importInputRef.current?.click();
                }}
                onOpenWorkspace={(ws) => {
                  setCreatorTemplateHtml(undefined);
                  setWorkspace(ws);
                }}
                onPickDocForWorkspace={(mode) => {
                  setPickSearch('');
                  setPendingPickMode(mode);
                }}
                onNavigateFiles={(cat) => {
                  setFilesInitialCat(cat);
                  setActiveTab('files');
                }}
                onNavigateTools={() => setActiveTab('tools')}
              />
            )}

            {activeTab === 'files' && (
              <FilesTab
                language={settings.language}
                docs={docs}
                folders={folders}
                initialCategory={filesInitialCat}
                onImportPdf={() => {
                  pendingImportTargetRef.current = 'viewer';
                  importInputRef.current?.click();
                }}
                onOpenDoc={openDocumentInViewer}
                onEditDoc={(doc) => setWorkspace({ type: 'editor', docId: doc.id })}
                onUpdateDoc={upsertDoc}
                onSaveNewDoc={upsertDoc}
                onDuplicateDoc={handleDuplicateDoc}
                onDeleteForever={handleDeleteForever}
                onCreateFolder={handleCreateFolder}
              />
            )}

            {activeTab === 'tools' && (
              <ToolsTab
                language={settings.language}
                docs={docs}
                onOpenWorkspace={(ws) => setWorkspace(ws)}
                onPickDocForWorkspace={(mode) => {
                  setPickSearch('');
                  setPendingPickMode(mode);
                }}
              />
            )}

            {activeTab === 'create' && (
              <CreateTab
                language={settings.language}
                docs={docs}
                defaultPageSize={settings.defaultPageSize}
                onCreateBlankPdf={handleCreateBlankPdf}
                onOpenWorkspace={(ws) => {
                  setCreatorTemplateHtml(undefined);
                  setWorkspace(ws);
                }}
                onStartFromTemplate={(html) => {
                  setCreatorTemplateHtml(html);
                  setWorkspace({ type: 'wordCreator' });
                }}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsTab
                settings={settings}
                docs={docs}
                onUpdateSettings={updateSettings}
                onEmptyTrash={handleEmptyTrash}
                onDeleteAllFiles={handleDeleteAllFiles}
                onRestoreBackupDocs={handleRestoreBackupDocs}
              />
            )}
          </>
        )}
      </main>

      {/* Circular Gradient Floating Action Button */}
      {workspace.type === 'none' &&
        (activeTab === 'home' || activeTab === 'files' || activeTab === 'tools') && (
          <button
            onClick={() => setShowFabSheet(true)}
            aria-label="Quick create or import"
            className="fixed bottom-20 md:bottom-6 right-4 z-30 w-14 h-14 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#06B6D4] text-white shadow-xl shadow-cyan-500/30 flex items-center justify-center active:scale-95 transition-transform"
          >
            <Plus className="w-7 h-7 stroke-[2.5]" />
          </button>
        )}

      {/* Mobile Bottom Navigation Bar (Matches Screenshot Pill Indicator) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-[#0D1322]/95 backdrop-blur-md border-t border-slate-200 dark:border-[#1E293B] pb-safe">
        <div className="grid grid-cols-5 items-center h-[64px]">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  active
                    ? 'text-[#2563EB] dark:text-[#3B82F6]'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <span
                  className={`px-4 py-1 rounded-full transition-colors ${
                    active ? 'bg-[#2563EB]/12 dark:bg-[#2563EB]/20' : ''
                  }`}
                >
                  {item.icon}
                </span>
                <span className="text-[10.5px] font-semibold tracking-tight whitespace-nowrap">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Hidden File Picker for PDF Import */}
      <input
        ref={importInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        onChange={handleImportPdfs}
        className="hidden"
      />

      {/* FAB Quick Action Bottom Sheet */}
      {showFabSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowFabSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#121929] border-t sm:border border-slate-200 dark:border-[#1E293B] p-5 shadow-2xl space-y-2"
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mb-1 sm:hidden" />
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                {settings.language === 'bn' ? 'দ্রুত শুরু করুন' : 'Quick Create or Import'}
              </h3>
              <button
                onClick={() => setShowFabSheet(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full text-slate-500 dark:text-slate-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <button
              onClick={() => {
                pendingImportTargetRef.current = 'viewer';
                importInputRef.current?.click();
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-100 dark:bg-[#1A243B] flex items-center gap-3 text-sm font-semibold text-slate-900 dark:text-white"
            >
              <FileUp className="w-5 h-5 text-[#3B82F6]" />
              <span>{settings.language === 'bn' ? 'ডিভাইস থেকে পিডিএফ আনুন' : 'Import PDF from Device'}</span>
            </button>
            <button
              onClick={() => {
                setShowFabSheet(false);
                setWorkspace({ type: 'scanner' });
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-100 dark:bg-[#1A243B] flex items-center gap-3 text-sm font-semibold text-slate-900 dark:text-white"
            >
              <Camera className="w-5 h-5 text-[#06B6D4]" />
              <span>{settings.language === 'bn' ? 'ক্যামেরা দিয়ে স্ক্যান করুন' : 'Scan Document with Camera'}</span>
            </button>
            <button
              onClick={() => {
                setShowFabSheet(false);
                setCreatorTemplateHtml(undefined);
                setWorkspace({ type: 'wordCreator' });
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-100 dark:bg-[#1A243B] flex items-center gap-3 text-sm font-semibold text-slate-900 dark:text-white"
            >
              <FilePlus2 className="w-5 h-5 text-emerald-500" />
              <span>{settings.language === 'bn' ? 'নতুন ওয়ার্ড ডকুমেন্ট তৈরি' : 'Create Word-Style Document'}</span>
            </button>
            <button
              onClick={() => {
                setShowFabSheet(false);
                setWorkspace({ type: 'toolRunner', toolId: 'imagesToPdf' });
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-100 dark:bg-[#1A243B] flex items-center gap-3 text-sm font-semibold text-slate-900 dark:text-white"
            >
              <ImageIcon className="w-5 h-5 text-indigo-400" />
              <span>{settings.language === 'bn' ? 'ছবি থেকে পিডিএফ তৈরি' : 'Convert Images to PDF'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Active Full-Screen Mobile Workspaces */}
      {workspace.type === 'viewer' && activeDocForWorkspace && (
        <PdfViewerView
          key={activeDocForWorkspace.id}
          doc={activeDocForWorkspace}
          language={settings.language}
          defaultViewMode={settings.defaultViewMode}
          isExternalSession={isExternalViewerActive}
          onClose={() => {
            setExternalDoc(null);
            setWorkspace({ type: 'none' });
          }}
          onUpdateDoc={async (updated) => {
            if (isExternalViewerActive) {
              setExternalDoc(updated);
            } else {
              await upsertDoc(updated);
            }
          }}
          onSaveExternalToVault={async (doc) => {
            const persisted = await promoteExternalDocToVault(doc);
            emitAppToast({
              message:
                settings.language === 'bn'
                  ? `অ্যাপ ভল্টে সেভ হয়েছে: ${persisted.name}`
                  : `Saved to App Vault: ${persisted.name}`,
              variant: 'success',
            });
          }}
          onOpenFullApp={() => {
            setExternalDoc(null);
            setWorkspace({ type: 'none' });
          }}
          onOpenEditor={async () => {
            const target = isExternalViewerActive
              ? await promoteExternalDocToVault(activeDocForWorkspace)
              : activeDocForWorkspace;
            setWorkspace({ type: 'editor', docId: target.id });
          }}
          onOpenOrganizer={async () => {
            const target = isExternalViewerActive
              ? await promoteExternalDocToVault(activeDocForWorkspace)
              : activeDocForWorkspace;
            setWorkspace({ type: 'organizer', docId: target.id });
          }}
        />
      )}

      {workspace.type === 'editor' && activeDocForWorkspace && (
        <PdfEditorView
          doc={activeDocForWorkspace}
          language={settings.language}
          onClose={() => setWorkspace({ type: 'none' })}
          onSaveNewVersion={upsertDoc}
          onSaveAsCopy={upsertDoc}
        />
      )}

      {workspace.type === 'organizer' && activeDocForWorkspace && (
        <PageOrganizerView
          doc={activeDocForWorkspace}
          allDocs={docs}
          language={settings.language}
          onClose={() => setWorkspace({ type: 'none' })}
          onSaveDocument={upsertDoc}
          onCreateExtractedDoc={upsertDoc}
          onImportDoc={upsertDoc}
        />
      )}

      {workspace.type === 'scanner' && (
        <ScannerView
          language={settings.language}
          autoCropDefault={settings.scannerAutoCrop}
          defaultFilter={settings.scannerDefaultFilter}
          onClose={() => setWorkspace({ type: 'none' })}
          onSaveScannedPdf={async (newDoc, openOcrAfter) => {
            await upsertDoc(newDoc);
            if (openOcrAfter) {
              setWorkspace({ type: 'ocr', docId: newDoc.id });
            } else {
              setWorkspace({ type: 'viewer', docId: newDoc.id });
            }
          }}
        />
      )}

      {workspace.type === 'ocr' && (
        <OcrView
          language={settings.language}
          docs={docs}
          initialDocId={workspace.docId}
          onImportDoc={upsertDoc}
          onClose={() => setWorkspace({ type: 'none' })}
          onSaveSearchablePdf={upsertDoc}
          onOpenInWordCreator={(html) => {
            setCreatorTemplateHtml(html);
            setWorkspace({ type: 'wordCreator' });
          }}
        />
      )}

      {workspace.type === 'wordCreator' && (
        <WordCreatorView
          language={settings.language}
          defaultPageSize={settings.defaultPageSize}
          existingDoc={activeDocForWorkspace}
          initialHtml={creatorTemplateHtml}
          onClose={() => setWorkspace({ type: 'none' })}
          onSaveDocument={upsertDoc}
        />
      )}

      {workspace.type === 'compare' && (
        <CompareView
          language={settings.language}
          docs={docs}
          initialDocA={workspace.docIdA}
          initialDocB={workspace.docIdB}
          onImportDoc={upsertDoc}
          onClose={() => setWorkspace({ type: 'none' })}
        />
      )}

      {workspace.type === 'toolRunner' && (
        <ToolRunnerModal
          toolId={workspace.toolId}
          language={settings.language}
          docs={docs}
          preselectedDocId={workspace.preselectedDocId}
          onClose={() => setWorkspace({ type: 'none' })}
          onSaveResultDoc={upsertDoc}
          onUpdateExistingDoc={upsertDoc}
          onOpenResultDoc={(doc, target) => setWorkspace({ type: target, docId: doc.id })}
        />
      )}

      {/* Document Picker Modal for Edit PDF / Sign / Organize Pages */}
      {pendingPickMode && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/65 backdrop-blur-sm"
          onClick={() => setPendingPickMode(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md max-h-[86vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#121929] border-t sm:border border-slate-200 dark:border-[#1E293B] shadow-2xl overflow-hidden"
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-3 sm:hidden" />

            <div className="px-5 pt-4 pb-3 border-b border-slate-200 dark:border-[#1E293B] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-[#2563EB]/15 text-[#3B82F6] flex items-center justify-center shrink-0">
                  <Edit3 className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-display text-base font-bold text-slate-900 dark:text-white truncate">
                    {pendingPickMode === 'editor'
                      ? settings.language === 'bn'
                        ? 'এডিট করার জন্য ফাইল বাছুন'
                        : 'Choose PDF to Edit'
                      : settings.language === 'bn'
                      ? 'পৃষ্ঠা সাজাতে ফাইল বাছুন'
                      : 'Choose PDF to Organize'}
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {settings.language === 'bn'
                      ? 'লোকাল স্টোরেজ বা রিসেন্ট ডকুমেন্ট থেকে বেছে নিন'
                      : 'Pick from device local storage or recent documents'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setPendingPickMode(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#1A243B]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto flex-1">
              {/* Primary Device Local Storage Picker */}
              <button
                onClick={() => {
                  pendingImportTargetRef.current = pendingPickMode;
                  setPendingPickMode(null);
                  importInputRef.current?.click();
                }}
                className="w-full min-h-[52px] px-4 rounded-2xl bg-gradient-to-r from-[#3B82F6] to-[#06B6D4] text-white font-semibold text-sm flex items-center justify-center gap-2.5 shadow-lg shadow-blue-500/25 active:scale-[0.99] transition-transform"
              >
                <FolderOpen className="w-5 h-5 shrink-0" />
                <span>
                  {settings.language === 'bn'
                    ? 'ডিভাইস স্টোরেজ থেকে পিডিএফ ওপেন করুন'
                    : 'Open PDF from Device Storage'}
                </span>
              </button>

              {/* Search recent documents */}
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  value={pickSearch}
                  onChange={(e) => setPickSearch(e.target.value)}
                  placeholder={
                    settings.language === 'bn'
                      ? 'রিসেন্ট ডকুমেন্ট খুঁজুন...'
                      : 'Search recent documents...'
                  }
                  className="w-full min-h-[42px] pl-10 pr-3 rounded-xl bg-slate-100 dark:bg-[#0D1322] border border-slate-200 dark:border-[#1E293B] text-xs font-medium text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-[#3B82F6]"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {settings.language === 'bn' ? 'সাম্প্রতিক ডকুমেন্ট' : 'Recent Documents'}
                </span>
                <span className="text-[11px] font-semibold text-slate-400">
                  {recentEditableDocs.length}
                </span>
              </div>

              {recentEditableDocs.length === 0 ? (
                <div className="py-8 text-center rounded-2xl border border-dashed border-slate-200 dark:border-[#1E293B] space-y-2">
                  <FileText className="w-8 h-8 text-slate-400 mx-auto" />
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {settings.language === 'bn'
                      ? 'কোনো রিসেন্ট পিডিএফ পাওয়া যায়নি'
                      : 'No matching recent PDFs found'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {recentEditableDocs.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => {
                        const mode = pendingPickMode;
                        setPendingPickMode(null);
                        setWorkspace({ type: mode, docId: d.id });
                      }}
                      className="w-full p-2.5 rounded-2xl bg-slate-50 dark:bg-[#161F33] hover:bg-slate-100 dark:hover:bg-[#1B263F] border border-slate-200 dark:border-[#1E293B] flex items-center gap-3 text-left transition-colors active:scale-[0.99]"
                    >
                      <div className="w-11 h-14 rounded-xl bg-white dark:bg-[#0D1322] border border-slate-200 dark:border-[#1E293B] overflow-hidden shrink-0 flex items-center justify-center">
                        {d.thumbnailDataUrl ? (
                          <img
                            src={d.thumbnailDataUrl}
                            alt={d.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <FileText className="w-5 h-5 text-[#3B82F6]" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                          {d.name}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {d.pageCount}p · {formatBytes(d.sizeBytes)} ·{' '}
                          {formatRelativeTime(d.lastOpenedAt, settings.language)}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating Feedback Toast */}
      {appToast && (
        <div className="fixed bottom-24 sm:bottom-6 left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-2rem)] max-w-md px-4 py-3 rounded-2xl bg-[#121929]/95 text-white border border-white/15 shadow-2xl backdrop-blur-md flex items-center gap-3">
          {appToast.variant === 'error' ? (
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          ) : appToast.variant === 'info' ? (
            <Info className="w-5 h-5 text-cyan-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          )}
          <span className="text-xs font-semibold flex-1 leading-snug break-words">
            {appToast.message}
          </span>
          {appToast.shareFile && (
            <button
              onClick={() => {
                const sf = appToast.shareFile!;
                void shareBufferNativeOrWeb(sf.buf, sf.filename, sf.mime);
              }}
              className="px-2.5 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-xs font-bold flex items-center gap-1 shrink-0"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>{settings.language === 'bn' ? 'শেয়ার' : 'Share'}</span>
            </button>
          )}
          <button
            onClick={() => setAppToast(null)}
            aria-label="Dismiss notification"
            className="p-1 rounded-lg hover:bg-white/10 text-slate-300 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

    </div>
  );
}
