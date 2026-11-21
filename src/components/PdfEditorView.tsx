import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ArrowUpToLine,
  Bold,
  Calendar,
  Check,
  CheckCheck,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Copy,
  Crop,
  Download,
  Droplet,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Hand,
  Highlighter,
  ImagePlus,
  Italic,
  Layers,
  LayoutGrid,
  Loader2,
  Lock,
  Maximize2,
  MessageSquare,
  MousePointer,
  MousePointer2,
  PaintBucket,
  Pen,
  Pencil,
  PenTool,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanText,
  SlidersHorizontal,
  Square,
  Strikethrough,
  Trash2,
  Type as TypeIcon,
  Underline,
  Undo2,
  Unlock,
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
  PdfEditorState,
  PdfFontFamily,
  TextReplacementEdit,
} from '../types';
import { getT } from '../i18n/translations';
import { cloneEditorState } from '../services/storageService';
import {
  OFFICIAL_FONT_OPTIONS,
  applyPdfEditsToBytes,
  cloneBuffer,
  computeSha256Hex,
  computeStickyArrowGeometry,
  extractPageTextRuns,
  getFontCssStack,
  inferOfficialFontFromPdfName,
  renderPageThumbnail,
  renderPageToCanvas,
} from '../services/pdfEngine';
import { detectOcrLineRuns } from '../services/ocrService';
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

type EditorStateSnapshot = PdfEditorState;

type SelectedElementRef = {
  kind: 'image' | 'textBox' | 'annotation';
  id: string;
};

type LayerAction =
  | 'forward'
  | 'backward'
  | 'front'
  | 'back'
  | 'behindContent'
  | 'frontContent';

type UnifiedOverlayItem =
  | { kind: 'textBox'; id: string; z: number; order: number; behind: boolean; item: AddedTextBox }
  | { kind: 'image'; id: string; z: number; order: number; behind: boolean; item: AddedImageOverlay }
  | { kind: 'annotation'; id: string; z: number; order: number; behind: boolean; item: AnnotationOverlay };

const MAX_UNDO_HISTORY = 50;

function getElementBounds(
  kind: SelectedElementRef['kind'],
  item: AddedTextBox | AddedImageOverlay | AnnotationOverlay
): { x: number; y: number; w: number; h: number } {
  if (kind === 'textBox') {
    const tb = item as AddedTextBox;
    const lineCount = Math.max(1, (tb.text || '').split('\n').length);
    return {
      x: tb.x,
      y: tb.y,
      w: Math.max(24, tb.width),
      h: Math.max(18, tb.fontSize * 1.42 * lineCount),
    };
  }
  if (kind === 'image') {
    const im = item as AddedImageOverlay;
    return { x: im.x, y: im.y, w: im.width, h: im.height };
  }
  const an = item as AnnotationOverlay;
  if (an.kind === 'freehand' && an.points && an.points.length > 0) {
    const xs = an.points.map((p) => p.x);
    const ys = an.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: minX,
      y: minY,
      w: Math.max(10, Math.max(...xs) - minX),
      h: Math.max(10, Math.max(...ys) - minY),
    };
  }
  if (an.kind === 'arrow') {
    return {
      x: Math.min(an.x, an.x + an.width),
      y: Math.min(an.y, an.y + an.height),
      w: Math.max(10, Math.abs(an.width)),
      h: Math.max(10, Math.abs(an.height)),
    };
  }
  if (an.kind === 'sticky') {
    return { x: an.x, y: an.y, w: Math.max(84, an.width || 165), h: Math.max(44, an.height || 76) };
  }
  if (an.kind === 'stamp') {
    return { x: an.x, y: an.y, w: Math.max(72, an.width || 96), h: Math.max(22, an.height || 28) };
  }
  return {
    x: an.x,
    y: an.y,
    w: Math.max(10, Math.abs(an.width)),
    h: Math.max(8, Math.abs(an.height)),
  };
}

function buildUnifiedPageItems(snap: PdfEditorState, pg: number): UnifiedOverlayItem[] {
  const items: UnifiedOverlayItem[] = [];
  snap.addedTexts.forEach((tb, i) => {
    if (tb.pageNumber === pg) {
      items.push({
        kind: 'textBox',
        id: tb.id,
        z: tb.zIndex ?? 1000 + i,
        order: i,
        behind: tb.layerPlacement === 'behind',
        item: tb,
      });
    }
  });
  snap.addedImages.forEach((im, i) => {
    if (im.pageNumber === pg) {
      items.push({
        kind: 'image',
        id: im.id,
        z: im.zIndex ?? 2000 + i,
        order: 100000 + i,
        behind: im.layerPlacement === 'behind',
        item: im,
      });
    }
  });
  snap.annotations.forEach((an, i) => {
    if (an.pageNumber === pg) {
      items.push({
        kind: 'annotation',
        id: an.id,
        z: an.zIndex ?? 3000 + i,
        order: 200000 + i,
        behind: an.layerPlacement === 'behind',
        item: an,
      });
    }
  });
  items.sort((a, b) => a.z - b.z || a.order - b.order);
  return items;
}

function getNextTopZIndex(snap: PdfEditorState, pg: number): number {
  const items = buildUnifiedPageItems(snap, pg);
  let maxZ = 3000;
  for (const it of items) {
    if (it.z > maxZ) maxZ = it.z;
  }
  return maxZ + 10;
}

function doesSnapContainElement(snap: PdfEditorState, sel: SelectedElementRef): boolean {
  if (sel.kind === 'image') return snap.addedImages.some((x) => x.id === sel.id);
  if (sel.kind === 'textBox') return snap.addedTexts.some((x) => x.id === sel.id);
  return snap.annotations.some((x) => x.id === sel.id);
}

