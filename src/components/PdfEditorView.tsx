import React, { useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  ArrowUpRight,
  Bold,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Circle,
  Crop,
  Download,
  Highlighter,
  ImagePlus,
  Italic,
  MessageSquare,
  MousePointer,
  Pen,
  PenTool,
  Redo2,
  RotateCw,
  Save,
  Square,
  Strikethrough,
  Trash2,
  Type as TypeIcon,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import type {
  AddedImageOverlay,
  AddedTextBox,
  AnnotationOverlay,
  AppLanguage,
  DocumentRecord,
  ExtractedTextRun,
  TextReplacementEdit,
} from '../types';
import { getT } from '../i18n/translations';
import {
  applyPdfEditsToBytes,
  cloneBuffer,
  computeSha256Hex,
  extractPageTextRuns,
  renderPageThumbnail,
  renderPageToCanvas,
} from '../services/pdfEngine';
import { downloadArrayBuffer } from '../services/storageService';
import { SignatureModal } from './SignatureModal';

interface PdfEditorViewProps {
  doc: DocumentRecord;
  language: AppLanguage;
  onClose: () => void;
  onSaveNewVersion: (updatedDoc: DocumentRecord) => Promise<void>;
  onSaveAsCopy: (newDoc: DocumentRecord) => Promise<void>;
}

type EditorTool =
  | 'editText'
  | 'addText'
  | 'addImage'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'draw'
  | 'rect'
  | 'circle'
  | 'arrow'
  | 'sticky'
  | 'signature'
  | 'stamp';

interface EditorStateSnapshot {
  replacements: TextReplacementEdit[];
  addedTexts: AddedTextBox[];
  addedImages: AddedImageOverlay[];
  annotations: AnnotationOverlay[];
}

export const PdfEditorView: React.FC<PdfEditorViewProps> = ({
  doc,
  language,
  onClose,
  onSaveNewVersion,
  onSaveAsCopy,
}) => {
  const t = getT(language);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [textRuns, setTextRuns] = useState<ExtractedTextRun[]>([]);
  const [activeTool, setActiveTool] = useState<EditorTool>('editText');
  const [activeColor, setActiveColor] = useState('#2563EB');

  // Edit layers + undo/redo stack
  const [state, setState] = useState<EditorStateSnapshot>({
    replacements: [],
    addedTexts: [],
    addedImages: [],
    annotations: [],
  });
  const [undoStack, setUndoStack] = useState<EditorStateSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorStateSnapshot[]>([]);

  // Active modals/popovers
  const [editingRun, setEditingRun] = useState<ExtractedTextRun | null>(null);
  const [runDraft, setRunDraft] = useState({
    text: '',
    fontSize: 12,
    fontFamily: 'sans' as 'sans' | 'serif' | 'mono',
    color: '#1E293B',
    bold: false,
    italic: false,
    underline: false,
    align: 'left' as 'left' | 'center' | 'right',
    letterSpacing: 0,
  });

  const [addingBoxPos, setAddingBoxPos] = useState<{ x: number; y: number } | null>(null);
  const [newBoxDraft, setNewBoxDraft] = useState({
    text: '',
    fontSize: 14,
    fontFamily: 'sans' as 'sans' | 'serif' | 'mono',
    color: '#142B4A',
    bold: false,
    italic: false,
    underline: false,
    align: 'left' as 'left' | 'center' | 'right',
    letterSpacing: 0,
  });

  const [stickyPos, setStickyPos] = useState<{ x: number; y: number } | null>(null);
  const [stickyText, setStickyText] = useState('');

  const [showSigModal, setShowSigModal] = useState(false);
  const [pendingSig, setPendingSig] = useState<{
    dataUrl: string;
    signerName: string;
    dateStr: string;
    attachIntegritySeal: boolean;
  } | null>(null);

  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [cropModalImg, setCropModalImg] = useState<AddedImageOverlay | null>(null);
  const [cropInsets, setCropInsets] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [draggingItem, setDraggingItem] = useState<{
    kind: 'image' | 'textBox' | 'annotation';
    id: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Drawing interaction
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [liveFreehand, setLiveFreehand] = useState<Array<{ x: number; y: number }>>([]);
  const [liveBox, setLiveBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const commitState = (updater: (prev: EditorStateSnapshot) => EditorStateSnapshot) => {
    setUndoStack((u) => [...u.slice(-24), state]);
    setRedoStack([]);
    setState((prev) => updater(prev));
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, state]);
    setUndoStack((u) => u.slice(0, -1));
    setState(prev);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, state]);
    setRedoStack((r) => r.slice(0, -1));
    setState(next);
  };

  useEffect(() => {
    const w = window.innerWidth;
    setScale(w < 640 ? Math.max(0.55, Math.min(1.0, (w - 28) / 595)) : 1.1);
  }, []);

  useEffect(() => {
    let active = true;
    const loadPage = async () => {
      if (canvasRef.current) {
        const res = await renderPageToCanvas(doc.pdfBytes, pageNumber, canvasRef.current, scale);
        if (active) {
          setPageSize({ width: res.unscaledWidth, height: res.unscaledHeight });
        }
      }
      const { runs } = await extractPageTextRuns(doc.pdfBytes, pageNumber);
      if (active) setTextRuns(runs);
    };
    loadPage().catch(() => {});
    return () => {
      active = false;
    };
  }, [doc.pdfBytes, pageNumber, scale]);

  const toUnscaledCoords = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  };

  const handleOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== overlayRef.current) return;
    const pt = toUnscaledCoords(e.clientX, e.clientY);

    if (activeTool === 'addText') {
      setAddingBoxPos(pt);
      setNewBoxDraft({
        text: '',
        fontSize: 14,
        fontFamily: 'sans',
        color: activeColor,
        bold: false,
        italic: false,
        underline: false,
        align: 'left',
        letterSpacing: 0,
      });
      return;
    }

    if (activeTool === 'sticky') {
      setStickyPos(pt);
      setStickyText('');
      return;
    }

    if (activeTool === 'stamp') {
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: `ann_${Date.now()}`,
            pageNumber,
            kind: 'stamp',
            x: pt.x,
            y: pt.y,
            width: 110,
            height: 26,
            color: activeColor,
            dateStr: new Date().toLocaleDateString(),
          },
        ],
      }));
      return;
    }

    if (activeTool === 'signature' && pendingSig) {
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: `sig_${Date.now()}`,
            pageNumber,
            kind: 'signature',
            x: pt.x - 75,
            y: pt.y - 32,
            width: 150,
            height: 64,
            color: activeColor,
            signatureDataUrl: pendingSig.dataUrl,
            signerName: pendingSig.signerName,
            dateStr: pendingSig.dateStr,
          },
        ],
      }));
      setStatusMessage('Signature placed on page');
      setTimeout(() => setStatusMessage(null), 2000);
      return;
    }

    if (['draw', 'highlight', 'underline', 'strike', 'rect', 'circle', 'arrow'].includes(activeTool)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStartRef.current = pt;
      if (activeTool === 'draw') {
        setLiveFreehand([pt]);
      } else {
        setLiveBox({ x: pt.x, y: pt.y, w: 0, h: 0 });
      }
    }
  };

  const handleOverlayPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingItem) {
      const dx = (e.clientX - draggingItem.startClientX) / scale;
      const dy = (e.clientY - draggingItem.startClientY) / scale;
      const nx = Math.max(0, Math.min(pageSize.width - 20, draggingItem.origX + dx));
      const ny = Math.max(0, Math.min(pageSize.height - 20, draggingItem.origY + dy));
      setState((prev) => {
        if (draggingItem.kind === 'image') {
          return {
            ...prev,
            addedImages: prev.addedImages.map((im) =>
              im.id === draggingItem.id ? { ...im, x: nx, y: ny } : im
            ),
          };
        }
        if (draggingItem.kind === 'textBox') {
          return {
            ...prev,
            addedTexts: prev.addedTexts.map((tb) =>
              tb.id === draggingItem.id ? { ...tb, x: nx, y: ny } : tb
            ),
          };
        }
        return {
          ...prev,
          annotations: prev.annotations.map((an) =>
            an.id === draggingItem.id ? { ...an, x: nx, y: ny } : an
          ),
        };
      });
      return;
    }

    if (!dragStartRef.current) return;
    const pt = toUnscaledCoords(e.clientX, e.clientY);
    if (activeTool === 'draw') {
      setLiveFreehand((prev) => [...prev, pt]);
    } else {
      const sx = dragStartRef.current.x;
      const sy = dragStartRef.current.y;
      setLiveBox({
        x: activeTool === 'arrow' ? sx : Math.min(sx, pt.x),
        y: activeTool === 'arrow' ? sy : Math.min(sy, pt.y),
        w: activeTool === 'arrow' ? pt.x - sx : Math.abs(pt.x - sx),
        h: activeTool === 'arrow' ? pt.y - sy : Math.abs(pt.y - sy),
      });
    }
  };

  const handleOverlayPointerUp = () => {
    if (draggingItem) {
      setDraggingItem(null);
      return;
    }
    if (!dragStartRef.current) return;
    if (activeTool === 'draw' && liveFreehand.length > 1) {
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: `ann_${Date.now()}`,
            pageNumber,
            kind: 'freehand',
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            color: activeColor,
            strokeWidth: 2.5,
            points: liveFreehand,
          },
        ],
      }));
    } else if (liveBox && (Math.abs(liveBox.w) > 8 || Math.abs(liveBox.h) > 8)) {
      const kindMap: Record<string, AnnotationOverlay['kind']> = {
        highlight: 'highlight',
        underline: 'underline',
        strike: 'strikethrough',
        rect: 'rect',
        circle: 'circle',
        arrow: 'arrow',
      };
      const kind = kindMap[activeTool];
      if (kind) {
        commitState((prev) => ({
          ...prev,
          annotations: [
            ...prev.annotations,
            {
              id: `ann_${Date.now()}`,
              pageNumber,
              kind,
              x: liveBox.x,
              y: liveBox.y,
              width: liveBox.w,
              height: Math.max(kind === 'highlight' ? 14 : 6, liveBox.h),
              color: activeTool === 'highlight' ? '#FACC15' : activeColor,
              strokeWidth: 2.5,
            },
          ],
        }));
      }
    }
    dragStartRef.current = null;
    setLiveFreehand([]);
    setLiveBox(null);
  };

  const handleOpenTextRunEditor = (run: ExtractedTextRun) => {
    const existing = state.replacements.find((r) => r.runId === run.id);
    setEditingRun(run);
    setRunDraft({
      text: existing ? existing.newText : run.str,
      fontSize: existing ? existing.fontSize : Math.round(run.fontSize),
      fontFamily: existing?.fontFamily || 'sans',
      color: existing?.color || '#1E293B',
      bold: existing?.bold || false,
      italic: existing?.italic || false,
      underline: existing?.underline || false,
      align: existing?.align || 'left',
      letterSpacing: existing?.letterSpacing || 0,
    });
  };

  const handleApplyRunReplacement = (deleted: boolean) => {
    if (!editingRun) return;
    commitState((prev) => {
      const filtered = prev.replacements.filter((r) => r.runId !== editingRun.id);
      return {
        ...prev,
        replacements: [
          ...filtered,
          {
            id: `rep_${Date.now()}`,
            runId: editingRun.id,
            pageNumber,
            originalText: editingRun.str,
            newText: runDraft.text,
            deleted,
            x: editingRun.x,
            y: editingRun.y,
            width: editingRun.width,
            height: editingRun.height,
            fontSize: runDraft.fontSize,
            fontFamily: runDraft.fontFamily,
            color: runDraft.color,
            bold: runDraft.bold,
            italic: runDraft.italic,
            underline: runDraft.underline,
            align: runDraft.align,
            letterSpacing: runDraft.letterSpacing,
          },
        ],
      };
    });
    setEditingRun(null);
  };

  const handleImageFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const w = Math.min(220, img.naturalWidth || 180);
        const h = Math.round((w / (img.naturalWidth || 180)) * (img.naturalHeight || 140));
        commitState((prev) => ({
          ...prev,
          addedImages: [
            ...prev.addedImages,
            {
              id: `img_${Date.now()}`,
              pageNumber,
              dataUrl,
              x: 80,
              y: 120,
              width: w,
              height: h,
              rotation: 0,
            },
          ],
        }));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSave = async (mode: 'version' | 'copy' | 'download') => {
    setSaving(true);
    try {
      const editedBytes = await applyPdfEditsToBytes(doc.pdfBytes, state);
      const seal = pendingSig?.attachIntegritySeal
        ? await computeSha256Hex(editedBytes)
        : doc.sha256Seal;

      if (mode === 'download') {
        downloadArrayBuffer(editedBytes, doc.name.replace(/\.pdf$/i, '_edited.pdf'));
        setStatusMessage('Exported modified PDF');
        return;
      }

      const thumb = await renderPageThumbnail(editedBytes, 1, 200).catch(() => doc.thumbnailDataUrl);
      const now = Date.now();

      if (mode === 'version') {
        const updated: DocumentRecord = {
          ...doc,
          origin: 'edited',
          updatedAt: now,
          sizeBytes: editedBytes.byteLength,
          thumbnailDataUrl: thumb,
          pdfBytes: cloneBuffer(editedBytes),
          sha256Seal: seal,
          versions: [
            {
              id: `ver_${now}`,
              timestamp: now,
              note: `Edited (${state.replacements.length} text edits, ${state.annotations.length} annotations)`,
              sizeBytes: editedBytes.byteLength,
              pdfBytes: cloneBuffer(editedBytes),
            },
            ...doc.versions,
          ],
        };
        await onSaveNewVersion(updated);
        onClose();
      } else {
        const copyDoc: DocumentRecord = {
          ...doc,
          id: `doc_${now}`,
          name: doc.name.replace(/\.pdf$/i, '') + ' (Edited Copy).pdf',
          origin: 'edited',
          createdAt: now,
          updatedAt: now,
          lastOpenedAt: now,
          sizeBytes: editedBytes.byteLength,
          thumbnailDataUrl: thumb,
          pdfBytes: cloneBuffer(editedBytes),
          sha256Seal: seal,
          versions: [
            {
              id: `ver_${now}`,
              timestamp: now,
              note: 'Saved as edited copy',
              sizeBytes: editedBytes.byteLength,
              pdfBytes: cloneBuffer(editedBytes),
            },
          ],
        };
        await onSaveAsCopy(copyDoc);
        onClose();
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to save PDF edits');
    } finally {
      setSaving(false);
    }
  };

  const pageReplacements = state.replacements.filter((r) => r.pageNumber === pageNumber);
  const pageAddedTexts = state.addedTexts.filter((tb) => tb.pageNumber === pageNumber);
  const pageAddedImages = state.addedImages.filter((im) => im.pageNumber === pageNumber);
  const pageAnnotations = state.annotations.filter((an) => an.pageNumber === pageNumber);
  const selectedImg = pageAddedImages.find((i) => i.id === selectedImageId);

  const toolsList: Array<{ id: EditorTool; label: string; icon: React.ReactNode }> = [
    { id: 'editText', label: t.editor.tools.selectText, icon: <MousePointer className="w-4 h-4" /> },
    { id: 'addText', label: t.editor.tools.addText, icon: <TypeIcon className="w-4 h-4" /> },
    { id: 'addImage', label: t.editor.tools.addImage, icon: <ImagePlus className="w-4 h-4" /> },
    { id: 'highlight', label: t.editor.tools.highlight, icon: <Highlighter className="w-4 h-4" /> },
    { id: 'underline', label: t.editor.tools.underline, icon: <Underline className="w-4 h-4" /> },
    { id: 'strike', label: t.editor.tools.strike, icon: <Strikethrough className="w-4 h-4" /> },
    { id: 'draw', label: t.editor.tools.draw, icon: <Pen className="w-4 h-4" /> },
    { id: 'rect', label: 'Box', icon: <Square className="w-4 h-4" /> },
    { id: 'circle', label: 'Circle', icon: <Circle className="w-4 h-4" /> },
    { id: 'arrow', label: 'Arrow', icon: <ArrowUpRight className="w-4 h-4" /> },
    { id: 'sticky', label: t.editor.tools.sticky, icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'signature', label: t.editor.tools.signature, icon: <PenTool className="w-4 h-4" /> },
    { id: 'stamp', label: t.editor.tools.stamp, icon: <Calendar className="w-4 h-4" /> },
  ];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#E2E8F0] dark:bg-[#0B1120]">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-[#142B4A] dark:text-white truncate">
              {t.editor.title}
            </h1>
            <p className="text-[11px] font-mono-nums text-slate-500">
              Page {pageNumber}/{doc.pageCount}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            aria-label={t.editor.undo}
            className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            aria-label={t.editor.redo}
            className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleSave('download')}
            disabled={saving}
            aria-label={t.editor.exportPdf}
            className="min-h-[42px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t.editor.exportPdf}</span>
          </button>
          <button
            onClick={() => handleSave('version')}
            disabled={saving}
            className="min-h-[42px] px-3.5 rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save'}</span>
          </button>
        </div>
      </header>

      {/* Genuine Text Layer Diagnostic Banner */}
      <div className="px-3 py-1.5 bg-slate-100 dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="truncate">
          {textRuns.length > 0 ? t.editor.nativeTextDetected : t.editor.scannedOnlyNotice}
        </span>
        {statusMessage && (
          <span className="font-semibold text-[#2563EB] shrink-0">{statusMessage}</span>
        )}
      </div>

      {/* Selected Image Manipulation Toolbar */}
      {selectedImg && (
        <div className="px-3 py-2 bg-[#142B4A] text-white flex items-center justify-between gap-2 text-xs">
          <span>Selected Image</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() =>
                commitState((prev) => ({
                  ...prev,
                  addedImages: prev.addedImages.map((im) =>
                    im.id === selectedImg.id ? { ...im, width: im.width * 1.15, height: im.height * 1.15 } : im
                  ),
                }))
              }
              className="px-2.5 py-1 rounded-lg bg-white/15"
            >
              + Size
            </button>
            <button
              onClick={() =>
                commitState((prev) => ({
                  ...prev,
                  addedImages: prev.addedImages.map((im) =>
                    im.id === selectedImg.id ? { ...im, width: Math.max(40, im.width * 0.85), height: Math.max(40, im.height * 0.85) } : im
                  ),
                }))
              }
              className="px-2.5 py-1 rounded-lg bg-white/15"
            >
              - Size
            </button>
            <button
              onClick={() => {
                setCropInsets({ top: 0, right: 0, bottom: 0, left: 0 });
                setCropModalImg(selectedImg);
              }}
              className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1"
            >
              <Crop className="w-3.5 h-3.5" /> Crop
            </button>
            <button
              onClick={() =>
                commitState((prev) => ({
                  ...prev,
                  addedImages: prev.addedImages.map((im) =>
                    im.id === selectedImg.id ? { ...im, rotation: (im.rotation + 90) % 360 } : im
                  ),
                }))
              }
              className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1"
            >
              <RotateCw className="w-3.5 h-3.5" /> 90°
            </button>
            <button
              onClick={() => {
                commitState((prev) => ({
                  ...prev,
                  addedImages: prev.addedImages.filter((im) => im.id !== selectedImg.id),
                }));
                setSelectedImageId(null);
              }}
              className="px-2.5 py-1 rounded-lg bg-rose-500 text-white"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Editable Page Canvas */}
      <div className="flex-1 overflow-auto p-3 sm:p-6 flex justify-center items-start">
        <div
          className="relative bg-white shadow-xl rounded-md overflow-hidden select-none"
          style={{ width: pageSize.width * scale, height: pageSize.height * scale }}
        >
          <canvas ref={canvasRef} className="block" />

          {/* Interactive Vector & Text Overlay Layer */}
          <div
            ref={overlayRef}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            className="absolute inset-0 touch-none"
          >
            {/* Detected native PDF text runs (clickable when editText is active) */}
            {activeTool === 'editText' &&
              textRuns.map((run) => {
                const replaced = pageReplacements.find((r) => r.runId === run.id);
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenTextRunEditor(run);
                    }}
                    title="Tap to edit text"
                    style={{
                      left: run.x * scale,
                      top: run.y * scale,
                      minWidth: Math.max(16, run.width * scale),
                      minHeight: Math.max(14, run.height * scale),
                    }}
                    className={`absolute text-left rounded transition-colors ${
                      replaced
                        ? 'bg-white border border-[#2563EB]'
                        : 'hover:bg-[#2563EB]/15 border border-transparent hover:border-[#2563EB]/50'
                    }`}
                  >
                    {replaced && !replaced.deleted && (
                      <span
                        style={{
                          fontSize: replaced.fontSize * scale,
                          color: replaced.color,
                          fontWeight: replaced.bold ? 700 : 400,
                          fontStyle: replaced.italic ? 'italic' : 'normal',
                          textDecoration: replaced.underline ? 'underline' : 'none',
                        }}
                        className="block leading-tight whitespace-nowrap px-0.5"
                      >
                        {replaced.newText}
                      </span>
                    )}
                  </button>
                );
              })}

            {/* Added text boxes (drag to move, tap × to delete) */}
            {pageAddedTexts.map((tb) => (
              <div
                key={tb.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  overlayRef.current?.setPointerCapture?.(e.pointerId);
                  setDraggingItem({
                    kind: 'textBox',
                    id: tb.id,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    origX: tb.x,
                    origY: tb.y,
                  });
                }}
                style={{
                  left: tb.x * scale,
                  top: tb.y * scale,
                  maxWidth: tb.width * scale,
                  fontSize: tb.fontSize * scale,
                  color: tb.color,
                  fontWeight: tb.bold ? 700 : 400,
                  fontStyle: tb.italic ? 'italic' : 'normal',
                  textDecoration: tb.underline ? 'underline' : 'none',
                  textAlign: tb.align,
                  letterSpacing: `${tb.letterSpacing * scale}px`,
                }}
                className="group absolute px-1.5 py-0.5 rounded border border-dashed border-[#2563EB]/60 bg-white/85 whitespace-pre-wrap cursor-move"
              >
                {tb.text}
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.filter((x) => x.id !== tb.id),
                    }));
                  }}
                  aria-label="Delete text box"
                  className="absolute -top-2.5 -right-2.5 w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center shadow"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}

            {/* Added images (drag to move, tap to select) */}
            {pageAddedImages.map((im) => (
              <img
                key={im.id}
                src={im.dataUrl}
                alt="Inserted"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelectedImageId(im.id);
                  overlayRef.current?.setPointerCapture?.(e.pointerId);
                  setDraggingItem({
                    kind: 'image',
                    id: im.id,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    origX: im.x,
                    origY: im.y,
                  });
                }}
                style={{
                  left: im.x * scale,
                  top: im.y * scale,
                  width: im.width * scale,
                  height: im.height * scale,
                  transform: `rotate(${im.rotation}deg)`,
                }}
                className={`absolute object-contain cursor-move ${
                  selectedImageId === im.id ? 'ring-2 ring-[#2563EB]' : ''
                }`}
              />
            ))}

            {/* Annotations SVG & HTML preview */}
            <svg
              className="pointer-events-none absolute inset-0 w-full h-full"
              viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
            >
              {pageAnnotations.map((ann) => {
                if (ann.kind === 'highlight') {
                  return (
                    <rect
                      key={ann.id}
                      x={ann.x}
                      y={ann.y}
                      width={ann.width}
                      height={ann.height}
                      fill={ann.color}
                      fillOpacity={0.35}
                    />
                  );
                }
                if (ann.kind === 'underline') {
                  return (
                    <line
                      key={ann.id}
                      x1={ann.x}
                      y1={ann.y + ann.height}
                      x2={ann.x + ann.width}
                      y2={ann.y + ann.height}
                      stroke={ann.color}
                      strokeWidth={2}
                    />
                  );
                }
                if (ann.kind === 'strikethrough') {
                  return (
                    <line
                      key={ann.id}
                      x1={ann.x}
                      y1={ann.y + ann.height / 2}
                      x2={ann.x + ann.width}
                      y2={ann.y + ann.height / 2}
                      stroke={ann.color}
                      strokeWidth={2}
                    />
                  );
                }
                if (ann.kind === 'rect') {
                  return (
                    <rect
                      key={ann.id}
                      x={ann.x}
                      y={ann.y}
                      width={ann.width}
                      height={ann.height}
                      fill="none"
                      stroke={ann.color}
                      strokeWidth={ann.strokeWidth || 2}
                    />
                  );
                }
                if (ann.kind === 'circle') {
                  return (
                    <ellipse
                      key={ann.id}
                      cx={ann.x + ann.width / 2}
                      cy={ann.y + ann.height / 2}
                      rx={ann.width / 2}
                      ry={ann.height / 2}
                      fill="none"
                      stroke={ann.color}
                      strokeWidth={ann.strokeWidth || 2}
                    />
                  );
                }
                if (ann.kind === 'arrow') {
                  return (
                    <line
                      key={ann.id}
                      x1={ann.x}
                      y1={ann.y}
                      x2={ann.x + ann.width}
                      y2={ann.y + ann.height}
                      stroke={ann.color}
                      strokeWidth={ann.strokeWidth || 2.5}
                      strokeLinecap="round"
                    />
                  );
                }
                if (ann.kind === 'freehand' && ann.points && ann.points.length > 1) {
                  const d = ann.points
                    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
                    .join(' ');
                  return (
                    <path
                      key={ann.id}
                      d={d}
                      fill="none"
                      stroke={ann.color}
                      strokeWidth={ann.strokeWidth || 2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                }
                return null;
              })}

              {liveFreehand.length > 1 && (
                <path
                  d={liveFreehand.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')}
                  fill="none"
                  stroke={activeColor}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                />
              )}

              {liveBox && (
                <rect
                  x={liveBox.x}
                  y={liveBox.y}
                  width={Math.abs(liveBox.w)}
                  height={Math.abs(liveBox.h)}
                  fill="none"
                  stroke={activeColor}
                  strokeWidth={2}
                  strokeDasharray="4 2"
                />
              )}
            </svg>

            {/* Sticky notes, stamps, signatures (drag to move, tap × to delete) */}
            {pageAnnotations
              .filter((a) => a.kind === 'sticky' || a.kind === 'stamp' || a.kind === 'signature')
              .map((ann) => {
                const startDrag = (e: React.PointerEvent) => {
                  e.stopPropagation();
                  overlayRef.current?.setPointerCapture?.(e.pointerId);
                  setDraggingItem({
                    kind: 'annotation',
                    id: ann.id,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    origX: ann.x,
                    origY: ann.y,
                  });
                };
                const removeBtn = (
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.filter((x) => x.id !== ann.id),
                      }));
                    }}
                    aria-label="Delete annotation"
                    className="absolute -top-2.5 -right-2.5 w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center shadow"
                  >
                    <X className="w-3 h-3" />
                  </button>
                );

                if (ann.kind === 'sticky') {
                  return (
                    <div
                      key={ann.id}
                      onPointerDown={startDrag}
                      style={{ left: ann.x * scale, top: ann.y * scale, width: 150 * scale }}
                      className="absolute p-2 rounded-lg bg-amber-100 border border-amber-400 text-[10px] text-slate-900 shadow cursor-move"
                    >
                      {ann.comment}
                      {removeBtn}
                    </div>
                  );
                }
                if (ann.kind === 'stamp') {
                  return (
                    <div
                      key={ann.id}
                      onPointerDown={startDrag}
                      style={{
                        left: ann.x * scale,
                        top: ann.y * scale,
                        borderColor: ann.color,
                        color: ann.color,
                      }}
                      className="absolute px-2 py-0.5 rounded border-2 bg-white/90 text-[10px] font-bold cursor-move"
                    >
                      {ann.dateStr}
                      {removeBtn}
                    </div>
                  );
                }
                return (
                  <div
                    key={ann.id}
                    onPointerDown={startDrag}
                    style={{
                      left: ann.x * scale,
                      top: ann.y * scale,
                      width: ann.width * scale,
                    }}
                    className="absolute cursor-move"
                  >
                    <img
                      src={ann.signatureDataUrl}
                      alt="Signature"
                      style={{ width: ann.width * scale, height: ann.height * scale }}
                      className="object-contain pointer-events-none"
                    />
                    {(ann.signerName || ann.dateStr) && (
                      <p className="text-[8px] text-slate-600 truncate">
                        {ann.signerName} {ann.dateStr ? `· ${ann.dateStr}` : ''}
                      </p>
                    )}
                    {removeBtn}
                  </div>
                );
              })}
          </div>
        </div>
      </div>

      {/* Bottom Editing Toolbar */}
      <div className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pb-safe shrink-0">
        {/* Page switcher + color dots + Save As Copy */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              disabled={pageNumber <= 1}
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono-nums px-1.5">
              {pageNumber}/{doc.pageCount}
            </span>
            <button
              onClick={() => setPageNumber((p) => Math.min(doc.pageCount, p + 1))}
              disabled={pageNumber >= doc.pageCount}
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {['#142B4A', '#2563EB', '#06B6D4', '#DC2626', '#16A34A'].map((c) => (
              <button
                key={c}
                onClick={() => setActiveColor(c)}
                className={`w-6 h-6 rounded-full border-2 ${
                  activeColor === c ? 'border-slate-900 dark:border-white scale-110' : 'border-transparent'
                }`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>

          <button
            onClick={() => handleSave('copy')}
            disabled={saving}
            className="min-h-[36px] px-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap"
          >
            {t.editor.saveCopy}
          </button>
        </div>

        {/* Scrollable Horizontal Tools */}
        <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto no-scrollbar">
          {toolsList.map((tool) => {
            const active = activeTool === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => {
                  if (tool.id === 'addImage') {
                    imageInputRef.current?.click();
                    return;
                  }
                  if (tool.id === 'signature') {
                    setActiveTool('signature');
                    setShowSigModal(true);
                    return;
                  }
                  setActiveTool(tool.id);
                }}
                className={`min-h-[44px] px-3 rounded-xl flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                  active
                    ? 'bg-[#2563EB] text-white shadow-sm'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                }`}
              >
                {tool.icon}
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageFileSelect}
        className="hidden"
      />

      {/* Existing Text Run Editor Modal */}
      {editingRun && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Modify PDF Text
              </h3>
              <button
                onClick={() => setEditingRun(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <input
              type="text"
              value={runDraft.text}
              onChange={(e) => setRunDraft((d) => ({ ...d, text: e.target.value }))}
              className="w-full min-h-[46px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
            />

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={runDraft.fontFamily}
                onChange={(e) =>
                  setRunDraft((d) => ({ ...d, fontFamily: e.target.value as 'sans' | 'serif' | 'mono' }))
                }
                className="h-10 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              >
                <option value="sans">Sans (Unicode/বাংলা)</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
              </select>
              <input
                type="number"
                min={6}
                max={72}
                value={runDraft.fontSize}
                onChange={(e) => setRunDraft((d) => ({ ...d, fontSize: Number(e.target.value) || 12 }))}
                className="w-16 h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-mono-nums"
              />
              <button
                onClick={() => setRunDraft((d) => ({ ...d, bold: !d.bold }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  runDraft.bold ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Bold className="w-4 h-4" />
              </button>
              <button
                onClick={() => setRunDraft((d) => ({ ...d, italic: !d.italic }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  runDraft.italic ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Italic className="w-4 h-4" />
              </button>
              <button
                onClick={() => setRunDraft((d) => ({ ...d, underline: !d.underline }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  runDraft.underline ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Underline className="w-4 h-4" />
              </button>
              <input
                type="color"
                value={runDraft.color}
                onChange={(e) => setRunDraft((d) => ({ ...d, color: e.target.value }))}
                className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-1">
                {(['left', 'center', 'right'] as const).map((al) => (
                  <button
                    key={al}
                    type="button"
                    onClick={() => setRunDraft((d) => ({ ...d, align: al }))}
                    className={`h-9 w-9 rounded-lg flex items-center justify-center border ${
                      runDraft.align === al
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {al === 'left' ? (
                      <AlignLeft className="w-4 h-4" />
                    ) : al === 'center' ? (
                      <AlignCenter className="w-4 h-4" />
                    ) : (
                      <AlignRight className="w-4 h-4" />
                    )}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 flex-1">
                <span className="text-slate-500 whitespace-nowrap">Spacing: {runDraft.letterSpacing}px</span>
                <input
                  type="range"
                  min={-1}
                  max={6}
                  step={0.5}
                  value={runDraft.letterSpacing}
                  onChange={(e) =>
                    setRunDraft((d) => ({ ...d, letterSpacing: Number(e.target.value) }))
                  }
                  className="flex-1 accent-[#2563EB]"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleApplyRunReplacement(true)}
                className="min-h-[46px] rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 text-sm font-semibold"
              >
                Delete Text
              </button>
              <button
                onClick={() => handleApplyRunReplacement(false)}
                className="min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
              >
                Replace Text
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add New Text Box Modal */}
      {addingBoxPos && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Add Text Box
              </h3>
              <button
                onClick={() => setAddingBoxPos(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <textarea
              rows={3}
              value={newBoxDraft.text}
              onChange={(e) => setNewBoxDraft((d) => ({ ...d, text: e.target.value }))}
              placeholder="Type English or বাংলা text..."
              autoFocus
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={newBoxDraft.fontFamily}
                onChange={(e) =>
                  setNewBoxDraft((d) => ({ ...d, fontFamily: e.target.value as 'sans' | 'serif' | 'mono' }))
                }
                className="h-10 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              >
                <option value="sans">Sans (English + বাংলা)</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
              </select>
              <input
                type="number"
                min={8}
                max={64}
                value={newBoxDraft.fontSize}
                onChange={(e) => setNewBoxDraft((d) => ({ ...d, fontSize: Number(e.target.value) || 14 }))}
                className="w-16 h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-mono-nums"
              />
              <button
                onClick={() => setNewBoxDraft((d) => ({ ...d, bold: !d.bold }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  newBoxDraft.bold ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Bold className="w-4 h-4" />
              </button>
              <button
                onClick={() => setNewBoxDraft((d) => ({ ...d, italic: !d.italic }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  newBoxDraft.italic ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Italic className="w-4 h-4" />
              </button>
              <input
                type="color"
                value={newBoxDraft.color}
                onChange={(e) => setNewBoxDraft((d) => ({ ...d, color: e.target.value }))}
                className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-1">
                {(['left', 'center', 'right'] as const).map((al) => (
                  <button
                    key={al}
                    type="button"
                    onClick={() => setNewBoxDraft((d) => ({ ...d, align: al }))}
                    className={`h-9 w-9 rounded-lg flex items-center justify-center border ${
                      newBoxDraft.align === al
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {al === 'left' ? (
                      <AlignLeft className="w-4 h-4" />
                    ) : al === 'center' ? (
                      <AlignCenter className="w-4 h-4" />
                    ) : (
                      <AlignRight className="w-4 h-4" />
                    )}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 flex-1">
                <span className="text-slate-500 whitespace-nowrap">Spacing: {newBoxDraft.letterSpacing}px</span>
                <input
                  type="range"
                  min={-1}
                  max={6}
                  step={0.5}
                  value={newBoxDraft.letterSpacing}
                  onChange={(e) =>
                    setNewBoxDraft((d) => ({ ...d, letterSpacing: Number(e.target.value) }))
                  }
                  className="flex-1 accent-[#2563EB]"
                />
              </label>
            </div>
            <button
              onClick={() => {
                if (!newBoxDraft.text.trim()) return;
                commitState((prev) => ({
                  ...prev,
                  addedTexts: [
                    ...prev.addedTexts,
                    {
                      id: `tb_${Date.now()}`,
                      pageNumber,
                      text: newBoxDraft.text,
                      x: addingBoxPos.x,
                      y: addingBoxPos.y,
                      width: 260,
                      fontSize: newBoxDraft.fontSize,
                      fontFamily: newBoxDraft.fontFamily,
                      color: newBoxDraft.color,
                      bold: newBoxDraft.bold,
                      italic: newBoxDraft.italic,
                      underline: newBoxDraft.underline,
                      align: newBoxDraft.align,
                      letterSpacing: newBoxDraft.letterSpacing,
                    },
                  ],
                }));
                setAddingBoxPos(null);
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              Place Text on Page
            </button>
          </div>
        </div>
      )}

      {/* Sticky Note Modal */}
      {stickyPos && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Add Sticky Note Comment
              </h3>
              <button onClick={() => setStickyPos(null)} className="min-h-[40px] min-w-[40px]">
                <X className="w-5 h-5" />
              </button>
            </div>
            <textarea
              rows={3}
              value={stickyText}
              onChange={(e) => setStickyText(e.target.value)}
              placeholder="Write comment..."
              autoFocus
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-amber-50 dark:bg-slate-800 text-sm"
            />
            <button
              onClick={() => {
                if (!stickyText.trim()) return;
                commitState((prev) => ({
                  ...prev,
                  annotations: [
                    ...prev.annotations,
                    {
                      id: `sticky_${Date.now()}`,
                      pageNumber,
                      kind: 'sticky',
                      x: stickyPos.x,
                      y: stickyPos.y,
                      width: 150,
                      height: 54,
                      color: '#FACC15',
                      comment: stickyText.trim(),
                    },
                  ],
                }));
                setStickyPos(null);
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              Add Sticky Note
            </button>
          </div>
        </div>
      )}

      <SignatureModal
        open={showSigModal}
        onClose={() => setShowSigModal(false)}
        onSelectSignature={(sig) => {
          setPendingSig(sig);
          setShowSigModal(false);
          setStatusMessage('Tap anywhere on the page to place signature');
        }}
      />

      {/* Crop Inserted Image Modal */}
      {cropModalImg && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Crop Image
              </h3>
              <button onClick={() => setCropModalImg(null)} className="min-h-[40px] min-w-[40px]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative mx-auto w-fit max-h-52 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100">
              <img
                src={cropModalImg.dataUrl}
                alt="Crop preview"
                style={{
                  clipPath: `inset(${cropInsets.top}% ${cropInsets.right}% ${cropInsets.bottom}% ${cropInsets.left}%)`,
                }}
                className="max-h-52 object-contain block"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                <label key={side} className="space-y-1 capitalize">
                  <span className="flex justify-between text-slate-500">
                    <span>{side} trim</span>
                    <span className="font-mono-nums">{cropInsets[side]}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    value={cropInsets[side]}
                    onChange={(e) =>
                      setCropInsets((prev) => ({ ...prev, [side]: Number(e.target.value) }))
                    }
                    className="w-full accent-[#2563EB]"
                  />
                </label>
              ))}
            </div>

            <button
              onClick={() => {
                const img = new Image();
                img.onload = () => {
                  const sx = Math.round((cropInsets.left / 100) * img.naturalWidth);
                  const sy = Math.round((cropInsets.top / 100) * img.naturalHeight);
                  const sw = Math.max(
                    20,
                    Math.round(((100 - cropInsets.left - cropInsets.right) / 100) * img.naturalWidth)
                  );
                  const sh = Math.max(
                    20,
                    Math.round(((100 - cropInsets.top - cropInsets.bottom) / 100) * img.naturalHeight)
                  );
                  const c = document.createElement('canvas');
                  c.width = sw;
                  c.height = sh;
                  c.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
                  const croppedUrl = c.toDataURL('image/png');
                  const newH = Math.round((cropModalImg.width / sw) * sh);
                  commitState((prev) => ({
                    ...prev,
                    addedImages: prev.addedImages.map((im) =>
                      im.id === cropModalImg.id
                        ? { ...im, dataUrl: croppedUrl, height: newH }
                        : im
                    ),
                  }));
                  setCropModalImg(null);
                };
                img.src = cropModalImg.dataUrl;
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              Apply Crop
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
