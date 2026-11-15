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
  Hand,
  Highlighter,
  ImagePlus,
  Italic,
  MessageSquare,
  MousePointer,
  Pen,
  Pencil,
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
  ZoomIn,
  ZoomOut,
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
import { usePdfPinchZoom } from '../hooks/usePdfPinchZoom';

interface PdfEditorViewProps {
  doc: DocumentRecord;
  language: AppLanguage;
  onClose: () => void;
  onSaveNewVersion: (updatedDoc: DocumentRecord) => Promise<void>;
  onSaveAsCopy: (newDoc: DocumentRecord) => Promise<void>;
}

type EditorTool =
  | 'pan'
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
  const [scale, setScale] = useState<number>(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return w < 640 ? Math.max(0.55, Math.min(1.0, (w - 28) / 595)) : 1.05;
  });
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
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
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
  const [editingStickyId, setEditingStickyId] = useState<string | null>(null);
  const [stickyText, setStickyText] = useState('');
  const [stickyArrow, setStickyArrow] = useState<'left' | 'right' | 'top' | 'bottom'>('left');

  const [showSigModal, setShowSigModal] = useState(false);
  const [pendingSig, setPendingSig] = useState<{
    dataUrl: string;
    signerName: string;
    dateStr: string;
    attachIntegritySeal: boolean;
  } | null>(null);

  const [selectedElement, setSelectedElement] = useState<{
    kind: 'image' | 'textBox' | 'annotation';
    id: string;
  } | null>(null);
  const selectedImageId = selectedElement?.kind === 'image' ? selectedElement.id : null;
  const setSelectedImageId = (id: string | null) =>
    setSelectedElement(id ? { kind: 'image', id } : null);
  const [cropModalImg, setCropModalImg] = useState<AddedImageOverlay | null>(null);
  const [cropInsets, setCropInsets] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [draggingItem, setDraggingItem] = useState<{
    kind: 'image' | 'textBox' | 'annotation';
    id: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    origPoints?: Array<{ x: number; y: number }>;
  } | null>(null);
  const [resizingImage, setResizingImage] = useState<{
    id: string;
    corner: 'nw' | 'ne' | 'sw' | 'se';
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const [resizingTextBox, setResizingTextBox] = useState<{
    id: string;
    startClientX: number;
    origW: number;
  } | null>(null);
  const preGestureSnapshotRef = useRef<EditorStateSnapshot | null>(null);
  const pointerMovedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Drawing interaction
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
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

  usePdfPinchZoom({
    rootRef: editorRootRef,
    scrollRef: canvasScrollRef,
    scale,
    setScale,
    minScale: 0.4,
    maxScale: 3.0,
    dragPan: activeTool === 'pan' ? 'all' : 'mouse',
  });

  // Keyboard arrow / PageUp / PageDown / Delete navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editingRun || addingBoxPos || stickyPos || showSigModal || cropModalImg) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const sc = canvasScrollRef.current;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (sc && sc.scrollHeight > sc.clientHeight + 4 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 4) {
          sc.scrollBy({ top: 110, behavior: 'auto' });
        } else {
          setPageNumber((p) => Math.min(doc.pageCount, p + 1));
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (sc && sc.scrollHeight > sc.clientHeight + 4 && sc.scrollTop > 4) {
          sc.scrollBy({ top: -110, behavior: 'auto' });
        } else {
          setPageNumber((p) => Math.max(1, p - 1));
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (sc && sc.scrollWidth > sc.clientWidth + 10 && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 4) {
          sc.scrollBy({ left: 100, behavior: 'auto' });
        } else {
          setPageNumber((p) => Math.min(doc.pageCount, p + 1));
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (sc && sc.scrollWidth > sc.clientWidth + 10 && sc.scrollLeft > 4) {
          sc.scrollBy({ left: -100, behavior: 'auto' });
        } else {
          setPageNumber((p) => Math.max(1, p - 1));
        }
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        setPageNumber((p) => Math.min(doc.pageCount, p + 1));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        setPageNumber((p) => Math.max(1, p - 1));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElement) {
        e.preventDefault();
        const targetEl = selectedElement;
        commitState((prev) => ({
          ...prev,
          addedImages:
            targetEl.kind === 'image'
              ? prev.addedImages.filter((im) => im.id !== targetEl.id)
              : prev.addedImages,
          addedTexts:
            targetEl.kind === 'textBox'
              ? prev.addedTexts.filter((tb) => tb.id !== targetEl.id)
              : prev.addedTexts,
          annotations:
            targetEl.kind === 'annotation'
              ? prev.annotations.filter((an) => an.id !== targetEl.id)
              : prev.annotations,
        }));
        setSelectedElement(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    editingRun,
    addingBoxPos,
    stickyPos,
    showSigModal,
    cropModalImg,
    selectedElement,
    doc.pageCount,
  ]);

  const [renderScale, setRenderScale] = useState(scale);

  useEffect(() => {
    const id = setTimeout(() => setRenderScale(scale), 180);
    return () => clearTimeout(id);
  }, [scale]);

  useEffect(() => {
    let active = true;
    const loadPageCanvas = async () => {
      if (canvasRef.current) {
        const res = await renderPageToCanvas(doc.pdfBytes, pageNumber, canvasRef.current, renderScale);
        if (active) {
          setPageSize({ width: res.unscaledWidth, height: res.unscaledHeight });
        }
      }
    };
    loadPageCanvas().catch(() => {});
    return () => {
      active = false;
    };
  }, [doc.pdfBytes, pageNumber, renderScale]);

  useEffect(() => {
    let active = true;
    extractPageTextRuns(doc.pdfBytes, pageNumber)
      .then(({ runs }) => {
        if (active) setTextRuns(runs);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [doc.pdfBytes, pageNumber]);

  const toUnscaledCoords = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  };

  const openEditAddedTextBox = (tb: AddedTextBox) => {
    setEditingBoxId(tb.id);
    setAddingBoxPos({ x: tb.x, y: tb.y });
    setNewBoxDraft({
      text: tb.text,
      fontSize: tb.fontSize,
      fontFamily: tb.fontFamily,
      color: tb.color,
      bold: tb.bold,
      italic: tb.italic,
      underline: tb.underline,
      align: tb.align,
      letterSpacing: tb.letterSpacing,
    });
  };

  const openEditStickyNote = (ann: AnnotationOverlay) => {
    setEditingStickyId(ann.id);
    setStickyPos({ x: ann.x, y: ann.y });
    setStickyText(ann.comment || '');
    setStickyArrow(ann.stickyArrow || 'left');
  };

  const isDragStrokeTool =
    activeTool === 'draw' ||
    activeTool === 'highlight' ||
    activeTool === 'underline' ||
    activeTool === 'strike' ||
    activeTool === 'rect' ||
    activeTool === 'circle' ||
    activeTool === 'arrow';

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== overlayRef.current) return;
    setSelectedImageId(null);
    const pt = toUnscaledCoords(e.clientX, e.clientY);

    if (activeTool === 'addText') {
      setEditingBoxId(null);
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
      setEditingStickyId(null);
      setStickyPos(pt);
      setStickyText('');
      setStickyArrow('left');
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
    }
  };

  const handleOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    if (e.target !== overlayRef.current) return;
    if (!isDragStrokeTool) return;
    setSelectedImageId(null);
    const pt = toUnscaledCoords(e.clientX, e.clientY);

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
    if (resizingTextBox) {
      pointerMovedRef.current = true;
      const dx = (e.clientX - resizingTextBox.startClientX) / scale;
      const newW = Math.round(Math.max(80, Math.min(pageSize.width - 20, resizingTextBox.origW + dx)));
      setState((prev) => ({
        ...prev,
        addedTexts: prev.addedTexts.map((tb) =>
          tb.id === resizingTextBox.id ? { ...tb, width: newW } : tb
        ),
      }));
      return;
    }

    if (resizingImage) {
      pointerMovedRef.current = true;
      const dx = (e.clientX - resizingImage.startClientX) / scale;
      const dy = (e.clientY - resizingImage.startClientY) / scale;
      const aspect = resizingImage.origW / Math.max(1, resizingImage.origH);
      let newW = resizingImage.origW;
      let newX = resizingImage.origX;
      let newY = resizingImage.origY;

      if (resizingImage.corner === 'se') {
        newW = Math.max(24, Math.min(pageSize.width - resizingImage.origX, resizingImage.origW + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * aspect)));
      } else if (resizingImage.corner === 'ne') {
        newW = Math.max(24, Math.min(pageSize.width - resizingImage.origX, resizingImage.origW + (Math.abs(dx) >= Math.abs(dy) ? dx : -dy * aspect)));
      } else if (resizingImage.corner === 'sw') {
        const deltaW = Math.abs(dx) >= Math.abs(dy) ? -dx : dy * aspect;
        newW = Math.max(24, Math.min(resizingImage.origX + resizingImage.origW, resizingImage.origW + deltaW));
        newX = resizingImage.origX + (resizingImage.origW - newW);
      } else if (resizingImage.corner === 'nw') {
        const deltaW = Math.abs(dx) >= Math.abs(dy) ? -dx : -dy * aspect;
        newW = Math.max(24, Math.min(resizingImage.origX + resizingImage.origW, resizingImage.origW + deltaW));
        newX = resizingImage.origX + (resizingImage.origW - newW);
      }
      const newH = Math.max(24, newW / aspect);
      if (resizingImage.corner === 'ne' || resizingImage.corner === 'nw') {
        newY = Math.max(0, resizingImage.origY + (resizingImage.origH - newH));
      }

      setState((prev) => ({
        ...prev,
        addedImages: prev.addedImages.map((im) =>
          im.id === resizingImage.id
            ? { ...im, x: newX, y: newY, width: Math.round(newW), height: Math.round(newH) }
            : im
        ),
      }));
      return;
    }

    if (draggingItem) {
      const rawDx = e.clientX - draggingItem.startClientX;
      const rawDy = e.clientY - draggingItem.startClientY;
      if (Math.hypot(rawDx, rawDy) > 5) {
        pointerMovedRef.current = true;
      }
      const dx = rawDx / scale;
      const dy = rawDy / scale;
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
          annotations: prev.annotations.map((an) => {
            if (an.id !== draggingItem.id) return an;
            if (an.kind === 'freehand' && draggingItem.origPoints) {
              return {
                ...an,
                points: draggingItem.origPoints.map((pt) => ({
                  x: pt.x + dx,
                  y: pt.y + dy,
                })),
              };
            }
            return { ...an, x: nx, y: ny };
          }),
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

  const handleOverlayPointerCancel = () => {
    setResizingTextBox(null);
    setResizingImage(null);
    setDraggingItem(null);
    preGestureSnapshotRef.current = null;
    dragStartRef.current = null;
    setLiveFreehand([]);
    setLiveBox(null);
  };

  const handleOverlayPointerUp = () => {
    if (resizingTextBox) {
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        setUndoStack((u) => [...u.slice(-24), preGestureSnapshotRef.current!]);
        setRedoStack([]);
      }
      preGestureSnapshotRef.current = null;
      setResizingTextBox(null);
      return;
    }
    if (resizingImage) {
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        setUndoStack((u) => [...u.slice(-24), preGestureSnapshotRef.current!]);
        setRedoStack([]);
      }
      preGestureSnapshotRef.current = null;
      setResizingImage(null);
      return;
    }
    if (draggingItem) {
      const wasTap = !pointerMovedRef.current;
      const item = draggingItem;
      if (!wasTap && preGestureSnapshotRef.current) {
        setUndoStack((u) => [...u.slice(-24), preGestureSnapshotRef.current!]);
        setRedoStack([]);
      }
      preGestureSnapshotRef.current = null;
      setDraggingItem(null);
      if (wasTap) {
        setSelectedElement({ kind: item.kind, id: item.id });
        if (item.kind === 'textBox') {
          const tb = state.addedTexts.find((x) => x.id === item.id);
          if (tb) openEditAddedTextBox(tb);
        } else if (item.kind === 'annotation') {
          const ann = state.annotations.find((x) => x.id === item.id);
          if (ann?.kind === 'sticky') openEditStickyNote(ann);
        }
      }
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
        const newId = `img_${Date.now()}`;
        commitState((prev) => ({
          ...prev,
          addedImages: [
            ...prev.addedImages,
            {
              id: newId,
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
        setSelectedImageId(newId);
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
  const selectedTextBox =
    selectedElement?.kind === 'textBox'
      ? pageAddedTexts.find((tb) => tb.id === selectedElement.id)
      : undefined;
  const selectedAnn =
    selectedElement?.kind === 'annotation'
      ? pageAnnotations.find((an) => an.id === selectedElement.id)
      : undefined;

  const toolsList: Array<{ id: EditorTool; label: string; icon: React.ReactNode }> = [
    { id: 'pan', label: language === 'bn' ? 'প্যান' : 'Pan', icon: <Hand className="w-4 h-4" /> },
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
    <div
      ref={editorRootRef}
      style={{ touchAction: 'pan-x pan-y' }}
      className="fixed inset-0 z-40 flex flex-col bg-[#E2E8F0] dark:bg-[#0B1120]"
    >
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

      {/* Genuine Text Layer Diagnostic Banner & Zoom */}
      <div className="px-3 py-1.5 bg-slate-100 dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="truncate">
          {textRuns.length > 0 ? t.editor.nativeTextDetected : t.editor.scannedOnlyNotice}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {statusMessage && (
            <span className="font-semibold text-[#2563EB] mr-1">{statusMessage}</span>
          )}
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))))}
            aria-label="Zoom out PDF"
            className="h-7 w-7 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono-nums text-[11px] min-w-[38px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(3.0, Number((s + 0.15).toFixed(2))))}
            aria-label="Zoom in PDF"
            className="h-7 w-7 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Editable Page Canvas Area with non-shifting floating element toolbar */}
      <div className="relative flex-1 flex flex-col overflow-hidden">
        {(selectedImg || selectedTextBox || selectedAnn) && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[94vw] overflow-x-auto no-scrollbar px-3 py-1.5 rounded-2xl bg-[#142B4A]/95 backdrop-blur-md text-white shadow-xl border border-white/15 flex items-center gap-1.5 text-xs">
            {selectedImg && (
              <>
                <span className="font-semibold text-cyan-300 pr-1 whitespace-nowrap">Image</span>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id
                          ? { ...im, width: Math.round(im.width * 1.15), height: Math.round(im.height * 1.15) }
                          : im
                      ),
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                >
                  + Size
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id
                          ? { ...im, width: Math.max(32, Math.round(im.width * 0.85)), height: Math.max(32, Math.round(im.height * 0.85)) }
                          : im
                      ),
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                >
                  - Size
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCropInsets({ top: 0, right: 0, bottom: 0, left: 0 });
                    setCropModalImg(selectedImg);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Crop className="w-3.5 h-3.5" /> Crop
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, rotation: (im.rotation + 90) % 360 } : im
                      ),
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <RotateCw className="w-3.5 h-3.5" /> 90°
                </button>
                <button
                  type="button"
                  onClick={() => {
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.filter((im) => im.id !== selectedImg.id),
                    }));
                    setSelectedElement(null);
                  }}
                  aria-label="Delete selected image"
                  className="px-2.5 py-1 rounded-lg bg-rose-500 text-white"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            {selectedTextBox && (
              <>
                <span className="font-semibold text-cyan-300 pr-1 whitespace-nowrap">Text</span>
                <button
                  type="button"
                  onClick={() => openEditAddedTextBox(selectedTextBox)}
                  className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap"
                >
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === selectedTextBox.id ? { ...tb, fontSize: Math.min(64, tb.fontSize + 2) } : tb
                      ),
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                >
                  A+
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === selectedTextBox.id ? { ...tb, fontSize: Math.max(8, tb.fontSize - 2) } : tb
                      ),
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                >
                  A-
                </button>
                <button
                  type="button"
                  onClick={() => {
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.filter((tb) => tb.id !== selectedTextBox.id),
                    }));
                    setSelectedElement(null);
                  }}
                  aria-label="Delete text box"
                  className="px-2.5 py-1 rounded-lg bg-rose-500 text-white"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            {selectedAnn && (
              <>
                <span className="font-semibold text-cyan-300 pr-1 capitalize whitespace-nowrap">
                  {selectedAnn.kind}
                </span>
                {selectedAnn.kind === 'sticky' && (
                  <button
                    type="button"
                    onClick={() => openEditStickyNote(selectedAnn)}
                    className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap"
                  >
                    <Pencil className="w-3 h-3" /> Edit Note
                  </button>
                )}
                {(selectedAnn.kind === 'signature' ||
                  selectedAnn.kind === 'rect' ||
                  selectedAnn.kind === 'circle' ||
                  selectedAnn.kind === 'highlight') && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id
                              ? { ...an, width: Math.round(an.width * 1.15), height: Math.round(an.height * 1.15) }
                              : an
                          ),
                        }))
                      }
                      className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      + Size
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id
                              ? {
                                  ...an,
                                  width: Math.max(16, Math.round(an.width * 0.85)),
                                  height: Math.max(10, Math.round(an.height * 0.85)),
                                }
                              : an
                          ),
                        }))
                      }
                      className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      - Size
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      annotations: prev.annotations.map((an) =>
                        an.id === selectedAnn.id ? { ...an, color: activeColor } : an
                      ),
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: activeColor }} />
                  Color
                </button>
                <button
                  type="button"
                  onClick={() => {
                    commitState((prev) => ({
                      ...prev,
                      annotations: prev.annotations.filter((an) => an.id !== selectedAnn.id),
                    }));
                    setSelectedElement(null);
                  }}
                  aria-label="Delete annotation"
                  className="px-2.5 py-1 rounded-lg bg-rose-500 text-white"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setSelectedElement(null)}
              aria-label="Deselect element"
              className="px-1.5 py-1 rounded-lg hover:bg-white/10 text-slate-300"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

      <div
        ref={canvasScrollRef}
        style={{
          touchAction: activeTool === 'pan' ? 'none' : 'pan-x pan-y',
          overscrollBehavior: 'contain',
          scrollBehavior: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
        className={`flex-1 overflow-auto ${activeTool === 'pan' ? 'cursor-grab' : ''}`}
      >
        <div className="min-w-full min-h-full w-fit p-3 sm:p-6 flex items-start justify-center">
        <div
          className="relative bg-white shadow-xl rounded-md overflow-hidden select-none shrink-0"
          style={{ width: pageSize.width * scale, height: pageSize.height * scale }}
        >
          <canvas ref={canvasRef} className="block w-full h-full" />

          {/* Interactive Vector & Text Overlay Layer */}
          <div
            ref={overlayRef}
            onClick={handleOverlayClick}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerCancel}
            style={{
              touchAction: activeTool === 'pan' || isDragStrokeTool ? 'none' : 'pan-x pan-y',
              pointerEvents: activeTool === 'pan' ? 'none' : 'auto',
            }}
            className="absolute inset-0"
          >
            {/* Always render committed native text replacements across all tools */}
            {pageReplacements.map((rep) => {
              const runMatch = textRuns.find((r) => r.id === rep.runId);
              return (
                <button
                  key={rep.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (runMatch) {
                      handleOpenTextRunEditor(runMatch);
                    } else {
                      handleOpenTextRunEditor({
                        id: rep.runId,
                        pageNumber: rep.pageNumber,
                        str: rep.originalText,
                        x: rep.x,
                        y: rep.y,
                        width: rep.width,
                        height: rep.height,
                        fontSize: rep.fontSize,
                        fontName: 'Helvetica',
                      });
                    }
                  }}
                  title="Tap to modify replaced text"
                  style={{
                    left: rep.x * scale,
                    top: rep.y * scale,
                    minWidth: Math.max(16, rep.width * scale),
                    minHeight: Math.max(14, rep.height * scale),
                  }}
                  className="absolute text-left rounded bg-white border border-[#2563EB]/80 z-10"
                >
                  {!rep.deleted && (
                    <span
                      style={{
                        fontSize: rep.fontSize * scale,
                        color: rep.color,
                        fontWeight: rep.bold ? 700 : 400,
                        fontStyle: rep.italic ? 'italic' : 'normal',
                        textDecoration: rep.underline ? 'underline' : 'none',
                        letterSpacing: `${(rep.letterSpacing || 0) * scale}px`,
                      }}
                      className="block leading-tight whitespace-nowrap px-0.5"
                    >
                      {rep.newText}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Untouched native PDF text runs (interactive when editText is active) */}
            {activeTool === 'editText' &&
              textRuns
                .filter((run) => !pageReplacements.some((r) => r.runId === run.id))
                .map((run) => (
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
                    className="absolute text-left rounded transition-colors hover:bg-[#2563EB]/15 border border-transparent hover:border-[#2563EB]/50"
                  />
                ))}

            {/* Added text boxes (drag to move, drag right handle to resize width, tap or pencil to edit, tap × to delete) */}
            {pageAddedTexts.map((tb) => {
              const isSelected = selectedElement?.kind === 'textBox' && selectedElement.id === tb.id;
              return (
                <div
                  key={tb.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    pointerMovedRef.current = false;
                    preGestureSnapshotRef.current = state;
                    setSelectedElement({ kind: 'textBox', id: tb.id });
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
                    width: tb.width * scale,
                    fontSize: tb.fontSize * scale,
                    color: tb.color,
                    fontWeight: tb.bold ? 700 : 400,
                    fontStyle: tb.italic ? 'italic' : 'normal',
                    textDecoration: tb.underline ? 'underline' : 'none',
                    textAlign: tb.align,
                    letterSpacing: `${tb.letterSpacing * scale}px`,
                    touchAction: 'none',
                  }}
                  title="Drag to move · Tap to edit text"
                  className={`group absolute px-1.5 py-0.5 rounded bg-white/90 whitespace-pre-wrap cursor-move z-10 ${
                    isSelected
                      ? 'border-2 border-[#2563EB] ring-2 ring-[#2563EB]/30'
                      : 'border border-dashed border-[#2563EB]/70'
                  }`}
                >
                  {tb.text}
                  <button
                    type="button"
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditAddedTextBox(tb);
                    }}
                    aria-label="Edit text box"
                    className="absolute -top-3 right-5 w-6 h-6 rounded-full bg-[#2563EB] text-white flex items-center justify-center shadow-md"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState((prev) => ({
                        ...prev,
                        addedTexts: prev.addedTexts.filter((x) => x.id !== tb.id),
                      }));
                      if (isSelected) setSelectedElement(null);
                    }}
                    aria-label="Delete text box"
                    className="absolute -top-3 -right-2.5 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                  {/* Width resize handle */}
                  <div
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pointerMovedRef.current = false;
                      preGestureSnapshotRef.current = state;
                      setSelectedElement({ kind: 'textBox', id: tb.id });
                      overlayRef.current?.setPointerCapture?.(e.pointerId);
                      setResizingTextBox({
                        id: tb.id,
                        startClientX: e.clientX,
                        origW: tb.width,
                      });
                    }}
                    title="Drag to resize text box width"
                    className="absolute top-1/2 -right-2 -translate-y-1/2 w-4 h-7 rounded-full bg-white border-2 border-[#2563EB] shadow cursor-ew-resize"
                  />
                </div>
              );
            })}

            {/* Added images (drag to move, drag corners to resize, tap × to delete) */}
            {pageAddedImages.map((im) => {
              const isSelected = selectedImageId === im.id;
              return (
                <div
                  key={im.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    pointerMovedRef.current = false;
                    preGestureSnapshotRef.current = state;
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
                    touchAction: 'none',
                  }}
                  className={`group absolute cursor-move select-none z-10 ${
                    isSelected ? 'ring-2 ring-[#2563EB]' : 'hover:ring-1 hover:ring-[#2563EB]/60'
                  }`}
                >
                  <img
                    src={im.dataUrl}
                    alt="Inserted"
                    draggable={false}
                    style={{ transform: `rotate(${im.rotation}deg)` }}
                    className="w-full h-full object-contain pointer-events-none block"
                  />

                  {/* Direct on-image Delete button */}
                  <button
                    type="button"
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.filter((x) => x.id !== im.id),
                      }));
                      if (isSelected) setSelectedImageId(null);
                    }}
                    aria-label="Delete image"
                    className="absolute -top-3 -right-3 z-20 w-7 h-7 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md"
                  >
                    <X className="w-4 h-4" />
                  </button>

                  {/* Corner Drag-Resize Handles (nw, sw, se) with 24px touch target */}
                  {(['nw', 'sw', 'se'] as const).map((corner) => {
                    const posClass =
                      corner === 'nw'
                        ? '-top-2.5 -left-2.5 cursor-nwse-resize'
                        : corner === 'sw'
                        ? '-bottom-2.5 -left-2.5 cursor-nesw-resize'
                        : '-bottom-2.5 -right-2.5 cursor-nwse-resize';
                    return (
                      <div
                        key={corner}
                        style={{ touchAction: 'none' }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          pointerMovedRef.current = false;
                          preGestureSnapshotRef.current = state;
                          setSelectedImageId(im.id);
                          overlayRef.current?.setPointerCapture?.(e.pointerId);
                          setResizingImage({
                            id: im.id,
                            corner,
                            startClientX: e.clientX,
                            startClientY: e.clientY,
                            origX: im.x,
                            origY: im.y,
                            origW: im.width,
                            origH: im.height,
                          });
                        }}
                        title="Drag to resize picture"
                        className={`absolute ${posClass} z-20 w-6 h-6 rounded-full bg-white border-2 border-[#2563EB] shadow-md`}
                      />
                    );
                  })}
                </div>
              );
            })}

            {/* Annotations SVG & HTML preview */}
            <svg
              className="pointer-events-none absolute inset-0 w-full h-full"
              viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
            >
              {pageAnnotations.map((ann) => {
                const isSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
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
                      stroke={isSel ? '#2563EB' : undefined}
                      strokeWidth={isSel ? 1.5 : undefined}
                      strokeDasharray={isSel ? '4 2' : undefined}
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
                      strokeWidth={isSel ? 3.5 : 2}
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
                      strokeWidth={isSel ? 3.5 : 2}
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
                      strokeWidth={(ann.strokeWidth || 2) + (isSel ? 1.5 : 0)}
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
                      strokeWidth={(ann.strokeWidth || 2) + (isSel ? 1.5 : 0)}
                    />
                  );
                }
                if (ann.kind === 'arrow') {
                  const sx = ann.x;
                  const sy = ann.y;
                  const ex = ann.x + ann.width;
                  const ey = ann.y + ann.height;
                  const ang = Math.atan2(ey - sy, ex - sx);
                  const headLen = 10;
                  return (
                    <g key={ann.id}>
                      <line
                        x1={sx}
                        y1={sy}
                        x2={ex}
                        y2={ey}
                        stroke={ann.color}
                        strokeWidth={(ann.strokeWidth || 2.5) + (isSel ? 1.5 : 0)}
                        strokeLinecap="round"
                      />
                      <path
                        d={`M ${ex - headLen * Math.cos(ang - Math.PI / 6)} ${ey - headLen * Math.sin(ang - Math.PI / 6)} L ${ex} ${ey} L ${ex - headLen * Math.cos(ang + Math.PI / 6)} ${ey - headLen * Math.sin(ang + Math.PI / 6)}`}
                        fill="none"
                        stroke={ann.color}
                        strokeWidth={(ann.strokeWidth || 2.5) + (isSel ? 1.5 : 0)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
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
                      strokeWidth={(ann.strokeWidth || 2.5) + (isSel ? 1.5 : 0)}
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
                activeTool === 'arrow' ? (
                  <line
                    x1={liveBox.x}
                    y1={liveBox.y}
                    x2={liveBox.x + liveBox.w}
                    y2={liveBox.y + liveBox.h}
                    stroke={activeColor}
                    strokeWidth={2.5}
                    strokeDasharray="4 2"
                  />
                ) : (
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
                )
              )}
            </svg>

            {/* Interactive hitboxes for drawn vector annotations (tap to select, drag to move, tap × to delete) */}
            {!isDragStrokeTool &&
              pageAnnotations
                .filter((a) => a.kind !== 'sticky' && a.kind !== 'stamp' && a.kind !== 'signature')
                .map((ann) => {
                  const isSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
                  let bx = ann.x;
                  let by = ann.y;
                  let bw = Math.max(20, Math.abs(ann.width));
                  let bh = Math.max(16, Math.abs(ann.height));
                  if (ann.kind === 'arrow') {
                    bx = Math.min(ann.x, ann.x + ann.width) - 6;
                    by = Math.min(ann.y, ann.y + ann.height) - 6;
                    bw = Math.max(20, Math.abs(ann.width) + 12);
                    bh = Math.max(20, Math.abs(ann.height) + 12);
                  } else if (ann.kind === 'freehand' && ann.points && ann.points.length > 0) {
                    const xs = ann.points.map((p) => p.x);
                    const ys = ann.points.map((p) => p.y);
                    bx = Math.min(...xs) - 6;
                    by = Math.min(...ys) - 6;
                    bw = Math.max(20, Math.max(...xs) - Math.min(...xs) + 12);
                    bh = Math.max(20, Math.max(...ys) - Math.min(...ys) + 12);
                  }
                  return (
                    <div
                      key={`hit_${ann.id}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        pointerMovedRef.current = false;
                        preGestureSnapshotRef.current = state;
                        setSelectedElement({ kind: 'annotation', id: ann.id });
                        overlayRef.current?.setPointerCapture?.(e.pointerId);
                        setDraggingItem({
                          kind: 'annotation',
                          id: ann.id,
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          origX: ann.x,
                          origY: ann.y,
                          origPoints: ann.points ? ann.points.map((p) => ({ ...p })) : undefined,
                        });
                      }}
                      style={{
                        left: bx * scale,
                        top: by * scale,
                        width: bw * scale,
                        height: bh * scale,
                        touchAction: 'none',
                      }}
                      className={`absolute cursor-move ${
                        isSel ? 'ring-2 ring-[#2563EB] rounded bg-[#2563EB]/5' : ''
                      }`}
                    >
                      {isSel && (
                        <button
                          type="button"
                          style={{ touchAction: 'none' }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            commitState((prev) => ({
                              ...prev,
                              annotations: prev.annotations.filter((x) => x.id !== ann.id),
                            }));
                            setSelectedElement(null);
                          }}
                          aria-label="Delete shape"
                          className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

            {/* Sticky notes, stamps, signatures (drag to move, tap × to delete) */}
            {pageAnnotations
              .filter((a) => a.kind === 'sticky' || a.kind === 'stamp' || a.kind === 'signature')
              .map((ann) => {
                const isSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
                const startDrag = (e: React.PointerEvent) => {
                  e.stopPropagation();
                  pointerMovedRef.current = false;
                  preGestureSnapshotRef.current = state;
                  setSelectedElement({ kind: 'annotation', id: ann.id });
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
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.filter((x) => x.id !== ann.id),
                      }));
                      if (isSel) setSelectedElement(null);
                    }}
                    aria-label="Delete annotation"
                    className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                );

                if (ann.kind === 'sticky') {
                  const arrowSide = ann.stickyArrow || 'left';
                  const cycleOrder: Array<'left' | 'top' | 'right' | 'bottom'> = ['left', 'top', 'right', 'bottom'];
                  const nextSide = cycleOrder[(cycleOrder.indexOf(arrowSide) + 1) % cycleOrder.length];
                  return (
                    <div
                      key={ann.id}
                      onPointerDown={startDrag}
                      style={{
                        left: ann.x * scale,
                        top: ann.y * scale,
                        width: 150 * scale,
                        touchAction: 'none',
                      }}
                      title="Drag to move · Tap to edit note"
                      className={`absolute p-2 rounded-lg bg-amber-100 border-2 text-[10px] text-slate-900 shadow-md cursor-move z-10 ${
                        isSel ? 'border-[#2563EB] ring-2 ring-[#2563EB]/30' : 'border-amber-500'
                      }`}
                    >
                      {/* Callout Arrow Indicator */}
                      {arrowSide === 'left' && (
                        <div className="pointer-events-none absolute top-1/2 -left-5 -translate-y-1/2 flex items-center">
                          <svg width="20" height="14" viewBox="0 0 20 14" className="drop-shadow-sm">
                            <path d="M 20 7 L 2 7 M 8 2 L 2 7 L 8 12" stroke="#D97706" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                      {arrowSide === 'right' && (
                        <div className="pointer-events-none absolute top-1/2 -right-5 -translate-y-1/2 flex items-center">
                          <svg width="20" height="14" viewBox="0 0 20 14" className="drop-shadow-sm">
                            <path d="M 0 7 L 18 7 M 12 2 L 18 7 L 12 12" stroke="#D97706" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                      {arrowSide === 'top' && (
                        <div className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 flex justify-center">
                          <svg width="14" height="20" viewBox="0 0 14 20" className="drop-shadow-sm">
                            <path d="M 7 20 L 7 2 M 2 8 L 7 2 L 12 8" stroke="#D97706" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                      {arrowSide === 'bottom' && (
                        <div className="pointer-events-none absolute -bottom-5 left-1/2 -translate-x-1/2 flex justify-center">
                          <svg width="14" height="20" viewBox="0 0 14 20" className="drop-shadow-sm">
                            <path d="M 7 0 L 7 18 M 2 12 L 7 18 L 12 12" stroke="#D97706" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}

                      <div className="flex items-start justify-between gap-1">
                        <span className="leading-snug break-words">{ann.comment}</span>
                      </div>

                      <button
                        type="button"
                        style={{ touchAction: 'none' }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          commitState((prev) => ({
                            ...prev,
                            annotations: prev.annotations.map((x) =>
                              x.id === ann.id ? { ...x, stickyArrow: nextSide } : x
                            ),
                          }));
                        }}
                        title="Change arrow pointer direction"
                        className="absolute -top-3 right-5 w-6 h-6 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center shadow-md"
                      >
                        {arrowSide === 'left' ? '←' : arrowSide === 'right' ? '→' : arrowSide === 'top' ? '↑' : '↓'}
                      </button>
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
                        touchAction: 'none',
                      }}
                      className={`absolute px-2 py-0.5 rounded border-2 bg-white/90 text-[10px] font-bold cursor-move z-10 ${
                        isSel ? 'ring-2 ring-[#2563EB]' : ''
                      }`}
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
                      touchAction: 'none',
                    }}
                    className={`absolute cursor-move z-10 ${
                      isSel ? 'ring-2 ring-[#2563EB] rounded' : ''
                    }`}
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

      {/* Add / Edit Text Box Modal */}
      {addingBoxPos && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {editingBoxId ? 'Edit Text Box' : 'Add Text Box'}
              </h3>
              <button
                onClick={() => {
                  setAddingBoxPos(null);
                  setEditingBoxId(null);
                }}
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
                type="button"
                onClick={() => setNewBoxDraft((d) => ({ ...d, bold: !d.bold }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  newBoxDraft.bold ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Bold className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setNewBoxDraft((d) => ({ ...d, italic: !d.italic }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  newBoxDraft.italic ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Italic className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setNewBoxDraft((d) => ({ ...d, underline: !d.underline }))}
                className={`h-10 w-10 rounded-xl flex items-center justify-center border ${
                  newBoxDraft.underline ? 'bg-[#2563EB] text-white border-[#2563EB]' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <Underline className="w-4 h-4" />
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
            <div className={editingBoxId ? 'grid grid-cols-2 gap-2' : ''}>
              {editingBoxId && (
                <button
                  type="button"
                  onClick={() => {
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.filter((x) => x.id !== editingBoxId),
                    }));
                    setAddingBoxPos(null);
                    setEditingBoxId(null);
                  }}
                  className="min-h-[46px] rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 text-sm font-semibold"
                >
                  Delete Text
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!newBoxDraft.text.trim()) return;
                  if (editingBoxId) {
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === editingBoxId
                          ? {
                              ...tb,
                              text: newBoxDraft.text,
                              fontSize: newBoxDraft.fontSize,
                              fontFamily: newBoxDraft.fontFamily,
                              color: newBoxDraft.color,
                              bold: newBoxDraft.bold,
                              italic: newBoxDraft.italic,
                              underline: newBoxDraft.underline,
                              align: newBoxDraft.align,
                              letterSpacing: newBoxDraft.letterSpacing,
                            }
                          : tb
                      ),
                    }));
                  } else {
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
                  }
                  setAddingBoxPos(null);
                  setEditingBoxId(null);
                }}
                className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
              >
                {editingBoxId ? 'Update Text' : 'Place Text on Page'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sticky Note Modal */}
      {stickyPos && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {editingStickyId ? 'Edit Sticky Note' : 'Add Sticky Note Comment'}
              </h3>
              <button
                onClick={() => {
                  setStickyPos(null);
                  setEditingStickyId(null);
                }}
                className="min-h-[40px] min-w-[40px]"
              >
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
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-500 font-medium">Arrow Indicator:</span>
              <div className="flex items-center gap-1">
                {([
                  { side: 'left', label: '← Left' },
                  { side: 'top', label: '↑ Top' },
                  { side: 'right', label: '→ Right' },
                  { side: 'bottom', label: '↓ Bottom' },
                ] as const).map((item) => (
                  <button
                    key={item.side}
                    type="button"
                    onClick={() => setStickyArrow(item.side)}
                    className={`px-2.5 py-1.5 rounded-lg font-semibold border ${
                      stickyArrow === item.side
                        ? 'bg-amber-500 text-white border-amber-500'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => {
                if (!stickyText.trim()) return;
                if (editingStickyId) {
                  commitState((prev) => ({
                    ...prev,
                    annotations: prev.annotations.map((an) =>
                      an.id === editingStickyId
                        ? { ...an, comment: stickyText.trim(), stickyArrow }
                        : an
                    ),
                  }));
                } else {
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
                        stickyArrow,
                      },
                    ],
                  }));
                }
                setStickyPos(null);
                setEditingStickyId(null);
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              {editingStickyId ? 'Update Sticky Note' : 'Add Sticky Note'}
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