function applyLayerActionToState(
  prev: PdfEditorState,
  pg: number,
  targets: SelectedElementRef[],
  action: LayerAction
): PdfEditorState {
  if (targets.length === 0) return prev;
  const targetKeys = new Set(targets.map((t) => `${t.kind}:${t.id}`));
  const isTarget = (u: UnifiedOverlayItem) => targetKeys.has(`${u.kind}:${u.id}`);

  const unified = buildUnifiedPageItems(prev, pg);
  let behindList = unified.filter((u) => u.behind);
  let frontList = unified.filter((u) => !u.behind);

  const placementUpdates = new Map<string, 'front' | 'behind'>();
  if (action === 'behindContent' || action === 'frontContent') {
    const nextPlacement = action === 'behindContent' ? 'behind' : 'front';
    for (const u of unified) {
      if (isTarget(u)) {
        placementUpdates.set(`${u.kind}:${u.id}`, nextPlacement);
        u.behind = nextPlacement === 'behind';
      }
    }
    const merged = [...behindList, ...frontList].sort((a, b) => a.z - b.z || a.order - b.order);
    behindList = merged.filter((u) => u.behind);
    frontList = merged.filter((u) => !u.behind);
  } else {
    const reorderPartition = (list: UnifiedOverlayItem[]): UnifiedOverlayItem[] => {
      if (list.length <= 1 || !list.some(isTarget)) return list;
      const arr = [...list];
      if (action === 'front') {
        return [...arr.filter((u) => !isTarget(u)), ...arr.filter(isTarget)];
      }
      if (action === 'back') {
        return [...arr.filter(isTarget), ...arr.filter((u) => !isTarget(u))];
      }
      if (action === 'forward') {
        for (let i = arr.length - 2; i >= 0; i--) {
          if (isTarget(arr[i]) && !isTarget(arr[i + 1])) {
            const tmp = arr[i];
            arr[i] = arr[i + 1];
            arr[i + 1] = tmp;
          }
        }
        return arr;
      }
      for (let i = 1; i < arr.length; i++) {
        if (isTarget(arr[i]) && !isTarget(arr[i - 1])) {
          const tmp = arr[i];
          arr[i] = arr[i - 1];
          arr[i - 1] = tmp;
        }
      }
      return arr;
    };
    behindList = reorderPartition(behindList);
    frontList = reorderPartition(frontList);
  }

  const zUpdates = new Map<string, number>();
  [...behindList, ...frontList].forEach((u, idx) => {
    zUpdates.set(`${u.kind}:${u.id}`, 100 + idx * 10);
  });

  return {
    ...prev,
    addedTexts: prev.addedTexts.map((tb) => {
      if (tb.pageNumber !== pg) return tb;
      const key = `textBox:${tb.id}`;
      const nz = zUpdates.get(key);
      const np = placementUpdates.get(key);
      if (nz === undefined && !np) return tb;
      return { ...tb, zIndex: nz ?? tb.zIndex, layerPlacement: np ?? tb.layerPlacement };
    }),
    addedImages: prev.addedImages.map((im) => {
      if (im.pageNumber !== pg) return im;
      const key = `image:${im.id}`;
      const nz = zUpdates.get(key);
      const np = placementUpdates.get(key);
      if (nz === undefined && !np) return im;
      return { ...im, zIndex: nz ?? im.zIndex, layerPlacement: np ?? im.layerPlacement };
    }),
    annotations: prev.annotations.map((an) => {
      if (an.pageNumber !== pg) return an;
      const key = `annotation:${an.id}`;
      const nz = zUpdates.get(key);
      const np = placementUpdates.get(key);
      if (nz === undefined && !np) return an;
      return { ...an, zIndex: nz ?? an.zIndex, layerPlacement: np ?? an.layerPlacement };
    }),
  };
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

function tryCapturePointer(el: HTMLElement | null, pointerId: number): void {
  try {
    el?.setPointerCapture?.(pointerId);
  } catch {
    // Ignore unsupported or synthetic pointer capture
  }
}

function isErasableAnnotation(ann: AnnotationOverlay, includeAll = false): boolean {
  if (includeAll) return true;
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
  radius: number,
  includeAll = false
): boolean {
  if (!isErasableAnnotation(ann, includeAll)) return false;
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

  const minX = Math.min(ann.x, ann.x + ann.width);
  const maxX = Math.max(ann.x, ann.x + ann.width);
  const minY = Math.min(ann.y, ann.y + ann.height);
  const maxY = Math.max(ann.y, ann.y + ann.height);

  // Hollow rect: check border edges so erasing strokes inside a frame leaves the frame intact
  if (ann.kind === 'rect' && !ann.fillColor) {
    return (
      distPointToSegment(px, py, minX, minY, maxX, minY) <= pad ||
      distPointToSegment(px, py, maxX, minY, maxX, maxY) <= pad ||
      distPointToSegment(px, py, maxX, maxY, minX, maxY) <= pad ||
      distPointToSegment(px, py, minX, maxY, minX, minY) <= pad
    );
  }

  // Hollow circle/ellipse: check perimeter band
  if (ann.kind === 'circle' && !ann.fillColor) {
    const rx = Math.max(2, (maxX - minX) / 2);
    const ry = Math.max(2, (maxY - minY) / 2);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const norm = Math.hypot((px - cx) / rx, (py - cy) / ry);
    const approxDist = Math.abs(norm - 1) * Math.min(rx, ry);
    return approxDist <= pad;
  }

  return px >= minX - pad && px <= maxX + pad && py >= minY - pad && py <= maxY + pad;
}

interface EditTextRunsLayerProps {
  runs: ExtractedTextRun[];
  replacedRunIds: Set<string>;
  scale: number;
  disabled?: boolean;
  onSelectRun: (run: ExtractedTextRun) => void;
}

const EditTextRunsLayer = React.memo<EditTextRunsLayerProps>(
  ({ runs, replacedRunIds, scale, disabled, onSelectRun }) => {
    const untouched = useMemo(
      () => runs.filter((r) => !replacedRunIds.has(r.id)),
      [runs, replacedRunIds]
    );
    const runById = useMemo(() => {
      const m = new Map<string, ExtractedTextRun>();
      for (const r of untouched) m.set(r.id, r);
      return m;
    }, [untouched]);

    if (untouched.length === 0) return null;

    return (
      <div
        onClick={(e) => {
          if (disabled) return;
          const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-run-id]');
          if (!btn) return;
          e.stopPropagation();
          const run = runById.get(btn.dataset.runId || '');
          if (run) onSelectRun(run);
        }}
        className="pointer-events-none absolute inset-0"
      >
        {untouched.map((run) => (
          <button
            key={run.id}
            type="button"
            data-run-id={run.id}
            style={{
              left: run.x * scale,
              top: run.y * scale,
              minWidth: Math.max(14, run.width * scale),
              minHeight: Math.max(12, run.height * scale),
              pointerEvents: disabled ? 'none' : 'auto',
            }}
            className="absolute text-left rounded bg-[#2563EB]/[0.03] active:bg-[#2563EB]/20 border border-dashed border-[#2563EB]/35"
          />
        ))}
      </div>
    );
  }
);

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
  const [ocrScannedPages, setOcrScannedPages] = useState<Record<number, ExtractedTextRun[]>>({});
  const [ocrScanning, setOcrScanning] = useState(false);
  const [editBoxDrawMode, setEditBoxDrawMode] = useState(false);
  const [activeTool, setActiveTool] = useState<EditorTool>('editText');
  const [activeColor, setActiveColor] = useState('#2563EB');

  // Fine-grained drawing, shape, arrow & sticky options
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [drawMode, setDrawMode] = useState<'pen' | 'marker'>('pen');
  const [penOpacity, setPenOpacity] = useState(1);
  const [shapeFilled, setShapeFilled] = useState(false);
  const [lineStyle, setLineStyle] = useState<'solid' | 'dashed'>('solid');
  const [arrowStyle, setArrowStyle] = useState<'single' | 'double' | 'line'>('single');
  const [highlightOpacity, setHighlightOpacity] = useState(0.36);
  const [eraserRadius, setEraserRadius] = useState(14);
  const [eraserIncludeAll, setEraserIncludeAll] = useState(false);
  const [eraserCursor, setEraserCursor] = useState<{ x: number; y: number } | null>(null);
  const [whiteoutColor, setWhiteoutColor] = useState('#FFFFFF');
  const [eyedropperActive, setEyedropperActive] = useState(false);
  const [stampPreset, setStampPreset] = useState<string>('DATE');
  const [customStampText, setCustomStampText] = useState('');
  const [stampSolidFill, setStampSolidFill] = useState(false);
  const [showToolGrid, setShowToolGrid] = useState(false);
  const [showPageJump, setShowPageJump] = useState(false);
  const [pageJumpInput, setPageJumpInput] = useState('1');
  const [keepToolActive, setKeepToolActive] = useState(false);
  const [snapGuides, setSnapGuides] = useState<{ x?: number; y?: number } | null>(null);

  // Preserve original unbaked base PDF buffer & persisted edit layer across saves and re-opens
  const basePdfRef = useRef<{ docId: string; bytes: ArrayBuffer }>({
    docId: doc.id,
    bytes: cloneBuffer(doc.basePdfBytes || doc.pdfBytes),
  });
  if (basePdfRef.current.docId !== doc.id) {
    basePdfRef.current = { docId: doc.id, bytes: cloneBuffer(doc.basePdfBytes || doc.pdfBytes) };
  }

  // Restore persisted edits once per mounted session so previously added items stay live & re-editable
  const initialSessionRef = useRef<EditorStateSnapshot>(
    cloneEditorState(doc.editorState) || {
      replacements: [],
      addedTexts: [],
      addedImages: [],
      annotations: [],
    }
  );
  const [state, setState] = useState<EditorStateSnapshot>(() => initialSessionRef.current);
  const [savedSnapshot, setSavedSnapshot] = useState<EditorStateSnapshot | null>(() =>
    doc.editorState ? initialSessionRef.current : null
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [undoStack, setUndoStack] = useState<EditorStateSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorStateSnapshot[]>([]);
  const lastBoxPrefsRef = useRef<{ fontSize: number; fontFamily: PdfFontFamily }>({
    fontSize: 14,
    fontFamily: 'arial',
  });
  const idSeqRef = useRef(0);
  const nextElementId = useCallback((prefix: string) => {
    idSeqRef.current += 1;
    return `${prefix}_${Date.now()}_${idSeqRef.current}`;
  }, []);
  const textSubmitLockRef = useRef(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Active modals/popovers
  const [editingRun, setEditingRun] = useState<ExtractedTextRun | null>(null);
  const [runDraft, setRunDraft] = useState({
    text: '',
    fontSize: 12,
    fontFamily: 'arial' as PdfFontFamily,
    color: '#1E293B',
    backgroundColor: '#FFFFFF',
    bold: false,
    italic: false,
    underline: false,
    align: 'left' as 'left' | 'center' | 'right',
    letterSpacing: 0,
    dx: 0,
    dy: 0,
  });
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const [addingBoxPos, setAddingBoxPos] = useState<{ x: number; y: number } | null>(null);
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
  const [newBoxDraft, setNewBoxDraft] = useState({
    text: '',
    fontSize: 14,
    fontFamily: 'arial' as PdfFontFamily,
    color: '#142B4A',
    backgroundColor: 'transparent',
    border: false,
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

  const [editingStampId, setEditingStampId] = useState<string | null>(null);
  const [stampEditDraft, setStampEditDraft] = useState({
    text: '',
    color: '#2563EB',
    fontSize: 10,
    solidFill: false,
  });

  const [showSigModal, setShowSigModal] = useState(false);
  const [pendingSig, setPendingSig] = useState<{
    dataUrl: string;
    signerName: string;
    dateStr: string;
    attachIntegritySeal: boolean;
  } | null>(null);

  const [selectedElements, setSelectedElements] = useState<SelectedElementRef[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [marqueeBox, setMarqueeBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const selectedElement: SelectedElementRef | null =
    selectedElements.length === 1 ? selectedElements[0] : null;
  const setSelectedElement = useCallback((sel: SelectedElementRef | null) => {
    setSelectedElements(sel ? [sel] : []);
  }, []);
  const selectedImageId = selectedElement?.kind === 'image' ? selectedElement.id : null;
  const setSelectedImageId = useCallback((id: string | null) => {
    setSelectedElements(id ? [{ kind: 'image', id }] : []);
  }, []);
  const isElementSelected = useCallback(
    (kind: SelectedElementRef['kind'], id: string) =>
      selectedElements.some((s) => s.kind === kind && s.id === id),
    [selectedElements]
  );

  const [cropModalImg, setCropModalImg] = useState<AddedImageOverlay | null>(null);
  const [cropInsets, setCropInsets] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [cropNaturalSize, setCropNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [showImageAdjustModal, setShowImageAdjustModal] = useState(false);
  const [draggingItem, setDraggingItem] = useState<{
    kind: 'image' | 'textBox' | 'annotation';
    id: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    wasSelectedBeforeDown?: boolean;
    toggleOffOnTap?: boolean;
    origPoints?: Array<{ x: number; y: number }>;
    origTipX?: number;
    origTipY?: number;
    multiOrigs?: Array<{
      kind: 'image' | 'textBox' | 'annotation';
      id: string;
      origX: number;
      origY: number;
      origPoints?: Array<{ x: number; y: number }>;
      origTipX?: number;
      origTipY?: number;
    }>;
  } | null>(null);
  const [resizingImage, setResizingImage] = useState<{
    id: string;
    handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
    lockAspect: boolean;
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
  const lastGestureEndTsRef = useRef(0);
  const erasingActiveRef = useRef(false);
  const erasedAnythingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashStatus = useCallback((msg: string, ms = 2400) => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatusMessage(msg);
    statusTimerRef.current = setTimeout(() => {
      setStatusMessage(null);
      statusTimerRef.current = null;
    }, ms);
  }, []);

  // Drawing & modal textarea refs
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const runTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const boxTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const liveFreehandRef = useRef<Array<{ x: number; y: number }>>([]);
  const [liveFreehand, setLiveFreehand] = useState<Array<{ x: number; y: number }>>([]);
  const [liveBox, setLiveBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const liveBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    setSelectedElements([]);
    setShowImageAdjustModal(false);
    setSnapGuides(null);
    setEraserCursor(null);
    setEyedropperActive(false);
    setLiveBox(null);
    setLiveFreehand([]);
    setMarqueeBox(null);
    marqueeBoxRef.current = null;
    setPageJumpInput(String(pageNumber));
  }, [pageNumber]);

  const pushUndoSnapshot = useCallback((snap: EditorStateSnapshot) => {
    const cloned = cloneEditorState(snap) || snap;
    setUndoStack((u) => [...u.slice(-(MAX_UNDO_HISTORY - 1)), cloned]);
    setRedoStack([]);
  }, []);

  const capturePreGestureSnapshot = useCallback(() => {
    preGestureSnapshotRef.current = cloneEditorState(stateRef.current) || stateRef.current;
  }, []);

  const commitState = useCallback(
    (updater: (prev: EditorStateSnapshot) => EditorStateSnapshot) => {
      const current = stateRef.current;
      const next = updater(current);
      if (next === current) return;
      const snapshotForHistory = cloneEditorState(current) || current;
      setUndoStack((u) => [...u.slice(-(MAX_UNDO_HISTORY - 1)), snapshotForHistory]);
      setRedoStack([]);
      stateRef.current = next;
      setState(next);
    },
    []
  );

  const updateStateLive = useCallback(
    (updater: (prev: EditorStateSnapshot) => EditorStateSnapshot) => {
      const current = stateRef.current;
      const next = updater(current);
      if (next === current) return;
      stateRef.current = next;
      setState(next);
    },
    []
  );

  const closeActiveModals = useCallback(() => {
    setEditingRun(null);
    setAddingBoxPos(null);
    setEditingBoxId(null);
    setStickyPos(null);
    setEditingStickyId(null);
    setEditingStampId(null);
    setCropModalImg(null);
    setShowImageAdjustModal(false);
    setShowSigModal(false);
    setShowToolGrid(false);
    setShowPageJump(false);
    textSubmitLockRef.current = false;
    preGestureSnapshotRef.current = null;
  }, []);

  const openImagePicker = useCallback(() => {
    closeActiveModals();
    setEyedropperActive(false);
    setDraggingItem(null);
    setResizingImage(null);
    setResizingTextBox(null);
    setResizingAnnotation(null);
    setDraggingStickyTip(null);
    dragStartRef.current = null;
    liveFreehandRef.current = [];
    liveBoxRef.current = null;
    marqueeBoxRef.current = null;
    setLiveFreehand([]);
    setLiveBox(null);
    setMarqueeBox(null);
    setSelectedElements([]);
    imageInputRef.current?.click();
  }, [closeActiveModals]);

  const handleUndo = useCallback(() => {
    setUndoStack((u) => {
      if (u.length === 0) return u;
      const prevSnap = cloneEditorState(u[u.length - 1]) || u[u.length - 1];
      const currentForRedo = cloneEditorState(stateRef.current) || stateRef.current;
      setRedoStack((r) => [...r.slice(-(MAX_UNDO_HISTORY - 1)), currentForRedo]);
      stateRef.current = prevSnap;
      setState(prevSnap);
      setSelectedElements((cur) => cur.filter((s) => doesSnapContainElement(prevSnap, s)));
      return u.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const nextSnap = cloneEditorState(r[r.length - 1]) || r[r.length - 1];
      const currentForUndo = cloneEditorState(stateRef.current) || stateRef.current;
      setUndoStack((u) => [...u.slice(-(MAX_UNDO_HISTORY - 1)), currentForUndo]);
      stateRef.current = nextSnap;
      setState(nextSnap);
      setSelectedElements((cur) => cur.filter((s) => doesSnapContainElement(nextSnap, s)));
      return r.slice(0, -1);
    });
  }, []);

  const selectAllOnCurrentPage = useCallback(() => {
    const snap = stateRef.current;
    const refs: SelectedElementRef[] = [
      ...snap.addedTexts.filter((x) => x.pageNumber === pageNumber).map((x) => ({ kind: 'textBox' as const, id: x.id })),
      ...snap.addedImages.filter((x) => x.pageNumber === pageNumber).map((x) => ({ kind: 'image' as const, id: x.id })),
      ...snap.annotations.filter((x) => x.pageNumber === pageNumber).map((x) => ({ kind: 'annotation' as const, id: x.id })),
    ];
    setSelectedElements(refs);
    if (refs.length > 0) setActiveTool('select');
  }, [pageNumber]);

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

  // Keyboard arrow / PageUp / PageDown / Delete / Escape / Ctrl+Z navigation & nudging
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editingRun || addingBoxPos || stickyPos || showSigModal || cropModalImg || showImageAdjustModal || editingStampId) return;
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

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAllOnCurrentPage();
        return;
      }

      if (e.key === 'Escape' && (selectedElements.length > 0 || multiSelectMode)) {
        e.preventDefault();
        setSelectedElements([]);
        setMultiSelectMode(false);
        return;
      }

      // Smooth 1pt (or 8pt with Shift) nudging for single or multi-selected elements
      if (
        selectedElements.length > 0 &&
        (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 8 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const imgIds = new Set(selectedElements.filter((s) => s.kind === 'image').map((s) => s.id));
        const tbIds = new Set(selectedElements.filter((s) => s.kind === 'textBox').map((s) => s.id));
        const annIds = new Set(selectedElements.filter((s) => s.kind === 'annotation').map((s) => s.id));
        commitState((prev) => ({
          ...prev,
          addedImages: prev.addedImages.map((im) =>
            imgIds.has(im.id)
              ? {
                  ...im,
                  x: Math.max(0, Math.min(pageSize.width - 10, im.x + dx)),
                  y: Math.max(0, Math.min(pageSize.height - 10, im.y + dy)),
                }
              : im
          ),
          addedTexts: prev.addedTexts.map((tb) =>
            tbIds.has(tb.id)
              ? {
                  ...tb,
                  x: Math.max(0, Math.min(pageSize.width - 10, tb.x + dx)),
                  y: Math.max(0, Math.min(pageSize.height - 10, tb.y + dy)),
                }
              : tb
          ),
          annotations: prev.annotations.map((an) => {
            if (!annIds.has(an.id)) return an;
            if (an.kind === 'freehand' && an.points) {
              return {
                ...an,
                points: an.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
              };
            }
            return {
              ...an,
              x: Math.max(0, Math.min(pageSize.width - 10, an.x + dx)),
              y: Math.max(0, Math.min(pageSize.height - 10, an.y + dy)),
              ...(an.kind === 'sticky' && an.stickyTipX !== undefined && an.stickyTipY !== undefined
                ? { stickyTipX: an.stickyTipX + dx, stickyTipY: an.stickyTipY + dy }
                : {}),
            };
          }),
        }));
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElements.length > 0) {
        e.preventDefault();
        const imgIds = new Set(selectedElements.filter((s) => s.kind === 'image').map((s) => s.id));
        const tbIds = new Set(selectedElements.filter((s) => s.kind === 'textBox').map((s) => s.id));
        const annIds = new Set(selectedElements.filter((s) => s.kind === 'annotation').map((s) => s.id));
        commitState((prev) => ({
          ...prev,
          addedImages: prev.addedImages.filter((im) => !imgIds.has(im.id)),
          addedTexts: prev.addedTexts.filter((tb) => !tbIds.has(tb.id)),
          annotations: prev.annotations.filter((an) => !annIds.has(an.id)),
        }));
        setSelectedElements([]);
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
    showImageAdjustModal,
    editingStampId,
    selectedElements,
    multiSelectMode,
    doc.pageCount,
    pageSize.width,
    pageSize.height,
    commitState,
    handleUndo,
    handleRedo,
    selectAllOnCurrentPage,
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
        const res = await renderPageToCanvas(basePdfRef.current.bytes, pageNumber, canvasRef.current, renderScale, 0, true);
        if (active) {
          setPageSize({ width: res.unscaledWidth, height: res.unscaledHeight });
        }
      }
    };
    loadPageCanvas().catch(() => {});
    return () => {
      active = false;
    };
  }, [doc.id, pageNumber, renderScale]);

  useEffect(() => {
    let active = true;
    extractPageTextRuns(basePdfRef.current.bytes, pageNumber)
      .then(({ runs }) => {
        if (active) setTextRuns(runs);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [doc.id, pageNumber]);

  const toUnscaledCoords = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(pageSize.width, (clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(pageSize.height, (clientY - rect.top) / scale)),
    };
  };

  const openEditAddedTextBox = (tb: AddedTextBox) => {
    closeActiveModals();
    setEditingBoxId(tb.id);
    setAddingBoxPos({ x: tb.x, y: tb.y });
    setNewBoxDraft({
      text: tb.text,
      fontSize: tb.fontSize,
      fontFamily: tb.fontFamily,
      color: tb.color,
      backgroundColor: tb.backgroundColor || 'transparent',
      border: Boolean(tb.borderColor),
      rotation: tb.rotation || 0,
      bold: tb.bold,
      italic: tb.italic,
      underline: tb.underline,
      align: tb.align,
      letterSpacing: tb.letterSpacing,
    });
  };

  const openEditStickyNote = (ann: AnnotationOverlay) => {
    closeActiveModals();
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

  const openEditStamp = (ann: AnnotationOverlay) => {
    closeActiveModals();
    setEditingStampId(ann.id);
    setStampEditDraft({
      text: ann.comment || ann.dateStr || 'APPROVED',
      color: ann.color || '#2563EB',
      fontSize: Math.round(ann.fontSize || 10),
      solidFill: Boolean(ann.fillColor),
    });
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

  const isPlacementTool =
    activeTool === 'addText' ||
    activeTool === 'sticky' ||
    activeTool === 'stamp' ||
    activeTool === 'signature';

  const sampleCanvasPointHex = (pt: { x: number; y: number }): string => {
    const canvas = canvasRef.current;
    if (!canvas || !pageSize.width || !pageSize.height) return '#FFFFFF';
    const ctx = canvas.getContext('2d');
    if (!ctx) return '#FFFFFF';
    const sx = canvas.width / pageSize.width;
    const sy = canvas.height / pageSize.height;
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round(pt.x * sx)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round(pt.y * sy)));
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      if (d[3] < 20) return '#FFFFFF';
      const toHex = (n: number) =>
        Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      return `#${toHex(d[0])}${toHex(d[1])}${toHex(d[2])}`.toUpperCase();
    } catch {
      return '#FFFFFF';
    }
  };

  const eraseAtPoint = (pt: { x: number; y: number }) => {
    setState((prev) => {
      const nextAnns = prev.annotations.filter(
        (an) =>
          an.pageNumber !== pageNumber ||
          !doesEraserHitAnnotation(an, pt.x, pt.y, eraserRadius, eraserIncludeAll)
      );
      const nextTexts = eraserIncludeAll
        ? prev.addedTexts.filter((tb) => {
            if (tb.pageNumber !== pageNumber) return true;
            const estH = Math.max(24, tb.fontSize * 1.6);
            return !(
              pt.x >= tb.x - eraserRadius &&
              pt.x <= tb.x + tb.width + eraserRadius &&
              pt.y >= tb.y - eraserRadius &&
              pt.y <= tb.y + estH + eraserRadius
            );
          })
        : prev.addedTexts;
      const nextImgs = eraserIncludeAll
        ? prev.addedImages.filter((im) => {
            if (im.pageNumber !== pageNumber) return true;
            return !(
              pt.x >= im.x - eraserRadius &&
              pt.x <= im.x + im.width + eraserRadius &&
              pt.y >= im.y - eraserRadius &&
              pt.y <= im.y + im.height + eraserRadius
            );
          })
        : prev.addedImages;

      if (
        nextAnns.length !== prev.annotations.length ||
        nextTexts.length !== prev.addedTexts.length ||
        nextImgs.length !== prev.addedImages.length
      ) {
        erasedAnythingRef.current = true;
        const next = {
          ...prev,
          annotations: nextAnns,
          addedTexts: nextTexts,
          addedImages: nextImgs,
        };
        stateRef.current = next;
        return next;
      }
      return prev;
    });
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (showToolGrid) setShowToolGrid(false);
    if (showPageJump) setShowPageJump(false);
    if (performance.now() - lastGestureEndTsRef.current < 260) return;
    if (e.target !== overlayRef.current) return;
    if (!multiSelectMode && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      setSelectedElements([]);
    }
    const pt = toUnscaledCoords(e.clientX, e.clientY);

    if (activeTool === 'whiteout' && eyedropperActive) {
      const picked = sampleCanvasPointHex(pt);
      setWhiteoutColor(picked);
      setEyedropperActive(false);
      flashStatus(`${language === 'bn' ? 'রঙ নির্বাচিত:' : 'Color picked:'} ${picked}`, 2000);
      return;
    }

    if (activeTool === 'addText') {
      if (addingBoxPos) return;
      closeActiveModals();
      setEditingBoxId(null);
      setAddingBoxPos(pt);
      setNewBoxDraft({
        text: '',
        fontSize: lastBoxPrefsRef.current.fontSize,
        fontFamily: lastBoxPrefsRef.current.fontFamily,
        color: activeColor,
        backgroundColor: 'transparent',
        border: false,
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
      if (stickyPos) return;
      closeActiveModals();
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
      const stampFont = 10;
      const stampW = Math.max(96, chosenLabel.length * 7.2 + 24);
      const stampH = 28;
      const newId = nextElementId('ann');
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: newId,
            pageNumber,
            kind: 'stamp',
            x: Math.max(4, Math.min(pageSize.width - stampW - 4, pt.x - stampW / 2)),
            y: Math.max(4, Math.min(pageSize.height - stampH - 4, pt.y - stampH / 2)),
            width: stampW,
            height: stampH,
            fontSize: stampFont,
            color: activeColor,
            fillColor: stampSolidFill ? activeColor : undefined,
            dateStr: new Date().toLocaleDateString(),
            comment: chosenLabel,
            zIndex: getNextTopZIndex(prev, pageNumber),
          },
        ],
      }));
      setSelectedElement({ kind: 'annotation', id: newId });
      if (!keepToolActive) setActiveTool('select');
      return;
    }

    if (activeTool === 'signature') {
      if (!pendingSig) {
        setShowSigModal(true);
        return;
      }
      const newId = nextElementId('sig');
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: newId,
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
            zIndex: getNextTopZIndex(prev, pageNumber),
          },
        ],
      }));
      setSelectedElement({ kind: 'annotation', id: newId });
      if (!keepToolActive) setActiveTool('select');
      flashStatus(language === 'bn' ? 'স্বাক্ষর যুক্ত হয়েছে' : 'Signature placed on page', 2000);
    }
  };

  const handleOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) {
      handleOverlayPointerCancel();
      return;
    }

    if (activeTool === 'whiteout' && eyedropperActive) {
      e.preventDefault();
      e.stopPropagation();
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      const picked = sampleCanvasPointHex(pt);
      setWhiteoutColor(picked);
      setEyedropperActive(false);
      flashStatus(`${language === 'bn' ? 'রঙ নির্বাচিত:' : 'Color picked:'} ${picked}`, 2000);
      return;
    }

    if (activeTool === 'eraser') {
      e.preventDefault();
      e.stopPropagation();
      tryCapturePointer(e.currentTarget, e.pointerId);
      capturePreGestureSnapshot();
      erasingActiveRef.current = true;
      erasedAnythingRef.current = false;
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      setEraserCursor(pt);
      eraseAtPoint(pt);
      return;
    }

    if (
      activeTool === 'editText' &&
      e.target === overlayRef.current &&
      (editBoxDrawMode || e.pointerType === 'mouse')
    ) {
      e.preventDefault();
      e.stopPropagation();
      setSelectedElements([]);
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      tryCapturePointer(e.currentTarget, e.pointerId);
      dragStartRef.current = pt;
      const initialBox = { x: pt.x, y: pt.y, w: 0, h: 0 };
      liveBoxRef.current = initialBox;
      setLiveBox(initialBox);
      return;
    }

    if (
      activeTool === 'select' &&
      e.target === overlayRef.current &&
      (e.pointerType === 'mouse' || multiSelectMode)
    ) {
      e.preventDefault();
      e.stopPropagation();
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      tryCapturePointer(e.currentTarget, e.pointerId);
      dragStartRef.current = pt;
      const initMarquee = { x: pt.x, y: pt.y, w: 0, h: 0 };
      marqueeBoxRef.current = initMarquee;
      setMarqueeBox(initMarquee);
      return;
    }

    if (!isDragStrokeTool) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedElements([]);
    const pt = toUnscaledCoords(e.clientX, e.clientY);

    tryCapturePointer(e.currentTarget, e.pointerId);
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
      const newW = Math.round(Math.max(70, Math.min(pageSize.width - 20, resizingTextBox.origW + dx)));
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
      const { handle, lockAspect, origX, origY, origW, origH } = resizingImage;
      const aspect = origW / Math.max(1, origH);
      const isEdge = handle === 'n' || handle === 's' || handle === 'e' || handle === 'w';

      let newX = origX;
      let newY = origY;
      let newW = origW;
      let newH = origH;

      if (isEdge || !lockAspect) {
        if (handle.includes('e')) {
          newW = Math.max(20, Math.min(pageSize.width - origX, origW + dx));
        }
        if (handle.includes('s')) {
          newH = Math.max(20, Math.min(pageSize.height - origY, origH + dy));
        }
        if (handle.includes('w')) {
          const clampedX = Math.max(0, Math.min(origX + origW - 20, origX + dx));
          newW = origW + (origX - clampedX);
          newX = clampedX;
        }
        if (handle.includes('n')) {
          const clampedY = Math.max(0, Math.min(origY + origH - 20, origY + dy));
          newH = origH + (origY - clampedY);
          newY = clampedY;
        }
      } else {
        if (handle === 'se') {
          newW = Math.max(
            24,
            Math.min(
              pageSize.width - origX,
              origW + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * aspect)
            )
          );
        } else if (handle === 'ne') {
          newW = Math.max(
            24,
            Math.min(
              pageSize.width - origX,
              origW + (Math.abs(dx) >= Math.abs(dy) ? dx : -dy * aspect)
            )
          );
        } else if (handle === 'sw') {
          const deltaW = Math.abs(dx) >= Math.abs(dy) ? -dx : dy * aspect;
          newW = Math.max(24, Math.min(origX + origW, origW + deltaW));
          newX = origX + (origW - newW);
        } else if (handle === 'nw') {
          const deltaW = Math.abs(dx) >= Math.abs(dy) ? -dx : -dy * aspect;
          newW = Math.max(24, Math.min(origX + origW, origW + deltaW));
          newX = origX + (origW - newW);
        }
        newH = Math.max(24, newW / aspect);
        if (handle === 'ne' || handle === 'nw') {
          newY = Math.max(0, origY + (origH - newH));
        }
      }

      setState((prev) => ({
        ...prev,
        addedImages: prev.addedImages.map((im) =>
          im.id === resizingImage.id
            ? {
                ...im,
                x: Math.round(newX),
                y: Math.round(newY),
                width: Math.round(newW),
                height: Math.round(newH),
              }
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

          if (an.kind === 'signature') {
            const aspect = origW / Math.max(1, origH);
            const nw = Math.max(40, Math.min(pageSize.width - origX, origW + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * aspect)));
            const nh = Math.max(20, nw / aspect);
            return { ...an, width: Math.round(nw), height: Math.round(nh) };
          }

          const minW = an.kind === 'sticky' ? 92 : an.kind === 'stamp' ? 68 : 14;
          const minH = an.kind === 'sticky' ? 44 : an.kind === 'stamp' ? 22 : 10;
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
      if (Math.hypot(rawDx, rawDy) > 4) {
        pointerMovedRef.current = true;
      }
      const dx = rawDx / scale;
      const dy = rawDy / scale;
      let nx = Math.max(0, Math.min(pageSize.width - 20, draggingItem.origX + dx));
      let ny = Math.max(0, Math.min(pageSize.height - 20, draggingItem.origY + dy));

      // Gentle magnetic snap to page center & 24pt margins for crisp placement
      let itemW = 0;
      let itemH = 0;
      let canSnap = true;
      if (draggingItem.kind === 'image') {
        const im = stateRef.current.addedImages.find((x) => x.id === draggingItem.id);
        itemW = im?.width || 0;
        itemH = im?.height || 0;
      } else if (draggingItem.kind === 'textBox') {
        const tb = stateRef.current.addedTexts.find((x) => x.id === draggingItem.id);
        itemW = tb?.width || 0;
        itemH = tb ? tb.fontSize * 1.4 : 0;
      } else {
        const an = stateRef.current.annotations.find((x) => x.id === draggingItem.id);
        if (!an || an.kind === 'freehand' || an.kind === 'arrow') canSnap = false;
        else {
          itemW = Math.abs(an.width || 0);
          itemH = Math.abs(an.height || 0);
        }
      }

      let gx: number | undefined;
      let gy: number | undefined;
      if (canSnap && itemW > 0 && pointerMovedRef.current) {
        const cx = nx + itemW / 2;
        const pageCx = pageSize.width / 2;
        if (Math.abs(cx - pageCx) <= 4.5) {
          nx = pageCx - itemW / 2;
          gx = pageCx;
        } else if (Math.abs(nx - 24) <= 4) {
          nx = 24;
          gx = 24;
        } else if (Math.abs(nx + itemW - (pageSize.width - 24)) <= 4) {
          nx = pageSize.width - 24 - itemW;
          gx = pageSize.width - 24;
        }
        const cy = ny + itemH / 2;
        const pageCy = pageSize.height / 2;
        if (itemH > 0 && Math.abs(cy - pageCy) <= 4.5) {
          ny = pageCy - itemH / 2;
          gy = pageCy;
        }
      }
      setSnapGuides(gx !== undefined || gy !== undefined ? { x: gx, y: gy } : null);

      const actualDx = nx - draggingItem.origX;
      const actualDy = ny - draggingItem.origY;
      const origsList =
        draggingItem.multiOrigs && draggingItem.multiOrigs.length > 0
          ? draggingItem.multiOrigs
          : [
              {
                kind: draggingItem.kind,
                id: draggingItem.id,
                origX: draggingItem.origX,
                origY: draggingItem.origY,
                origPoints: draggingItem.origPoints,
                origTipX: draggingItem.origTipX,
                origTipY: draggingItem.origTipY,
              },
            ];
      const imgOrigMap = new Map(origsList.filter((o) => o.kind === 'image').map((o) => [o.id, o]));
      const tbOrigMap = new Map(origsList.filter((o) => o.kind === 'textBox').map((o) => [o.id, o]));
      const annOrigMap = new Map(origsList.filter((o) => o.kind === 'annotation').map((o) => [o.id, o]));

      setState((prev) => ({
        ...prev,
        addedImages:
          imgOrigMap.size > 0
            ? prev.addedImages.map((im) => {
                const o = imgOrigMap.get(im.id);
                if (!o) return im;
                return {
                  ...im,
                  x: Math.round(Math.max(0, Math.min(pageSize.width - 10, o.origX + actualDx))),
                  y: Math.round(Math.max(0, Math.min(pageSize.height - 10, o.origY + actualDy))),
                };
              })
            : prev.addedImages,
        addedTexts:
          tbOrigMap.size > 0
            ? prev.addedTexts.map((tb) => {
                const o = tbOrigMap.get(tb.id);
                if (!o) return tb;
                return {
                  ...tb,
                  x: Math.round(Math.max(0, Math.min(pageSize.width - 10, o.origX + actualDx))),
                  y: Math.round(Math.max(0, Math.min(pageSize.height - 10, o.origY + actualDy))),
                };
              })
            : prev.addedTexts,
        annotations:
          annOrigMap.size > 0
            ? prev.annotations.map((an) => {
                const o = annOrigMap.get(an.id);
                if (!o) return an;
                if (an.kind === 'freehand' && o.origPoints) {
                  return {
                    ...an,
                    points: o.origPoints.map((pt) => ({
                      x: pt.x + actualDx,
                      y: pt.y + actualDy,
                    })),
                  };
                }
                if (an.kind === 'sticky') {
                  return {
                    ...an,
                    x: Math.round(Math.max(0, Math.min(pageSize.width - 10, o.origX + actualDx))),
                    y: Math.round(Math.max(0, Math.min(pageSize.height - 10, o.origY + actualDy))),
                    ...(o.origTipX !== undefined && o.origTipY !== undefined
                      ? {
                          stickyTipX: Math.max(4, Math.min(pageSize.width - 4, o.origTipX + actualDx)),
                          stickyTipY: Math.max(4, Math.min(pageSize.height - 4, o.origTipY + actualDy)),
                        }
                      : {}),
                  };
                }
                return {
                  ...an,
                  x: Math.round(Math.max(0, Math.min(pageSize.width - 10, o.origX + actualDx))),
                  y: Math.round(Math.max(0, Math.min(pageSize.height - 10, o.origY + actualDy))),
                };
              })
            : prev.annotations,
      }));
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
    if (activeTool === 'select') {
      const pt = toUnscaledCoords(e.clientX, e.clientY);
      const sx = dragStartRef.current.x;
      const sy = dragStartRef.current.y;
      const mBox = {
        x: Math.min(sx, pt.x),
        y: Math.min(sy, pt.y),
        w: Math.abs(pt.x - sx),
        h: Math.abs(pt.y - sy),
      };
      marqueeBoxRef.current = mBox;
      setMarqueeBox(mBox);
      return;
    }
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
      } else if (activeTool === 'underline') {
        // Keep underline strictly horizontal at the traced finger/cursor Y line
        box = {
          x: Math.min(sx, pt.x),
          y: pt.y - 2,
          w: Math.abs(pt.x - sx),
          h: 2,
        };
      } else if (activeTool === 'strike') {
        box = {
          x: Math.min(sx, pt.x),
          y: pt.y - 1,
          w: Math.abs(pt.x - sx),
          h: 2,
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
    setSnapGuides(null);
    erasingActiveRef.current = false;
    erasedAnythingRef.current = false;
    setEraserCursor(null);
    preGestureSnapshotRef.current = null;
    dragStartRef.current = null;
    liveFreehandRef.current = [];
    liveBoxRef.current = null;
    marqueeBoxRef.current = null;
    setLiveFreehand([]);
    setLiveBox(null);
    setMarqueeBox(null);
  };

  const handleOverlayPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
    setSnapGuides(null);
    if (draggingStickyTip) {
      lastGestureEndTsRef.current = performance.now();
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        pushUndoSnapshot(preGestureSnapshotRef.current);
      }
      preGestureSnapshotRef.current = null;
      setDraggingStickyTip(null);
      return;
    }
    if (resizingTextBox) {
      lastGestureEndTsRef.current = performance.now();
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        pushUndoSnapshot(preGestureSnapshotRef.current);
      }
      preGestureSnapshotRef.current = null;
      setResizingTextBox(null);
      return;
    }
    if (resizingImage) {
      lastGestureEndTsRef.current = performance.now();
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        pushUndoSnapshot(preGestureSnapshotRef.current);
      }
      preGestureSnapshotRef.current = null;
      setResizingImage(null);
      return;
    }
    if (resizingAnnotation) {
      lastGestureEndTsRef.current = performance.now();
      if (pointerMovedRef.current && preGestureSnapshotRef.current) {
        pushUndoSnapshot(preGestureSnapshotRef.current);
      }
      preGestureSnapshotRef.current = null;
      setResizingAnnotation(null);
      return;
    }
    if (draggingItem) {
      lastGestureEndTsRef.current = performance.now();
      const wasTap = !pointerMovedRef.current;
      const item = draggingItem;
      if (!wasTap && preGestureSnapshotRef.current) {
        pushUndoSnapshot(preGestureSnapshotRef.current);
      }
      preGestureSnapshotRef.current = null;
      setDraggingItem(null);
      if (wasTap) {
        if (item.toggleOffOnTap) {
          setSelectedElements((prev) =>
            prev.filter((s) => !(s.kind === item.kind && s.id === item.id))
          );
          return;
        }
        if (!multiSelectMode && selectedElements.length > 1) {
          setSelectedElement({ kind: item.kind, id: item.id });
          return;
        }
        if (!multiSelectMode) {
          setSelectedElement({ kind: item.kind, id: item.id });
          // Tap once to select & reveal resize/editing controls; tap again (already selected) to open quick editor
          if (item.wasSelectedBeforeDown) {
            if (item.kind === 'image') {
              capturePreGestureSnapshot();
              setShowImageAdjustModal(true);
            } else if (item.kind === 'textBox') {
              const tb = stateRef.current.addedTexts.find((x) => x.id === item.id);
              if (tb) openEditAddedTextBox(tb);
            } else if (item.kind === 'annotation') {
              const ann = stateRef.current.annotations.find((x) => x.id === item.id);
              if (ann?.kind === 'sticky') openEditStickyNote(ann);
              else if (ann?.kind === 'stamp') openEditStamp(ann);
            }
          }
        }
      }
      return;
    }
    if (erasingActiveRef.current) {
      lastGestureEndTsRef.current = performance.now();
      erasingActiveRef.current = false;
      if (erasedAnythingRef.current && preGestureSnapshotRef.current) {
        pushUndoSnapshot(preGestureSnapshotRef.current);
      }
      erasedAnythingRef.current = false;
      preGestureSnapshotRef.current = null;
      return;
    }

    if (!dragStartRef.current) return;
    if (activeTool === 'select') {
      const mBox = marqueeBoxRef.current;
      dragStartRef.current = null;
      marqueeBoxRef.current = null;
      setMarqueeBox(null);
      if (mBox && (mBox.w > 6 || mBox.h > 6)) {
        lastGestureEndTsRef.current = performance.now();
        const unified = buildUnifiedPageItems(stateRef.current, pageNumber);
        const hits: SelectedElementRef[] = [];
        for (const u of unified) {
          const b = getElementBounds(u.kind, u.item);
          const overlaps =
            b.x <= mBox.x + mBox.w &&
            b.x + b.w >= mBox.x &&
            b.y <= mBox.y + mBox.h &&
            b.y + b.h >= mBox.y;
          if (overlaps) hits.push({ kind: u.kind, id: u.id });
        }
        if (e?.shiftKey || multiSelectMode) {
          setSelectedElements((prev) => {
            const seen = new Set(prev.map((s) => `${s.kind}:${s.id}`));
            const merged = [...prev];
            for (const h of hits) {
              if (!seen.has(`${h.kind}:${h.id}`)) merged.push(h);
            }
            return merged;
          });
        } else {
          setSelectedElements(hits);
        }
      } else if (!multiSelectMode && !e?.shiftKey) {
        setSelectedElements([]);
      }
      return;
    }

    const finalPts = liveFreehandRef.current;
    const finalBox = liveBoxRef.current;

    if (activeTool === 'editText' && finalBox && Math.abs(finalBox.w) > 8 && Math.abs(finalBox.h) > 6) {
      lastGestureEndTsRef.current = performance.now();
      const bx = Math.min(finalBox.x, finalBox.x + finalBox.w);
      const by = Math.min(finalBox.y, finalBox.y + finalBox.h);
      const bw = Math.abs(finalBox.w);
      const bh = Math.abs(finalBox.h);
      const customRun: ExtractedTextRun = {
        id: nextElementId(`custom_run_${pageNumber}`),
        pageNumber,
        str: '',
        x: bx,
        y: by,
        width: Math.max(14, bw),
        height: Math.max(10, bh),
        fontSize: Math.max(6, Math.min(44, Math.round(bh * 0.78))),
        fontName: 'Arial',
      };
      dragStartRef.current = null;
      liveFreehandRef.current = [];
      liveBoxRef.current = null;
      setLiveFreehand([]);
      setLiveBox(null);
      handleOpenTextRunEditor(customRun);
      return;
    }

    if (activeTool === 'draw' && finalPts.length >= 1) {
      lastGestureEndTsRef.current = performance.now();
      const strokePts =
        finalPts.length === 1
          ? [finalPts[0], { x: finalPts[0].x + 0.5, y: finalPts[0].y + 0.5 }]
          : finalPts;
      commitState((prev) => ({
        ...prev,
        annotations: [
          ...prev.annotations,
          {
            id: nextElementId('ann'),
            pageNumber,
            kind: 'freehand',
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            color: activeColor,
            strokeWidth,
            opacity: penOpacity,
            points: strokePts,
            zIndex: getNextTopZIndex(prev, pageNumber),
          },
        ],
      }));
    } else if (finalBox && (Math.abs(finalBox.w) > 5 || Math.abs(finalBox.h) > 5)) {
      lastGestureEndTsRef.current = performance.now();
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
            ? 2
            : kind === 'arrow'
            ? finalBox.h
            : Math.max(10, finalBox.h);
        const newAnnId = nextElementId('ann');
        commitState((prev) => ({
          ...prev,
          annotations: [
            ...prev.annotations,
            {
              id: newAnnId,
              pageNumber,
              kind,
              x: finalBox.x,
              y: finalBox.y,
              width: kind === 'arrow' ? finalBox.w : Math.max(10, finalBox.w),
              height: finalH,
              color: kind === 'whiteout' ? whiteoutColor : activeColor,
              strokeWidth,
              opacity: kind === 'highlight' ? highlightOpacity : 1,
              lineStyle:
                kind === 'rect' || kind === 'circle' || kind === 'arrow' ? lineStyle : undefined,
              arrowStyle: kind === 'arrow' ? arrowStyle : undefined,
              fillColor:
                kind === 'whiteout'
                  ? whiteoutColor
                  : (kind === 'rect' || kind === 'circle') && shapeFilled
                  ? activeColor
                  : undefined,
              zIndex: getNextTopZIndex(prev, pageNumber),
            },
          ],
        }));
        setSelectedElement({ kind: 'annotation', id: newAnnId });
        if (!keepToolActive) {
          setActiveTool('select');
        }
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
    const existing = stateRef.current.replacements.find((r) => r.runId === run.id);
    setEditingRun(run);
    setRunDraft({
      text: existing ? existing.newText : run.str,
      fontSize: existing ? existing.fontSize : Math.round(run.fontSize),
      fontFamily: existing?.fontFamily || inferOfficialFontFromPdfName(run.fontName),
      color: existing?.color || '#1E293B',
      backgroundColor: existing?.backgroundColor || sampleCanvasBgHex(run),
      bold: existing?.bold || false,
      italic: existing?.italic || false,
      underline: existing?.underline || false,
      align: existing?.align || 'left',
      letterSpacing: existing?.letterSpacing || 0,
      dx: existing ? Math.round(existing.x - run.x) : 0,
      dy: existing ? Math.round(existing.y - run.y) : 0,
    });
  };

  const openRunEditorRef = useRef(handleOpenTextRunEditor);
  openRunEditorRef.current = handleOpenTextRunEditor;
  const handleSelectRunStable = useCallback((run: ExtractedTextRun) => {
    openRunEditorRef.current(run);
  }, []);

  const handleScanMissingTextOcr = async () => {
    if (ocrScanning) return;
    setOcrScanning(true);
    setStatusMessage(
      language === 'bn' ? 'অদৃশ্য/ইমেজ টেক্সট স্ক্যান হচ্ছে...' : 'Scanning missing text...'
    );
    try {
      const offscreen = document.createElement('canvas');
      const res = await renderPageToCanvas(basePdfRef.current.bytes, pageNumber, offscreen, 2.0);
      const existingAll = [...textRuns, ...(ocrScannedPages[pageNumber] || [])];
      const found = await detectOcrLineRuns(
        offscreen,
        pageNumber,
        res.unscaledWidth,
        res.unscaledHeight,
        existingAll,
        'eng+ben'
      );
      if (found.length > 0) {
        setOcrScannedPages((prev) => ({
          ...prev,
          [pageNumber]: [...(prev[pageNumber] || []), ...found],
        }));
        flashStatus(
          language === 'bn'
            ? `আরও ${found.length}টি টেক্সট লাইন পাওয়া গেছে`
            : `Found ${found.length} more editable lines`,
          3200
        );
      } else {
        flashStatus(
          language === 'bn'
            ? 'সব টেক্সট চিহ্নিত আছে — প্রয়োজনে "বক্স এঁকে এডিট" ব্যবহার করুন'
            : 'All text detected — use Box Select for any custom area',
          3200
        );
      }
    } catch {
      flashStatus(language === 'bn' ? 'টেক্সট স্ক্যান ব্যর্থ হয়েছে' : 'OCR scan failed', 2600);
    } finally {
      setOcrScanning(false);
    }
  };

  const handleApplyRunReplacement = (deleted: boolean) => {
    if (!editingRun) return;
    const baseRun = textRuns.find((r) => r.id === editingRun.id) || (ocrScannedPages[pageNumber] || []).find((r) => r.id === editingRun.id) || editingRun;
    const nextRepId = nextElementId('rep');
    commitState((prev) => {
      const filtered = prev.replacements.filter((r) => r.runId !== editingRun.id);
      return {
        ...prev,
        replacements: [
          ...filtered,
          {
            id: nextRepId,
            runId: editingRun.id,
            pageNumber,
            originalText: baseRun.str,
            newText: runDraft.text,
            deleted,
            x: Math.max(0, baseRun.x + runDraft.dx),
            y: Math.max(0, baseRun.y + runDraft.dy),
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

  const handleRestoreRunOriginal = () => {
    if (!editingRun) return;
    commitState((prev) => ({
      ...prev,
      replacements: prev.replacements.filter((r) => r.runId !== editingRun.id),
    }));
    setEditingRun(null);
  };

  const handleImageFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const targetPage = pageNumber;
    const targetPageW = pageSize.width;
    const targetPageH = pageSize.height;
    const reader = new FileReader();
    reader.onload = () => {
      if (!isMountedRef.current) return;
      const rawUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        if (!isMountedRef.current) return;
        const natW = Math.max(1, img.naturalWidth || 180);
        const natH = Math.max(1, img.naturalHeight || 140);
        const maxDim = 1800;
        const ratio = Math.min(1, maxDim / Math.max(natW, natH));
        const cw = Math.max(1, Math.round(natW * ratio));
        const ch = Math.max(1, Math.round(natH * ratio));
        let finalUrl = rawUrl;
        if ((!rawUrl.startsWith('data:image/png') && !rawUrl.startsWith('data:image/jpeg')) || ratio < 1) {
          const c = document.createElement('canvas');
          c.width = cw;
          c.height = ch;
          c.getContext('2d')!.drawImage(img, 0, 0, cw, ch);
          finalUrl = c.toDataURL('image/png');
        }
        const w = Math.min(220, natW);
        const h = Math.max(24, Math.round((w / natW) * natH));
        const newId = nextElementId('img');
        closeActiveModals();
        commitState((prev) => ({
          ...prev,
          addedImages: [
            ...prev.addedImages,
            {
              id: newId,
              pageNumber: targetPage,
              dataUrl: finalUrl,
              x: Math.max(16, Math.round((targetPageW - w) / 2)),
              y: Math.max(24, Math.round((targetPageH - h) / 3)),
              width: w,
              height: h,
              rotation: 0,
              zIndex: getNextTopZIndex(prev, targetPage),
            },
          ],
        }));
        setSelectedElement({ kind: 'image', id: newId });
        setActiveTool('select');
        flashStatus(t.editor.tapSelectedHint, 2400);
      };
      img.src = rawUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (mode: 'version' | 'copy' | 'download', closeAfter = false) => {
    setSaving(true);
    try {
      const baseBytesSnapshot = cloneBuffer(basePdfRef.current.bytes);
      const stateSnapshot = cloneEditorState(stateRef.current) || {
        replacements: [],
        addedTexts: [],
        addedImages: [],
        annotations: [],
      };
      const editedBytes = await applyPdfEditsToBytes(baseBytesSnapshot, stateSnapshot);
      const seal = pendingSig?.attachIntegritySeal
        ? await computeSha256Hex(editedBytes)
        : doc.sha256Seal;

      if (mode === 'download') {
        await saveBufferToDeviceStorage(
          editedBytes,
          doc.name.replace(/\.pdf$/i, '_edited.pdf'),
          'application/pdf'
        );
        flashStatus(language === 'bn' ? 'এক্সপোর্ট সম্পন্ন হয়েছে' : 'Exported modified PDF', 2600);
        return;
      }

      const thumb = await renderPageThumbnail(editedBytes, 1, 200).catch(() => doc.thumbnailDataUrl);
      const now = Date.now();
      const summaryCounts = `${stateSnapshot.replacements.length} text edits, ${stateSnapshot.addedTexts.length} text boxes, ${stateSnapshot.addedImages.length} images, ${stateSnapshot.annotations.length} annotations`;

      if (mode === 'version') {
        const updated: DocumentRecord = {
          ...doc,
          origin: 'edited',
          updatedAt: now,
          sizeBytes: editedBytes.byteLength,
          thumbnailDataUrl: thumb,
          pdfBytes: cloneBuffer(editedBytes),
          basePdfBytes: cloneBuffer(baseBytesSnapshot),
          editorState: cloneEditorState(stateSnapshot),
          sha256Seal: seal,
          versions: [
            {
              id: `ver_${now}`,
              timestamp: now,
              note: `Edited (${summaryCounts})`,
              sizeBytes: editedBytes.byteLength,
              pdfBytes: cloneBuffer(editedBytes),
              editorState: cloneEditorState(stateSnapshot),
            },
            ...doc.versions,
          ],
        };
        await onSaveNewVersion(updated);
        setSavedSnapshot(stateRef.current);
        if (closeAfter) {
          onClose();
        } else {
          flashStatus(t.editor.savedStayHint, 3200);
        }
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
          basePdfBytes: cloneBuffer(baseBytesSnapshot),
          editorState: cloneEditorState(stateSnapshot),
          sha256Seal: seal,
          versions: [
            {
              id: `ver_${now}`,
              timestamp: now,
              note: 'Saved as edited copy',
              sizeBytes: editedBytes.byteLength,
              pdfBytes: cloneBuffer(editedBytes),
              editorState: cloneEditorState(stateSnapshot),
            },
          ],
        };
        await onSaveAsCopy(copyDoc);
        if (closeAfter) {
          onClose();
        } else {
          flashStatus(t.editor.savedCopyStayHint, 3200);
        }
      }
    } catch (err) {
      flashStatus(err instanceof Error ? err.message : 'Failed to save PDF edits', 3200);
    } finally {
      setSaving(false);
    }
  };

  const hasAnyEdits =
    state.replacements.length > 0 ||
    state.addedTexts.length > 0 ||
    state.addedImages.length > 0 ||
    state.annotations.length > 0;
  const hasUnsavedChanges = savedSnapshot
    ? state.replacements !== savedSnapshot.replacements ||
      state.addedTexts !== savedSnapshot.addedTexts ||
      state.addedImages !== savedSnapshot.addedImages ||
      state.annotations !== savedSnapshot.annotations
    : hasAnyEdits;

  const handleRequestClose = () => {
    if (hasUnsavedChanges) {
      setShowExitConfirm(true);
    } else {
      onClose();
    }
  };

  const pageReplacements = useMemo(
    () => state.replacements.filter((r) => r.pageNumber === pageNumber),
    [state.replacements, pageNumber]
  );
  const replacedRunIds = useMemo(
    () => new Set(pageReplacements.map((r) => r.runId)),
    [pageReplacements]
  );
  const displayedTextRuns = useMemo(
    () => [...textRuns, ...(ocrScannedPages[pageNumber] || [])],
    [textRuns, ocrScannedPages, pageNumber]
  );
  const pageAddedTexts = state.addedTexts.filter((tb) => tb.pageNumber === pageNumber);
  const pageAddedImages = state.addedImages.filter((im) => im.pageNumber === pageNumber);
  const pageAnnotations = state.annotations.filter((an) => an.pageNumber === pageNumber);
  const pageErasableCount = pageAnnotations.filter((a) => isErasableAnnotation(a, eraserIncludeAll)).length;

  const selectedImg = pageAddedImages.find((i) => i.id === selectedImageId);
  const selectedTextBox =
    selectedElement?.kind === 'textBox'
      ? pageAddedTexts.find((tb) => tb.id === selectedElement.id)
      : undefined;
  const selectedAnn =
    selectedElement?.kind === 'annotation'
      ? pageAnnotations.find((an) => an.id === selectedElement.id)
      : undefined;

  const toolsList: Array<{ id: EditorTool; label: string; category: 'core' | 'draw' | 'markup' | 'shapes' | 'insert'; icon: React.ReactNode }> = [
    { id: 'select', label: t.editor.tools.select, category: 'core', icon: <MousePointer2 className="w-4 h-4" /> },
    { id: 'pan', label: t.editor.tools.pan, category: 'core', icon: <Hand className="w-4 h-4" /> },
    { id: 'editText', label: t.editor.tools.selectText, category: 'core', icon: <MousePointer className="w-4 h-4" /> },
    { id: 'addText', label: t.editor.tools.addText, category: 'core', icon: <TypeIcon className="w-4 h-4" /> },
    { id: 'draw', label: t.editor.tools.draw, category: 'draw', icon: <Pen className="w-4 h-4" /> },
    { id: 'eraser', label: t.editor.tools.eraser, category: 'draw', icon: <Eraser className="w-4 h-4" /> },
    { id: 'highlight', label: t.editor.tools.highlight, category: 'markup', icon: <Highlighter className="w-4 h-4" /> },
    { id: 'underline', label: t.editor.tools.underline, category: 'markup', icon: <Underline className="w-4 h-4" /> },
    { id: 'strike', label: t.editor.tools.strike, category: 'markup', icon: <Strikethrough className="w-4 h-4" /> },
    { id: 'rect', label: t.editor.tools.rect, category: 'shapes', icon: <Square className="w-4 h-4" /> },
    { id: 'circle', label: t.editor.tools.circle, category: 'shapes', icon: <Circle className="w-4 h-4" /> },
    { id: 'arrow', label: t.editor.tools.arrow, category: 'shapes', icon: <ArrowUpRight className="w-4 h-4" /> },
    { id: 'whiteout', label: t.editor.tools.whiteout, category: 'shapes', icon: <Square className="w-4 h-4 fill-current" /> },
    { id: 'addImage', label: t.editor.tools.addImage, category: 'insert', icon: <ImagePlus className="w-4 h-4" /> },
    { id: 'sticky', label: t.editor.tools.sticky, category: 'insert', icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'signature', label: t.editor.tools.signature, category: 'insert', icon: <PenTool className="w-4 h-4" /> },
    { id: 'stamp', label: t.editor.tools.stamp, category: 'insert', icon: <Calendar className="w-4 h-4" /> },
  ];

  const handleFitWidth = () => {
    const sc = canvasScrollRef.current;
    const avail = sc ? Math.max(240, sc.clientWidth - 28) : (typeof window !== 'undefined' ? window.innerWidth - 28 : 595);
    const next = Math.max(0.4, Math.min(2.5, Number((avail / Math.max(100, pageSize.width)).toFixed(2))));
    setScale(next);
  };

  // Existing elements ignore pointers while drawing/stroking/erasing/eyedropper so you can draw smoothly over anything
  const lockExistingElements = isDragStrokeTool || activeTool === 'eraser';

  const unifiedPageItems = useMemo(
    () => buildUnifiedPageItems(state, pageNumber),
    [state, pageNumber]
  );
  const behindPageItems = useMemo(
    () => unifiedPageItems.filter((u) => u.behind),
    [unifiedPageItems]
  );
  const frontPageItems = useMemo(
    () => unifiedPageItems.filter((u) => !u.behind),
    [unifiedPageItems]
  );
  const hasMultiSelection = selectedElements.length > 1;
  const showContextualSubBar =
    Boolean(hasMultiSelection || selectedImg || selectedTextBox || selectedAnn) || activeTool !== 'pan';
  const multiSelectedTextCount = selectedElements.filter((s) => s.kind === 'textBox').length;
  const multiSelectedImgCount = selectedElements.filter((s) => s.kind === 'image').length;
  const multiSelectedAnnCount = selectedElements.filter((s) => s.kind === 'annotation').length;
  const allSelectedBehind = useMemo(() => {
    if (selectedElements.length === 0) return false;
    return selectedElements.every((s) => {
      if (s.kind === 'textBox') return pageAddedTexts.find((x) => x.id === s.id)?.layerPlacement === 'behind';
      if (s.kind === 'image') return pageAddedImages.find((x) => x.id === s.id)?.layerPlacement === 'behind';
      return pageAnnotations.find((x) => x.id === s.id)?.layerPlacement === 'behind';
    });
  }, [selectedElements, pageAddedTexts, pageAddedImages, pageAnnotations]);

  const startElementPointerDown = (
    e: React.PointerEvent,
    kind: SelectedElementRef['kind'],
    id: string,
    origX: number,
    origY: number,
    opts?: { origPoints?: Array<{ x: number; y: number }>; origTipX?: number; origTipY?: number }
  ) => {
    if (lockExistingElements || eyedropperActive) return;
    e.stopPropagation();
    pointerMovedRef.current = false;
    capturePreGestureSnapshot();
    const toggleRequested = e.shiftKey || e.ctrlKey || e.metaKey || multiSelectMode;
    const wasSelected = isElementSelected(kind, id);
    let activeSel: SelectedElementRef[];
    if (wasSelected) {
      activeSel = selectedElements;
    } else if (toggleRequested) {
      activeSel = [...selectedElements, { kind, id }];
      setSelectedElements(activeSel);
    } else {
      activeSel = [{ kind, id }];
      setSelectedElements(activeSel);
    }
    const curSnap = stateRef.current;
    const multiOrigs = activeSel.map((sel) => {
      if (sel.kind === 'image') {
        const im = curSnap.addedImages.find((x) => x.id === sel.id);
        return { kind: 'image' as const, id: sel.id, origX: im?.x ?? 0, origY: im?.y ?? 0 };
      }
      if (sel.kind === 'textBox') {
        const tb = curSnap.addedTexts.find((x) => x.id === sel.id);
        return { kind: 'textBox' as const, id: sel.id, origX: tb?.x ?? 0, origY: tb?.y ?? 0 };
      }
      const an = curSnap.annotations.find((x) => x.id === sel.id);
      return {
        kind: 'annotation' as const,
        id: sel.id,
        origX: an?.x ?? 0,
        origY: an?.y ?? 0,
        origPoints: an?.points ? an.points.map((p) => ({ ...p })) : undefined,
        origTipX: an?.stickyTipX,
        origTipY: an?.stickyTipY,
      };
    });
    tryCapturePointer(overlayRef.current, e.pointerId);
    setDraggingItem({
      kind,
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX,
      origY,
      wasSelectedBeforeDown: wasSelected,
      toggleOffOnTap: wasSelected && toggleRequested,
      origPoints: opts?.origPoints,
      origTipX: opts?.origTipX,
      origTipY: opts?.origTipY,
      multiOrigs,
    });
  };

  const duplicateSelectedElement = () => {
    if (selectedElements.length === 0) return;
    const newRefs: SelectedElementRef[] = [];
    commitState((prev) => {
      let nextZ = getNextTopZIndex(prev, pageNumber);
      const addedImgs: AddedImageOverlay[] = [];
      const addedTbs: AddedTextBox[] = [];
      const addedAnns: AnnotationOverlay[] = [];

      for (const sel of selectedElements) {
        if (sel.kind === 'image') {
          const src = prev.addedImages.find((im) => im.id === sel.id);
          if (!src) continue;
          const newId = nextElementId('img');
          newRefs.push({ kind: 'image', id: newId });
          addedImgs.push({
            ...src,
            id: newId,
            x: Math.min(pageSize.width - 40, src.x + 18),
            y: Math.min(pageSize.height - 40, src.y + 18),
            zIndex: nextZ,
          });
          nextZ += 10;
        } else if (sel.kind === 'textBox') {
          const src = prev.addedTexts.find((tb) => tb.id === sel.id);
          if (!src) continue;
          const newId = nextElementId('tb');
          newRefs.push({ kind: 'textBox', id: newId });
          addedTbs.push({
            ...src,
            id: newId,
            x: Math.min(pageSize.width - 40, src.x + 18),
            y: Math.min(pageSize.height - 40, src.y + 18),
            zIndex: nextZ,
          });
          nextZ += 10;
        } else {
          const src = prev.annotations.find((an) => an.id === sel.id);
          if (!src) continue;
          const newId = nextElementId('ann');
          newRefs.push({ kind: 'annotation', id: newId });
          addedAnns.push({
            ...src,
            id: newId,
            x: Math.min(pageSize.width - 30, src.x + 18),
            y: Math.min(pageSize.height - 30, src.y + 18),
            points: src.points?.map((p) => ({ x: p.x + 18, y: p.y + 18 })),
            stickyTipX:
              src.stickyTipX !== undefined ? Math.min(pageSize.width - 8, src.stickyTipX + 18) : undefined,
            stickyTipY:
              src.stickyTipY !== undefined ? Math.min(pageSize.height - 8, src.stickyTipY + 18) : undefined,
            zIndex: nextZ,
          });
          nextZ += 10;
        }
      }
      return {
        ...prev,
        addedImages: [...prev.addedImages, ...addedImgs],
        addedTexts: [...prev.addedTexts, ...addedTbs],
        annotations: [...prev.annotations, ...addedAnns],
      };
    });
    if (newRefs.length > 0) setSelectedElements(newRefs);
  };

  const batchDeleteSelected = () => {
    if (selectedElements.length === 0) return;
    const imgIds = new Set(selectedElements.filter((s) => s.kind === 'image').map((s) => s.id));
    const tbIds = new Set(selectedElements.filter((s) => s.kind === 'textBox').map((s) => s.id));
    const annIds = new Set(selectedElements.filter((s) => s.kind === 'annotation').map((s) => s.id));
    commitState((prev) => ({
      ...prev,
      addedImages: prev.addedImages.filter((im) => !imgIds.has(im.id)),
      addedTexts: prev.addedTexts.filter((tb) => !tbIds.has(tb.id)),
      annotations: prev.annotations.filter((an) => !annIds.has(an.id)),
    }));
    setSelectedElements([]);
  };

  const applyLayerAction = (action: LayerAction) => {
    if (selectedElements.length === 0) return;
    commitState((prev) => applyLayerActionToState(prev, pageNumber, selectedElements, action));
    if (action === 'behindContent') {
      flashStatus(t.editor.behindPageContent, 1600);
    } else if (action === 'frontContent') {
      flashStatus(t.editor.frontOfPageContent, 1600);
    }
  };

  const batchChangeColor = (color: string) => {
    if (selectedElements.length === 0) return;
    const tbIds = new Set(selectedElements.filter((s) => s.kind === 'textBox').map((s) => s.id));
    const annIds = new Set(selectedElements.filter((s) => s.kind === 'annotation').map((s) => s.id));
    commitState((prev) => ({
      ...prev,
      addedTexts: prev.addedTexts.map((tb) => (tbIds.has(tb.id) ? { ...tb, color } : tb)),
      annotations: prev.annotations.map((an) =>
        annIds.has(an.id) && an.kind !== 'whiteout' && an.kind !== 'signature'
          ? {
              ...an,
              color,
              fillColor: an.kind === 'sticky' ? an.fillColor : an.fillColor ? color : undefined,
            }
          : an
      ),
    }));
  };

  const batchAdjustFontSize = (delta: number) => {
    if (selectedElements.length === 0) return;
    const tbIds = new Set(selectedElements.filter((s) => s.kind === 'textBox').map((s) => s.id));
    const annIds = new Set(selectedElements.filter((s) => s.kind === 'annotation').map((s) => s.id));
    commitState((prev) => ({
      ...prev,
      addedTexts: prev.addedTexts.map((tb) =>
        tbIds.has(tb.id)
          ? { ...tb, fontSize: Math.max(8, Math.min(64, tb.fontSize + delta)) }
          : tb
      ),
      annotations: prev.annotations.map((an) => {
        if (!annIds.has(an.id)) return an;
        if (an.kind === 'sticky') {
          return { ...an, fontSize: Math.max(7, Math.min(22, (an.fontSize || 10) + delta)) };
        }
        if (an.kind === 'stamp') {
          const nextFs = Math.max(8, Math.min(24, (an.fontSize || 10) + delta));
          const sf = nextFs / (an.fontSize || 10);
          return {
            ...an,
            fontSize: nextFs,
            width: Math.max(72, Math.round((an.width || 96) * sf)),
            height: Math.max(22, Math.round((an.height || 28) * sf)),
          };
        }
        return an;
      }),
    }));
  };

  const batchToggleTextStyle = (prop: 'bold' | 'italic') => {
    if (selectedElements.length === 0) return;
    const tbIds = new Set(selectedElements.filter((s) => s.kind === 'textBox').map((s) => s.id));
    if (tbIds.size === 0) return;
    commitState((prev) => {
      const selectedTbs = prev.addedTexts.filter((tb) => tbIds.has(tb.id));
      const allActive = selectedTbs.length > 0 && selectedTbs.every((tb) => Boolean(tb[prop]));
      const nextVal = !allActive;
      return {
        ...prev,
        addedTexts: prev.addedTexts.map((tb) => (tbIds.has(tb.id) ? { ...tb, [prop]: nextVal } : tb)),
      };
    });
  };

  const batchCycleOpacity = () => {
    if (selectedElements.length === 0) return;
    const imgIds = new Set(selectedElements.filter((s) => s.kind === 'image').map((s) => s.id));
    const annIds = new Set(selectedElements.filter((s) => s.kind === 'annotation').map((s) => s.id));
    const steps = [1, 0.75, 0.5, 0.25];
    commitState((prev) => {
      const firstImg = prev.addedImages.find((im) => imgIds.has(im.id));
      const firstAnn = prev.annotations.find((an) => annIds.has(an.id));
      const curOp = firstImg?.opacity ?? firstAnn?.opacity ?? 1;
      const idx = steps.findIndex((s) => Math.abs(s - curOp) < 0.08);
      const nextOp = steps[(idx + 1) % steps.length];
      return {
        ...prev,
        addedImages: prev.addedImages.map((im) => (imgIds.has(im.id) ? { ...im, opacity: nextOp } : im)),
        annotations: prev.annotations.map((an) => (annIds.has(an.id) ? { ...an, opacity: nextOp } : an)),
      };
    });
  };

  const renderLayerControls = (isBehind: boolean) => (
    <div className="flex items-center gap-1 pl-1 border-l border-slate-200 dark:border-slate-700 shrink-0">
      <button
        type="button"
        onClick={() => applyLayerAction('forward')}
        title={t.editor.bringForward}
        aria-label={t.editor.bringForward}
        className="px-1.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-[#2563EB] shrink-0"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => applyLayerAction('backward')}
        title={t.editor.sendBackward}
        aria-label={t.editor.sendBackward}
        className="px-1.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-[#2563EB] shrink-0"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => applyLayerAction('front')}
        title={t.editor.bringFront}
        aria-label={t.editor.bringFront}
        className="px-1.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-[#2563EB] shrink-0"
      >
        <ArrowUpToLine className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => applyLayerAction('back')}
        title={t.editor.sendToBack}
        aria-label={t.editor.sendToBack}
        className="px-1.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-[#2563EB] shrink-0"
      >
        <ArrowDownToLine className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => applyLayerAction(isBehind ? 'frontContent' : 'behindContent')}
        title={isBehind ? t.editor.frontOfPageContent : t.editor.behindPageContent}
        className={`px-2 py-1 rounded-lg border flex items-center gap-1 font-semibold whitespace-nowrap shrink-0 ${
          isBehind
            ? 'bg-amber-500 text-white border-amber-500'
            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
        }`}
      >
        {isBehind ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        <span>{isBehind ? t.editor.frontOfPageContent : t.editor.behindPageContent}</span>
      </button>
    </div>
  );

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
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setPageJumpInput(String(pageNumber));
                  setShowPageJump((v) => !v);
                }}
                className="text-[11px] font-mono-nums text-slate-600 dark:text-slate-300 hover:text-[#2563EB] flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800"
              >
                <span>{t.viewer.page} {pageNumber}/{doc.pageCount}</span>
              </button>
              {showPageJump && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const parsed = parseInt(pageJumpInput, 10);
                    if (!Number.isNaN(parsed)) {
                      setPageNumber(Math.max(1, Math.min(doc.pageCount, parsed)));
                    }
                    setShowPageJump(false);
                  }}
                  className="absolute left-0 top-full mt-1.5 z-40 p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl flex items-center gap-1.5"
                >
                  <input
                    type="number"
                    min={1}
                    max={doc.pageCount}
                    value={pageJumpInput}
                    onChange={(e) => setPageJumpInput(e.target.value)}
                    autoFocus
                    className="w-16 h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-mono-nums"
                  />
                  <button
                    type="submit"
                    aria-label="Go to page"
                    className="h-8 px-2.5 rounded-lg bg-[#2563EB] text-white text-xs font-semibold flex items-center justify-center"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            aria-label={`${t.editor.undo} (${undoStack.length})`}
            title={`${t.editor.undo}${undoStack.length > 0 ? ` (${undoStack.length})` : ''}`}
            className="min-h-[42px] px-2 flex items-center justify-center gap-0.5 rounded-xl disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Undo2 className="w-4 h-4" />
            {undoStack.length > 0 && (
              <span className="text-[10px] font-mono-nums font-bold text-slate-500 dark:text-slate-400">
                {undoStack.length}
              </span>
            )}
          </button>
          <button
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            aria-label={`${t.editor.redo} (${redoStack.length})`}
            title={`${t.editor.redo}${redoStack.length > 0 ? ` (${redoStack.length})` : ''}`}
            className="min-h-[42px] px-2 flex items-center justify-center gap-0.5 rounded-xl disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Redo2 className="w-4 h-4" />
            {redoStack.length > 0 && (
              <span className="text-[10px] font-mono-nums font-bold text-slate-500 dark:text-slate-400">
                {redoStack.length}
              </span>
            )}
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

      {/* Diagnostic Banner & Zoom */}
      <div className="px-3 py-1.5 bg-slate-100 dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="truncate font-medium">
          {statusMessage ? (
            <span className="font-semibold text-[#2563EB]">{statusMessage}</span>
          ) : eyedropperActive ? (
            <span className="font-semibold text-[#2563EB]">{t.editor.pickFromPageHint}</span>
          ) : hasMultiSelection ? (
            <span className="font-semibold text-[#2563EB]">
              {selectedElements.length} {t.editor.selectedCount}
            </span>
          ) : selectedElement ? (
            t.editor.tapSelectedHint
          ) : textRuns.length > 0 ? (
            t.editor.nativeTextDetected
          ) : (
            t.editor.scannedOnlyNotice
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleFitWidth}
            title={t.editor.fitWidth}
            className="h-7 px-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10px] font-semibold"
          >
            {t.editor.fitWidth}
          </button>
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))))}
            aria-label="Zoom out PDF"
            className="h-7 w-7 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono-nums text-[11px] min-w-[36px] text-center">
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

      {/* Main Editable Page Canvas Area */}
      <div className="relative flex-1 flex flex-col overflow-hidden">
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
              className="relative bg-white shadow-xl rounded-md overflow-visible select-none shrink-0"
              style={{ width: pageSize.width * scale, height: pageSize.height * scale }}
            >
              {/* Elements positioned BEHIND original PDF page content */}
              {behindPageItems.length > 0 && (
                <div className="absolute inset-0 rounded-md overflow-hidden pointer-events-none z-[1]">
                  {(() => {
                    const nodes: React.ReactNode[] = [];
                    let svgBatch: AnnotationOverlay[] = [];
                    let svgZ = 10;
                    const flushSvg = (keySuffix: string | number) => {
                      if (svgBatch.length === 0) return;
                      const captured = svgBatch;
                      const zVal = svgZ;
                      svgBatch = [];
                      nodes.push(
                        <svg
                          key={`behind_svg_${keySuffix}`}
                          style={{ zIndex: zVal }}
                          className="pointer-events-none absolute inset-0 w-full h-full"
                          viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
                        >
                          {captured.map((ann) => {
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
                                  strokeWidth={sw}
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
                                  strokeWidth={sw}
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
                                  strokeWidth={sw}
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
                                  strokeWidth={sw}
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
                                    strokeWidth={sw}
                                    strokeDasharray={ann.lineStyle === 'dashed' ? '6 4' : undefined}
                                    strokeLinecap="round"
                                  />
                                  {aStyle !== 'line' && (
                                    <path
                                      d={`M ${ex - headLen * Math.cos(ang - Math.PI / 6)} ${ey - headLen * Math.sin(ang - Math.PI / 6)} L ${ex} ${ey} L ${ex - headLen * Math.cos(ang + Math.PI / 6)} ${ey - headLen * Math.sin(ang + Math.PI / 6)}`}
                                      fill="none"
                                      stroke={ann.color}
                                      strokeWidth={sw}
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  )}
                                  {aStyle === 'double' && (
                                    <path
                                      d={`M ${sx - headLen * Math.cos(revAng - Math.PI / 6)} ${sy - headLen * Math.sin(revAng - Math.PI / 6)} L ${sx} ${sy} L ${sx - headLen * Math.cos(revAng + Math.PI / 6)} ${sy - headLen * Math.sin(revAng + Math.PI / 6)}`}
                                      fill="none"
                                      stroke={ann.color}
                                      strokeWidth={sw}
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
                                  strokeWidth={sw}
                                  strokeOpacity={op}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              );
                            }
                            return null;
                          })}
                        </svg>
                      );
                    };

                    behindPageItems.forEach((entry, idx) => {
                      const cssZ = 10 + idx * 2;
                      if (entry.kind === 'annotation') {
                        const ann = entry.item;
                        if (ann.kind === 'sticky' || ann.kind === 'stamp' || ann.kind === 'signature') {
                          if (ann.kind === 'sticky') {
                            if (svgBatch.length === 0) svgZ = cssZ;
                            svgBatch.push(ann);
                          }
                          flushSvg(`pre_${entry.id}`);
                          if (ann.kind === 'sticky') {
                            const boxW = Math.max(84, ann.width || 165);
                            const boxH = Math.max(44, ann.height || 76);
                            nodes.push(
                              <div
                                key={`behind_${ann.id}`}
                                style={{
                                  left: ann.x * scale,
                                  top: ann.y * scale,
                                  width: boxW * scale,
                                  height: boxH * scale,
                                  backgroundColor: ann.fillColor || '#FEF3C7',
                                  borderColor: ann.color && ann.color !== '#FACC15' ? ann.color : '#D97706',
                                  fontSize: Math.max(7, Math.min(24, ann.fontSize || 10)) * scale,
                                  zIndex: cssZ + 1,
                                }}
                                className="absolute p-2 rounded-lg border-2 text-slate-900 overflow-hidden leading-snug break-words whitespace-pre-wrap"
                              >
                                {ann.comment}
                              </div>
                            );
                          } else if (ann.kind === 'stamp') {
                            const isSolid = Boolean(ann.fillColor);
                            nodes.push(
                              <div
                                key={`behind_${ann.id}`}
                                style={{
                                  left: ann.x * scale,
                                  top: ann.y * scale,
                                  minWidth: (ann.width || 96) * scale,
                                  height: (ann.height || 28) * scale,
                                  borderColor: ann.color,
                                  backgroundColor: isSolid ? ann.fillColor : 'rgba(255,255,255,0.95)',
                                  color: isSolid ? '#FFFFFF' : ann.color,
                                  fontSize: Math.max(8, Math.min(26, ann.fontSize || 10)) * scale,
                                  transform: ann.rotation ? `rotate(${ann.rotation}deg)` : undefined,
                                  transformOrigin: 'center center',
                                  zIndex: cssZ,
                                }}
                                className="absolute px-2.5 rounded border-2 font-extrabold tracking-wide flex items-center justify-center whitespace-nowrap"
                              >
                                {ann.comment || ann.dateStr || ''}
                              </div>
                            );
                          } else {
                            nodes.push(
                              <div
                                key={`behind_${ann.id}`}
                                style={{
                                  left: ann.x * scale,
                                  top: ann.y * scale,
                                  width: ann.width * scale,
                                  transform: ann.rotation ? `rotate(${ann.rotation}deg)` : undefined,
                                  transformOrigin: 'center center',
                                  zIndex: cssZ,
                                }}
                                className="absolute"
                              >
                                <img
                                  src={ann.signatureDataUrl}
                                  alt="Signature"
                                  style={{ width: ann.width * scale, height: ann.height * scale }}
                                  className="object-contain"
                                />
                              </div>
                            );
                          }
                        } else {
                          if (svgBatch.length === 0) svgZ = cssZ;
                          svgBatch.push(ann);
                        }
                        return;
                      }

                      flushSvg(`pre_${entry.id}`);
                      if (entry.kind === 'textBox') {
                        const tb = entry.item;
                        const bgStyle =
                          tb.backgroundColor && tb.backgroundColor !== 'transparent'
                            ? tb.backgroundColor
                            : 'transparent';
                        nodes.push(
                          <div
                            key={`behind_${tb.id}`}
                            style={{
                              left: tb.x * scale,
                              top: tb.y * scale,
                              width: tb.width * scale,
                              padding: `${2 * scale}px ${4 * scale}px`,
                              lineHeight: 1.32,
                              fontSize: tb.fontSize * scale,
                              fontFamily: getFontCssStack(tb.fontFamily),
                              color: tb.color,
                              backgroundColor: bgStyle,
                              borderColor: tb.borderColor || 'transparent',
                              borderStyle: tb.borderColor ? 'solid' : 'none',
                              borderWidth: tb.borderColor ? 1 : 0,
                              transform: tb.rotation ? `rotate(${tb.rotation}deg)` : undefined,
                              transformOrigin: 'center center',
                              fontWeight: tb.bold ? 700 : 400,
                              fontStyle: tb.italic ? 'italic' : 'normal',
                              textDecoration: tb.underline ? 'underline' : 'none',
                              textAlign: tb.align,
                              letterSpacing: `${tb.letterSpacing * scale}px`,
                              zIndex: cssZ,
                            }}
                            className="absolute rounded whitespace-pre-wrap"
                          >
                            {tb.text}
                          </div>
                        );
                      } else {
                        const im = entry.item;
                        const radiusPx = Math.min(im.width, im.height) * ((im.borderRadius || 0) / 100) * scale;
                        const filters: string[] = [];
                        if ((im.brightness ?? 100) !== 100) filters.push(`brightness(${im.brightness}%)`);
                        if ((im.contrast ?? 100) !== 100) filters.push(`contrast(${im.contrast}%)`);
                        if (im.grayscale) filters.push('grayscale(100%)');
                        nodes.push(
                          <div
                            key={`behind_${im.id}`}
                            style={{
                              left: im.x * scale,
                              top: im.y * scale,
                              width: im.width * scale,
                              height: im.height * scale,
                              zIndex: cssZ,
                            }}
                            className="absolute"
                          >
                            <div
                              style={{
                                opacity: im.opacity ?? 1,
                                transform: `rotate(${im.rotation || 0}deg)`,
                                borderRadius: `${radiusPx}px`,
                                border:
                                  im.borderWidth && im.borderWidth > 0
                                    ? `${im.borderWidth * scale}px solid ${im.borderColor || '#142B4A'}`
                                    : undefined,
                                overflow: 'hidden',
                              }}
                              className="w-full h-full"
                            >
                              <img
                                src={im.dataUrl}
                                alt="Inserted"
                                draggable={false}
                                style={{
                                  transform: `scale(${im.flipX ? -1 : 1}, ${im.flipY ? -1 : 1})`,
                                  filter: filters.length > 0 ? filters.join(' ') : undefined,
                                }}
                                className="w-full h-full object-fill block"
                              />
                            </div>
                          </div>
                        );
                      }
                    });
                    flushSvg('tail');
                    return nodes;
                  })()}
                </div>
              )}

              <div className="absolute inset-0 rounded-md overflow-hidden pointer-events-none z-[5]">
                <canvas
                  ref={canvasRef}
                  className={`block w-full h-full ${behindPageItems.length > 0 ? 'mix-blend-multiply' : ''}`}
                />
              </div>

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
                    activeTool === 'pan' ||
                    isDragStrokeTool ||
                    activeTool === 'eraser' ||
                    eyedropperActive ||
                    (activeTool === 'select' && multiSelectMode) ||
                    (activeTool === 'editText' && editBoxDrawMode)
                      ? 'none'
                      : 'pan-x pan-y',
                  pointerEvents: activeTool === 'pan' ? 'none' : 'auto',
                  cursor:
                    eyedropperActive ||
                    isDragStrokeTool ||
                    activeTool === 'eraser' ||
                    (activeTool === 'editText' && editBoxDrawMode)
                      ? 'crosshair'
                      : isPlacementTool
                      ? 'copy'
                      : 'default',
                }}
                className="absolute inset-0 z-[10]"
              >
                {/* Always render committed native text replacements across all tools */}
                {pageReplacements.map((rep) => {
                  const runMatch = displayedTextRuns.find((r) => r.id === rep.runId);
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
                            fontName: 'Arial',
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
                        pointerEvents: lockExistingElements || isPlacementTool || eyedropperActive ? 'none' : 'auto',
                      }}
                      className={`absolute text-left rounded z-10 ${
                        activeTool === 'editText'
                          ? 'border border-[#2563EB]/80'
                          : rep.deleted
                          ? 'border-0'
                          : 'border border-transparent hover:border-[#2563EB]/60'
                      }`}
                    >
                      {!rep.deleted && (
                        <span
                          style={{
                            fontSize: rep.fontSize * scale,
                            fontFamily: getFontCssStack(rep.fontFamily),
                            color: rep.color,
                            fontWeight: rep.bold ? 700 : 400,
                            fontStyle: rep.italic ? 'italic' : 'normal',
                            textDecoration: rep.underline ? 'underline' : 'none',
                            letterSpacing: `${(rep.letterSpacing || 0) * scale}px`,
                          }}
                          className="block leading-tight whitespace-pre-wrap px-0.5"
                        >
                          {rep.newText}
                        </span>
                      )}
                    </button>
                  );
                })}

                {/* Merged, memoized native + OCR text lines */}
                {activeTool === 'editText' && (
                  <EditTextRunsLayer
                    runs={displayedTextRuns}
                    replacedRunIds={replacedRunIds}
                    scale={scale}
                    disabled={editBoxDrawMode}
                    onSelectRun={handleSelectRunStable}
                  />
                )}

                {/* Interactive hitboxes for BEHIND-PDF HTML items (text boxes, images, sticky, stamp, sig) */}
                {!lockExistingElements &&
                  activeTool !== 'pan' &&
                  behindPageItems
                    .filter(
                      (u) =>
                        u.kind !== 'annotation' ||
                        u.item.kind === 'sticky' ||
                        u.item.kind === 'stamp' ||
                        u.item.kind === 'signature'
                    )
                    .map((entry) => {
                      const isSel = isElementSelected(entry.kind, entry.id);
                      const isSingleSel = selectedElement?.kind === entry.kind && selectedElement.id === entry.id;
                      const b = getElementBounds(entry.kind, entry.item);
                      const annSticky =
                        entry.kind === 'annotation' && entry.item.kind === 'sticky' ? entry.item : null;
                      return (
                        <div
                          key={`behind_hit_${entry.kind}_${entry.id}`}
                          onPointerDown={(e) =>
                            startElementPointerDown(e, entry.kind, entry.id, b.x, b.y, {
                              origTipX: annSticky?.stickyTipX,
                              origTipY: annSticky?.stickyTipY,
                            })
                          }
                          style={{
                            left: b.x * scale,
                            top: b.y * scale,
                            width: b.w * scale,
                            height: b.h * scale,
                            touchAction: 'none',
                            pointerEvents: lockExistingElements || isPlacementTool || eyedropperActive ? 'none' : 'auto',
                            zIndex: isSel ? 25 : 4,
                          }}
                          title="Behind PDF content · Drag or tap to select"
                          className={`absolute cursor-move rounded ${
                            isSel
                              ? 'ring-2 ring-dashed ring-[#2563EB] bg-[#2563EB]/10'
                              : 'hover:ring-1 hover:ring-dashed hover:ring-[#2563EB]/55'
                          }`}
                        >
                          {isSel && (
                            <span className="pointer-events-none absolute -top-5 left-0 px-1.5 py-0.5 rounded bg-slate-900/90 text-white text-[9px] font-bold whitespace-nowrap shadow">
                              {t.editor.layerBehindBadge}
                            </span>
                          )}
                          {isSingleSel && (
                            <button
                              type="button"
                              style={{ touchAction: 'none' }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                batchDeleteSelected();
                              }}
                              aria-label="Delete behind item"
                              className="absolute -top-3 -right-2.5 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md z-30"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}

                {/* Unified z-index interleaved rendering of ALL front overlay elements */}
                {(() => {
                  const nodes: React.ReactNode[] = [];
                  let svgBatch: AnnotationOverlay[] = [];
                  let svgZ = 100;

                  const flushFrontSvg = (keySuffix: string | number) => {
                    if (svgBatch.length === 0) return;
                    const captured = svgBatch;
                    const zVal = svgZ;
                    svgBatch = [];
                    nodes.push(
                      <svg
                        key={`front_svg_${keySuffix}`}
                        style={{ zIndex: zVal }}
                        className="pointer-events-none absolute inset-0 w-full h-full"
                        viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
                      >
                        {captured.map((ann) => {
                          const isSel = isElementSelected('annotation', ann.id);
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
                      </svg>
                    );
                  };

                  frontPageItems.forEach((entry, idx) => {
                    const cssZ = 100 + idx * 4;
                    if (entry.kind === 'textBox') {
                      flushFrontSvg(`pre_${entry.id}`);
                      const tb = entry.item;
                      const isSel = isElementSelected('textBox', tb.id);
                      const isSingleSel = selectedElement?.kind === 'textBox' && selectedElement.id === tb.id;
                      const bgStyle =
                        tb.backgroundColor && tb.backgroundColor !== 'transparent'
                          ? tb.backgroundColor
                          : 'rgba(255,255,255,0.12)';
                      nodes.push(
                        <div
                          key={tb.id}
                          onPointerDown={(e) => startElementPointerDown(e, 'textBox', tb.id, tb.x, tb.y)}
                          style={{
                            left: tb.x * scale,
                            top: tb.y * scale,
                            width: tb.width * scale,
                            padding: `${2 * scale}px ${4 * scale}px`,
                            lineHeight: 1.32,
                            fontSize: tb.fontSize * scale,
                            fontFamily: getFontCssStack(tb.fontFamily),
                            color: tb.color,
                            backgroundColor: bgStyle,
                            borderColor: isSel ? '#2563EB' : tb.borderColor || 'rgba(37,99,235,0.55)',
                            borderStyle: tb.borderColor || isSel ? 'solid' : 'dashed',
                            borderWidth: isSel ? 2 : 1,
                            transform: tb.rotation ? `rotate(${tb.rotation}deg)` : undefined,
                            transformOrigin: 'center center',
                            fontWeight: tb.bold ? 700 : 400,
                            fontStyle: tb.italic ? 'italic' : 'normal',
                            textDecoration: tb.underline ? 'underline' : 'none',
                            textAlign: tb.align,
                            letterSpacing: `${tb.letterSpacing * scale}px`,
                            touchAction: 'none',
                            pointerEvents: lockExistingElements || eyedropperActive ? 'none' : 'auto',
                            zIndex: cssZ,
                          }}
                          title="Drag to move · Tap again to edit text"
                          className={`group absolute rounded whitespace-pre-wrap cursor-move ${
                            isSel ? 'ring-2 ring-[#2563EB]/30' : ''
                          }`}
                        >
                          {tb.text}
                          {isSingleSel && !lockExistingElements && (
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
                                className="absolute -top-3 right-5 w-6 h-6 rounded-full bg-[#2563EB] text-white flex items-center justify-center shadow-md z-30"
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
                                  setSelectedElements([]);
                                }}
                                aria-label="Delete text box"
                                className="absolute -top-3 -right-2.5 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md z-30"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                              <div
                                style={{ touchAction: 'none' }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  capturePreGestureSnapshot();
                                  setSelectedElement({ kind: 'textBox', id: tb.id });
                                  tryCapturePointer(overlayRef.current, e.pointerId);
                                  setResizingTextBox({
                                    id: tb.id,
                                    startClientX: e.clientX,
                                    origW: tb.width,
                                  });
                                }}
                                title="Drag to resize text box width"
                                className="absolute top-1/2 -right-2 -translate-y-1/2 w-4 h-7 rounded-full bg-white border-2 border-[#2563EB] shadow cursor-ew-resize z-30"
                              />
                            </>
                          )}
                        </div>
                      );
                      return;
                    }

                    if (entry.kind === 'image') {
                      flushFrontSvg(`pre_${entry.id}`);
                      const im = entry.item;
                      const isSel = isElementSelected('image', im.id);
                      const isSingleSel = selectedImageId === im.id;
                      const radiusPx =
                        Math.min(im.width, im.height) * ((im.borderRadius || 0) / 100) * scale;
                      const filters: string[] = [];
                      if ((im.brightness ?? 100) !== 100) filters.push(`brightness(${im.brightness}%)`);
                      if ((im.contrast ?? 100) !== 100) filters.push(`contrast(${im.contrast}%)`);
                      if (im.grayscale) filters.push('grayscale(100%)');
                      const handleList: Array<{
                        handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
                        cls: string;
                      }> = [
                        { handle: 'nw', cls: '-top-2.5 -left-2.5 w-5 h-5 rounded-full cursor-nwse-resize' },
                        { handle: 'ne', cls: '-top-2.5 -right-2.5 w-5 h-5 rounded-full cursor-nesw-resize' },
                        { handle: 'sw', cls: '-bottom-2.5 -left-2.5 w-5 h-5 rounded-full cursor-nesw-resize' },
                        { handle: 'se', cls: '-bottom-2.5 -right-2.5 w-5 h-5 rounded-full cursor-nwse-resize' },
                        { handle: 'n', cls: '-top-2 left-1/2 -translate-x-1/2 w-6 h-3.5 rounded-full cursor-ns-resize' },
                        { handle: 's', cls: '-bottom-2 left-1/2 -translate-x-1/2 w-6 h-3.5 rounded-full cursor-ns-resize' },
                        { handle: 'w', cls: 'top-1/2 -left-2 -translate-y-1/2 w-3.5 h-6 rounded-full cursor-ew-resize' },
                        { handle: 'e', cls: 'top-1/2 -right-2 -translate-y-1/2 w-3.5 h-6 rounded-full cursor-ew-resize' },
                      ];
                      nodes.push(
                        <div
                          key={im.id}
                          onPointerDown={(e) => startElementPointerDown(e, 'image', im.id, im.x, im.y)}
                          style={{
                            left: im.x * scale,
                            top: im.y * scale,
                            width: im.width * scale,
                            height: im.height * scale,
                            touchAction: 'none',
                            pointerEvents: lockExistingElements || eyedropperActive ? 'none' : 'auto',
                            zIndex: cssZ,
                          }}
                          className={`group absolute cursor-move select-none ${
                            isSel ? 'ring-2 ring-[#2563EB]' : 'hover:ring-1 hover:ring-[#2563EB]/60'
                          }`}
                        >
                          <div
                            style={{
                              opacity: im.opacity ?? 1,
                              transform: `rotate(${im.rotation || 0}deg)`,
                              borderRadius: `${radiusPx}px`,
                              border:
                                im.borderWidth && im.borderWidth > 0
                                  ? `${im.borderWidth * scale}px solid ${im.borderColor || '#142B4A'}`
                                  : undefined,
                              overflow: 'hidden',
                            }}
                            className="w-full h-full pointer-events-none"
                          >
                            <img
                              src={im.dataUrl}
                              alt="Inserted"
                              draggable={false}
                              style={{
                                transform: `scale(${im.flipX ? -1 : 1}, ${im.flipY ? -1 : 1})`,
                                filter: filters.length > 0 ? filters.join(' ') : undefined,
                              }}
                              className="w-full h-full object-fill pointer-events-none block"
                            />
                          </div>

                          {isSingleSel && !lockExistingElements && (
                            <>
                              <button
                                type="button"
                                style={{ touchAction: 'none' }}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  capturePreGestureSnapshot();
                                  setShowImageAdjustModal(true);
                                }}
                                aria-label="Adjust image"
                                className="absolute -top-3 right-5 z-30 w-6 h-6 rounded-full bg-[#2563EB] text-white flex items-center justify-center shadow-md"
                              >
                                <SlidersHorizontal className="w-3 h-3" />
                              </button>
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
                                  setSelectedElements([]);
                                }}
                                aria-label="Delete image"
                                className="absolute -top-3 -right-2.5 z-30 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>

                              {handleList.map(({ handle, cls }) => (
                                <div
                                  key={handle}
                                  style={{ touchAction: 'none' }}
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    pointerMovedRef.current = false;
                                    capturePreGestureSnapshot();
                                    setSelectedImageId(im.id);
                                    tryCapturePointer(overlayRef.current, e.pointerId);
                                    setResizingImage({
                                      id: im.id,
                                      handle,
                                      lockAspect: im.lockAspect !== false,
                                      startClientX: e.clientX,
                                      startClientY: e.clientY,
                                      origX: im.x,
                                      origY: im.y,
                                      origW: im.width,
                                      origH: im.height,
                                    });
                                  }}
                                  title="Drag to resize picture"
                                  className={`absolute ${cls} z-30 bg-white border-2 border-[#2563EB] shadow-md`}
                                />
                              ))}
                            </>
                          )}
                        </div>
                      );
                      return;
                    }

                    const ann = entry.item;
                    if (ann.kind === 'sticky' || ann.kind === 'stamp' || ann.kind === 'signature') {
                      if (ann.kind === 'sticky') {
                        if (svgBatch.length === 0) svgZ = cssZ;
                        svgBatch.push(ann);
                      }
                      flushFrontSvg(`pre_${entry.id}`);
                      const isSel = isElementSelected('annotation', ann.id);
                      const isSingleSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
                      const startDrag = (e: React.PointerEvent) =>
                        startElementPointerDown(e, 'annotation', ann.id, ann.x, ann.y, {
                          origTipX: ann.stickyTipX,
                          origTipY: ann.stickyTipY,
                        });
                      const removeBtn = isSingleSel && !lockExistingElements && (
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
                            setSelectedElements([]);
                          }}
                          aria-label="Delete annotation"
                          className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md z-30"
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
                        nodes.push(
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
                                pointerEvents: lockExistingElements || eyedropperActive ? 'none' : 'auto',
                                zIndex: cssZ + 1,
                              }}
                              title="Drag to move · Tap again to edit note · Pull corners to resize"
                              className={`absolute p-2 rounded-lg border-2 text-slate-900 shadow-md cursor-move overflow-visible ${
                                isSel ? 'ring-2 ring-[#2563EB]/30' : ''
                              }`}
                            >
                              <div className="w-full h-full overflow-hidden leading-snug break-words whitespace-pre-wrap">
                                {ann.comment}
                              </div>
                              {isSingleSel &&
                                !lockExistingElements &&
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
                                        capturePreGestureSnapshot();
                                        tryCapturePointer(overlayRef.current, e.pointerId);
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
                                      className={`absolute ${posClass} w-5 h-5 rounded-full bg-white border-2 border-[#2563EB] shadow-md z-30`}
                                    />
                                  );
                                })}
                              {removeBtn}
                            </div>

                            {isSingleSel && !lockExistingElements && geo.hasArrow && (
                              <div
                                style={{
                                  touchAction: 'none',
                                  left: geo.tipX * scale - 16,
                                  top: geo.tipY * scale - 16,
                                  zIndex: cssZ + 2,
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  capturePreGestureSnapshot();
                                  tryCapturePointer(overlayRef.current, e.pointerId);
                                  setDraggingStickyTip({ id: ann.id });
                                }}
                                title={t.editor.dragTipHint}
                                className="absolute w-8 h-8 cursor-crosshair flex items-center justify-center"
                              >
                                <span
                                  style={{ borderColor: noteAccent }}
                                  className="w-5 h-5 rounded-full bg-white border-[2.5px] shadow-lg flex items-center justify-center"
                                >
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: noteAccent }}
                                  />
                                </span>
                                {draggingStickyTip?.id === ann.id && (
                                  <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-slate-900/90 text-white font-mono-nums text-[9px] whitespace-nowrap shadow">
                                    {geo.angleDeg}° · {Math.round(geo.length)}pt
                                  </span>
                                )}
                              </div>
                            )}
                          </React.Fragment>
                        );
                      } else if (ann.kind === 'stamp') {
                        const label = ann.comment || ann.dateStr || '';
                        const stampFont = Math.max(8, Math.min(26, ann.fontSize || 10));
                        const isSolid = Boolean(ann.fillColor);
                        nodes.push(
                          <div
                            key={ann.id}
                            onPointerDown={startDrag}
                            style={{
                              left: ann.x * scale,
                              top: ann.y * scale,
                              minWidth: (ann.width || 96) * scale,
                              height: (ann.height || 28) * scale,
                              borderColor: ann.color,
                              backgroundColor: isSolid ? ann.fillColor : 'rgba(255,255,255,0.95)',
                              color: isSolid ? '#FFFFFF' : ann.color,
                              fontSize: stampFont * scale,
                              transform: ann.rotation ? `rotate(${ann.rotation}deg)` : undefined,
                              transformOrigin: 'center center',
                              touchAction: 'none',
                              pointerEvents: lockExistingElements || eyedropperActive ? 'none' : 'auto',
                              zIndex: cssZ,
                            }}
                            className={`absolute px-2.5 rounded border-2 font-extrabold tracking-wide flex items-center justify-center cursor-move whitespace-nowrap ${
                              isSel ? 'ring-2 ring-[#2563EB]' : ''
                            }`}
                          >
                            {label}
                            {removeBtn}
                          </div>
                        );
                      } else {
                        nodes.push(
                          <div
                            key={ann.id}
                            onPointerDown={startDrag}
                            style={{
                              left: ann.x * scale,
                              top: ann.y * scale,
                              width: ann.width * scale,
                              transform: ann.rotation ? `rotate(${ann.rotation}deg)` : undefined,
                              transformOrigin: 'center center',
                              touchAction: 'none',
                              pointerEvents: lockExistingElements || eyedropperActive ? 'none' : 'auto',
                              zIndex: cssZ,
                            }}
                            className={`absolute cursor-move ${
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
                            {isSingleSel && !lockExistingElements && (
                              <div
                                style={{ touchAction: 'none' }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  capturePreGestureSnapshot();
                                  tryCapturePointer(overlayRef.current, e.pointerId);
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
                                className="absolute -bottom-2.5 -right-2.5 w-5 h-5 rounded-full bg-white border-2 border-[#2563EB] shadow-md cursor-nwse-resize z-30"
                              />
                            )}
                            {removeBtn}
                          </div>
                        );
                      }
                      return;
                    }

                    if (svgBatch.length === 0) svgZ = cssZ;
                    svgBatch.push(ann);
                  });

                  flushFrontSvg('tail');
                  return nodes;
                })()}

                {/* Live drawing, snap guides, eraser cursor & marquee box SVG layer */}
                <svg
                  style={{ zIndex: 5000 }}
                  className="pointer-events-none absolute inset-0 w-full h-full"
                  viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
                >
                  {liveFreehand.length >= 1 && (
                    <path
                      d={buildSmoothSvgPath(liveFreehand)}
                      fill="none"
                      stroke={activeColor}
                      strokeWidth={strokeWidth}
                      strokeOpacity={penOpacity}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}

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
                      fill={whiteoutColor}
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

                  {liveBox && activeTool === 'editText' && (
                    <rect
                      x={liveBox.x}
                      y={liveBox.y}
                      width={Math.abs(liveBox.w)}
                      height={Math.abs(liveBox.h)}
                      fill="rgba(37,99,235,0.12)"
                      stroke="#2563EB"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )}

                  {marqueeBox && (
                    <rect
                      x={marqueeBox.x}
                      y={marqueeBox.y}
                      width={marqueeBox.w}
                      height={marqueeBox.h}
                      fill="rgba(37,99,235,0.12)"
                      stroke="#2563EB"
                      strokeWidth={1.4}
                      strokeDasharray="4 3"
                    />
                  )}

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

                  {snapGuides?.x !== undefined && (
                    <line
                      x1={snapGuides.x}
                      y1={0}
                      x2={snapGuides.x}
                      y2={pageSize.height}
                      stroke="#2563EB"
                      strokeWidth={1.2}
                      strokeDasharray="5 3"
                    />
                  )}
                  {snapGuides?.y !== undefined && (
                    <line
                      x1={0}
                      y1={snapGuides.y}
                      x2={pageSize.width}
                      y2={snapGuides.y}
                      stroke="#2563EB"
                      strokeWidth={1.2}
                      strokeDasharray="5 3"
                    />
                  )}
                </svg>

                {/* Live Angle & Length Readout Badge when drawing arrow */}
                {(liveBox && activeTool === 'arrow' && Math.hypot(liveBox.w, liveBox.h) > 6) && (
                  <div
                    style={{
                      left: Math.min(pageSize.width - 95, Math.max(8, liveBox.x + liveBox.w)) * scale,
                      top: Math.max(6, (liveBox.y + liveBox.h) * scale - 28),
                      zIndex: 5010,
                    }}
                    className="pointer-events-none absolute px-2 py-0.5 rounded-full bg-slate-900/90 text-white font-mono-nums text-[10px] shadow"
                  >
                    {Math.round((Math.atan2(liveBox.h, liveBox.w) * 180) / Math.PI)}° · {Math.round(Math.hypot(liveBox.w, liveBox.h))}pt
                  </div>
                )}

                {/* Live Image Resize & Position HUD */}
                {resizingImage && selectedImg && (
                  <div
                    style={{
                      left: Math.min(pageSize.width - 110, Math.max(6, selectedImg.x)) * scale,
                      top: Math.max(6, selectedImg.y * scale - 26),
                      zIndex: 5010,
                    }}
                    className="pointer-events-none absolute px-2 py-0.5 rounded-full bg-[#142B4A]/95 text-white font-mono-nums text-[10px] shadow"
                  >
                    {Math.round(selectedImg.width)} × {Math.round(selectedImg.height)} pt
                  </div>
                )}
                {draggingItem?.kind === 'image' && selectedImg && pointerMovedRef.current && (
                  <div
                    style={{
                      left: Math.min(pageSize.width - 100, Math.max(6, selectedImg.x)) * scale,
                      top: Math.max(6, selectedImg.y * scale - 26),
                      zIndex: 5010,
                    }}
                    className="pointer-events-none absolute px-2 py-0.5 rounded-full bg-[#142B4A]/95 text-white font-mono-nums text-[10px] shadow"
                  >
                    {Math.round(selectedImg.x)}, {Math.round(selectedImg.y)} pt
                  </div>
                )}

                {/* Interactive hitboxes for drawn vector annotations + 4-corner/endpoint resize handles */}
                {!lockExistingElements &&
                  activeTool !== 'pan' &&
                  unifiedPageItems
                    .filter(
                      (u): u is UnifiedOverlayItem & { kind: 'annotation' } =>
                        u.kind === 'annotation' &&
                        u.item.kind !== 'sticky' &&
                        u.item.kind !== 'stamp' &&
                        u.item.kind !== 'signature'
                    )
                    .map((entry) => {
                      const ann = entry.item;
                      const isSel = isElementSelected('annotation', ann.id);
                      const isSingleSel = selectedElement?.kind === 'annotation' && selectedElement.id === ann.id;
                      const isBehind = entry.behind;
                      const frontIdx = frontPageItems.indexOf(entry);
                      const hitZ = isBehind
                        ? isSel
                          ? 25
                          : 5
                        : 100 + Math.max(0, frontIdx) * 4 + 1;

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
                          onPointerDown={(e) =>
                            startElementPointerDown(e, 'annotation', ann.id, ann.x, ann.y, {
                              origPoints: ann.points ? ann.points.map((p) => ({ ...p })) : undefined,
                            })
                          }
                          style={{
                            left: bx * scale,
                            top: by * scale,
                            width: bw * scale,
                            height: bh * scale,
                            touchAction: 'none',
                            pointerEvents:
                              lockExistingElements || isPlacementTool || eyedropperActive
                                ? 'none'
                                : 'auto',
                            zIndex: hitZ,
                          }}
                          className={`absolute cursor-move ${
                            isSel
                              ? `ring-2 ${isBehind ? 'ring-dashed' : ''} ring-[#2563EB] rounded bg-[#2563EB]/5`
                              : ''
                          }`}
                        >
                          {isSel && isBehind && (
                            <span className="pointer-events-none absolute -top-5 left-0 px-1.5 py-0.5 rounded bg-slate-900/90 text-white text-[9px] font-bold whitespace-nowrap shadow">
                              {t.editor.layerBehindBadge}
                            </span>
                          )}
                          {isSingleSel && (
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
                                setSelectedElements([]);
                              }}
                              aria-label="Delete shape"
                              className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-md z-30"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {isSingleSel &&
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
                                    capturePreGestureSnapshot();
                                    tryCapturePointer(overlayRef.current, e.pointerId);
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

                          {isSingleSel && isLineResizable && (
                            <>
                              <div
                                style={{
                                  touchAction: 'none',
                                  left:
                                    ann.kind === 'arrow'
                                      ? (ann.x - bx) * scale - 10
                                      : -10,
                                  top:
                                    ann.kind === 'arrow'
                                      ? (ann.y - by) * scale - 10
                                      : (bh * scale) / 2 - 10,
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  capturePreGestureSnapshot();
                                  tryCapturePointer(overlayRef.current, e.pointerId);
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
                                className="absolute w-5 h-5 rounded-full bg-white border-2 border-[#2563EB] shadow cursor-grab z-30"
                              />
                              <div
                                style={{
                                  touchAction: 'none',
                                  left:
                                    ann.kind === 'arrow'
                                      ? (ann.x + ann.width - bx) * scale - 10
                                      : bw * scale - 10,
                                  top:
                                    ann.kind === 'arrow'
                                      ? (ann.y + ann.height - by) * scale - 10
                                      : (bh * scale) / 2 - 10,
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pointerMovedRef.current = false;
                                  capturePreGestureSnapshot();
                                  tryCapturePointer(overlayRef.current, e.pointerId);
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
                                className="absolute w-5 h-5 rounded-full bg-white border-2 border-[#2563EB] shadow cursor-grab z-30"
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
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Editing Toolbar + Always-Visible Contextual Sub-bar + Categorized All-Tools Grid */}
      <div className="relative bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pb-safe shrink-0">
        {showToolGrid && (
          <div className="absolute bottom-full left-2 right-2 sm:left-4 sm:right-auto sm:w-[440px] mb-2 z-40 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl p-3 space-y-3 max-h-[62vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#142B4A] dark:text-white flex items-center gap-1.5">
                <LayoutGrid className="w-3.5 h-3.5 text-[#2563EB]" />
                {t.editor.allTools}
              </span>
              <button
                type="button"
                onClick={() => setShowToolGrid(false)}
                className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close all tools"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {[
              { key: 'core', title: t.editor.catCore, cats: ['core'] },
              { key: 'insert', title: t.editor.catInsert, cats: ['insert'] },
              { key: 'markup', title: t.editor.catMarkup, cats: ['draw', 'markup'] },
              { key: 'shapes', title: t.editor.catShapes, cats: ['shapes'] },
            ].map((group) => {
              const items = toolsList.filter((tl) => group.cats.includes(tl.category));
              return (
                <div key={group.key} className="space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 px-0.5">
                    {group.title}
                  </p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                    {items.map((tool) => {
                      const active = activeTool === tool.id;
                      return (
                        <button
                          key={`grid_${tool.id}`}
                          type="button"
                          onClick={() => {
                            setShowToolGrid(false);
                            setEyedropperActive(false);
                            if (tool.id === 'addImage') {
                              openImagePicker();
                              return;
                            }
                            setSelectedElement(null);
                            if (tool.id === 'signature') {
                              setActiveTool('signature');
                              if (!pendingSig) setShowSigModal(true);
                              else flashStatus(t.editor.tapToPlaceSig, 2200);
                              return;
                            }
                            if (tool.id === 'highlight' && activeColor === '#2563EB') {
                              setActiveColor('#FACC15');
                            }
                            if (tool.id === 'stamp') {
                              flashStatus(t.editor.tapToPlaceStamp, 2000);
                            } else if (tool.id === 'addText') {
                              flashStatus(t.editor.tapToPlaceText, 2000);
                            } else if (tool.id === 'sticky') {
                              flashStatus(t.editor.tapToPlaceSticky, 2000);
                            }
                            setActiveTool(tool.id);
                          }}
                          className={`p-2 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-semibold border transition-colors ${
                            active
                              ? 'bg-[#2563EB] text-white border-[#2563EB] shadow-sm'
                              : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
                          }`}
                        >
                          {tool.icon}
                          <span className="truncate max-w-full">{tool.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {showContextualSubBar && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar text-xs">
            {hasMultiSelection ? (
              <div className="flex items-center gap-1.5 w-full">
                <span className="px-2 py-1 rounded-lg bg-[#2563EB] text-white font-bold whitespace-nowrap shrink-0 flex items-center gap-1">
                  <CheckSquare className="w-3.5 h-3.5" />
                  {selectedElements.length} {t.editor.selectedCount}
                </span>
                {(multiSelectedTextCount > 0 || multiSelectedAnnCount > 0) && (
                  <>
                    <button
                      type="button"
                      onClick={() => batchChangeColor(activeColor)}
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: activeColor }} />
                      {language === 'bn' ? 'রঙ' : 'Color'}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {(['#0F172A', '#2563EB', '#DC2626', '#16A34A'] as const).map((qc) => (
                        <button
                          key={`batch_clr_${qc}`}
                          type="button"
                          onClick={() => batchChangeColor(qc)}
                          style={{ backgroundColor: qc }}
                          aria-label={`Batch color ${qc}`}
                          className="w-5 h-5 rounded-full border border-white dark:border-slate-700 shadow-sm shrink-0"
                        />
                      ))}
                    </div>
                  </>
                )}
                {(multiSelectedTextCount > 0 ||
                  pageAnnotations.some(
                    (an) =>
                      (an.kind === 'sticky' || an.kind === 'stamp') &&
                      isElementSelected('annotation', an.id)
                  )) && (
                  <>
                    <button
                      type="button"
                      onClick={() => batchAdjustFontSize(2)}
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
                    >
                      A+
                    </button>
                    <button
                      type="button"
                      onClick={() => batchAdjustFontSize(-2)}
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
                    >
                      A-
                    </button>
                  </>
                )}
                {multiSelectedTextCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => batchToggleTextStyle('bold')}
                      aria-label="Batch toggle bold"
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0"
                    >
                      <Bold className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => batchToggleTextStyle('italic')}
                      aria-label="Batch toggle italic"
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0"
                    >
                      <Italic className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {(multiSelectedImgCount > 0 || multiSelectedAnnCount > 0) && (
                  <button
                    type="button"
                    onClick={batchCycleOpacity}
                    title={t.editor.opacity}
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold whitespace-nowrap shrink-0"
                  >
                    {t.editor.opacity}
                  </button>
                )}
                {renderLayerControls(allSelectedBehind)}
                <button
                  type="button"
                  onClick={selectAllOnCurrentPage}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  {t.editor.selectAllOnPage}
                </button>
                <button
                  type="button"
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={batchDeleteSelected}
                  title={t.editor.batchDelete}
                  className="px-2.5 py-1 rounded-lg bg-rose-500 text-white font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t.editor.batchDelete}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedElements([]);
                    setMultiSelectMode(false);
                  }}
                  className="ml-auto px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : selectedImg ? (
              <div className="flex items-center gap-1.5 w-full">
                <button
                  type="button"
                  onClick={() => {
                    capturePreGestureSnapshot();
                    setShowImageAdjustModal(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" /> {t.editor.adjustImage}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCropInsets({ top: 0, right: 0, bottom: 0, left: 0 });
                    setCropNaturalSize(null);
                    setCropModalImg(selectedImg);
                  }}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
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
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <RotateCw className="w-3.5 h-3.5" /> 90°
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, flipX: !im.flipX } : im
                      ),
                    }))
                  }
                  title={t.editor.flipH}
                  className={`px-2 py-1 rounded-lg border flex items-center gap-1 whitespace-nowrap shrink-0 ${
                    selectedImg.flipX
                      ? 'bg-cyan-600 text-white border-cyan-600'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <FlipHorizontal2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, flipY: !im.flipY } : im
                      ),
                    }))
                  }
                  title={t.editor.flipV}
                  className={`px-2 py-1 rounded-lg border flex items-center gap-1 whitespace-nowrap shrink-0 ${
                    selectedImg.flipY
                      ? 'bg-cyan-600 text-white border-cyan-600'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <FlipVertical2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, lockAspect: im.lockAspect === false } : im
                      ),
                    }))
                  }
                  title={selectedImg.lockAspect !== false ? t.editor.lockAspect : t.editor.freeAspect}
                  className={`px-2 py-1 rounded-lg border flex items-center gap-1 whitespace-nowrap shrink-0 ${
                    selectedImg.lockAspect === false
                      ? 'bg-amber-500 text-white border-amber-500 font-semibold'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {selectedImg.lockAspect === false ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id
                          ? { ...im, x: Math.max(0, Math.round((pageSize.width - im.width) / 2)) }
                          : im
                      ),
                    }))
                  }
                  title={t.editor.centerH}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold whitespace-nowrap shrink-0"
                >
                  ↔
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const targetW = Math.max(80, Math.round(pageSize.width - 48));
                    const targetH = Math.max(24, Math.round((targetW / Math.max(1, selectedImg.width)) * selectedImg.height));
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, x: 24, width: targetW, height: targetH } : im
                      ),
                    }));
                  }}
                  title={t.editor.fitPageWidth}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const steps = [1, 0.75, 0.5, 0.25];
                    const cur = selectedImg.opacity ?? 1;
                    const idx = steps.findIndex((s) => Math.abs(s - cur) < 0.08);
                    const nextOp = steps[(idx + 1) % steps.length];
                    commitState((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, opacity: nextOp } : im
                      ),
                    }));
                  }}
                  title={t.editor.opacity}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-mono-nums text-[11px] font-semibold whitespace-nowrap shrink-0"
                >
                  {Math.round((selectedImg.opacity ?? 1) * 100)}%
                </button>
                <button
                  type="button"
                  onClick={openImagePicker}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <ImagePlus className="w-3.5 h-3.5" /> +
                </button>
                <button
                  type="button"
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                {renderLayerControls(selectedImg.layerPlacement === 'behind')}
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
                  className="px-2 py-1 rounded-lg bg-rose-500 text-white shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedElement(null)}
                  className="ml-auto px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : selectedTextBox ? (
              <div className="flex items-center gap-1.5 w-full">
                <button
                  type="button"
                  onClick={() => openEditAddedTextBox(selectedTextBox)}
                  className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
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
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
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
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
                >
                  A-
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === selectedTextBox.id ? { ...tb, bold: !tb.bold } : tb
                      ),
                    }))
                  }
                  className={`px-2 py-1 rounded-lg border shrink-0 ${
                    selectedTextBox.bold
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === selectedTextBox.id ? { ...tb, italic: !tb.italic } : tb
                      ),
                    }))
                  }
                  className={`px-2 py-1 rounded-lg border shrink-0 ${
                    selectedTextBox.italic
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <Italic className="w-3.5 h-3.5" />
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
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <RotateCw className="w-3 h-3" /> 90°
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitState((prev) => ({
                      ...prev,
                      addedTexts: prev.addedTexts.map((tb) =>
                        tb.id === selectedTextBox.id ? { ...tb, color: activeColor } : tb
                      ),
                    }))
                  }
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: activeColor }} />
                  {language === 'bn' ? 'রঙ' : 'Color'}
                </button>
                <button
                  type="button"
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                {renderLayerControls(selectedTextBox.layerPlacement === 'behind')}
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
                  className="px-2 py-1 rounded-lg bg-rose-500 text-white shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedElement(null)}
                  className="ml-auto px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : selectedAnn ? (
              <div className="flex items-center gap-1.5 w-full">
                <span className="font-bold text-[#142B4A] dark:text-cyan-300 capitalize whitespace-nowrap shrink-0 px-1">
                  {selectedAnn.kind}
                </span>
                {selectedAnn.kind === 'sticky' && (
                  <>
                    <button
                      type="button"
                      onClick={() => openEditStickyNote(selectedAnn)}
                      className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <Pencil className="w-3 h-3" /> {language === 'bn' ? 'এডিট' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id ? { ...an, fontSize: Math.min(22, (an.fontSize || 10) + 1.5) } : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
                    >
                      A+
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) =>
                            an.id === selectedAnn.id ? { ...an, fontSize: Math.max(7, (an.fontSize || 10) - 1.5) } : an
                          ),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
                    >
                      A-
                    </button>
                    {STICKY_THEMES.slice(0, 4).map((th) => (
                      <button
                        key={th.id}
                        type="button"
                        onClick={() =>
                          commitState((prev) => ({
                            ...prev,
                            annotations: prev.annotations.map((an) =>
                              an.id === selectedAnn.id ? { ...an, fillColor: th.bg, color: th.accent } : an
                            ),
                          }))
                        }
                        title={th.name}
                        style={{ backgroundColor: th.bg, borderColor: th.accent }}
                        className="w-5 h-5 rounded-full border shrink-0"
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.map((an) => {
                            if (an.id !== selectedAnn.id) return an;
                            if (an.stickyArrow && an.stickyArrow !== 'none') {
                              return { ...an, stickyArrow: 'none', stickyTipX: undefined, stickyTipY: undefined };
                            }
                            const boxW = Math.max(84, an.width || 165);
                            const boxH = Math.max(44, an.height || 76);
                            const tip = computeDefaultStickyTip(an.x, an.y, boxW, boxH, 'top-left', 44, pageSize.width, pageSize.height);
                            return { ...an, stickyArrow: 'top-left', stickyTipX: tip.tipX, stickyTipY: tip.tipY };
                          }),
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 whitespace-nowrap shrink-0"
                    >
                      {selectedAnn.stickyArrow === 'none'
                        ? (language === 'bn' ? 'তীর যুক্ত' : '+ Arrow')
                        : (language === 'bn' ? 'তীর বাদ' : 'No Arrow')}
                    </button>
                  </>
                )}
                {selectedAnn.kind === 'stamp' && (
                  <>
                    <button
                      type="button"
                      onClick={() => openEditStamp(selectedAnn)}
                      className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <Pencil className="w-3 h-3" /> {language === 'bn' ? 'এডিট' : 'Edit'}
                    </button>
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
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
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
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold shrink-0"
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
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 shrink-0"
                    >
                      <RotateCw className="w-3 h-3" /> 90°
                    </button>
                  </>
                )}
                {selectedAnn.kind === 'signature' && (
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
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 shrink-0"
                  >
                    <RotateCw className="w-3 h-3" /> 90°
                  </button>
                )}
                {selectedAnn.kind === 'whiteout' && (
                  <>
                    {(['#FFFFFF', '#F8FAFC', '#FEFCE8'] as const).map((wc) => (
                      <button
                        key={wc}
                        type="button"
                        onClick={() =>
                          commitState((prev) => ({
                            ...prev,
                            annotations: prev.annotations.map((an) =>
                              an.id === selectedAnn.id ? { ...an, color: wc, fillColor: wc } : an
                            ),
                          }))
                        }
                        style={{ backgroundColor: wc }}
                        className="w-5 h-5 rounded-full border border-slate-400 shrink-0"
                        aria-label={`Whiteout color ${wc}`}
                      />
                    ))}
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
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 whitespace-nowrap shrink-0"
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
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 whitespace-nowrap shrink-0"
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
                          an.id === selectedAnn.id ? { ...an, fillColor: an.fillColor ? undefined : an.color } : an
                        ),
                      }))
                    }
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
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
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 whitespace-nowrap shrink-0"
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
                      className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 whitespace-nowrap shrink-0"
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
                                  an.kind === 'sticky' ? an.fillColor : an.fillColor ? activeColor : undefined,
                              }
                            : an
                        ),
                      }))
                    }
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                  >
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: activeColor }} />
                    {language === 'bn' ? 'রঙ' : 'Color'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={duplicateSelectedElement}
                  title={t.editor.duplicate}
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                {renderLayerControls(selectedAnn.layerPlacement === 'behind')}
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
                  className="px-2 py-1 rounded-lg bg-rose-500 text-white shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedElement(null)}
                  className="ml-auto px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : (activeTool === 'select' || activeTool === 'addImage') ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300 truncate">
                  {t.editor.tapSelectedHint}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setMultiSelectMode((v) => !v)}
                    className={`px-2 py-1 rounded-lg font-semibold flex items-center gap-1 whitespace-nowrap border ${
                      multiSelectMode
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <CheckSquare className="w-3.5 h-3.5" /> {t.editor.multiSelect}
                  </button>
                  <button
                    type="button"
                    onClick={selectAllOnCurrentPage}
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex items-center gap-1 whitespace-nowrap"
                  >
                    <CheckCheck className="w-3.5 h-3.5" /> {t.editor.selectAllOnPage}
                  </button>
                  <button
                    type="button"
                    onClick={openImagePicker}
                    className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold flex items-center gap-1 whitespace-nowrap"
                  >
                    <ImagePlus className="w-3.5 h-3.5" /> {t.editor.tapChooseImage}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedElement(null);
                      setActiveTool('addText');
                      flashStatus(t.editor.tapToPlaceText, 2000);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold flex items-center gap-1 whitespace-nowrap"
                  >
                    <TypeIcon className="w-3.5 h-3.5" /> + {t.editor.tools.addText}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedElement(null);
                      setActiveTool('sticky');
                      flashStatus(t.editor.tapToPlaceSticky, 2000);
                    }}
                    className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold whitespace-nowrap"
                  >
                    + {t.editor.tools.sticky}
                  </button>
                </div>
              </div>
            ) : activeTool === 'addText' || activeTool === 'sticky' ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] font-semibold text-[#2563EB] dark:text-cyan-300 truncate">
                  {activeTool === 'addText' ? t.editor.tapToPlaceText : t.editor.tapToPlaceSticky}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setKeepToolActive((v) => !v)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] border whitespace-nowrap ${
                      keepToolActive
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.keepToolActive}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTool('select')}
                    className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.doneSelect}
                  </button>
                </div>
              </div>
            ) : activeTool === 'editText' ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] font-mono-nums font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">
                  {displayedTextRuns.length} {language === 'bn' ? 'লাইন' : 'lines'}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditBoxDrawMode((v) => !v)}
                    className={`px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap border flex items-center gap-1 ${
                      editBoxDrawMode
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <Square className="w-3 h-3" />
                    {language === 'bn' ? 'বক্স এঁকে এডিট' : 'Box Select'}
                  </button>
                  <button
                    type="button"
                    disabled={ocrScanning}
                    onClick={handleScanMissingTextOcr}
                    className="px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap bg-cyan-600 text-white disabled:opacity-60 flex items-center gap-1"
                  >
                    {ocrScanning ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ScanText className="w-3.5 h-3.5" />
                    )}
                    {language === 'bn' ? 'সব টেক্সট ধরুন (OCR)' : 'Scan Missing Text'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTool('select')}
                    className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.doneSelect}
                  </button>
                </div>
              </div>
            ) : activeTool === 'draw' ? (
              <div className="flex items-center gap-2 w-full justify-between">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setDrawMode('pen');
                      setPenOpacity(1);
                    }}
                    className={`px-2 py-1 rounded-lg font-semibold whitespace-nowrap ${
                      drawMode === 'pen'
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.penSolid}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDrawMode('marker');
                      setPenOpacity(0.42);
                    }}
                    className={`px-2 py-1 rounded-lg font-semibold whitespace-nowrap ${
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
                      className={`h-7 min-w-[26px] px-1 rounded-lg flex items-center justify-center border ${
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
                          opacity: penOpacity,
                        }}
                      />
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {[1, 0.7, 0.42].map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => setPenOpacity(op)}
                      className={`px-1.5 py-1 rounded-lg font-mono-nums text-[10px] border ${
                        Math.abs(penOpacity - op) < 0.05
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {Math.round(op * 100)}%
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
                    className="px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 font-semibold whitespace-nowrap shrink-0"
                  >
                    {t.editor.clearPageAnnots}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveTool('select')}
                  className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : activeTool === 'eraser' ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEraserIncludeAll(false)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] whitespace-nowrap border ${
                      !eraserIncludeAll
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.eraserInkOnly}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEraserIncludeAll(true)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] whitespace-nowrap border ${
                      eraserIncludeAll
                        ? 'bg-rose-600 text-white border-rose-600'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.eraserAllOverlays}
                  </button>
                </div>
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
                  {(pageErasableCount > 0 || (eraserIncludeAll && (pageAddedTexts.length > 0 || pageAddedImages.length > 0))) && (
                    <button
                      type="button"
                      onClick={() =>
                        commitState((prev) => ({
                          ...prev,
                          annotations: prev.annotations.filter(
                            (a) => a.pageNumber !== pageNumber || !isErasableAnnotation(a, eraserIncludeAll)
                          ),
                          addedTexts: eraserIncludeAll
                            ? prev.addedTexts.filter((tb) => tb.pageNumber !== pageNumber)
                            : prev.addedTexts,
                          addedImages: eraserIncludeAll
                            ? prev.addedImages.filter((im) => im.pageNumber !== pageNumber)
                            : prev.addedImages,
                        }))
                      }
                      className="px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 font-semibold whitespace-nowrap"
                    >
                      {t.editor.clearPageAnnots}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveTool('select')}
                    className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.doneSelect}
                  </button>
                </div>
              </div>
            ) : activeTool === 'whiteout' ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-slate-500 font-semibold whitespace-nowrap">
                    {t.editor.whiteoutBg}
                  </span>
                  {(['#FFFFFF', '#F8FAFC', '#FEFCE8'] as const).map((wc) => (
                    <button
                      key={wc}
                      type="button"
                      onClick={() => {
                        setWhiteoutColor(wc);
                        setEyedropperActive(false);
                      }}
                      style={{ backgroundColor: wc }}
                      className={`w-6 h-6 rounded-full border-2 shrink-0 ${
                        whiteoutColor.toUpperCase() === wc
                          ? 'border-[#2563EB] scale-110'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                      aria-label={`Whiteout ${wc}`}
                    />
                  ))}
                  <input
                    type="color"
                    value={whiteoutColor}
                    onChange={(e) => {
                      setWhiteoutColor(e.target.value.toUpperCase());
                      setEyedropperActive(false);
                    }}
                    className="w-6 h-6 rounded-full border border-slate-300 dark:border-slate-600 cursor-pointer p-0 bg-transparent shrink-0"
                  />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEyedropperActive((v) => !v)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] whitespace-nowrap flex items-center gap-1 border ${
                      eyedropperActive
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <Droplet className="w-3.5 h-3.5" />
                    {t.editor.pickFromPage}
                  </button>
                  <button
                    type="button"
                    onClick={() => setKeepToolActive((v) => !v)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] border whitespace-nowrap ${
                      keepToolActive
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.keepToolActive}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTool('select')}
                    className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.doneSelect}
                  </button>
                </div>
              </div>
            ) : (activeTool === 'rect' || activeTool === 'circle' || activeTool === 'arrow' || activeTool === 'underline' || activeTool === 'strike') ? (
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
                    className={`px-2 py-1 rounded-lg font-semibold flex items-center gap-1 whitespace-nowrap border ${
                      shapeFilled
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <PaintBucket className="w-3.5 h-3.5" /> {t.editor.fillShape}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setKeepToolActive((v) => !v)}
                  className={`px-2 py-1 rounded-lg font-semibold text-[11px] border whitespace-nowrap shrink-0 ${
                    keepToolActive
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {t.editor.keepToolActive}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool('select')}
                  className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : activeTool === 'highlight' ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] font-semibold text-slate-500 whitespace-nowrap">
                  {t.editor.tools.highlight} · {t.editor.opacity}:
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {[0.25, 0.36, 0.55].map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => setHighlightOpacity(op)}
                      className={`px-2 py-1 rounded-lg font-mono-nums text-[11px] border ${
                        highlightOpacity === op
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {Math.round(op * 100)}%
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setKeepToolActive((v) => !v)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] border whitespace-nowrap ${
                      keepToolActive
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.keepToolActive}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTool('select')}
                    className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.doneSelect}
                  </button>
                </div>
              </div>
            ) : activeTool === 'stamp' ? (
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
                <button
                  type="button"
                  onClick={() => setStampSolidFill((v) => !v)}
                  className={`px-2 py-1 rounded-lg font-semibold text-[10px] border whitespace-nowrap ${
                    stampSolidFill
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {stampSolidFill ? t.editor.stampSolid : t.editor.stampOutline}
                </button>
                <input
                  type="text"
                  value={customStampText}
                  onFocus={() => setStampPreset('CUSTOM')}
                  onChange={(e) => {
                    setStampPreset('CUSTOM');
                    setCustomStampText(e.target.value);
                  }}
                  placeholder={language === 'bn' ? 'কাস্টম...' : 'Custom...'}
                  className="h-7 w-20 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px]"
                />
                <button
                  type="button"
                  onClick={() => setKeepToolActive((v) => !v)}
                  className={`px-2 py-1 rounded-lg font-semibold text-[11px] border whitespace-nowrap shrink-0 ${
                    keepToolActive
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {t.editor.keepToolActive}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool('select')}
                  className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  {t.editor.doneSelect}
                </button>
              </div>
            ) : activeTool === 'signature' ? (
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-slate-600 dark:text-slate-300 truncate">
                  {pendingSig ? t.editor.tapToPlaceSig : ''}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowSigModal(true)}
                    className="px-2.5 py-1 rounded-lg bg-[#2563EB] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.changeSig}
                  </button>
                  <button
                    type="button"
                    onClick={() => setKeepToolActive((v) => !v)}
                    className={`px-2 py-1 rounded-lg font-semibold text-[11px] border whitespace-nowrap ${
                      keepToolActive
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {t.editor.keepToolActive}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTool('select')}
                    className="px-2.5 py-1 rounded-lg bg-[#142B4A] text-white font-semibold whitespace-nowrap"
                  >
                    {t.editor.doneSelect}
                  </button>
                </div>
              </div>
            ) : null}
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
            <button
              type="button"
              onClick={() => {
                setPageJumpInput(String(pageNumber));
                setShowPageJump((v) => !v);
              }}
              className="text-xs font-mono-nums px-1.5 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {pageNumber}/{doc.pageCount}
            </button>
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

        {/* Pinned All-Tools button + Scrollable Horizontal Tools */}
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <button
            type="button"
            onClick={() => setShowToolGrid((v) => !v)}
            title={t.editor.allTools}
            aria-label={t.editor.allTools}
            className={`min-h-[42px] min-w-[42px] px-2.5 rounded-xl flex items-center justify-center gap-1 text-xs font-semibold shrink-0 border transition-colors ${
              showToolGrid
                ? 'bg-[#142B4A] text-white border-[#142B4A]'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1">
            {toolsList.map((tool) => {
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  onClick={() => {
                    setShowToolGrid(false);
                    setEyedropperActive(false);
                    if (tool.id === 'addImage') {
                      openImagePicker();
                      return;
                    }
                    setSelectedElement(null);
                    if (tool.id === 'signature') {
                      setActiveTool('signature');
                      if (!pendingSig) setShowSigModal(true);
                      else flashStatus(t.editor.tapToPlaceSig, 2200);
                      return;
                    }
                    if (tool.id === 'highlight' && activeColor === '#2563EB') {
                      setActiveColor('#FACC15');
                    }
                    if (tool.id === 'stamp') {
                      flashStatus(t.editor.tapToPlaceStamp, 2000);
                    } else if (tool.id === 'addText') {
                      flashStatus(t.editor.tapToPlaceText, 2000);
                    } else if (tool.id === 'sticky') {
                      flashStatus(t.editor.tapToPlaceSticky, 2000);
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
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3.5 max-h-[92vh] overflow-y-auto">
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

            {editingRun.str && (
              <p className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {editingRun.str}
              </p>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    runTextareaRef.current?.focus();
                    runTextareaRef.current?.select();
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
                >
                  {t.editor.selectAllText}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRunDraft((d) => ({ ...d, text: '' }));
                    runTextareaRef.current?.focus();
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
                >
                  {t.editor.clearText}
                </button>
              </div>
              {replacedRunIds.has(editingRun.id) && (
                <button
                  type="button"
                  onClick={handleRestoreRunOriginal}
                  className="px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 text-[11px] font-semibold"
                >
                  {t.editor.restoreOriginal}
                </button>
              )}
            </div>

            <textarea
              ref={runTextareaRef}
              rows={2}
              value={runDraft.text}
              onChange={(e) => setRunDraft((d) => ({ ...d, text: e.target.value }))}
              placeholder={t.editor.textPlaceholder}
              style={{ fontFamily: getFontCssStack(runDraft.fontFamily) }}
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
            />

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={runDraft.fontFamily}
                onChange={(e) =>
                  setRunDraft((d) => ({ ...d, fontFamily: e.target.value as PdfFontFamily }))
                }
                style={{ fontFamily: getFontCssStack(runDraft.fontFamily) }}
                className="h-10 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              >
                {OFFICIAL_FONT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} style={{ fontFamily: opt.cssStack }}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, fontSize: Math.max(6, d.fontSize - 1) }))}
                  className="h-10 px-2 text-xs font-bold hover:bg-slate-200/60 dark:hover:bg-slate-700"
                >
                  A-
                </button>
                <input
                  type="number"
                  min={6}
                  max={72}
                  value={runDraft.fontSize}
                  onChange={(e) => setRunDraft((d) => ({ ...d, fontSize: Number(e.target.value) || 12 }))}
                  className="w-11 h-10 px-1 bg-transparent text-center text-xs font-mono-nums"
                />
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, fontSize: Math.min(72, d.fontSize + 1) }))}
                  className="h-10 px-2 text-xs font-bold hover:bg-slate-200/60 dark:hover:bg-slate-700"
                >
                  A+
                </button>
              </div>
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
              <div className="flex items-center gap-1">
                {(['#0F172A', '#142B4A', '#2563EB', '#DC2626', '#16A34A'] as const).map((tc) => (
                  <button
                    key={`run_clr_${tc}`}
                    type="button"
                    onClick={() => setRunDraft((d) => ({ ...d, color: tc }))}
                    style={{ backgroundColor: tc }}
                    className={`w-6 h-6 rounded-full border-2 shrink-0 ${
                      runDraft.color.toUpperCase() === tc ? 'border-slate-900 dark:border-white scale-110' : 'border-transparent'
                    }`}
                    aria-label={`Text color ${tc}`}
                  />
                ))}
                <input
                  type="color"
                  title={language === 'bn' ? 'টেক্সট রঙ' : 'Text color'}
                  value={runDraft.color}
                  onChange={(e) => setRunDraft((d) => ({ ...d, color: e.target.value }))}
                  className="w-9 h-9 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer"
                />
              </div>
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
                  className="px-2 h-8 rounded-lg bg-white text-slate-800 border border-slate-200 font-semibold"
                >
                  #FFF
                </button>
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, backgroundColor: '#FEF9C3' }))}
                  className="px-2 h-8 rounded-lg bg-[#FEF9C3] text-slate-800 border border-slate-200 font-semibold"
                >
                  #FEF
                </button>
              </div>
            </div>

            {/* Alignment, Spacing, and fine position nudge */}
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1">
                {(['left', 'center', 'right'] as const).map((al) => (
                  <button
                    key={al}
                    type="button"
                    onClick={() => setRunDraft((d) => ({ ...d, align: al }))}
                    className={`h-8 w-8 rounded-lg flex items-center justify-center border ${
                      runDraft.align === al
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {al === 'left' ? (
                      <AlignLeft className="w-3.5 h-3.5" />
                    ) : al === 'center' ? (
                      <AlignCenter className="w-3.5 h-3.5" />
                    ) : (
                      <AlignRight className="w-3.5 h-3.5" />
                    )}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, dx: d.dx - 2 }))}
                  className="h-8 w-7 rounded-lg border border-slate-200 dark:border-slate-700 font-bold"
                  title="Nudge left"
                >
                  ←
                </button>
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, dy: d.dy - 2 }))}
                  className="h-8 w-7 rounded-lg border border-slate-200 dark:border-slate-700 font-bold"
                  title="Nudge up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, dy: d.dy + 2 }))}
                  className="h-8 w-7 rounded-lg border border-slate-200 dark:border-slate-700 font-bold"
                  title="Nudge down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setRunDraft((d) => ({ ...d, dx: d.dx + 2 }))}
                  className="h-8 w-7 rounded-lg border border-slate-200 dark:border-slate-700 font-bold"
                  title="Nudge right"
                >
                  →
                </button>
                {(runDraft.dx !== 0 || runDraft.dy !== 0) && (
                  <button
                    type="button"
                    onClick={() => setRunDraft((d) => ({ ...d, dx: 0, dy: 0 }))}
                    className="h-8 px-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] font-mono-nums"
                  >
                    {runDraft.dx},{runDraft.dy}
                  </button>
                )}
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs">
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
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3.5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {editingBoxId ? t.editor.editTextBoxTitle : t.editor.addTextBoxTitle}
              </h3>
              <button
                onClick={() => {
                  const wasAdding = !editingBoxId;
                  textSubmitLockRef.current = false;
                  setAddingBoxPos(null);
                  setEditingBoxId(null);
                  if (wasAdding && !keepToolActive) setActiveTool('select');
                }}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  boxTextareaRef.current?.focus();
                  boxTextareaRef.current?.select();
                }}
                className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
              >
                {t.editor.selectAllText}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewBoxDraft((d) => ({ ...d, text: '' }));
                  boxTextareaRef.current?.focus();
                }}
                className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
              >
                {t.editor.clearText}
              </button>
            </div>
            <textarea
              ref={boxTextareaRef}
              rows={3}
              value={newBoxDraft.text}
              onChange={(e) => setNewBoxDraft((d) => ({ ...d, text: e.target.value }))}
              placeholder={t.editor.textPlaceholder}
              style={{ fontFamily: getFontCssStack(newBoxDraft.fontFamily) }}
              autoFocus
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={newBoxDraft.fontFamily}
                onChange={(e) =>
                  setNewBoxDraft((d) => ({ ...d, fontFamily: e.target.value as PdfFontFamily }))
                }
                style={{ fontFamily: getFontCssStack(newBoxDraft.fontFamily) }}
                className="h-10 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              >
                {OFFICIAL_FONT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} style={{ fontFamily: opt.cssStack }}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setNewBoxDraft((d) => ({ ...d, fontSize: Math.max(8, d.fontSize - 1) }))}
                  className="h-10 px-2 text-xs font-bold hover:bg-slate-200/60 dark:hover:bg-slate-700"
                >
                  A-
                </button>
                <input
                  type="number"
                  min={8}
                  max={64}
                  value={newBoxDraft.fontSize}
                  onChange={(e) => setNewBoxDraft((d) => ({ ...d, fontSize: Number(e.target.value) || 14 }))}
                  className="w-11 h-10 px-1 bg-transparent text-center text-xs font-mono-nums"
                />
                <button
                  type="button"
                  onClick={() => setNewBoxDraft((d) => ({ ...d, fontSize: Math.min(64, d.fontSize + 1) }))}
                  className="h-10 px-2 text-xs font-bold hover:bg-slate-200/60 dark:hover:bg-slate-700"
                >
                  A+
                </button>
              </div>
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
              <div className="flex items-center gap-1">
                {(['#0F172A', '#142B4A', '#2563EB', '#DC2626', '#16A34A'] as const).map((tc) => (
                  <button
                    key={`box_clr_${tc}`}
                    type="button"
                    onClick={() => setNewBoxDraft((d) => ({ ...d, color: tc }))}
                    style={{ backgroundColor: tc }}
                    className={`w-6 h-6 rounded-full border-2 shrink-0 ${
                      newBoxDraft.color.toUpperCase() === tc ? 'border-slate-900 dark:border-white scale-110' : 'border-transparent'
                    }`}
                    aria-label={`Box text color ${tc}`}
                  />
                ))}
                <input
                  type="color"
                  value={newBoxDraft.color}
                  onChange={(e) => setNewBoxDraft((d) => ({ ...d, color: e.target.value }))}
                  className="w-9 h-9 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs flex-wrap">
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
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setNewBoxDraft((d) => ({ ...d, border: !d.border }))}
                  className={`h-7 px-2 rounded-lg border font-semibold ${
                    newBoxDraft.border
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {language === 'bn' ? 'বর্ডার' : 'Border'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setNewBoxDraft((d) => ({ ...d, rotation: (d.rotation + 90) % 360 }))
                  }
                  className="h-7 px-2 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center gap-1 font-semibold"
                >
                  <RotateCw className="w-3.5 h-3.5" /> {newBoxDraft.rotation}°
                </button>
              </div>
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
                  if (textSubmitLockRef.current || !newBoxDraft.text.trim()) return;
                  textSubmitLockRef.current = true;
                  try {
                    lastBoxPrefsRef.current = {
                      fontSize: newBoxDraft.fontSize,
                      fontFamily: newBoxDraft.fontFamily,
                    };
                    const wasAdding = !editingBoxId;
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
                                borderColor: newBoxDraft.border ? newBoxDraft.color : undefined,
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
                      const newId = nextElementId('tb');
                      commitState((prev) => ({
                        ...prev,
                        addedTexts: [
                          ...prev.addedTexts,
                          {
                            id: newId,
                            pageNumber,
                            text: newBoxDraft.text,
                            x: addingBoxPos.x,
                            y: addingBoxPos.y,
                            width: 260,
                            fontSize: newBoxDraft.fontSize,
                            fontFamily: newBoxDraft.fontFamily,
                            color: newBoxDraft.color,
                            backgroundColor: newBoxDraft.backgroundColor,
                            borderColor: newBoxDraft.border ? newBoxDraft.color : undefined,
                            rotation: newBoxDraft.rotation,
                            bold: newBoxDraft.bold,
                            italic: newBoxDraft.italic,
                            underline: newBoxDraft.underline,
                            align: newBoxDraft.align,
                            letterSpacing: newBoxDraft.letterSpacing,
                            zIndex: getNextTopZIndex(prev, pageNumber),
                          },
                        ],
                      }));
                      setSelectedElement({ kind: 'textBox', id: newId });
                    }
                    setAddingBoxPos(null);
                    setEditingBoxId(null);
                    if (wasAdding && !keepToolActive) setActiveTool('select');
                  } finally {
                    textSubmitLockRef.current = false;
                  }
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
                  const wasAdding = !editingStickyId;
                  setStickyPos(null);
                  setEditingStickyId(null);
                  if (wasAdding && !keepToolActive) setActiveTool('select');
                }}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  stickyTextareaRef.current?.focus();
                  stickyTextareaRef.current?.select();
                }}
                className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
              >
                {t.editor.selectAllText}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStickyText('');
                  stickyTextareaRef.current?.focus();
                }}
                className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
              >
                {t.editor.clearText}
              </button>
            </div>
            <textarea
              ref={stickyTextareaRef}
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
                  const newId = nextElementId('sticky');
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
                        zIndex: getNextTopZIndex(prev, pageNumber),
                      },
                    ],
                  }));
                  setSelectedElement({ kind: 'annotation', id: newId });
                }
                const wasAdding = !editingStickyId;
                setStickyPos(null);
                setEditingStickyId(null);
                if (wasAdding && !keepToolActive) setActiveTool('select');
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              {editingStickyId ? t.editor.updateSticky : t.editor.addSticky}
            </button>
          </div>
        </div>
      )}

      {/* Edit Stamp Modal */}
      {editingStampId && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {t.editor.stampEditTitle}
              </h3>
              <button
                onClick={() => setEditingStampId(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={stampEditDraft.text}
              onChange={(e) => setStampEditDraft((d) => ({ ...d, text: e.target.value }))}
              className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-bold"
              autoFocus
            />
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5">
                {PALETTE_COLORS.slice(0, 6).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setStampEditDraft((d) => ({ ...d, color: c }))}
                    style={{ backgroundColor: c }}
                    className={`w-6 h-6 rounded-full border-2 ${
                      stampEditDraft.color === c ? 'border-slate-900 dark:border-white scale-110' : 'border-transparent'
                    }`}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => setStampEditDraft((d) => ({ ...d, solidFill: !d.solidFill }))}
                className={`px-2.5 py-1.5 rounded-lg font-semibold border ${
                  stampEditDraft.solidFill
                    ? 'bg-[#2563EB] text-white border-[#2563EB]'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                {stampEditDraft.solidFill ? t.editor.stampSolid : t.editor.stampOutline}
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                const txt = stampEditDraft.text.trim() || 'APPROVED';
                const nextW = Math.max(84, txt.length * (stampEditDraft.fontSize * 0.72) + 24);
                commitState((prev) => ({
                  ...prev,
                  annotations: prev.annotations.map((an) =>
                    an.id === editingStampId
                      ? {
                          ...an,
                          comment: txt,
                          color: stampEditDraft.color,
                          fillColor: stampEditDraft.solidFill ? stampEditDraft.color : undefined,
                          width: Math.round(nextW),
                        }
                      : an
                  ),
                }));
                setEditingStampId(null);
              }}
              className="w-full min-h-[44px] rounded-xl bg-[#2563EB] text-white text-sm font-semibold"
            >
              {t.editor.updateText}
            </button>
          </div>
        </div>
      )}

      <SignatureModal
        open={showSigModal}
        language={language}
        onClose={() => setShowSigModal(false)}
        onSelectSignature={(sig) => {
          setPendingSig(sig);
          setShowSigModal(false);
          flashStatus(t.editor.tapToPlaceSig, 3000);
        }}
      />

      {/* Crop Inserted Image Modal */}
      {cropModalImg && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3.5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {t.editor.cropImageTitle}
              </h3>
              <button onClick={() => setCropModalImg(null)} className="min-h-[40px] min-w-[40px] flex items-center justify-center">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Aspect Ratio Presets */}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {[
                { id: 'free', label: t.editor.cropFree, ratio: null },
                { id: '1:1', label: '1:1', ratio: 1 },
                { id: '3:4', label: '3:4 ID', ratio: 3 / 4 },
                { id: '4:3', label: '4:3', ratio: 4 / 3 },
                { id: '16:9', label: '16:9', ratio: 16 / 9 },
              ].map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    if (!preset.ratio) {
                      setCropInsets({ top: 0, right: 0, bottom: 0, left: 0 });
                      return;
                    }
                    const natW = cropNaturalSize?.w || cropModalImg.width;
                    const natH = cropNaturalSize?.h || cropModalImg.height;
                    const curRatio = natW / Math.max(1, natH);
                    if (curRatio > preset.ratio) {
                      const keepWFrac = preset.ratio / curRatio;
                      const insetPct = Math.min(40, Math.max(0, Math.round(((1 - keepWFrac) / 2) * 100)));
                      setCropInsets({ top: 0, bottom: 0, left: insetPct, right: insetPct });
                    } else {
                      const keepHFrac = curRatio / preset.ratio;
                      const insetPct = Math.min(40, Math.max(0, Math.round(((1 - keepHFrac) / 2) * 100)));
                      setCropInsets({ left: 0, right: 0, top: insetPct, bottom: insetPct });
                    }
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-[#2563EB] hover:text-white font-semibold transition-colors"
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCropInsets({ top: 0, right: 0, bottom: 0, left: 0 })}
                className="ml-auto px-2 py-1 rounded-lg text-rose-500 font-semibold flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> {t.editor.cropReset}
              </button>
            </div>

            <div className="relative mx-auto w-fit max-h-52 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800">
              <img
                src={cropModalImg.dataUrl}
                alt="Crop preview"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth && el.naturalHeight) {
                    setCropNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
                  }
                }}
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
                    max={45}
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

      {/* Adjust Picture Pro Modal */}
      {showImageAdjustModal && selectedImg && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-3.5 max-h-[92vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {t.editor.adjustImageTitle}
              </h3>
              <button
                type="button"
                onClick={() => {
                  const baseSnap = preGestureSnapshotRef.current;
                  const curImg = stateRef.current.addedImages.find((im) => im.id === selectedImg.id);
                  const baseImg = baseSnap?.addedImages.find((im) => im.id === selectedImg.id);
                  if (baseSnap && curImg && baseImg && JSON.stringify(curImg) !== JSON.stringify(baseImg)) {
                    pushUndoSnapshot(baseSnap);
                  }
                  preGestureSnapshotRef.current = null;
                  setShowImageAdjustModal(false);
                }}
                className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Live Compact Picture Preview */}
            <div className="h-28 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-center overflow-hidden p-2">
              <div
                style={{
                  opacity: selectedImg.opacity ?? 1,
                  transform: `rotate(${selectedImg.rotation || 0}deg)`,
                  borderRadius: `${Math.min(72, 72 * ((selectedImg.borderRadius || 0) / 100))}px`,
                  border:
                    selectedImg.borderWidth && selectedImg.borderWidth > 0
                      ? `${selectedImg.borderWidth}px solid ${selectedImg.borderColor || '#142B4A'}`
                      : undefined,
                  overflow: 'hidden',
                }}
                className="max-h-24 flex items-center justify-center"
              >
                <img
                  src={selectedImg.dataUrl}
                  alt="Adjust preview"
                  style={{
                    transform: `scale(${selectedImg.flipX ? -1 : 1}, ${selectedImg.flipY ? -1 : 1})`,
                    filter: [
                      (selectedImg.brightness ?? 100) !== 100 ? `brightness(${selectedImg.brightness}%)` : '',
                      (selectedImg.contrast ?? 100) !== 100 ? `contrast(${selectedImg.contrast}%)` : '',
                      selectedImg.grayscale ? 'grayscale(100%)' : '',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined,
                  }}
                  className="max-h-24 max-w-[200px] object-contain block"
                />
              </div>
            </div>

            {/* Dimensions + Aspect Ratio Lock + Align */}
            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
              <div className="grid grid-cols-3 gap-2 items-end">
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-500">W (pt)</span>
                  <input
                    type="number"
                    min={20}
                    max={Math.round(pageSize.width)}
                    value={Math.round(selectedImg.width)}
                    onChange={(e) => {
                      const nextW = Math.max(20, Math.min(pageSize.width, Number(e.target.value) || 20));
                      const ratio = selectedImg.width / Math.max(1, selectedImg.height);
                      const nextH =
                        selectedImg.lockAspect !== false ? Math.max(20, Math.round(nextW / ratio)) : selectedImg.height;
                      updateStateLive((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, width: nextW, height: nextH } : im
                        ),
                      }));
                    }}
                    className="w-full h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-500">H (pt)</span>
                  <input
                    type="number"
                    min={20}
                    max={Math.round(pageSize.height)}
                    value={Math.round(selectedImg.height)}
                    onChange={(e) => {
                      const nextH = Math.max(20, Math.min(pageSize.height, Number(e.target.value) || 20));
                      const ratio = selectedImg.width / Math.max(1, selectedImg.height);
                      const nextW =
                        selectedImg.lockAspect !== false ? Math.max(20, Math.round(nextH * ratio)) : selectedImg.width;
                      updateStateLive((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, width: nextW, height: nextH } : im
                        ),
                      }));
                    }}
                    className="w-full h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono-nums"
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, lockAspect: im.lockAspect === false } : im
                      ),
                    }))
                  }
                  className={`h-9 px-2 rounded-lg font-semibold border flex items-center justify-center gap-1 ${
                    selectedImg.lockAspect !== false
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {selectedImg.lockAspect !== false ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  <span className="truncate">{selectedImg.lockAspect !== false ? t.editor.lockAspect : t.editor.freeAspect}</span>
                </button>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id
                          ? { ...im, x: Math.max(0, Math.round((pageSize.width - im.width) / 2)) }
                          : im
                      ),
                    }))
                  }
                  className="h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold"
                >
                  {t.editor.centerH}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id
                          ? { ...im, y: Math.max(0, Math.round((pageSize.height - im.height) / 2)) }
                          : im
                      ),
                    }))
                  }
                  className="h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold"
                >
                  {t.editor.centerV}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const targetW = Math.max(80, Math.round(pageSize.width - 48));
                    const targetH = Math.max(
                      24,
                      Math.round((targetW / Math.max(1, selectedImg.width)) * selectedImg.height)
                    );
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, x: 24, width: targetW, height: targetH } : im
                      ),
                    }));
                  }}
                  className="h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-semibold"
                >
                  {t.editor.fitPageWidth}
                </button>
              </div>

              {/* Fine Nudge D-Pad */}
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] font-semibold text-slate-500">{t.editor.nudgePosition}</span>
                <div className="flex items-center gap-1">
                  {[
                    { icon: ArrowLeft, dx: -2, dy: 0, label: 'Nudge left' },
                    { icon: ArrowUp, dx: 0, dy: -2, label: 'Nudge up' },
                    { icon: ArrowDown, dx: 0, dy: 2, label: 'Nudge down' },
                    { icon: ArrowRight, dx: 2, dy: 0, label: 'Nudge right' },
                  ].map((btn, i) => {
                    const Icon = btn.icon;
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-label={btn.label}
                        onClick={() =>
                          updateStateLive((prev) => ({
                            ...prev,
                            addedImages: prev.addedImages.map((im) =>
                              im.id === selectedImg.id
                                ? {
                                    ...im,
                                    x: Math.max(0, Math.min(pageSize.width - 10, im.x + btn.dx)),
                                    y: Math.max(0, Math.min(pageSize.height - 10, im.y + btn.dy)),
                                  }
                                : im
                            ),
                          }))
                        }
                        className="w-8 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-center"
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Smooth Rotation & Flip */}
            <div className="space-y-2">
              <label className="block">
                <span className="flex justify-between text-slate-500 font-semibold mb-1">
                  <span>{t.editor.fineRotate}</span>
                  <span className="font-mono-nums">{selectedImg.rotation || 0}°</span>
                </span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={selectedImg.rotation > 180 ? selectedImg.rotation - 360 : selectedImg.rotation}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, rotation: val } : im
                      ),
                    }));
                  }}
                  className="w-full accent-[#2563EB]"
                />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {[-90, 0, 90].map((deg) => (
                  <button
                    key={deg}
                    type="button"
                    onClick={() =>
                      updateStateLive((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, rotation: deg } : im
                        ),
                      }))
                    }
                    className={`px-2.5 py-1 rounded-lg font-mono-nums font-semibold border ${
                      (selectedImg.rotation || 0) === deg
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {deg}°
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, flipX: !im.flipX } : im
                      ),
                    }))
                  }
                  className={`px-2.5 py-1 rounded-lg font-semibold border flex items-center gap-1 ${
                    selectedImg.flipX
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <FlipHorizontal2 className="w-3.5 h-3.5" /> {t.editor.flipH}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, flipY: !im.flipY } : im
                      ),
                    }))
                  }
                  className={`px-2.5 py-1 rounded-lg font-semibold border flex items-center gap-1 ${
                    selectedImg.flipY
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <FlipVertical2 className="w-3.5 h-3.5" /> {t.editor.flipV}
                </button>
              </div>
            </div>

            {/* Opacity, Brightness, Contrast */}
            <div className="grid grid-cols-1 gap-2">
              <label className="block">
                <span className="flex justify-between text-slate-500 font-semibold">
                  <span>{t.editor.opacity}</span>
                  <span className="font-mono-nums">{Math.round((selectedImg.opacity ?? 1) * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round((selectedImg.opacity ?? 1) * 100)}
                  onChange={(e) => {
                    const op = Number(e.target.value) / 100;
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, opacity: op } : im
                      ),
                    }));
                  }}
                  className="w-full accent-[#2563EB]"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="flex justify-between text-slate-500 font-semibold">
                    <span>{t.editor.brightness}</span>
                    <span className="font-mono-nums">{selectedImg.brightness ?? 100}%</span>
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={150}
                    value={selectedImg.brightness ?? 100}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      updateStateLive((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, brightness: val } : im
                        ),
                      }));
                    }}
                    className="w-full accent-[#2563EB]"
                  />
                </label>
                <label className="block">
                  <span className="flex justify-between text-slate-500 font-semibold">
                    <span>{t.editor.contrast}</span>
                    <span className="font-mono-nums">{selectedImg.contrast ?? 100}%</span>
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={150}
                    value={selectedImg.contrast ?? 100}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      updateStateLive((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, contrast: val } : im
                        ),
                      }));
                    }}
                    className="w-full accent-[#2563EB]"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, grayscale: !im.grayscale } : im
                      ),
                    }))
                  }
                  className={`px-3 py-1.5 rounded-xl font-semibold border ${
                    selectedImg.grayscale
                      ? 'bg-[#2563EB] text-white border-[#2563EB]'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {t.editor.grayscale}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const img = new Image();
                    img.onload = () => {
                      const c = document.createElement('canvas');
                      c.width = img.naturalWidth || 200;
                      c.height = img.naturalHeight || 200;
                      const ctx = c.getContext('2d')!;
                      ctx.drawImage(img, 0, 0);
                      const imgData = ctx.getImageData(0, 0, c.width, c.height);
                      const d = imgData.data;
                      for (let i = 0; i < d.length; i += 4) {
                        const r = d[i];
                        const g = d[i + 1];
                        const b = d[i + 2];
                        if (r > 228 && g > 228 && b > 228) {
                          d[i + 3] = 0;
                        } else if (r > 205 && g > 205 && b > 205) {
                          d[i + 3] = Math.round(d[i + 3] * 0.35);
                        }
                      }
                      ctx.putImageData(imgData, 0, 0);
                      const cleanUrl = c.toDataURL('image/png');
                      commitState((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, dataUrl: cleanUrl } : im
                        ),
                      }));
                    };
                    img.src = selectedImg.dataUrl;
                  }}
                  className="px-3 py-1.5 rounded-xl font-semibold border border-slate-200 dark:border-slate-700 hover:border-[#2563EB] text-[#142B4A] dark:text-slate-200"
                >
                  {t.editor.removeWhiteBg}
                </button>
              </div>
            </div>

            {/* Rounded Corners & Frame Border */}
            <div className="grid grid-cols-2 gap-3 pt-1 border-t border-slate-100 dark:border-slate-800">
              <label className="block">
                <span className="flex justify-between text-slate-500 font-semibold">
                  <span>{t.editor.cornerRadius}</span>
                  <span className="font-mono-nums">{selectedImg.borderRadius ?? 0}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={50}
                  value={selectedImg.borderRadius ?? 0}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    updateStateLive((prev) => ({
                      ...prev,
                      addedImages: prev.addedImages.map((im) =>
                        im.id === selectedImg.id ? { ...im, borderRadius: val } : im
                      ),
                    }));
                  }}
                  className="w-full accent-[#2563EB]"
                />
              </label>
              <div>
                <span className="flex justify-between text-slate-500 font-semibold mb-1">
                  <span>{t.editor.frameBorder}</span>
                  <span className="font-mono-nums">{selectedImg.borderWidth ?? 0}pt</span>
                </span>
                <div className="flex items-center gap-1">
                  {[0, 1.5, 3, 5].map((bw) => (
                    <button
                      key={bw}
                      type="button"
                      onClick={() =>
                        updateStateLive((prev) => ({
                          ...prev,
                          addedImages: prev.addedImages.map((im) =>
                            im.id === selectedImg.id ? { ...im, borderWidth: bw } : im
                          ),
                        }))
                      }
                      className={`flex-1 h-7 rounded-lg font-mono-nums font-semibold border ${
                        (selectedImg.borderWidth ?? 0) === bw
                          ? 'bg-[#2563EB] text-white border-[#2563EB]'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {bw === 0 ? '0' : bw}
                    </button>
                  ))}
                  <input
                    type="color"
                    value={selectedImg.borderColor || '#142B4A'}
                    onChange={(e) =>
                      updateStateLive((prev) => ({
                        ...prev,
                        addedImages: prev.addedImages.map((im) =>
                          im.id === selectedImg.id ? { ...im, borderColor: e.target.value } : im
                        ),
                      }))
                    }
                    className="w-7 h-7 rounded-lg shrink-0"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() =>
                  updateStateLive((prev) => ({
                    ...prev,
                    addedImages: prev.addedImages.map((im) =>
                      im.id === selectedImg.id
                        ? {
                            ...im,
                            rotation: 0,
                            opacity: 1,
                            flipX: false,
                            flipY: false,
                            brightness: 100,
                            contrast: 100,
                            grayscale: false,
                            borderRadius: 0,
                            borderWidth: 0,
                            lockAspect: true,
                          }
                        : im
                    ),
                  }))
                }
                className="min-h-[42px] rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold"
              >
                {t.editor.resetImage}
              </button>
              <button
                type="button"
                onClick={() => {
                  const baseSnap = preGestureSnapshotRef.current;
                  const curImg = stateRef.current.addedImages.find((im) => im.id === selectedImg.id);
                  const baseImg = baseSnap?.addedImages.find((im) => im.id === selectedImg.id);
                  if (baseSnap && curImg && baseImg && JSON.stringify(curImg) !== JSON.stringify(baseImg)) {
                    pushUndoSnapshot(baseSnap);
                  }
                  preGestureSnapshotRef.current = null;
                  setShowImageAdjustModal(false);
                }}
                className="min-h-[42px] rounded-xl bg-[#2563EB] text-white font-semibold"
              >
                {t.editor.applyChanges}
              </button>
            </div>
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
                  void handleSave('version', true);
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
