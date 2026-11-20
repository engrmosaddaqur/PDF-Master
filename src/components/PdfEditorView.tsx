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
  Copy,
  Crop,
  Download,
  Eraser,
  Hand,
  Highlighter,
  ImagePlus,
  Italic,
  Layers,
  MessageSquare,
  MousePointer,
  MousePointer2,
  PaintBucket,
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
  computeStickyArrowGeometry,
  extractPageTextRuns,
  renderPageThumbnail,
  renderPageToCanvas,
} from '../services/pdfEngine';
import { saveBufferToDeviceStorage } from '../services/deviceFileActions';
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
  | 'select'
  | 'pan'
  | 'editText'
  | 'addText'
  | 'addImage'
  | 'draw'
  | 'eraser'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'rect'
  | 'circle'
  | 'arrow'
  | 'whiteout'
  | 'sticky'
  | 'signature'
  | 'stamp';

interface EditorStateSnapshot {
  replacements: TextReplacementEdit[];
  addedTexts: AddedTextBox[];
  addedImages: AddedImageOverlay[];
  annotations: AnnotationOverlay[];
}

const STAMP_PRESETS = [
  { id: 'DATE', label: 'DATE', color: '#2563EB' },
  { id: 'APPROVED', label: 'APPROVED', color: '#16A34A' },
  { id: 'CONFIDENTIAL', label: 'CONFIDENTIAL', color: '#DC2626' },
  { id: 'PAID', label: 'PAID', color: '#059669' },
  { id: 'DRAFT', label: 'DRAFT', color: '#D97706' },
  { id: 'RECEIVED', label: 'RECEIVED', color: '#0891B2' },
];

const PALETTE_COLORS = [
  '#0F172A',
  '#142B4A',
  '#2563EB',
  '#06B6D4',
  '#16A34A',
  '#FACC15',
  '#EA580C',
  '#DC2626',
  '#7C3AED',
];

const STICKY_THEMES = [
  { id: 'amber', bg: '#FEF3C7', accent: '#D97706', name: 'Amber' },
  { id: 'yellow', bg: '#FEF9C3', accent: '#CA8A04', name: 'Yellow' },
  { id: 'blue', bg: '#DBEAFE', accent: '#2563EB', name: 'Blue' },
  { id: 'green', bg: '#DCFCE7', accent: '#16A34A', name: 'Green' },
  { id: 'pink', bg: '#FCE7F3', accent: '#DB2777', name: 'Pink' },
  { id: 'slate', bg: '#F1F5F9', accent: '#475569', name: 'Slate' },
];

const TEXTBOX_BG_OPTIONS = [
  { value: 'transparent', label: 'None' },
  { value: '#FFFFFF', label: 'White' },
  { value: '#FEF9C3', label: 'Yellow' },
  { value: '#DBEAFE', label: 'Blue' },
];

type StickyArrowSide = NonNullable<AnnotationOverlay['stickyArrow']>;

function computeDefaultStickyTip(
  x: number,
  y: number,
  w: number,
  h: number,
  side: StickyArrowSide,
  len: number,
  pageW: number,
  pageH: number
): { tipX?: number; tipY?: number } {
  if (side === 'none') return {};
  const diag = Math.round(len / Math.SQRT2);
  let tx = x - diag;
  let ty = y - diag;
  switch (side) {
    case 'top-left':
      tx = x - diag;
      ty = y - diag;
      break;
    case 'top-right':
      tx = x + w + diag;
      ty = y - diag;
      break;
    case 'bottom-left':
      tx = x - diag;
      ty = y + h + diag;
      break;
    case 'bottom-right':
      tx = x + w + diag;
      ty = y + h + diag;
      break;
    case 'left':
      tx = x - len;
      ty = y + h / 2;
      break;
    case 'right':
      tx = x + w + len;
      ty = y + h / 2;
      break;
    case 'top':
      tx = x + w / 2;
      ty = y - len;
      break;
    case 'bottom':
      tx = x + w / 2;
      ty = y + h + len;
      break;
  }
  return {
    tipX: Math.round(Math.max(8, Math.min(pageW - 8, tx))),
    tipY: Math.round(Math.max(8, Math.min(pageH - 8, ty))),
  };
}

function buildSmoothSvgPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y} L ${pts[0].x + 0.01} ${pts[0].y}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = ((pts[i].x + pts[i + 1].x) / 2).toFixed(2);
    const midY = ((pts[i].y + pts[i + 1].y) / 2).toFixed(2);
    d += ` Q ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}, ${midX} ${midY}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
}

function distPointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isErasableAnnotation(ann: AnnotationOverlay): boolean {
  return (
    ann.kind === 'freehand' ||
    ann.kind === 'rect' ||
    ann.kind === 'circle' ||
    ann.kind === 'arrow' ||
    ann.kind === 'highlight' ||
    ann.kind === 'underline' ||
    ann.kind === 'strikethrough' ||
    ann.kind === 'whiteout'
  );
}

function doesEraserHitAnnotation(
  ann: AnnotationOverlay,
  px: number,
  py: number,
  radius: number
): boolean {
  if (!isErasableAnnotation(ann)) return false;
  const pad = radius + (ann.strokeWidth || 2.5) / 2;

  if (ann.kind === 'freehand' && ann.points && ann.points.length > 0) {
    if (ann.points.length === 1) {
      return Math.hypot(px - ann.points[0].x, py - ann.points[0].y) <= pad;
    }
    for (let i = 1; i < ann.points.length; i++) {
      if (
        distPointToSegment(
          px,
          py,
          ann.points[i - 1].x,
          ann.points[i - 1].y,
          ann.points[i].x,
          ann.points[i].y
        ) <= pad
      ) {
        return true;
      }
    }
    return false;
  }

  if (ann.kind === 'arrow') {
    return (
      distPointToSegment(px, py, ann.x, ann.y, ann.x + ann.width, ann.y + ann.height) <= pad
    );
  }
  if (ann.kind === 'underline') {
    return (
      distPointToSegment(
        px,
        py,
        ann.x,
        ann.y + ann.height,
        ann.x + ann.width,
        ann.y + ann.height
      ) <= pad
    );
  }
  if (ann.kind === 'strikethrough') {
    return (
      distPointToSegment(
        px,
        py,
        ann.x,
        ann.y + ann.height / 2,
        ann.x + ann.width,
        ann.y + ann.height / 2
      ) <= pad
    );
  }
  const minX = Math.min(ann.x, ann.x + ann.width) - pad;
  const maxX = Math.max(ann.x, ann.x + ann.width) + pad;
  const minY = Math.min(ann.y, ann.y + ann.height) - pad;
  const maxY = Math.max(ann.y, ann.y + ann.height) + pad;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
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

  // Fine-grained drawing, shape, arrow & sticky options
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [drawMode, setDrawMode] = useState<'pen' | 'marker'>('pen');
  const [shapeFilled, setShapeFilled] = useState(false);
  const [lineStyle, setLineStyle] = useState<'solid' | 'dashed'>('solid');
  const [arrowStyle, setArrowStyle] = useState<'single' | 'double' | 'line'>('single');
  const [highlightOpacity, setHighlightOpacity] = useState(0.36);
  const [eraserRadius, setEraserRadius] = useState(14);
  const [eraserCursor, setEraserCursor] = useState<{ x: number; y: number } | null>(null);
  const [stampPreset, setStampPreset] = useState<string>('DATE');
  const [customStampText, setCustomStampText] = useState('');

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
    backgroundColor: '#FFFFFF',
    bold: false,
    italic: false,
    underline: false,
    align: 'left' as 'left' | 'center' | 'right',
    letterSpacing: 0,
  });
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const [addingBoxPos, setAddingBoxPos] = useState<{ x: number; y: number } | null>(null);
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
  const [newBoxDraft, setNewBoxDraft] = useState({
    text: '',
    fontSize: 14,
    fontFamily: 'sans' as 'sans' | 'serif' | 'mono',
    color: '#142B4A',
    backgroundColor: 'transparent',
    rotation: 0,
    bold: false,
    italic: false,
    underline: false,
    align: 'left' as 'left' | 'center' | 'right',
    letterSpacing: 0,
  });

  const [stickyPos, setStickyPos] = useState<{ x: number; y: number } | null>(null);
  const [editingStickyId, setEditingStickyId] = useState<string | null>(null);
  const [stickyText, setStickyText] = useState('');
  const [stickyArrow, setStickyArrow] = useState<StickyArrowSide>('top-left');
  const [stickyArrowLength, setStickyArrowLength] = useState(44);
  const [stickyBgColor, setStickyBgColor] = useState('#FEF3C7');
  const [stickyAccentColor, setStickyAccentColor] = useState('#D97706');
  const [stickyFontSize, setStickyFontSize] = useState(10);

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
    origTipX?: number;
    origTipY?: number;
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
  const [resizingAnnotation, setResizingAnnotation] = useState<{
    id: string;
    handle: 'nw' | 'ne' | 'sw' | 'se' | 'start' | 'end';
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const [draggingStickyTip, setDraggingStickyTip] = useState<{
    id: string;
  } | null>(null);

  const preGestureSnapshotRef = useRef<EditorStateSnapshot | null>(null);
  const pointerMovedRef = useRef(false);
  const erasingActiveRef = useRef(false);
  const erasedAnythingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Drawing interaction
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const liveFreehandRef = useRef<Array<{ x: number; y: number }>>([]);
  const [liveFreehand, setLiveFreehand] = useState<Array<{ x: number; y: number }>>([]);
  const [liveBox, setLiveBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const liveBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

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

  // CRITICAL: Only enable 1-finger/left-mouse drag-pan when Pan tool is selected.
  // Spacebar + Drag & Middle-mouse drag & 2-finger pinch still work in all tools!
  usePdfPinchZoom({
    rootRef: editorRootRef,
    scrollRef: canvasScrollRef,
    contentRef: scrollContentRef,
    scale,
    setScale,
    minScale: 0.4,
    maxScale: 3.0,
    dragPan: activeTool === 'pan' ? 'all' : false,
  });

  useEffect(() => {
    const onMultiTouchCap = (e: TouchEvent) => {
      if (e.touches.length >= 2 && (dragStartRef.current || erasingActiveRef.current)) {
        handleOverlayPointerCancel();
      }
    };
    document.addEventListener('touchstart', onMultiTouchCap, { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart', onMultiTouchCap, { capture: true });
    };
  }, []);

  // Keyboard arrow / PageUp / PageDown / Delete / Ctrl+Z navigation
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

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
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
    undoStack,
    redoStack,
    state,
  ]);

  const [renderScale, setRenderScale] = useState(scale);

  useEffect(() => {
    const id = setTimeout(() => setRenderScale(scale), 160);
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
      x: Math.max(0, Math.min(pageSize.width, (clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(pageSize.height, (clientY - rect.top) / scale)),
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
      backgroundColor: tb.backgroundColor || 'transparent',
      rotation: tb.rotation || 0,
      bold: tb.bold,
      italic: tb.italic,
      underline: tb.underline,
      align: tb.align,
      letterSpacing: tb.letterSpacing,
    });
  };

  const openEditStickyNote = (ann: AnnotationOverlay) => {
    const geo = computeStickyArrowGeometry(ann);
    setEditingStickyId(ann.id);
    setStickyPos({ x: ann.x, y: ann.y });
    setStickyText(ann.comment || '');
    setStickyArrow(ann.stickyArrow || 'top-left');
    setStickyArrowLength(geo.hasArrow ? Math.round(Math.max(16, Math.min(220, geo.length))) : 44);
    setStickyBgColor(ann.fillColor || '#FEF3C7');
    setStickyAccentColor(ann.color && ann.color !== '#FACC15' ? ann.color : '#D97706');
    setStickyFontSize(ann.fontSize || 10);
  };

  const isDragStrokeTool =
    activeTool === 'draw' ||
    activeTool === 'highlight' ||
    activeTool === 'underline' ||
    activeTool === 'strike' ||
    activeTool === 'rect' ||
    activeTool === 'circle' ||
    activeTool === 'arrow' ||
    activeTool === 'whiteout';

  const eraseAtPoint = (pt: { x: number; y: number }) => {
    setState((prev) => {
      const remaining = prev.annotations.filter(
        (an) => an.pageNumber !== pageNumber || !doesEraserHitAnnotation(an, pt.x, pt.y, eraserRadius)
      );
      if (remaining.length !== prev.annotations.length) {
        erasedAnythingRef.current = true;
        return { ...prev, annotations: remaining };
      }
      return prev;
    });
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== overlayRef.current) return;
    setSelectedElement(null);
    const pt = toUnscaledCoords(e.clientX, e.clientY);

    if (activeTool === 'addText') {
      setEditingBoxId(null);
      setAddingBoxPos(pt);
      setNewBoxDraft({
        text: '',
        fontSize: 14,
        fontFamily: 'sans',
        color: activeColor,
        backgroundColor: 'transparent',
        rotation: 0,
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
      setStickyArrow('top-left');
      setStickyArrowLength(44);
      setStickyBgColor('#FEF3C7');
      setStickyAccentColor('#D97706');
      setStickyFontSize(10);
      return;
    }

    if (activeTool === 'stamp') {
      const chosenLabel =
        stampPreset === 'CUSTOM'
          ? customStampText.trim() || 'CUSTOM'
          : stampPreset === 'DATE'
          ? new Date().toLocaleDateString()
          : stampPreset;
      const stampW = Math.max(96, chosenLabel.length * 7.2 + 22);
      const stampH = 28;
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: `ann_${Date.now()}`,
            pageNumber,
            kind: 'stamp',
            x: Math.max(4, Math.min(pageSize.width - stampW - 4, pt.x - stampW / 2)),
            y: Math.max(4, Math.min(pageSize.height - stampH - 4, pt.y - stampH / 2)),
            width: stampW,
            height: stampH,
            color: activeColor,
            dateStr: new Date().toLocaleDateString(),
            comment: chosenLabel,
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
            x: Math.max(4, Math.min(pageSize.width - 154, pt.x - 75)),
            y: Math.max(4, Math.min(pageSize.height - 68, pt.y - 32)),
            width: 150,
            height: 64,
            color: activeColor,
            signatureDataUrl: pendingSig.dataUrl,
            signerName: pendingSig.signerName,
            dateStr: pendingSig.dateStr,
          },
        ],
      }));
      setStatusMessage(language === 'bn' ? 'স্বাক্ষর যুক্ত হয়েছে' : 'Signature placed on page');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  };

  const handleOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) {
      // Multi-touch pinch started — abort active stroke cleanly
      handleOverlayPointerCancel();
      return;
    }

    if (activeTool === 'eraser') {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      preGestureSnapshotRef.current = state;
      erasingActiveRef.current = true;
      erasedAnythingRef.current = false;
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      setEraserCursor(pt);
      eraseAtPoint(pt);
      return;
    }

    if (!isDragStrokeTool) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedElement(null);
    const pt = toUnscaledCoords(e.clientX, e.clientY);

    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = pt;
    if (activeTool === 'draw') {
      const initialPts = [pt];
      liveFreehandRef.current = initialPts;
      setLiveFreehand(initialPts);
    } else {
      const initialBox = { x: pt.x, y: pt.y, w: 0, h: 0 };
      liveBoxRef.current = initialBox;
      setLiveBox(initialBox);
    }
  };

  const handleOverlayPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingStickyTip) {
      pointerMovedRef.current = true;
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      setState((prev) => ({
        ...prev,
        annotations: prev.annotations.map((an) =>
          an.id === draggingStickyTip.id
            ? {
                ...an,
                stickyTipX: Math.round(pt.x),
                stickyTipY: Math.round(pt.y),
                stickyArrow: an.stickyArrow === 'none' ? 'top-left' : an.stickyArrow,
              }
            : an
        ),
      }));
      return;
    }

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
        newW = Math.max(
          24,
          Math.min(
            pageSize.width - resizingImage.origX,
            resizingImage.origW + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * aspect)
          )
        );
      } else if (resizingImage.corner === 'ne') {
        newW = Math.max(
          24,
          Math.min(
            pageSize.width - resizingImage.origX,
            resizingImage.origW + (Math.abs(dx) >= Math.abs(dy) ? dx : -dy * aspect)
          )
        );
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

    if (resizingAnnotation) {
      pointerMovedRef.current = true;
      const dx = (e.clientX - resizingAnnotation.startClientX) / scale;
      const dy = (e.clientY - resizingAnnotation.startClientY) / scale;
      const { id, handle, origX, origY, origW, origH } = resizingAnnotation;

      setState((prev) => ({
        ...prev,
        annotations: prev.annotations.map((an) => {
          if (an.id !== id) return an;
          if (an.kind === 'arrow' || an.kind === 'underline' || an.kind === 'strikethrough') {
            if (handle === 'start') {
              const nextX = Math.max(0, Math.min(pageSize.width, origX + dx));
              const nextY = an.kind === 'arrow' ? Math.max(0, Math.min(pageSize.height, origY + dy)) : origY;
              return {
                ...an,
                x: nextX,
                y: nextY,
                width: origW - (nextX - origX),
                height: an.kind === 'arrow' ? origH - (nextY - origY) : origH,
              };
            }
            const nextEndX = Math.max(0, Math.min(pageSize.width, origX + origW + dx));
            const nextEndY = Math.max(0, Math.min(pageSize.height, origY + origH + dy));
            return {
              ...an,
              width: nextEndX - origX,
              height: an.kind === 'arrow' ? nextEndY - origY : origH,
            };
          }

          const minW = an.kind === 'sticky' ? 92 : 14;
          const minH = an.kind === 'sticky' ? 44 : 10;
          let nx = origX;
          let ny = origY;
          let nw = origW;
          let nh = origH;
          if (handle.includes('e')) {
            nw = Math.max(minW, Math.min(pageSize.width - origX, origW + dx));
          }
          if (handle.includes('s')) {
            nh = Math.max(minH, Math.min(pageSize.height - origY, origH + dy));
          }
          if (handle.includes('w')) {
            const clampedX = Math.max(0, Math.min(origX + origW - minW, origX + dx));
            nw = origW + (origX - clampedX);
            nx = clampedX;
          }
          if (handle.includes('n')) {
            const clampedY = Math.max(0, Math.min(origY + origH - minH, origY + dy));
            nh = origH + (origY - clampedY);
            ny = clampedY;
          }
          return { ...an, x: nx, y: ny, width: nw, height: nh };
        }),
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
      const actualDx = nx - draggingItem.origX;
      const actualDy = ny - draggingItem.origY;
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
            if (an.kind === 'sticky') {
              return {
                ...an,
                x: nx,
                y: ny,
                ...(draggingItem.origTipX !== undefined && draggingItem.origTipY !== undefined
                  ? {
                      stickyTipX: Math.max(4, Math.min(pageSize.width - 4, draggingItem.origTipX + actualDx)),
                      stickyTipY: Math.max(4, Math.min(pageSize.height - 4, draggingItem.origTipY + actualDy)),
                    }
                  : {}),
              };
            }
            return { ...an, x: nx, y: ny };
          }),
        };
      });
      return;
    }

    if (activeTool === 'eraser') {
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      setEraserCursor(pt);
      if (erasingActiveRef.current) {
        eraseAtPoint(pt);
      }
      return;
    }

    if (!dragStartRef.current) return;
    if (activeTool === 'draw') {
      const nativeEvt = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
      const coalesced = typeof nativeEvt.getCoalescedEvents === 'function' ? nativeEvt.getCoalescedEvents() : null;
      const events = coalesced && coalesced.length > 0 ? coalesced : [e.nativeEvent];
      const nextPts = [...liveFreehandRef.current];
      let added = false;
      for (const ev of events) {
        const pt = toUnscaledCoords(ev.clientX, ev.clientY);
        const last = nextPts[nextPts.length - 1];
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 1.5) {
          nextPts.push(pt);
          added = true;
        }
      }
      if (added) {
        liveFreehandRef.current = nextPts;
        setLiveFreehand(nextPts);
      }
    } else {
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      const sx = dragStartRef.current.x;
      const sy = dragStartRef.current.y;
      let box: { x: number; y: number; w: number; h: number };
      if (activeTool === 'arrow') {
        box = { x: sx, y: sy, w: pt.x - sx, h: pt.y - sy };
      } else if (activeTool === 'underline' || activeTool === 'strike') {
        box = {
          x: Math.min(sx, pt.x),
          y: Math.min(sy, pt.y),
          w: Math.abs(pt.x - sx),
          h: Math.max(2, Math.abs(pt.y - sy)),
        };
      } else {
        box = {
          x: Math.min(sx, pt.x),
          y: Math.min(sy, pt.y),
          w: Math.abs(pt.x - sx),
          h: Math.abs(pt.y - sy),
        };
      }
      liveBoxRef.current = box;
      setLiveBox(box);
    }
  };

  const handleOverlayPointerCancel = () => {
    setDraggingStickyTip(null);
    setResizingTextBox(null);
    setResizingImage(null);
    setResizingAnnotation(null);
    setDraggingItem(null);
    erasingActiveRef.current = false;
    erasedAnythingRef.current = false;
    setEraserCursor(null);
    preGestureSnapshotRef.current = null;
    dragStartRef.current = null;
    liveFreehandRef.current = [];
    liveBoxRef.current = null;
    setLiveFreehand([]);
    setLiveBox(null);
  };

  const handleOverlayPointerUp = () => {
    if (draggingStickyTip) {
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        setUndoStack((u) => [...u.slice(-24), preGestureSnapshotRef.current!]);
        setRedoStack([]);
      }
      preGestureSnapshotRef.current = null;
      setDraggingStickyTip(null);
      return;
    }
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
    if (resizingAnnotation) {
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        setUndoStack((u) => [...u.slice(-24), preGestureSnapshotRef.current!]);
        setRedoStack([]);
      }
      preGestureSnapshotRef.current = null;
      setResizingAnnotation(null);
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
    if (erasingActiveRef.current) {
      erasingActiveRef.current = false;
      if (erasedAnythingRef.current && preGestureSnapshotRef.current) {
        setUndoStack((u) => [...u.slice(-24), preGestureSnapshotRef.current!]);
        setRedoStack([]);
      }
      erasedAnythingRef.current = false;
      preGestureSnapshotRef.current = null;
      return;
    }

    if (!dragStartRef.current) return;
    const finalPts = liveFreehandRef.current;
    const finalBox = liveBoxRef.current;

    if (activeTool === 'draw' && finalPts.length >= 1) {
      const strokePts =
        finalPts.length === 1
          ? [finalPts[0], { x: finalPts[0].x + 0.5, y: finalPts[0].y + 0.5 }]
          : finalPts;
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
            strokeWidth,
            opacity: drawMode === 'marker' ? 0.42 : 1,
            points: strokePts,
          },
        ],
      }));
    } else if (finalBox && (Math.abs(finalBox.w) > 5 || Math.abs(finalBox.h) > 5)) {
      const kindMap: Record<string, AnnotationOverlay['kind']> = {
        highlight: 'highlight',
        underline: 'underline',
        strike: 'strikethrough',
        rect: 'rect',
        circle: 'circle',
        arrow: 'arrow',
        whiteout: 'whiteout',
      };
      const kind = kindMap[activeTool];
      if (kind) {
        const finalH =
          kind === 'highlight'
            ? Math.max(12, finalBox.h)
            : kind === 'underline' || kind === 'strikethrough'
            ? Math.max(2, finalBox.h)
            : kind === 'arrow'
            ? finalBox.h
            : Math.max(10, finalBox.h);
        commitState((prev) => ({
          ...prev,
          annotations: [
            ...prev.annotations,
            {
              id: `ann_${Date.now()}`,
              pageNumber,
              kind,
              x: finalBox.x,
              y: finalBox.y,
              width: kind === 'arrow' ? finalBox.w : Math.max(10, finalBox.w),
              height: finalH,
              color: kind === 'whiteout' ? '#FFFFFF' : activeColor,
              strokeWidth,
              opacity: kind === 'highlight' ? highlightOpacity : 1,
              lineStyle:
                kind === 'rect' || kind === 'circle' || kind === 'arrow' ? lineStyle : undefined,
              arrowStyle: kind === 'arrow' ? arrowStyle : undefined,
              fillColor:
                kind === 'whiteout'
                  ? '#FFFFFF'
                  : (kind === 'rect' || kind === 'circle') && shapeFilled
                  ? activeColor
                  : undefined,
            },
          ],
        }));
      }
    }
    dragStartRef.current = null;
    liveFreehandRef.current = [];
    liveBoxRef.current = null;
    setLiveFreehand([]);
    setLiveBox(null);
  };

  const sampleCanvasBgHex = (run: ExtractedTextRun): string => {
    const canvas = canvasRef.current;
    if (!canvas || !pageSize.width || !pageSize.height) return '#FFFFFF';
    const ctx = canvas.getContext('2d');
    if (!ctx) return '#FFFFFF';
    const sx = canvas.width / pageSize.width;
    const sy = canvas.height / pageSize.height;
    const x1 = Math.max(0, Math.min(canvas.width - 1, Math.round((run.x - 2) * sx)));
    const x2 = Math.max(0, Math.min(canvas.width - 1, Math.round((run.x + run.width + 2) * sx)));
    const y1 = Math.max(0, Math.min(canvas.height - 1, Math.round((run.y - 2) * sy)));
    const y2 = Math.max(0, Math.min(canvas.height - 1, Math.round((run.y + run.height + 2) * sy)));
    const pts: Array<[number, number]> = [
      [x1, y1],
      [x2, y1],
      [x1, y2],
      [x2, y2],
    ];
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let count = 0;
    for (const [px, py] of pts) {
      try {
        const d = ctx.getImageData(px, py, 1, 1).data;
        if (d[3] > 20) {
          rSum += d[0];
          gSum += d[1];
          bSum += d[2];
          count += 1;
        }
      } catch {
        // Ignore read error
      }
    }
    if (count === 0) return '#FFFFFF';
    const toHex = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${toHex(rSum / count)}${toHex(gSum / count)}${toHex(bSum / count)}`;
  };

  const handleOpenTextRunEditor = (run: ExtractedTextRun) => {
    const existing = state.replacements.find((r) => r.runId === run.id);
    setEditingRun(run);
    setRunDraft({
      text: existing ? existing.newText : run.str,
      fontSize: existing ? existing.fontSize : Math.round(run.fontSize),
      fontFamily: existing?.fontFamily || 'sans',
      color: existing?.color || '#1E293B',
      backgroundColor: existing?.backgroundColor || sampleCanvasBgHex(run),
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
            backgroundColor: runDraft.backgroundColor,
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
        setActiveTool('select');
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
        await saveBufferToDeviceStorage(
          editedBytes,
          doc.name.replace(/\.pdf$/i, '_edited.pdf'),
          'application/pdf'
        );
        setStatusMessage(language === 'bn' ? 'এক্সপোর্ট সম্পন্ন হয়েছে' : 'Exported modified PDF');
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

  const hasUnsavedChanges =
    state.replacements.length > 0 ||
    state.addedTexts.length > 0 ||
    state.addedImages.length > 0 ||
    state.annotations.length > 0;

  const handleRequestClose = () => {
    if (hasUnsavedChanges) {
      setShowExitConfirm(true);
    } else {
      onClose();
    }
  };

  const pageReplacements = state.replacements.filter((r) => r.pageNumber === pageNumber);
  const pageAddedTexts = state.addedTexts.filter((tb) => tb.pageNumber === pageNumber);
  const pageAddedImages = state.addedImages.filter((im) => im.pageNumber === pageNumber);
  const pageAnnotations = state.annotations.filter((an) => an.pageNumber === pageNumber);
  const pageErasableCount = pageAnnotations.filter(isErasableAnnotation).length;

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
    { id: 'select', label: t.editor.tools.select, icon: <MousePointer2 className="w-4 h-4" /> },
    { id: 'pan', label: t.editor.tools.pan, icon: <Hand className="w-4 h-4" /> },
    { id: 'editText', label: t.editor.tools.selectText, icon: <MousePointer className="w-4 h-4" /> },
    { id: 'addText', label: t.editor.tools.addText, icon: <TypeIcon className="w-4 h-4" /> },
    { id: 'draw', label: t.editor.tools.draw, icon: <Pen className="w-4 h-4" /> },
    { id: 'eraser', label: t.editor.tools.eraser, icon: <Eraser className="w-4 h-4" /> },
    { id: 'highlight', label: t.editor.tools.highlight, icon: <Highlighter className="w-4 h-4" /> },
    { id: 'underline', label: t.editor.tools.underline, icon: <Underline className="w-4 h-4" /> },
    { id: 'strike', label: t.editor.tools.strike, icon: <Strikethrough className="w-4 h-4" /> },
    { id: 'rect', label: t.editor.tools.rect, icon: <Square className="w-4 h-4" /> },
    { id: 'circle', label: t.editor.tools.circle, icon: <Circle className="w-4 h-4" /> },
    { id: 'arrow', label: t.editor.tools.arrow, icon: <ArrowUpRight className="w-4 h-4" /> },
    { id: 'whiteout', label: t.editor.tools.whiteout, icon: <Square className="w-4 h-4 fill-current" /> },
    { id: 'addImage', label: t.editor.tools.addImage, icon: <ImagePlus className="w-4 h-4" /> },
    { id: 'sticky', label: t.editor.tools.sticky, icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'signature', label: t.editor.tools.signature, icon: <PenTool className="w-4 h-4" /> },
    { id: 'stamp', label: t.editor.tools.stamp, icon: <Calendar className="w-4 h-4" /> },
  ];

  // Existing elements ignore pointers while drawing/stroking/erasing so you can draw smoothly over anything
  const lockExistingElements = isDragStrokeTool || activeTool === 'eraser';

  const showContextualSubBar =
    activeTool === 'draw' ||
    activeTool === 'eraser' ||
    activeTool === 'rect' ||
    activeTool === 'circle' ||
    activeTool === 'arrow' ||
    activeTool === 'highlight' ||
    activeTool === 'underline' ||
    activeTool === 'strike' ||
    activeTool === 'stamp' ||
    activeTool === 'signature';

  const duplicateSelectedElement = () => {
    if (!selectedElement) return;
    if (selectedElement.kind === 'image' && selectedImg) {
      const newId = `img_${Date.now()}`;
      commitState((prev) => ({
        ...prev,
        addedImages: [
          ...prev.addedImages,
          { ...selectedImg, id: newId, x: Math.min(pageSize.width - 40, selectedImg.x + 18), y: Math.min(pageSize.height - 40, selectedImg.y + 18) },
        ],
      }));
      setSelectedElement({ kind: 'image', id: newId });
    } else if (selectedElement.kind === 'textBox' && selectedTextBox) {
      const newId = `tb_${Date.now()}`;
      commitState((prev) => ({
        ...prev,
        addedTexts: [
          ...prev.addedTexts,
          { ...selectedTextBox, id: newId, x: Math.min(pageSize.width - 40, selectedTextBox.x + 18), y: Math.min(pageSize.height - 40, selectedTextBox.y + 18) },
        ],
      }));
      setSelectedElement({ kind: 'textBox', id: newId });
    } else if (selectedElement.kind === 'annotation' && selectedAnn) {
      const newId = `ann_${Date.now()}`;
      const cloned: AnnotationOverlay = {
        ...selectedAnn,
        id: newId,
        x: Math.min(pageSize.width - 30, selectedAnn.x + 18),
        y: Math.min(pageSize.height - 30, selectedAnn.y + 18),
        points: selectedAnn.points?.map((p) => ({ x: p.x + 18, y: p.y + 18 })),
        stickyTipX: selectedAnn.stickyTipX !== undefined ? Math.min(pageSize.width - 8, selectedAnn.stickyTipX + 18) : undefined,
        stickyTipY: selectedAnn.stickyTipY !== undefined ? Math.min(pageSize.height - 8, selectedAnn.stickyTipY + 18) : undefined,
      };
      commitState((prev) => ({ ...prev, annotations: [...prev.annotations, cloned] }));
      setSelectedElement({ kind: 'annotation', id: newId });
    }
  };

  const bringSelectedToFront = () => {
    if (!selectedElement) return;
    commitState((prev) => {
      if (selectedElement.kind === 'image') {
        const target = prev.addedImages.find((im) => im.id === selectedElement.id);
        if (!target) return prev;
        return { ...prev, addedImages: [...prev.addedImages.filter((im) => im.id !== target.id), target] };
      }
      if (selectedElement.kind === 'textBox') {
        const target = prev.addedTexts.find((tb) => tb.id === selectedElement.id);
        if (!target) return prev;
        return { ...prev, addedTexts: [...prev.addedTexts.filter((tb) => tb.id !== target.id), target] };
      }
      const target = prev.annotations.find((an) => an.id === selectedElement.id);
      if (!target) return prev;
      return { ...prev, annotations: [...prev.annotations.filter((an) => an.id !== target.id), target] };
    });
  };

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
            onClick={handleRequestClose}
            aria-label="Back"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-[#142B4A] dark:text-white truncate">
              {t.editor.title}
            </h1>
            <p className="text-[11px] font-mono-nums text-slate-500">
              {t.viewer.page} {pageNumber}/{doc.pageCount}
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
            <span>{saving ? t.editor.saving : t.editor.save}</span>
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
                <span className="font-semibold text-cyan-300 pr-1 whitespace-nowrap">
                  {language === 'bn' ? 'ছবি' : 'Image'}
                </span>
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
                  + {language === 'bn' ? 'বড়' : 'Size'}
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
                  - {language === 'bn' ? 'ছোট' : 'Size'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCropInsets({ top: 0, right: 0, bottom: 0, left: 0 });
                    setCropModalImg(selectedImg);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Crop className="w-3.5 h-3.5" /> {language === 'bn' ? 'ক্রপ' : 'Crop'}
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
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={bringSelectedToFront}
                  title={t.editor.bringFront}
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Layers className="w-3.5 h-3.5" />
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
                <span className="font-semibold text-cyan-300 pr-1 whitespace-nowrap">
                  {language === 'bn' ? 'টেক্সট' : 'Text'}
                </span>
                <button
                  type="button"
                  onClick={() => openEditAddedTextBox(selectedTextBox)}
                  className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap"
                >
                  <Pencil className="w-3 h-3" /> {language === 'bn' ? 'এডিট' : 'Edit'}
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
                  className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
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
                  className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                >
                  A-
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === selectedTextBox.id ? { ...tb, rotation: ((tb.rotation || 0) + 90) % 360 } : tb
                      ),
                    }))
                  }
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <RotateCw className="w-3 h-3" /> 90°
                </button>
                <button
                  type="button"
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={bringSelectedToFront}
                  title={t.editor.bringFront}
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Layers className="w-3.5 h-3.5" />
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
                  <>
                    <button
                      type="button"
                      onClick={() => openEditStickyNote(selectedAnn)}
                      className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap"
                    >
                      <Pencil className="w-3 h-3" /> {language === 'bn' ? 'এডিট' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id
                              ? { ...an, fontSize: Math.min(22, (an.fontSize || 10) + 1.5) }
                              : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      A+
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id
                              ? { ...an, fontSize: Math.max(7, (an.fontSize || 10) - 1.5) }
                              : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      A-
                    </button>
                  </>
                )}
                {selectedAnn.kind === 'stamp' && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) => {
                            if (an.id !== selectedAnn.id) return an;
                            const nextFs = Math.min(24, (an.fontSize || 10) + 2);
                            const scaleF = nextFs / (an.fontSize || 10);
                            return {
                              ...an,
                              fontSize: nextFs,
                              width: Math.round((an.width || 96) * scaleF),
                              height: Math.round((an.height || 28) * scaleF),
                            };
                          }),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      A+
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) => {
                            if (an.id !== selectedAnn.id) return an;
                            const nextFs = Math.max(8, (an.fontSize || 10) - 2);
                            const scaleF = nextFs / (an.fontSize || 10);
                            return {
                              ...an,
                              fontSize: nextFs,
                              width: Math.max(72, Math.round((an.width || 96) * scaleF)),
                              height: Math.max(22, Math.round((an.height || 28) * scaleF)),
                            };
                          }),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      A-
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id ? { ...an, rotation: ((an.rotation || 0) + 90) % 360 } : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                    >
                      <RotateCw className="w-3 h-3" /> 90°
                    </button>
                  </>
                )}
                {selectedAnn.kind === 'arrow' && (
                  <button
                    type="button"
                    onClick={() =>
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.map((an) => {
                          if (an.id !== selectedAnn.id) return an;
                          const order: Array<'single' | 'double' | 'line'> = ['single', 'double', 'line'];
                          const cur = an.arrowStyle || 'single';
                          return { ...an, arrowStyle: order[(order.indexOf(cur) + 1) % order.length] };
                        }),
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                  >
                    {(selectedAnn.arrowStyle || 'single') === 'double'
                      ? t.editor.arrowDouble
                      : (selectedAnn.arrowStyle || 'single') === 'line'
                      ? t.editor.arrowLine
                      : t.editor.arrowSingle}
                  </button>
                )}
                {(selectedAnn.kind === 'rect' || selectedAnn.kind === 'circle' || selectedAnn.kind === 'arrow') && (
                  <button
                    type="button"
                    onClick={() =>
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.map((an) =>
                          an.id === selectedAnn.id
                            ? { ...an, lineStyle: an.lineStyle === 'dashed' ? 'solid' : 'dashed' }
                            : an
                        ),
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                  >
                    {selectedAnn.lineStyle === 'dashed' ? t.editor.dashed : t.editor.solid}
                  </button>
                )}
                {(selectedAnn.kind === 'rect' || selectedAnn.kind === 'circle') && (
                  <button
                    type="button"
                    onClick={() =>
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.map((an) =>
                          an.id === selectedAnn.id
                            ? { ...an, fillColor: an.fillColor ? undefined : an.color }
                            : an
                        ),
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                  >
                    <PaintBucket className="w-3 h-3" /> {t.editor.fillShape}
                  </button>
                )}
                {(selectedAnn.kind === 'freehand' ||
                  selectedAnn.kind === 'rect' ||
                  selectedAnn.kind === 'circle' ||
                  selectedAnn.kind === 'arrow' ||
                  selectedAnn.kind === 'underline' ||
                  selectedAnn.kind === 'strikethrough') && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id
                              ? { ...an, strokeWidth: Math.min(18, (an.strokeWidth || 2.5) + 1.5) }
                              : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      + px
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id
                              ? { ...an, strokeWidth: Math.max(1, (an.strokeWidth || 2.5) - 1.5) }
                              : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white/15 whitespace-nowrap"
                    >
                      - px
                    </button>
                  </>
                )}
                {selectedAnn.kind !== 'whiteout' && selectedAnn.kind !== 'signature' && (
                  <button
                    type="button"
                    onClick={() =>
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.map((an) =>
                          an.id === selectedAnn.id
                            ? {
                                ...an,
                                color: activeColor,
                                fillColor:
                                  an.kind === 'sticky'
                                    ? an.fillColor
                                    : an.fillColor
                                    ? activeColor
                                    : undefined,
                              }
                            : an
                        ),
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                  >
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: activeColor }} />
                    {language === 'bn' ? 'রঙ' : 'Color'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={bringSelectedToFront}
                  title={t.editor.bringFront}
                  className="px-2 py-1 rounded-lg bg-white/15 flex items-center gap-1 whitespace-nowrap"
                >
                  <Layers className="w-3.5 h-3.5" />
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
          <div
            ref={scrollContentRef}
            className="min-w-full min-h-full w-fit p-3 sm:p-6 flex items-start justify-center"
          >
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
                onPointerLeave={() => {
                  if (activeTool === 'eraser' && !erasingActiveRef.current) setEraserCursor(null);
                }}
                style={{
                  touchAction:
                    activeTool === 'pan' || isDragStrokeTool || activeTool === 'eraser'
                      ? 'none'
                      : 'pan-x pan-y',
                  pointerEvents: activeTool === 'pan' ? 'none' : 'auto',
                  cursor:
                    isDragStrokeTool || activeTool === 'eraser'
                      ? 'crosshair'
                      : activeTool === 'addText' || activeTool === 'sticky' || activeTool === 'stamp' || activeTool === 'signature'
                      ? 'copy'
                      : 'default',
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
                        backgroundColor: rep.backgroundColor || '#FFFFFF',
                        pointerEvents: lockExistingElements ? 'none' : 'auto',
                      }}
                      className="absolute text-left rounded border border-[#2563EB]/80 z-10"
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

                {/* Untouched native PDF text runs (visible dotted guides on mobile when editText is active) */}
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
                        className="absolute text-left rounded transition-colors bg-[#2563EB]/[0.03] hover:bg-[#2563EB]/15 border border-dashed border-[#2563EB]/25 hover:border-[#2563EB]/70"
                      />
                    ))}

                {/* Added text boxes */}
                {pageAddedTexts.map((tb) => {
                  const isSelected = selectedElement?.kind === 'textBox' && selectedElement.id === tb.id;
                  const bgStyle =
                    tb.backgroundColor && tb.backgroundColor !== 'transparent'
                      ? tb.backgroundColor
                      : 'rgba(255,255,255,0.22)';
                  return (
                    <div
                      key={tb.id}
                      onPointerDown={(e) => {
                        if (lockExistingElements) return;
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
                        backgroundColor: bgStyle,
                        transform: tb.rotation ? `rotate(${tb.rotation}deg)` : undefined,
                        transformOrigin: 'center center',
                        fontWeight: tb.bold ? 700 : 400,
                        fontStyle: tb.italic ? 'italic' : 'normal',
                        textDecoration: tb.underline ? 'underline' : 'none',
                        textAlign: tb.align,
                        letterSpacing: `${tb.letterSpacing * scale}px`,
                        touchAction: 'none',
                        pointerEvents: lockExistingElements ? 'none' : 'auto',
                      }}
                      title="Drag to move · Tap to edit text"
                      className={`group absolute px-1.5 py-0.5 rounded whitespace-pre-wrap cursor-move z-10 ${
                        isSelected
                          ? 'border-2 border-[#2563EB] ring-2 ring-[#2563EB]/30'
                          : 'border border-dashed border-[#2563EB]/70'
                      }`}
                    >
                      {tb.text}
                      {!lockExistingElements && (
                        <>
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
                        </>
                      )}
                    </div>
                  );
                })}

                {/* Added images */}
                {pageAddedImages.map((im) => {
                  const isSelected = selectedImageId === im.id;
                  return (
                    <div
                      key={im.id}
                      onPointerDown={(e) => {
                        if (lockExistingElements) return;
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
                        pointerEvents: lockExistingElements ? 'none' : 'auto',
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

                      {!lockExistingElements && (
                        <>
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
                        </>
                      )}
                    </div>
                  );
                })}

                {/* Vector SVG layer (committed + live preview) */}
                <svg
                  className="pointer-events-none absolute inset-0 w-full h-full"
                  viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
                >
                  {pageAnnotations.map((ann) => {
                    const isSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
                    const sw = ann.strokeWidth || 2.5;
                    const op = ann.opacity ?? 1;

                    if (ann.kind === 'highlight') {
                      return (
                        <rect
                          key={ann.id}
                          x={ann.x}
                          y={ann.y}
                          width={ann.width}
                          height={ann.height}
                          fill={ann.color}
                          fillOpacity={ann.opacity ?? 0.36}
                          stroke={isSel ? '#2563EB' : undefined}
                          strokeWidth={isSel ? 1.5 : undefined}
                          strokeDasharray={isSel ? '4 2' : undefined}
                        />
                      );
                    }
                    if (ann.kind === 'whiteout') {
                      return (
                        <rect
                          key={ann.id}
                          x={ann.x}
                          y={ann.y}
                          width={ann.width}
                          height={ann.height}
                          fill={ann.fillColor || ann.color || '#FFFFFF'}
                          stroke={isSel ? '#2563EB' : '#CBD5E1'}
                          strokeWidth={isSel ? 1.5 : 0.5}
                          strokeDasharray={isSel ? '4 2' : '2 2'}
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
                          strokeWidth={sw + (isSel ? 1.5 : 0)}
                          strokeLinecap="round"
                          strokeOpacity={op}
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
                          strokeWidth={sw + (isSel ? 1.5 : 0)}
                          strokeLinecap="round"
                          strokeOpacity={op}
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
                          fill={ann.fillColor || 'none'}
                          fillOpacity={ann.fillColor ? 0.18 : 0}
                          stroke={ann.color}
                          strokeWidth={sw + (isSel ? 1.5 : 0)}
                          strokeDasharray={ann.lineStyle === 'dashed' ? '6 4' : undefined}
                          strokeOpacity={op}
                        />
                      );
                    }
                    if (ann.kind === 'circle') {
                      return (
                        <ellipse
                          key={ann.id}
                          cx={ann.x + ann.width / 2}
                          cy={ann.y + ann.height / 2}
                          rx={Math.max(1, ann.width / 2)}
                          ry={Math.max(1, ann.height / 2)}
                          fill={ann.fillColor || 'none'}
                          fillOpacity={ann.fillColor ? 0.18 : 0}
                          stroke={ann.color}
                          strokeWidth={sw + (isSel ? 1.5 : 0)}
                          strokeDasharray={ann.lineStyle === 'dashed' ? '6 4' : undefined}
                          strokeOpacity={op}
                        />
                      );
                    }
                    if (ann.kind === 'arrow') {
                      const sx = ann.x;
                      const sy = ann.y;
                      const ex = ann.x + ann.width;
                      const ey = ann.y + ann.height;
                      const ang = Math.atan2(ey - sy, ex - sx);
                      const headLen = Math.max(9, sw * 3.4);
                      const aStyle = ann.arrowStyle || 'single';
                      const revAng = ang + Math.PI;
                      return (
                        <g key={ann.id} strokeOpacity={op}>
                          <line
                            x1={sx}
                            y1={sy}
                            x2={ex}
                            y2={ey}
                            stroke={ann.color}
                            strokeWidth={sw + (isSel ? 1.5 : 0)}
                            strokeDasharray={ann.lineStyle === 'dashed' ? '6 4' : undefined}
                            strokeLinecap="round"
                          />
                          {aStyle !== 'line' && (
                            <path
                              d={`M ${ex - headLen * Math.cos(ang - Math.PI / 6)} ${ey - headLen * Math.sin(ang - Math.PI / 6)} L ${ex} ${ey} L ${ex - headLen * Math.cos(ang + Math.PI / 6)} ${ey - headLen * Math.sin(ang + Math.PI / 6)}`}
                              fill="none"
                              stroke={ann.color}
                              strokeWidth={sw + (isSel ? 1.5 : 0)}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                          {aStyle === 'double' && (
                            <path
                              d={`M ${sx - headLen * Math.cos(revAng - Math.PI / 6)} ${sy - headLen * Math.sin(revAng - Math.PI / 6)} L ${sx} ${sy} L ${sx - headLen * Math.cos(revAng + Math.PI / 6)} ${sy - headLen * Math.sin(revAng + Math.PI / 6)}`}
                              fill="none"
                              stroke={ann.color}
                              strokeWidth={sw + (isSel ? 1.5 : 0)}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                        </g>
                      );
                    }
                    if (ann.kind === 'sticky') {
                      const geo = computeStickyArrowGeometry(ann);
                      if (!geo.hasArrow) return null;
                      const accent = ann.color && ann.color !== '#FACC15' ? ann.color : '#D97706';
                      const ang = Math.atan2(geo.tipY - geo.startY, geo.tipX - geo.startX);
                      const headLen = Math.max(8, Math.min(13, (ann.strokeWidth || 2.2) * 3.8));
                      return (
                        <g key={`sarrow_${ann.id}`}>
                          <line
                            x1={geo.startX}
                            y1={geo.startY}
                            x2={geo.tipX}
                            y2={geo.tipY}
                            stroke={accent}
                            strokeWidth={ann.strokeWidth || 2.2}
                            strokeLinecap="round"
                          />
                          <path
                            d={`M ${geo.tipX - headLen * Math.cos(ang - Math.PI / 6)} ${geo.tipY - headLen * Math.sin(ang - Math.PI / 6)} L ${geo.tipX} ${geo.tipY} L ${geo.tipX - headLen * Math.cos(ang + Math.PI / 6)} ${geo.tipY - headLen * Math.sin(ang + Math.PI / 6)}`}
                            fill="none"
                            stroke={accent}
                            strokeWidth={ann.strokeWidth || 2.2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </g>
                      );
                    }
                    if (ann.kind === 'freehand' && ann.points && ann.points.length > 0) {
                      return (
                        <path
                          key={ann.id}
                          d={buildSmoothSvgPath(ann.points)}
                          fill="none"
                          stroke={ann.color}
                          strokeWidth={sw + (isSel ? 1.5 : 0)}
                          strokeOpacity={op}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      );
                    }
                    return null;
                  })}

                  {/* Live smooth freehand stroke */}
                  {liveFreehand.length >= 1 && (
                    <path
                      d={buildSmoothSvgPath(liveFreehand)}
                      fill="none"
                      stroke={activeColor}
                      strokeWidth={strokeWidth}
                      strokeOpacity={drawMode === 'marker' ? 0.42 : 1}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}

                  {/* Accurate live preview for every drag tool */}
                  {liveBox && activeTool === 'arrow' && (
                    <g>
                      <line
                        x1={liveBox.x}
                        y1={liveBox.y}
                        x2={liveBox.x + liveBox.w}
                        y2={liveBox.y + liveBox.h}
                        stroke={activeColor}
                        strokeWidth={strokeWidth}
                        strokeDasharray={lineStyle === 'dashed' ? '6 4' : undefined}
                        strokeLinecap="round"
                      />
                      {Math.hypot(liveBox.w, liveBox.h) > 6 && (() => {
                        const sx = liveBox.x;
                        const sy = liveBox.y;
                        const ex = liveBox.x + liveBox.w;
                        const ey = liveBox.y + liveBox.h;
                        const ang = Math.atan2(liveBox.h, liveBox.w);
                        const revAng = ang + Math.PI;
                        const hl = Math.max(9, strokeWidth * 3.4);
                        return (
                          <>
                            {arrowStyle !== 'line' && (
                              <path
                                d={`M ${ex - hl * Math.cos(ang - Math.PI / 6)} ${ey - hl * Math.sin(ang - Math.PI / 6)} L ${ex} ${ey} L ${ex - hl * Math.cos(ang + Math.PI / 6)} ${ey - hl * Math.sin(ang + Math.PI / 6)}`}
                                fill="none"
                                stroke={activeColor}
                                strokeWidth={strokeWidth}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            )}
                            {arrowStyle === 'double' && (
                              <path
                                d={`M ${sx - hl * Math.cos(revAng - Math.PI / 6)} ${sy - hl * Math.sin(revAng - Math.PI / 6)} L ${sx} ${sy} L ${sx - hl * Math.cos(revAng + Math.PI / 6)} ${sy - hl * Math.sin(revAng + Math.PI / 6)}`}
                                fill="none"
                                stroke={activeColor}
                                strokeWidth={strokeWidth}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            )}
                          </>
                        );
                      })()}
                    </g>
                  )}

                  {liveBox && activeTool === 'highlight' && (
                    <rect
                      x={liveBox.x}
                      y={liveBox.y}
                      width={Math.abs(liveBox.w)}
                      height={Math.max(12, Math.abs(liveBox.h))}
                      fill={activeColor}
                      fillOpacity={highlightOpacity}
                      stroke={activeColor}
                      strokeWidth={1}
                      strokeDasharray="3 2"
                    />
                  )}

                  {liveBox && activeTool === 'whiteout' && (
                    <rect
                      x={liveBox.x}
                      y={liveBox.y}
                      width={Math.abs(liveBox.w)}
                      height={Math.max(10, Math.abs(liveBox.h))}
                      fill="#FFFFFF"
                      stroke="#94A3B8"
                      strokeWidth={1}
                      strokeDasharray="3 2"
                    />
                  )}

                  {liveBox && activeTool === 'underline' && (
                    <line
                      x1={liveBox.x}
                      y1={liveBox.y + liveBox.h}
                      x2={liveBox.x + liveBox.w}
                      y2={liveBox.y + liveBox.h}
                      stroke={activeColor}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                    />
                  )}

                  {liveBox && activeTool === 'strike' && (
                    <line
                      x1={liveBox.x}
                      y1={liveBox.y + liveBox.h / 2}
                      x2={liveBox.x + liveBox.w}
                      y2={liveBox.y + liveBox.h / 2}
                      stroke={activeColor}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                    />
                  )}

                  {liveBox && activeTool === 'circle' && (
                    <ellipse
                      cx={liveBox.x + Math.abs(liveBox.w) / 2}
                      cy={liveBox.y + Math.abs(liveBox.h) / 2}
                      rx={Math.max(1, Math.abs(liveBox.w) / 2)}
                      ry={Math.max(1, Math.abs(liveBox.h) / 2)}
                      fill={shapeFilled ? activeColor : 'none'}
                      fillOpacity={shapeFilled ? 0.18 : 0}
                      stroke={activeColor}
                      strokeWidth={strokeWidth}
                      strokeDasharray={lineStyle === 'dashed' ? '6 4' : undefined}
                    />
                  )}

                  {liveBox && activeTool === 'rect' && (
                    <rect
                      x={liveBox.x}
                      y={liveBox.y}
                      width={Math.abs(liveBox.w)}
                      height={Math.abs(liveBox.h)}
                      fill={shapeFilled ? activeColor : 'none'}
                      fillOpacity={shapeFilled ? 0.18 : 0}
                      stroke={activeColor}
                      strokeWidth={strokeWidth}
                      strokeDasharray={lineStyle === 'dashed' ? '6 4' : undefined}
                    />
                  )}

                  {/* Eraser cursor circle */}
                  {activeTool === 'eraser' && eraserCursor && (
                    <circle
                      cx={eraserCursor.x}
                      cy={eraserCursor.y}
                      r={eraserRadius}
                      fill="rgba(244,63,94,0.12)"
                      stroke="#E11D48"
                      strokeWidth={1.2}
                      strokeDasharray="3 2"
                    />
                  )}
                </svg>

                {/* Live Angle & Length Readout Badge when drawing or adjusting an arrow / sticky arrow */}
                {(liveBox && activeTool === 'arrow' && Math.hypot(liveBox.w, liveBox.h) > 6) && (
                  <div
                    style={{
                      left: Math.min(pageSize.width - 95, Math.max(8, (liveBox.x + liveBox.w))) * scale,
                      top: Math.max(6, (liveBox.y + liveBox.h) * scale - 28),
                    }}
                    className="pointer-events-none absolute z-30 px-2 py-0.5 rounded-full bg-slate-900/90 text-white font-mono-nums text-[10px] shadow"
                  >
                    {Math.round((Math.atan2(liveBox.h, liveBox.w) * 180) / Math.PI)}° · {Math.round(Math.hypot(liveBox.w, liveBox.h))}pt
                  </div>
                )}

                {/* Interactive hitboxes for drawn vector annotations + 4-corner/endpoint resize handles */}
                {!lockExistingElements &&
                  activeTool !== 'pan' &&
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
                      const isBoxResizable =
                        ann.kind === 'rect' ||
                        ann.kind === 'circle' ||
                        ann.kind === 'highlight' ||
                        ann.kind === 'whiteout';
                      const isLineResizable =
                        ann.kind === 'arrow' || ann.kind === 'underline' || ann.kind === 'strikethrough';

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
                            isSel ? 'ring-2 ring-[#2563EB] rounded bg-[#2563EB]/5 z-20' : ''
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
                              className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md z-30"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {/* 4-Corner resize handles for boxes/highlights/whiteout */}
                          {isSel &&
                            isBoxResizable &&
                            (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                              const posClass =
                                corner === 'nw'
                                  ? '-top-2.5 -left-2.5 cursor-nwse-resize'
                                  : corner === 'ne'
                                  ? '-top-2.5 -right-2.5 cursor-nesw-resize'
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
                                    overlayRef.current?.setPointerCapture?.(e.pointerId);
                                    setResizingAnnotation({
                                      id: ann.id,
                                      handle: corner,
                                      startClientX: e.clientX,
                                      startClientY: e.clientY,
                                      origX: ann.x,
                                      origY: ann.y,
                                      origW: ann.width,
                                      origH: ann.height,
                                    });
                                  }}
                                  title="Drag to resize"
                                  className={`absolute ${posClass} w-5 h-5 rounded-full bg-white border-2 border-[#2563EB] shadow-md z-30`}
                                />
                              );
                            })}

                          {/* Endpoint resize handles for arrow / underline / strike */}
                          {isSel && isLineResizable && (
                            <>
                              <div
                                style={{
                                  touchAction: 'none',
                                  left:
                                    ann.kind === 'arrow'
                                      ? (ann.x - bx) * scale - 9
                                      : -9,
                                  top:
                                    ann.kind === 'arrow'
                                      ? (ann.y - by) * scale - 9
                                      : (bh * scale) / 2 - 9,
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  preGestureSnapshotRef.current = state;
                                  overlayRef.current?.setPointerCapture?.(e.pointerId);
                                  setResizingAnnotation({
                                    id: ann.id,
                                    handle: 'start',
                                    startClientX: e.clientX,
                                    startClientY: e.clientY,
                                    origX: ann.x,
                                    origY: ann.y,
                                    origW: ann.width,
                                    origH: ann.height,
                                  });
                                }}
                                className="absolute w-4.5 h-4.5 rounded-full bg-white border-2 border-[#2563EB] shadow cursor-grab z-30"
                              />
                              <div
                                style={{
                                  touchAction: 'none',
                                  left:
                                    ann.kind === 'arrow'
                                      ? (ann.x + ann.width - bx) * scale - 9
                                      : bw * scale - 9,
                                  top:
                                    ann.kind === 'arrow'
                                      ? (ann.y + ann.height - by) * scale - 9
                                      : (bh * scale) / 2 - 9,
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  preGestureSnapshotRef.current = state;
                                  overlayRef.current?.setPointerCapture?.(e.pointerId);
                                  setResizingAnnotation({
                                    id: ann.id,
                                    handle: 'end',
                                    startClientX: e.clientX,
                                    startClientY: e.clientY,
                                    origX: ann.x,
                                    origY: ann.y,
                                    origW: ann.width,
                                    origH: ann.height,
                                  });
                                }}
                                className="absolute w-4.5 h-4.5 rounded-full bg-white border-2 border-[#2563EB] shadow cursor-grab z-30"
                              />
                              {ann.kind === 'arrow' && (
                                <div className="pointer-events-none -bottom-6 left-1/2 -translate-x-1/2 absolute px-1.5 py-0.5 rounded bg-slate-900/85 text-white font-mono-nums text-[9px] whitespace-nowrap">
                                  {Math.round((Math.atan2(ann.height, ann.width) * 180) / Math.PI)}° · {Math.round(Math.hypot(ann.width, ann.height))}pt
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}

                {/* Sticky notes, stamps, signatures */}
                {pageAnnotations
                  .filter((a) => a.kind === 'sticky' || a.kind === 'stamp' || a.kind === 'signature')
                  .map((ann) => {
                    const isSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
                    const startDrag = (e: React.PointerEvent) => {
                      if (lockExistingElements) return;
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
                        origTipX: ann.stickyTipX,
                        origTipY: ann.stickyTipY,
                      });
                    };
                    const removeBtn = !lockExistingElements && (
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
                        className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md z-20"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    );

                    if (ann.kind === 'sticky') {
                      const boxW = Math.max(84, ann.width || 165);
                      const boxH = Math.max(44, ann.height || 76);
                      const noteBg = ann.fillColor || '#FEF3C7';
                      const noteAccent = ann.color && ann.color !== '#FACC15' ? ann.color : '#D97706';
                      const fontSize = Math.max(7, Math.min(24, ann.fontSize || 10));
                      const geo = computeStickyArrowGeometry(ann);
                      return (
                        <React.Fragment key={ann.id}>
                          <div
                            onPointerDown={startDrag}
                            style={{
                              left: ann.x * scale,
                              top: ann.y * scale,
                              width: boxW * scale,
                              height: boxH * scale,
                              backgroundColor: noteBg,
                              borderColor: isSel ? '#2563EB' : noteAccent,
                              fontSize: fontSize * scale,
                              touchAction: 'none',
                              pointerEvents: lockExistingElements ? 'none' : 'auto',
                            }}
                            title="Drag to move · Tap to edit note · Pull corners to resize"
                            className={`absolute p-2 rounded-lg border-2 text-slate-900 shadow-md cursor-move z-10 overflow-visible ${
                              isSel ? 'ring-2 ring-[#2563EB]/30 z-20' : ''
                            }`}
                          >
                            <div className="w-full h-full overflow-hidden leading-snug break-words whitespace-pre-wrap">
                              {ann.comment}
                            </div>

                            {isSel &&
                              !lockExistingElements &&
                              (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                                const posClass =
                                  corner === 'nw'
                                    ? '-top-2 -left-2 cursor-nwse-resize'
                                    : corner === 'ne'
                                    ? '-top-2 -right-2 cursor-nesw-resize'
                                    : corner === 'sw'
                                    ? '-bottom-2 -left-2 cursor-nesw-resize'
                                    : '-bottom-2 -right-2 cursor-nwse-resize';
                                return (
                                  <div
                                    key={corner}
                                    style={{ touchAction: 'none' }}
                                    onPointerDown={(e) => {
                                      e.stopPropagation();
                                      pointerMovedRef.current = false;
                                      preGestureSnapshotRef.current = state;
                                      overlayRef.current?.setPointerCapture?.(e.pointerId);
                                      setResizingAnnotation({
                                        id: ann.id,
                                        handle: corner,
                                        startClientX: e.clientX,
                                        startClientY: e.clientY,
                                        origX: ann.x,
                                        origY: ann.y,
                                        origW: boxW,
                                        origH: boxH,
                                      });
                                    }}
                                    title="Drag corner to resize sticky note"
                                    className={`absolute ${posClass} w-4.5 h-4.5 rounded-full bg-white border-2 border-[#2563EB] shadow-md z-30`}
                                  />
                                );
                              })}
                            {isSel && removeBtn}
                          </div>

                          {/* Draggable Free-Angle & Any-Length Callout Arrow Tip Handle */}
                          {isSel && !lockExistingElements && geo.hasArrow && (
                            <div
                              style={{
                                touchAction: 'none',
                                left: geo.tipX * scale - 10,
                                top: geo.tipY * scale - 10,
                                borderColor: noteAccent,
                              }}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                pointerMovedRef.current = false;
                                preGestureSnapshotRef.current = state;
                                overlayRef.current?.setPointerCapture?.(e.pointerId);
                                setDraggingStickyTip({ id: ann.id });
                              }}
                              title={t.editor.dragTipHint}
                              className="absolute w-5 h-5 rounded-full bg-white border-[2.5px] shadow-lg cursor-crosshair z-30 flex items-center justify-center"
                            >
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: noteAccent }}
                              />
                              {draggingStickyTip?.id === ann.id && (
                                <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-slate-900/90 text-white font-mono-nums text-[9px] whitespace-nowrap shadow">
                                  {geo.angleDeg}° · {Math.round(geo.length)}pt
                                </span>
                              )}
                            </div>
                          )}
                        </React.Fragment>
                      );
                    }
                    if (ann.kind === 'stamp') {
                      const label = ann.comment || ann.dateStr || '';
                      const stampFont = Math.max(8, Math.min(26, ann.fontSize || 10));
                      return (
                        <div
                          key={ann.id}
                          onPointerDown={startDrag}
                          style={{
                            left: ann.x * scale,
                            top: ann.y * scale,
                            minWidth: (ann.width || 96) * scale,
                            height: (ann.height || 28) * scale,
                            borderColor: ann.color,
                            color: ann.color,
                            fontSize: stampFont * scale,
                            transform: ann.rotation ? `rotate(${ann.rotation}deg)` : undefined,
                            transformOrigin: 'center center',
                            touchAction: 'none',
                            pointerEvents: lockExistingElements ? 'none' : 'auto',
                          }}
                          className={`absolute px-2.5 rounded border-2 bg-white/95 font-extrabold tracking-wide flex items-center justify-center cursor-move z-10 whitespace-nowrap ${
                            isSel ? 'ring-2 ring-[#2563EB]' : ''
                          }`}
                        >
                          {label}
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
                          pointerEvents: lockExistingElements ? 'none' : 'auto',
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
                        {isSel && !lockExistingElements && (
                          <div
                            style={{ touchAction: 'none' }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              pointerMovedRef.current = false;
                              preGestureSnapshotRef.current = state;
                              overlayRef.current?.setPointerCapture?.(e.pointerId);
                              setResizingAnnotation({
                                id: ann.id,
                                handle: 'se',
                                startClientX: e.clientX,
                                startClientY: e.clientY,
                                origX: ann.x,
                                origY: ann.y,
                                origW: ann.width,
                                origH: ann.height,
                              });
                            }}
                            title="Drag to resize signature"
                            className="absolute -bottom-2.5 -right-2.5 w-5 h-5 rounded-full bg-white border-2 border-[#2563EB] shadow-md cursor-nwse-resize z-20"
                          />
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

      {/* Bottom Editing Toolbar + Contextual Sub-bar */}
      <div className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pb-safe shrink-0">
        {showContextualSubBar && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar text-xs">
            {activeTool === 'draw' && (
              <div className="flex items-center gap-2 w-full justify-between">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDrawMode('pen')}
                    className={`px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap ${
                      drawMode === 'pen'
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.penSolid}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawMode('marker')}
                    className={`px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap ${
                      drawMode === 'marker'
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.penMarker}
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  {[1.5, 3, 6, 10, 16].map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setStrokeWidth(sz)}
                      title={`${sz}px`}
                      className={`h-7 min-w-[28px] px-1.5 rounded-lg flex items-center justify-center border ${
                        strokeWidth === sz
                          ? 'bg-[#2563EB]/15 border-[#2563EB] text-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <span
                        className="rounded-full inline-block"
                        style={{
                          width: Math.min(14, Math.max(3, sz)),
                          height: Math.min(14, Math.max(3, sz)),
                          backgroundColor: activeColor,
                        }}
                      />
                    </button>
                  ))}
                </div>
                {pageErasableCount > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      commitState((prev) => ({
                        ...prev,
                        annotations: prev.annotations.filter(
                          (a) => a.pageNumber !== pageNumber || a.kind !== 'freehand'
                        ),
                      }))
                    }
                    className="px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 font-semibold whitespace-nowrap"
                  >
                    {t.editor.clearPageAnnots}
                  </button>
                )}
              </div>
            )}

            {activeTool === 'eraser' && (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-slate-500 dark:text-slate-300 truncate">
                  {t.editor.eraserHint}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {[10, 18, 28].map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setEraserRadius(r)}
                      className={`px-2 py-1 rounded-lg font-mono-nums text-[11px] border ${
                        eraserRadius === r
                          ? 'bg-rose-600 text-white border-rose-600'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {r}px
                    </button>
                  ))}
                  {pageErasableCount > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.filter(
                            (a) => a.pageNumber !== pageNumber || !isErasableAnnotation(a)
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 font-semibold whitespace-nowrap"
                    >
                      {t.editor.clearPageAnnots}
                    </button>
                  )}
                </div>
              </div>
            )}

            {(activeTool === 'rect' || activeTool === 'circle' || activeTool === 'arrow' || activeTool === 'underline' || activeTool === 'strike') && (
              <div className="flex items-center justify-between gap-2 w-full">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-slate-500 font-semibold">{t.editor.thickness}:</span>
                  {[1.5, 2.5, 4, 7].map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setStrokeWidth(sz)}
                      className={`px-2 py-1 rounded-lg font-mono-nums text-[11px] border ${
                        strokeWidth === sz
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
                {activeTool === 'arrow' && (
                  <div className="flex items-center gap-1">
                    {([
                      { id: 'single', label: t.editor.arrowSingle },
                      { id: 'double', label: t.editor.arrowDouble },
                      { id: 'line', label: t.editor.arrowLine },
                    ] as const).map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setArrowStyle(st.id)}
                        className={`px-2 py-1 rounded-lg font-semibold text-[11px] whitespace-nowrap border ${
                          arrowStyle === st.id
                            ? 'bg-[#2563EB] text-white border-[#2563EB]'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>
                )}
                {(activeTool === 'rect' || activeTool === 'circle' || activeTool === 'arrow') && (
                  <button
                    type="button"
                    onClick={() => setLineStyle((s) => (s === 'solid' ? 'dashed' : 'solid'))}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] whitespace-nowrap border ${
                      lineStyle === 'dashed'
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {lineStyle === 'dashed' ? t.editor.dashed : t.editor.solid}
                  </button>
                )}
                {(activeTool === 'rect' || activeTool === 'circle') && (
                  <button
                    type="button"
                    onClick={() => setShapeFilled((f) => !f)}
                    className={`px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 whitespace-nowrap border ${
                      shapeFilled
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <PaintBucket className="w-3.5 h-3.5" /> {t.editor.fillShape}
                  </button>
                )}
              </div>
            )}

            {activeTool === 'highlight' && (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] font-semibold text-slate-500">
                  {t.editor.tools.highlight}:
                </span>
                <div className="flex items-center gap-1.5">
                  {[0.25, 0.36, 0.55].map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => setHighlightOpacity(op)}
                      className={`px-2.5 py-1 rounded-lg font-mono-nums text-[11px] border ${
                        highlightOpacity === op
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {Math.round(op * 100)}%
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTool === 'stamp' && (
              <div className="flex items-center gap-1.5 w-full">
                {STAMP_PRESETS.map((sp) => (
                  <button
                    key={sp.id}
                    type="button"
                    onClick={() => {
                      setStampPreset(sp.id);
                      setActiveColor(sp.color);
                    }}
                    className={`px-2 py-1 rounded-lg font-bold text-[10px] border whitespace-nowrap ${
                      stampPreset === sp.id
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {sp.label}
                  </button>
                ))}
                <input
                  type="text"
                  value={customStampText}
                  onFocus={() => setStampPreset('CUSTOM')}
                  onChange={(e) => {
                    setStampPreset('CUSTOM');
                    setCustomStampText(e.target.value);
                  }}
                  placeholder={language === 'bn' ? 'কাস্টম স্ট্যাম্প...' : 'Custom...'}
                  className="h-7 w-24 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px]"
                />
              </div>
            )}

            {activeTool === 'signature' && (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-slate-600 dark:text-slate-300 truncate">
                  {pendingSig ? t.editor.tapToPlaceSig : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setShowSigModal(true)}
                  className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold whitespace-nowrap"
                >
                  {t.editor.changeSig}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Page switcher + expanded color palette + Save As Copy */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              disabled={pageNumber <= 1}
              className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono-nums px-1">
              {pageNumber}/{doc.pageCount}
            </span>
            <button
              onClick={() => setPageNumber((p) => Math.min(doc.pageCount, p + 1))}
              disabled={pageNumber >= doc.pageCount}
              className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 px-1">
            {PALETTE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setActiveColor(c)}
                className={`w-5 h-5 rounded-full border-2 shrink-0 ${
                  activeColor.toLowerCase() === c.toLowerCase()
                    ? 'border-slate-900 dark:border-white scale-115'
                    : 'border-slate-300/60 dark:border-slate-700'
                }`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
            <input
              type="color"
              value={activeColor}
              onChange={(e) => setActiveColor(e.target.value)}
              aria-label="Custom color"
              className="w-6 h-6 rounded-full border border-slate-300 dark:border-slate-600 cursor-pointer shrink-0 p-0 bg-transparent"
            />
          </div>

          <button
            onClick={() => handleSave('copy')}
            disabled={saving}
            className="min-h-[34px] px-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0"
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
                    if (!pendingSig) setShowSigModal(true);
                    else {
                      setStatusMessage(t.editor.tapToPlaceSig);
                      setTimeout(() => setStatusMessage(null), 2200);
                    }
                    return;
                  }
                  if (tool.id === 'highlight' && activeColor === '#2563EB') {
                    setActiveColor('#FACC15');
                  }
                  if (tool.id === 'stamp') {
                    setStatusMessage(t.editor.tapToPlaceStamp);
                    setTimeout(() => setStatusMessage(null), 2000);
                  }
                  setActiveTool(tool.id);
                }}
                className={`min-h-[42px] px-3 rounded-xl flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
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
                {t.editor.modifyText}
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
                title={language === 'bn' ? 'টেক্সট রঙ' : 'Text color'}
                value={runDraft.color}
                onChange={(e) => setRunDraft((d) => ({ ...d, color: e.target.value }))}
                className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-xs px-2.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700">
              <span className="font-semibold text-slate-600 dark:text-slate-300">
                {t.editor.bgColor}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={runDraft.backgroundColor}
                  onChange={(e) => setRunDraft((d) => ({ ...d, backgroundColor: e.target.value }))}
                  className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() =>
                    editingRun &&
                    setRunDraft((d) => ({ ...d, backgroundColor: sampleCanvasBgHex(editingRun) }))
                  }
                  className="px-2.5 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold"
                >
                  {t.editor.autoSampleBg}
                </button>
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, backgroundColor: '#FFFFFF' }))}
                  className="px-2.5 h-8 rounded-lg bg-white text-slate-800 border border-slate-200 font-semibold"
                >
                  #FFF
                </button>
              </div>
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
                <span className="text-slate-500 whitespace-nowrap">
                  {language === 'bn' ? 'ফাঁক' : 'Spacing'}: {runDraft.letterSpacing}px
                </span>
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
                {t.editor.deleteText}
              </button>
              <button
                onClick={() => handleApplyRunReplacement(false)}
                className="min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
              >
                {t.editor.replaceText}
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
                {editingBoxId ? t.editor.editTextBoxTitle : t.editor.addTextBoxTitle}
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
              placeholder={t.editor.textPlaceholder}
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
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500 whitespace-nowrap">{t.editor.boxBg}:</span>
                {TEXTBOX_BG_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setNewBoxDraft((d) => ({ ...d, backgroundColor: opt.value }))}
                    title={opt.label}
                    className={`h-7 px-2 rounded-lg border text-[11px] font-semibold ${
                      newBoxDraft.backgroundColor === opt.value
                        ? 'border-[#2563EB] ring-1 ring-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                    style={{
                      backgroundColor: opt.value === 'transparent' ? undefined : opt.value,
                      color: opt.value === 'transparent' ? undefined : '#0F172A',
                    }}
                  >
                    {opt.value === 'transparent' ? '✕' : opt.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setNewBoxDraft((d) => ({ ...d, rotation: (d.rotation + 90) % 360 }))
                }
                className="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center gap-1 font-semibold"
              >
                <RotateCw className="w-3.5 h-3.5" /> {newBoxDraft.rotation}°
              </button>
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
                <span className="text-slate-500 whitespace-nowrap">
                  {language === 'bn' ? 'ফাঁক' : 'Spacing'}: {newBoxDraft.letterSpacing}px
                </span>
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
                  {t.editor.deleteText}
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
                              backgroundColor: newBoxDraft.backgroundColor,
                              rotation: newBoxDraft.rotation,
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
                          backgroundColor: newBoxDraft.backgroundColor,
                          rotation: newBoxDraft.rotation,
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
                {editingBoxId ? t.editor.updateText : t.editor.placeText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sticky Note Modal */}
      {stickyPos && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3.5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {editingStickyId ? t.editor.editStickyTitle : t.editor.addStickyTitle}
              </h3>
              <button
                onClick={() => {
                  setStickyPos(null);
                  setEditingStickyId(null);
                }}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <textarea
              rows={3}
              value={stickyText}
              onChange={(e) => setStickyText(e.target.value)}
              placeholder={t.editor.stickyPlaceholder}
              autoFocus
              style={{ backgroundColor: stickyBgColor }}
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-900 text-sm"
            />

            {/* Sticky Paper Color & Font Size */}
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500 font-medium">{t.editor.stickyTheme}</span>
                {STICKY_THEMES.map((th) => (
                  <button
                    key={th.id}
                    type="button"
                    onClick={() => {
                      setStickyBgColor(th.bg);
                      setStickyAccentColor(th.accent);
                    }}
                    title={th.name}
                    style={{ backgroundColor: th.bg, borderColor: stickyBgColor === th.bg ? th.accent : '#CBD5E1' }}
                    className={`w-6 h-6 rounded-full border-2 ${stickyBgColor === th.bg ? 'scale-115 shadow' : ''}`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-slate-500">{t.editor.stickyFontSize}:</span>
                <button
                  type="button"
                  onClick={() => setStickyFontSize((f) => Math.max(7, f - 1))}
                  className="h-7 w-7 rounded-lg border border-slate-200 dark:border-slate-700 font-bold"
                >
                  -
                </button>
                <span className="font-mono-nums w-6 text-center">{stickyFontSize}</span>
                <button
                  type="button"
                  onClick={() => setStickyFontSize((f) => Math.min(20, f + 1))}
                  className="h-7 w-7 rounded-lg border border-slate-200 dark:border-slate-700 font-bold"
                >
                  +
                </button>
              </div>
            </div>

            {/* 8-Way Corner 45° & Edge Pointer Grid + Length Slider */}
            <div className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-xs">
              <div className="grid grid-cols-3 gap-1 shrink-0">
                {([
                  { side: 'top-left', label: '↖' },
                  { side: 'top', label: '↑' },
                  { side: 'top-right', label: '↗' },
                  { side: 'left', label: '←' },
                  { side: 'none', label: '✕' },
                  { side: 'right', label: '→' },
                  { side: 'bottom-left', label: '↙' },
                  { side: 'bottom', label: '↓' },
                  { side: 'bottom-right', label: '↘' },
                ] as const).map((item) => (
                  <button
                    key={item.side}
                    type="button"
                    onClick={() => setStickyArrow(item.side)}
                    className={`w-8 h-8 rounded-lg font-bold border flex items-center justify-center ${
                      stickyArrow === item.side
                        ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">{t.editor.arrowIndicator}</span>
                </div>
                {stickyArrow !== 'none' && (
                  <label className="block space-y-1">
                    <span className="flex justify-between text-[11px] text-slate-500">
                      <span>{t.editor.arrowLength}</span>
                      <span className="font-mono-nums">{stickyArrowLength}pt</span>
                    </span>
                    <input
                      type="range"
                      min={16}
                      max={200}
                      value={stickyArrowLength}
                      onChange={(e) => setStickyArrowLength(Number(e.target.value))}
                      className="w-full accent-amber-500"
                    />
                  </label>
                )}
                <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                  {t.editor.dragTipHint}
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                if (!stickyText.trim()) return;
                if (editingStickyId) {
                  commitState((prev) => ({
                    ...prev,
                    annotations: prev.annotations.map((an) => {
                      if (an.id !== editingStickyId) return an;
                      const boxW = Math.max(84, an.width || 165);
                      const boxH = Math.max(44, an.height || 76);
                      let nextTip: { tipX?: number; tipY?: number } = {};
                      if (stickyArrow !== 'none') {
                        const prevGeo = computeStickyArrowGeometry(an);
                        if (
                          an.stickyArrow === stickyArrow &&
                          an.stickyTipX !== undefined &&
                          an.stickyTipY !== undefined &&
                          prevGeo.hasArrow &&
                          prevGeo.length > 1
                        ) {
                          const ux = (prevGeo.tipX - prevGeo.startX) / prevGeo.length;
                          const uy = (prevGeo.tipY - prevGeo.startY) / prevGeo.length;
                          nextTip = {
                            tipX: Math.round(Math.max(8, Math.min(pageSize.width - 8, prevGeo.startX + ux * stickyArrowLength))),
                            tipY: Math.round(Math.max(8, Math.min(pageSize.height - 8, prevGeo.startY + uy * stickyArrowLength))),
                          };
                        } else {
                          nextTip = computeDefaultStickyTip(
                            an.x,
                            an.y,
                            boxW,
                            boxH,
                            stickyArrow,
                            stickyArrowLength,
                            pageSize.width,
                            pageSize.height
                          );
                        }
                      }
                      return {
                        ...an,
                        comment: stickyText.trim(),
                        stickyArrow,
                        stickyTipX: nextTip.tipX,
                        stickyTipY: nextTip.tipY,
                        fillColor: stickyBgColor,
                        color: stickyAccentColor,
                        fontSize: stickyFontSize,
                      };
                    }),
                  }));
                } else {
                  const boxW = 165;
                  const boxH = 76;
                  const placedX = Math.max(12, Math.min(pageSize.width - boxW - 12, stickyPos.x));
                  const placedY = Math.max(12, Math.min(pageSize.height - boxH - 12, stickyPos.y));
                  const tip = computeDefaultStickyTip(
                    placedX,
                    placedY,
                    boxW,
                    boxH,
                    stickyArrow,
                    stickyArrowLength,
                    pageSize.width,
                    pageSize.height
                  );
                  const newId = `sticky_${Date.now()}`;
                  commitState((prev) => ({
                    ...prev,
                    annotations: [
                      ...prev.annotations,
                      {
                        id: newId,
                        pageNumber,
                        kind: 'sticky',
                        x: placedX,
                        y: placedY,
                        width: boxW,
                        height: boxH,
                        color: stickyAccentColor,
                        fillColor: stickyBgColor,
                        fontSize: stickyFontSize,
                        comment: stickyText.trim(),
                        stickyArrow,
                        stickyTipX: tip.tipX,
                        stickyTipY: tip.tipY,
                      },
                    ],
                  }));
                  setSelectedElement({ kind: 'annotation', id: newId });
                }
                setStickyPos(null);
                setEditingStickyId(null);
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              {editingStickyId ? t.editor.updateSticky : t.editor.addSticky}
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
          setStatusMessage(t.editor.tapToPlaceSig);
          setTimeout(() => setStatusMessage(null), 3000);
        }}
      />

      {/* Crop Inserted Image Modal */}
      {cropModalImg && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {t.editor.cropImageTitle}
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
                    <span>{side}</span>
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
              {t.editor.applyCrop}
            </button>
          </div>
        </div>
      )}

      {/* Unsaved Changes Exit Guard Modal */}
      {showExitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 shadow-2xl space-y-4">
            <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
              {t.editor.unsavedTitle}
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {t.editor.unsavedMessage}
            </p>
            <div className="space-y-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setShowExitConfirm(false);
                  void handleSave('version');
                }}
                className="w-full min-h-[44px] rounded-xl bg-[#2563EB] text-white text-xs font-semibold"
              >
                {saving ? t.editor.saving : t.editor.saveAndExit}
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowExitConfirm(false);
                    onClose();
                  }}
                  className="min-h-[44px] rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 text-xs font-semibold"
                >
                  {t.editor.discardExit}
                </button>
                <button
                  type="button"
                  onClick={() => setShowExitConfirm(false)}
                  className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold"
                >
                  {t.editor.keepEditing}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
