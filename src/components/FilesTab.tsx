import React, { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Download,
  Edit3,
  FileText,
  Folder,
  FolderPlus,
  History,
  Info,
  Lock,
  MoreVertical,
  RotateCcw,
  Search,
  Share2,
  Star,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type {
  AppLanguage,
  DocumentCategory,
  DocumentRecord,
  FolderRecord,
} from '../types';
import { getT } from '../i18n/translations';
import { decryptVaultBytes } from '../services/pdfEngine';
import { downloadArrayBuffer, formatBytes } from '../services/storageService';

interface FilesTabProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  folders: FolderRecord[];
  initialCategory?: DocumentCategory;
  onOpenDoc: (doc: DocumentRecord) => void;
  onEditDoc: (doc: DocumentRecord) => void;
  onUpdateDoc: (doc: DocumentRecord) => Promise<void>;
  onDuplicateDoc: (doc: DocumentRecord) => Promise<void>;
  onDeleteForever: (id: string) => Promise<void>;
  onCreateFolder: (name: string) => Promise<void>;
}

export const FilesTab: React.FC<FilesTabProps> = ({
  language,
  docs,
  folders,
  initialCategory = 'my',
  onOpenDoc,
  onEditDoc,
  onUpdateDoc,
  onDuplicateDoc,
  onDeleteForever,
  onCreateFolder,
}) => {
  const t = getT(language);
  const [category, setCategory] = useState<DocumentCategory>(initialCategory);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'size'>('date');
  const [menuDoc, setMenuDoc] = useState<DocumentRecord | null>(null);
  const [infoDoc, setInfoDoc] = useState<DocumentRecord | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<DocumentRecord | null>(null);
  const [unlockPass, setUnlockPass] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<DocumentRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    setCategory(initialCategory);
    setActiveFolderId(null);
  }, [initialCategory]);

  const categories: Array<{ id: DocumentCategory; label: string }> = [
    { id: 'my', label: t.files.categories.my },
    { id: 'recent', label: t.files.categories.recent },
    { id: 'scanned', label: t.files.categories.scanned },
    { id: 'created', label: t.files.categories.created },
    { id: 'edited', label: t.files.categories.edited },
    { id: 'starred', label: t.files.categories.starred },
    { id: 'shared', label: t.files.categories.shared },
    { id: 'trash', label: t.files.categories.trash },
  ];

  const filteredDocs = useMemo(() => {
    let list = docs.filter((d) => {
      if (category === 'trash') return d.isTrashed;
      if (d.isTrashed) return false;
      if (activeFolderId && d.folderId !== activeFolderId) return false;
      if (category === 'scanned') return d.origin === 'scanned';
      if (category === 'created') return d.origin === 'created';
      if (category === 'edited') return d.origin === 'edited';
      if (category === 'starred') return d.isStarred;
      if (category === 'shared') return d.isShared;
      return true;
    });

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((d) => d.name.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
      if (category === 'recent') return b.lastOpenedAt - a.lastOpenedAt;
      return b.updatedAt - a.updatedAt;
    });
  }, [docs, category, activeFolderId, query, sortBy]);

  const openRenameModal = (doc: DocumentRecord) => {
    setRenameTarget(doc);
    setRenameValue(doc.name);
    setMenuDoc(null);
  };

  const handleRenameSubmit = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const trimmed = renameValue.trim();
    const normalized = trimmed.endsWith('.pdf') ? trimmed : `${trimmed}.pdf`;
    await onUpdateDoc({ ...renameTarget, name: normalized, updatedAt: Date.now() });
    setRenameTarget(null);
    setRenameValue('');
  };

  const handleNewFolderSubmit = async () => {
    if (!newFolderName.trim()) return;
    await onCreateFolder(newFolderName.trim());
    setNewFolderName('');
    setShowNewFolderModal(false);
  };

  const handleUnlockSubmit = async () => {
    if (!unlockTarget || !unlockTarget.vaultSalt || !unlockTarget.vaultIv) return;
    try {
      const plain = await decryptVaultBytes(
        unlockTarget.pdfBytes,
        unlockPass,
        unlockTarget.vaultSalt,
        unlockTarget.vaultIv
      );
      await onUpdateDoc({
        ...unlockTarget,
        isVaultLocked: false,
        vaultSalt: undefined,
        vaultIv: undefined,
        pdfBytes: plain,
        updatedAt: Date.now(),
      });
      setUnlockTarget(null);
      setUnlockPass('');
      setUnlockError(null);
    } catch {
      setUnlockError('Incorrect password');
    }
  };

  return (
    <div className="space-y-4 pb-6">
      {/* Search + Sort + Folder Creation */}
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 min-h-[44px] px-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.files.searchPlaceholder}
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'date' | 'name' | 'size')}
          aria-label={t.files.sortBy}
          className="min-h-[44px] px-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-semibold"
        >
          <option value="date">{t.files.sortDate}</option>
          <option value="name">{t.files.sortName}</option>
          <option value="size">{t.files.sortSize}</option>
        </select>
        <button
          onClick={() => {
            setNewFolderName('');
            setShowNewFolderModal(true);
          }}
          aria-label={t.files.newFolder}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[#2563EB]"
        >
          <FolderPlus className="w-5 h-5" />
        </button>
      </div>

      {/* Category Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => {
              setCategory(cat.id);
              setActiveFolderId(null);
            }}
            className={`min-h-[40px] px-3.5 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              category === cat.id && !activeFolderId
                ? 'bg-[#142B4A] dark:bg-[#2563EB] text-white'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Folders Row */}
      {folders.length > 0 && category !== 'trash' && (
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          {folders.map((f) => (
            <button
              key={f.id}
              onClick={() => setActiveFolderId(activeFolderId === f.id ? null : f.id)}
              className={`min-h-[42px] px-3.5 rounded-xl border flex items-center gap-2 text-xs font-semibold whitespace-nowrap shrink-0 ${
                activeFolderId === f.id
                  ? 'border-[#2563EB] bg-[#2563EB]/10 text-[#2563EB]'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200'
              }`}
            >
              <Folder className="w-4 h-4 text-[#2563EB]" />
              <span>{f.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Documents List */}
      {filteredDocs.length === 0 ? (
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 py-14 px-6 text-center">
          <FileText className="w-10 h-10 text-slate-300 dark:text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">{t.files.emptyCategory}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {filteredDocs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-3 p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
            >
              <button
                onClick={() => {
                  if (doc.isVaultLocked) {
                    setUnlockTarget(doc);
                    return;
                  }
                  onOpenDoc(doc);
                }}
                className="flex items-center gap-3 flex-1 min-w-0 text-left min-h-[56px]"
              >
                <div className="w-12 h-16 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                  {doc.isVaultLocked ? (
                    <Lock className="w-5 h-5 text-[#2563EB]" />
                  ) : doc.thumbnailDataUrl ? (
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

              <div className="flex items-center shrink-0">
                <button
                  onClick={() => onUpdateDoc({ ...doc, isStarred: !doc.isStarred })}
                  aria-label={doc.isStarred ? t.files.unstar : t.files.star}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-amber-500"
                >
                  <Star
                    className={`w-4 h-4 ${doc.isStarred ? 'fill-amber-400 text-amber-400' : ''}`}
                  />
                </button>
                <button
                  onClick={() => setMenuDoc(doc)}
                  aria-label="More actions"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action Bottom Sheet */}
      {menuDoc && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setMenuDoc(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-1.5"
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mb-2 sm:hidden" />
            <p className="font-display text-sm font-bold truncate px-2 pb-2 border-b border-slate-100 dark:border-slate-800">
              {menuDoc.name}
            </p>

            {!menuDoc.isTrashed ? (
              <>
                {!menuDoc.isVaultLocked && (
                  <button
                    onClick={() => {
                      const d = menuDoc;
                      setMenuDoc(null);
                      onEditDoc(d);
                    }}
                    className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Edit3 className="w-4 h-4 text-[#2563EB]" /> Edit PDF
                  </button>
                )}
                <button
                  onClick={() => openRenameModal(menuDoc)}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <FileText className="w-4 h-4" /> {t.files.rename}
                </button>
                <button
                  onClick={async () => {
                    await onDuplicateDoc(menuDoc);
                    setMenuDoc(null);
                  }}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Copy className="w-4 h-4" /> {t.files.duplicate}
                </button>
                <button
                  onClick={async () => {
                    downloadArrayBuffer(menuDoc.pdfBytes, menuDoc.name);
                    await onUpdateDoc({ ...menuDoc, isShared: true });
                    setMenuDoc(null);
                  }}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Share2 className="w-4 h-4" /> Export &amp; Share
                </button>
                {folders.length > 0 && (
                  <div className="px-3 py-1.5">
                    <label className="text-xs text-slate-500 block mb-1">
                      {t.files.moveToFolder}
                    </label>
                    <select
                      value={menuDoc.folderId || ''}
                      onChange={async (e) => {
                        await onUpdateDoc({
                          ...menuDoc,
                          folderId: e.target.value || null,
                        });
                        setMenuDoc(null);
                      }}
                      className="w-full min-h-[40px] px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
                    >
                      <option value="">Root Vault</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  onClick={() => {
                    setInfoDoc(menuDoc);
                    setMenuDoc(null);
                  }}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Info className="w-4 h-4" /> {t.files.info} &amp; {t.files.versions}
                </button>
                <button
                  onClick={async () => {
                    await onUpdateDoc({ ...menuDoc, isTrashed: true });
                    setMenuDoc(null);
                  }}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                >
                  <Trash2 className="w-4 h-4" /> {t.files.delete}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={async () => {
                    await onUpdateDoc({ ...menuDoc, isTrashed: false });
                    setMenuDoc(null);
                  }}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium text-[#2563EB]"
                >
                  <RotateCcw className="w-4 h-4" /> {t.files.restore}
                </button>
                <button
                  onClick={async () => {
                    await onDeleteForever(menuDoc.id);
                    setMenuDoc(null);
                  }}
                  className="w-full min-h-[46px] px-3 rounded-xl flex items-center gap-3 text-sm font-medium text-rose-600"
                >
                  <Trash2 className="w-4 h-4" /> {t.files.deleteForever}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* File Info & Version History Modal */}
      {infoDoc && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl max-h-[80vh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold">{t.files.info}</h3>
              <button onClick={() => setInfoDoc(null)} className="min-h-[40px] min-w-[40px]">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 font-mono-nums">
              <p>Name: {infoDoc.name}</p>
              <p>Origin: {infoDoc.origin}</p>
              <p>Pages: {infoDoc.pageCount}</p>
              <p>Size: {formatBytes(infoDoc.sizeBytes)}</p>
              <p>Updated: {new Date(infoDoc.updatedAt).toLocaleString()}</p>
              {infoDoc.sha256Seal && (
                <p className="break-all text-emerald-600 dark:text-emerald-400">
                  SHA-256 Seal: {infoDoc.sha256Seal}
                </p>
              )}
            </div>

            <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
              <h4 className="text-xs font-bold flex items-center gap-1.5 mb-2">
                <History className="w-4 h-4 text-[#2563EB]" />
                {t.files.versions} ({infoDoc.versions.length})
              </h4>
              <div className="space-y-2">
                {infoDoc.versions.map((v, idx) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold truncate">
                        v{infoDoc.versions.length - idx} · {v.note}
                      </p>
                      <p className="text-[11px] text-slate-500 font-mono-nums">
                        {new Date(v.timestamp).toLocaleString()} · {formatBytes(v.sizeBytes)}
                      </p>
                    </div>
                    <button
                      onClick={() => downloadArrayBuffer(v.pdfBytes, `v${infoDoc.versions.length - idx}_${infoDoc.name}`)}
                      className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[#2563EB]"
                      aria-label="Download version"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Vault Unlock Modal */}
      {unlockTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3">
            <div className="flex items-center gap-2">
              <Unlock className="w-5 h-5 text-[#2563EB]" />
              <h3 className="font-display text-base font-bold">{t.files.unlockVault}</h3>
            </div>
            <p className="text-xs text-slate-500 truncate">{unlockTarget.name}</p>
            <input
              type="password"
              value={unlockPass}
              onChange={(e) => setUnlockPass(e.target.value)}
              placeholder="Enter Vault password"
              autoFocus
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
            {unlockError && <p className="text-xs text-rose-500">{unlockError}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  setUnlockTarget(null);
                  setUnlockPass('');
                  setUnlockError(null);
                }}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleUnlockSubmit}
                className="min-h-[44px] rounded-xl bg-[#2563EB] text-white text-xs font-semibold"
              >
                Decrypt &amp; Open
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Document Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3">
            <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
              {t.files.rename}
            </h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
              autoFocus
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setRenameTarget(null)}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleRenameSubmit}
                disabled={!renameValue.trim()}
                className="min-h-[44px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-xs font-semibold"
              >
                Save Name
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Folder Modal */}
      {showNewFolderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3">
            <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
              {t.files.newFolder}
            </h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNewFolderSubmit()}
              placeholder="e.g. Invoices, Tax, Study"
              autoFocus
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setShowNewFolderModal(false)}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleNewFolderSubmit}
                disabled={!newFolderName.trim()}
                className="min-h-[44px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-xs font-semibold"
              >
                Create Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
