import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  FilePlus2,
  FileUp,
  FolderOpen,
  Home,
  Image as ImageIcon,
  Plus,
  Settings as SettingsIcon,
  Wrench,
  X,
} from 'lucide-react';
import type {
  ActiveWorkspace,
  AppSettings,
  DocumentCategory,
  DocumentRecord,
  FolderRecord,
  NavTab,
} from './types';
import { getT } from './i18n/translations';
import {
  cloneBuffer,
  getPdfDocumentInfo,
  renderPageThumbnail,
} from './services/pdfEngine';
import {
  deleteDocumentForever,
  getAllDocuments,
  getAllFolders,
  loadSettings,
  saveDocument,
  saveFolder,
  saveSettings,
  seedInitialDocumentsIfNeeded,
} from './services/storageService';
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
import { AIAssistantView } from './components/AIAssistantView';
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
  const [loadingVault, setLoadingVault] = useState(true);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const t = getT(settings.language);

  // Sync light/dark class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    document.documentElement.lang = settings.language;
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

  const handleImportPdfs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
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
          setWorkspace({ type: 'viewer', docId: record.id });
        }
      } catch (err) {
        console.error('Failed to import PDF:', err);
      }
    }
    e.target.value = '';
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
    { id: 'files', label: t.nav.files, icon: <FolderOpen className="w-5 h-5" /> },
    { id: 'tools', label: t.nav.tools, icon: <Wrench className="w-5 h-5" /> },
    { id: 'create', label: t.nav.create, icon: <FilePlus2 className="w-5 h-5" /> },
    { id: 'settings', label: t.nav.settings, icon: <SettingsIcon className="w-5 h-5" /> },
  ];

  const activeDocForWorkspace =
    'docId' in workspace && workspace.docId
      ? docs.find((d) => d.id === workspace.docId)
      : undefined;

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120] text-[#1E293B] dark:text-[#F1F5F9]">
      <OfflineIndicator />

      {/* Sticky Compact Top App Bar (3-zone contract, <=56px) */}
      <header className="sticky top-0 z-30 h-14 px-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 pt-safe">
        <PdfMasterLogo size={32} />

        {/* Desktop / Tablet single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-semibold">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`min-h-[40px] px-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                activeTab === item.id
                  ? 'border-[#2563EB] text-[#2563EB]'
                  : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-[#142B4A] dark:hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:block">
            <PWAInstallButton compact label="Install" />
          </div>
          <button
            onClick={() => importInputRef.current?.click()}
            className="min-h-[40px] px-3.5 rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 active:scale-[0.98] transition-transform"
          >
            <FileUp className="w-4 h-4" />
            <span>{t.home.importPdf}</span>
          </button>
        </div>
      </header>

      {/* Main Scrollable Viewport */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 pt-4 pb-24 md:pb-10">
        {loadingVault ? (
          <div className="py-20 text-center text-sm text-slate-500">
            Loading Document Vault...
          </div>
        ) : (
          <>
            {activeTab === 'home' && (
              <HomeTab
                language={settings.language}
                docs={docs}
                onImportPdf={() => importInputRef.current?.click()}
                onOpenWorkspace={(ws) => {
                  setCreatorTemplateHtml(undefined);
                  setWorkspace(ws);
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
                onOpenDoc={openDocumentInViewer}
                onEditDoc={(doc) => setWorkspace({ type: 'editor', docId: doc.id })}
                onUpdateDoc={upsertDoc}
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
              />
            )}

            {activeTab === 'create' && (
              <CreateTab
                language={settings.language}
                docs={docs}
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
                onRestoreBackupDocs={handleRestoreBackupDocs}
              />
            )}
          </>
        )}
      </main>

      {/* Floating Action Button (Quick Create / Import) */}
      {workspace.type === 'none' && (
        <button
          onClick={() => setShowFabSheet(true)}
          aria-label="Quick create or import"
          className="fixed bottom-20 md:bottom-6 right-4 z-30 w-14 h-14 rounded-2xl bg-[#2563EB] text-white shadow-xl shadow-[#2563EB]/30 flex items-center justify-center active:scale-95 transition-transform"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}

      {/* Mobile Bottom Navigation Bar (5 destinations, <=64px height) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 pb-safe">
        <div className="grid grid-cols-5 items-center h-16">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`min-h-[44px] flex flex-col items-center justify-center transition-colors ${
                  active
                    ? 'text-[#2563EB]'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {item.icon}
                <span className="text-[10px] font-semibold tracking-tight mt-1 whitespace-nowrap">
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
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowFabSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-2"
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Quick Create or Import
              </h3>
              <button
                onClick={() => setShowFabSheet(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <button
              onClick={() => importInputRef.current?.click()}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center gap-3 text-sm font-semibold"
            >
              <FileUp className="w-5 h-5 text-[#2563EB]" />
              <span>Import PDF from Device</span>
            </button>
            <button
              onClick={() => {
                setShowFabSheet(false);
                setWorkspace({ type: 'scanner' });
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center gap-3 text-sm font-semibold"
            >
              <Camera className="w-5 h-5 text-[#06B6D4]" />
              <span>Scan Document with Camera</span>
            </button>
            <button
              onClick={() => {
                setShowFabSheet(false);
                setCreatorTemplateHtml(undefined);
                setWorkspace({ type: 'wordCreator' });
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center gap-3 text-sm font-semibold"
            >
              <FilePlus2 className="w-5 h-5 text-emerald-600" />
              <span>Create New Word-Like Document</span>
            </button>
            <button
              onClick={() => {
                setShowFabSheet(false);
                setWorkspace({ type: 'toolRunner', toolId: 'imagesToPdf' });
              }}
              className="w-full min-h-[52px] px-4 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center gap-3 text-sm font-semibold"
            >
              <ImageIcon className="w-5 h-5 text-indigo-600" />
              <span>Convert Images to PDF</span>
            </button>
          </div>
        </div>
      )}

      {/* Active Full-Screen Mobile Workspaces */}
      {workspace.type === 'viewer' && activeDocForWorkspace && (
        <PdfViewerView
          doc={activeDocForWorkspace}
          language={settings.language}
          defaultViewMode={settings.defaultViewMode}
          onClose={() => setWorkspace({ type: 'none' })}
          onUpdateDoc={upsertDoc}
          onOpenEditor={() => setWorkspace({ type: 'editor', docId: activeDocForWorkspace.id })}
          onOpenOrganizer={() => setWorkspace({ type: 'organizer', docId: activeDocForWorkspace.id })}
          onOpenAI={() => setWorkspace({ type: 'aiAssistant', docId: activeDocForWorkspace.id })}
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
          aiConsentGranted={settings.aiConsentGranted}
          localOnlyMode={settings.localOnlyMode}
          onGrantAiConsent={() => updateSettings({ aiConsentGranted: true })}
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
          onClose={() => setWorkspace({ type: 'none' })}
        />
      )}

      {workspace.type === 'aiAssistant' && (
        <AIAssistantView
          language={settings.language}
          docs={docs}
          initialDocId={workspace.docId}
          aiConsentGranted={settings.aiConsentGranted}
          localOnlyMode={settings.localOnlyMode}
          onGrantConsent={() => updateSettings({ aiConsentGranted: true })}
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
        />
      )}
    </div>
  );
}
