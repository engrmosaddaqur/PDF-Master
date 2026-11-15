import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Check,
  CopyPlus,
  FilePlus2,
  FolderPlus,
  RotateCw,
  Save,
  Scissors,
  Trash2,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import {
  cloneBuffer,
  insertPdfIntoDocument,
  organizePdfPages,
  renderPageThumbnail,
  splitPdfByRanges,
} from '../services/pdfEngine';
import { PdfSourcePicker } from './PdfSourcePicker';

interface PageOrganizerViewProps {
  doc: DocumentRecord;
  allDocs: DocumentRecord[];
  language: AppLanguage;
  onClose: () => void;
  onSaveDocument: (updated: DocumentRecord) => Promise<void>;
  onCreateExtractedDoc: (newDoc: DocumentRecord) => Promise<void>;
  onImportDoc?: (doc: DocumentRecord) => Promise<void>;
}

interface PageTile {
  uid: string;
  sourcePageIndex: number | null; // null = new blank page
  rotationDelta: number;
  thumbUrl: string;
  label: string;
  selected: boolean;
}

export const PageOrganizerView: React.FC<PageOrganizerViewProps> = ({
  doc,
  allDocs,
  language,
  onClose,
  onSaveDocument,
  onCreateExtractedDoc,
  onImportDoc,
}) => {
  const [tiles, setTiles] = useState<PageTile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showInsertPicker, setShowInsertPicker] = useState(false);
  const [workingBytes, setWorkingBytes] = useState<ArrayBuffer>(() => cloneBuffer(doc.pdfBytes));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [moveModalFrom, setMoveModalFrom] = useState<number | null>(null);
  const [moveTargetInput, setMoveTargetInput] = useState('');

  const loadThumbnails = async (bytes: ArrayBuffer, count: number) => {
    setLoading(true);
    const list: PageTile[] = [];
    for (let i = 0; i < count; i++) {
      const thumb = await renderPageThumbnail(bytes, i + 1, 180).catch(() => '');
      list.push({
        uid: `tile_${i}_${Date.now()}`,
        sourcePageIndex: i,
        rotationDelta: 0,
        thumbUrl: thumb,
        label: `Page ${i + 1}`,
        selected: false,
      });
    }
    setTiles(list);
    setLoading(false);
  };

  useEffect(() => {
    loadThumbnails(workingBytes, doc.pageCount);
  }, [doc.id]);

  const selectedIndices = tiles
    .map((t, idx) => (t.selected ? idx : -1))
    .filter((i) => i !== -1);

  const toggleSelect = (idx: number) => {
    setTiles((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, selected: !t.selected } : t))
    );
  };

  const handleAddBlank = () => {
    setTiles((prev) => [
      ...prev,
      {
        uid: `blank_${Date.now()}`,
        sourcePageIndex: null,
        rotationDelta: 0,
        thumbUrl: '',
        label: 'Blank Page',
        selected: false,
      },
    ]);
  };

  const handleDuplicateSelected = () => {
    if (selectedIndices.length === 0) return;
    const next: PageTile[] = [];
    tiles.forEach((t) => {
      next.push(t);
      if (t.selected) {
        next.push({
          ...t,
          uid: `dup_${Date.now()}_${Math.random()}`,
          selected: false,
          label: `${t.label} (Copy)`,
        });
      }
    });
    setTiles(next);
  };

  const handleDeleteSelected = () => {
    if (selectedIndices.length === 0 || selectedIndices.length >= tiles.length) return;
    setTiles((prev) => prev.filter((t) => !t.selected));
  };

  const handleRotateSelected = () => {
    if (selectedIndices.length === 0) return;
    setTiles((prev) =>
      prev.map((t) =>
        t.selected ? { ...t, rotationDelta: (t.rotationDelta + 90) % 360 } : t
      )
    );
  };

  const moveTile = (from: number, to: number) => {
    if (to < 0 || to >= tiles.length || from === to) return;
    const copy = [...tiles];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    setTiles(copy);
  };

  const handleMoveToNumber = () => {
    if (selectedIndices.length !== 1) return;
    const from = selectedIndices[0];
    setMoveModalFrom(from);
    setMoveTargetInput(String(from + 1));
  };

  const confirmMoveToNumber = () => {
    if (moveModalFrom === null) return;
    const target = Math.max(1, Math.min(tiles.length, parseInt(moveTargetInput, 10) || moveModalFrom + 1)) - 1;
    moveTile(moveModalFrom, target);
    setMoveModalFrom(null);
  };

  const handleInsertFromOtherPdf = async (other: DocumentRecord) => {
    setShowInsertPicker(false);
    setSaving(true);
    try {
      const merged = await insertPdfIntoDocument(workingBytes, other.pdfBytes, tiles.length);
      const nextCount = doc.pageCount + other.pageCount;
      setWorkingBytes(merged);
      await loadThumbnails(merged, nextCount);
    } finally {
      setSaving(false);
    }
  };

  const handleExtractSelected = async () => {
    const validPages = tiles
      .filter((t) => t.selected && t.sourcePageIndex !== null)
      .map((t) => (t.sourcePageIndex as number) + 1);
    if (validPages.length === 0) return;

    setSaving(true);
    try {
      const extracted = await splitPdfByRanges(workingBytes, validPages);
      const thumb = await renderPageThumbnail(extracted, 1, 200).catch(() => undefined);
      const now = Date.now();
      await onCreateExtractedDoc({
        ...doc,
        id: `doc_ext_${now}`,
        name: `${doc.name.replace(/\.pdf$/i, '')}_extracted.pdf`,
        origin: 'edited',
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        sizeBytes: extracted.byteLength,
        pageCount: validPages.length,
        isStarred: false,
        thumbnailDataUrl: thumb,
        pdfBytes: cloneBuffer(extracted),
        versions: [
          {
            id: `ver_${now}`,
            timestamp: now,
            note: `Extracted ${validPages.length} pages`,
            sizeBytes: extracted.byteLength,
            pdfBytes: cloneBuffer(extracted),
          },
        ],
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleSaveOrder = async () => {
    setSaving(true);
    try {
      const plan = tiles.map((t) => ({
        sourcePageIndex: t.sourcePageIndex,
        rotationDelta: t.rotationDelta,
        insertBlank: t.sourcePageIndex === null,
      }));
      const outBytes = await organizePdfPages(workingBytes, plan);
      const thumb = await renderPageThumbnail(outBytes, 1, 200).catch(() => doc.thumbnailDataUrl);
      const now = Date.now();
      await onSaveDocument({
        ...doc,
        origin: 'edited',
        updatedAt: now,
        pageCount: tiles.length,
        sizeBytes: outBytes.byteLength,
        thumbnailDataUrl: thumb,
        pdfBytes: cloneBuffer(outBytes),
        versions: [
          {
            id: `ver_${now}`,
            timestamp: now,
            note: `Reorganized pages (${tiles.length} pages)`,
            sizeBytes: outBytes.byteLength,
            pdfBytes: cloneBuffer(outBytes),
          },
          ...doc.versions,
        ],
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120]">
      <header className="flex items-center justify-between gap-2 px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-sm font-bold text-[#142B4A] dark:text-white truncate">
              Page Organizer
            </h1>
            <p className="text-[11px] font-mono-nums text-slate-500">
              {tiles.length} pages · {selectedIndices.length} selected
            </p>
          </div>
        </div>

        <button
          onClick={handleSaveOrder}
          disabled={saving || tiles.length === 0}
          className="min-h-[44px] px-4 rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
        >
          <Save className="w-4 h-4" />
          <span>{saving ? 'Applying...' : 'Save Changes'}</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="py-20 text-center text-sm text-slate-500">
            Generating page thumbnails...
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 max-w-6xl mx-auto">
            {tiles.map((tile, idx) => (
              <div
                key={tile.uid}
                draggable
                onDragStart={() => setDragIndex(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) moveTile(dragIndex, idx);
                  setDragIndex(null);
                }}
                onClick={() => toggleSelect(idx)}
                className={`relative rounded-2xl p-2.5 bg-white dark:bg-slate-900 border-2 transition-all cursor-pointer ${
                  tile.selected
                    ? 'border-[#2563EB] shadow-md'
                    : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono-nums font-bold text-slate-600 dark:text-slate-300">
                    #{idx + 1}
                  </span>
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center border ${
                      tile.selected
                        ? 'bg-[#2563EB] border-[#2563EB] text-white'
                        : 'border-slate-300 dark:border-slate-600'
                    }`}
                  >
                    {tile.selected && <Check className="w-3.5 h-3.5" />}
                  </div>
                </div>

                <div className="aspect-[3/4] rounded-xl bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center justify-center">
                  {tile.thumbUrl ? (
                    <img
                      src={tile.thumbUrl}
                      alt={tile.label}
                      style={{ transform: `rotate(${tile.rotationDelta}deg)` }}
                      className="w-full h-full object-contain transition-transform"
                    />
                  ) : (
                    <span className="text-xs text-slate-400">Blank A4</span>
                  )}
                </div>

                <div
                  className="mt-2 flex items-center justify-between gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => moveTile(idx, idx - 1)}
                    disabled={idx === 0}
                    aria-label="Move page earlier"
                    className="min-h-[36px] flex-1 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-30 flex items-center justify-center"
                  >
                    <ArrowUp className="w-3.5 h-3.5 -rotate-90" />
                  </button>
                  <button
                    onClick={() => moveTile(idx, idx + 1)}
                    disabled={idx === tiles.length - 1}
                    aria-label="Move page later"
                    className="min-h-[36px] flex-1 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-30 flex items-center justify-center"
                  >
                    <ArrowDown className="w-3.5 h-3.5 -rotate-90" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Page Action Dock */}
      <div className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-3 py-2.5 pb-safe flex items-center gap-2 overflow-x-auto no-scrollbar shrink-0">
        <button
          onClick={handleAddBlank}
          className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <FilePlus2 className="w-4 h-4 text-[#2563EB]" />
          Blank Page
        </button>
        <button
          onClick={() => setShowInsertPicker(true)}
          className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <FolderPlus className="w-4 h-4 text-[#2563EB]" />
          Insert PDF
        </button>
        <button
          onClick={handleRotateSelected}
          disabled={selectedIndices.length === 0}
          className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <RotateCw className="w-4 h-4" />
          Rotate
        </button>
        <button
          onClick={handleDuplicateSelected}
          disabled={selectedIndices.length === 0}
          className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <CopyPlus className="w-4 h-4" />
          Duplicate
        </button>
        <button
          onClick={handleExtractSelected}
          disabled={selectedIndices.length === 0}
          className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Scissors className="w-4 h-4" />
          Extract
        </button>
        {selectedIndices.length === 1 && (
          <button
            onClick={handleMoveToNumber}
            className="min-h-[44px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold whitespace-nowrap shrink-0"
          >
            Move To #
          </button>
        )}
        <button
          onClick={handleDeleteSelected}
          disabled={selectedIndices.length === 0 || selectedIndices.length >= tiles.length}
          className="min-h-[44px] px-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </button>
      </div>

      {/* Insert from Device Storage or Recent PDFs Picker */}
      {showInsertPicker && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl max-h-[82vh] flex flex-col">
            <h3 className="font-display text-base font-bold mb-3">
              {language === 'bn'
                ? 'অন্য পিডিএফ থেকে পৃষ্ঠা যোগ করুন'
                : 'Insert Pages from Another PDF'}
            </h3>
            <div className="flex-1 overflow-y-auto pr-0.5">
              <PdfSourcePicker
                language={language}
                docs={allDocs}
                excludeDocId={doc.id}
                maxListHeightClass="max-h-60"
                onImportDoc={onImportDoc}
                onSelectDoc={(other) => void handleInsertFromOtherPdf(other)}
              />
            </div>
            <button
              onClick={() => setShowInsertPicker(false)}
              className="mt-3 w-full min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-sm font-semibold"
            >
              {language === 'bn' ? 'বাতিল' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* Move Page Position Modal */}
      {moveModalFrom !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
          <div className="w-full max-w-xs rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3">
            <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
              Move Page #{moveModalFrom + 1}
            </h3>
            <p className="text-xs text-slate-500">
              Enter destination position (1 – {tiles.length})
            </p>
            <input
              type="number"
              min={1}
              max={tiles.length}
              value={moveTargetInput}
              onChange={(e) => setMoveTargetInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmMoveToNumber()}
              autoFocus
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono-nums"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMoveModalFrom(null)}
                className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={confirmMoveToNumber}
                className="min-h-[44px] rounded-xl bg-[#2563EB] text-white text-xs font-semibold"
              >
                Move Page
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
