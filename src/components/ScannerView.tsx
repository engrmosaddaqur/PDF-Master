import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  Check,
  Copy,
  Crop,
  Download,
  Eye,
  FileText,
  Grid3x3,
  ImagePlus,
  Layers,
  Loader2,
  Maximize2,
  Pencil,
  RefreshCw,
  RotateCw,
  ScanLine,
  ScanText,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import {
  applyScanEnhancement,
  compileScannedPagesToPdf,
  detectDocumentBoundsWithConfidence,
  getResolutionMaxDim,
  perspectiveWarpCanvas,
  type DocumentBoundsResult,
  type EdgeSensitivity,
  type Point2D,
  type ScanCompileOptions,
  type ScanFilter,
  type ScanMarginSize,
  type ScanOrientation,
  type ScanPaperSize,
  type ScanResolutionTier,
} from '../services/imageProcessing';
import {
  cloneBuffer,
  createSearchablePdfFromOcr,
  renderPageThumbnail,
} from '../services/pdfEngine';
import { runOnDeviceOcrBatch, type OcrLanguage } from '../services/ocrService';
import { emitAppToast, saveBufferToDeviceStorage } from '../services/deviceFileActions';

export type ScannerNextAction = 'viewer' | 'ocr' | 'editor';

interface ScannerViewProps {
  language: AppLanguage;
  autoCropDefault: boolean;
  defaultFilter: ScanFilter;
  onClose: () => void;
  onSaveScannedPdf: (
    doc: DocumentRecord,
    nextAction?: ScannerNextAction | boolean
  ) => Promise<void>;
  onOpenInWordCreator?: (html: string) => void;
}

interface ScannedPageItem {
  id: string;
  rawCanvas: HTMLCanvasElement;
  rawPreviewUrl: string;
  warpedCanvas: HTMLCanvasElement;
  warpedOriginalUrl: string;
  corners: [Point2D, Point2D, Point2D, Point2D];
  sideLocked: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  filter: ScanFilter;
  brightness: number;
  contrast: number;
  shadowClean: number;
  sharpen: boolean;
  rotation: number;
  processedUrl: string;
}

type DragTarget =
  | { type: 'corner'; index: number }
  | {
      type: 'edge';
      edge: 'top' | 'right' | 'bottom' | 'left';
      startX: number;
      startY: number;
      origCorners: [Point2D, Point2D, Point2D, Point2D];
    };

function getDefaultShadowForFilter(filter: ScanFilter): number {
  if (filter === 'docPro') return 85;
  if (filter === 'magic') return 75;
  if (filter === 'bw') return 65;
  if (filter === 'grayscale') return 50;
  return 10;
}

function renderRotatedPreviewUrl(
  sourceCanvas: HTMLCanvasElement,
  rotation: number
): string {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 0) {
    return sourceCanvas.toDataURL('image/jpeg', 0.88);
  }
  const swap = rot === 90 || rot === 270;
  const c = document.createElement('canvas');
  c.width = swap ? sourceCanvas.height : sourceCanvas.width;
  c.height = swap ? sourceCanvas.width : sourceCanvas.height;
  const ctx = c.getContext('2d')!;
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  ctx.restore();
  return c.toDataURL('image/jpeg', 0.88);
}

function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1] || '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  language,
  autoCropDefault,
  defaultFilter,
  onClose,
  onSaveScannedPdf,
  onOpenInWordCreator,
}) => {
  const t = getT(language);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cropBoxRef = useRef<HTMLDivElement | null>(null);
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [continuousMode, setContinuousMode] = useState(true);
  const [autoCapture, setAutoCapture] = useState(false);
  const [edgeSensitivity, setEdgeSensitivity] = useState<EdgeSensitivity>('high');
  const [resolutionTier, setResolutionTier] = useState<ScanResolutionTier>('ultra');
  const [liveBounds, setLiveBounds] = useState<DocumentBoundsResult | null>(null);
  const [videoAspect, setVideoAspect] = useState<number>(3 / 4);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const [pages, setPages] = useState<ScannedPageItem[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [step, setStep] = useState<'capture' | 'crop' | 'review'>('capture');
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [loupeFocus, setLoupeFocus] = useState<Point2D | null>(null);
  const [compareOriginal, setCompareOriginal] = useState(false);

  // Complete-Document Options
  const [docTitle, setDocTitle] = useState(
    () => `Document_${new Date().toISOString().slice(0, 10)}`
  );
  const [paperSize, setPaperSize] = useState<ScanPaperSize>('a4');
  const [marginSize, setMarginSize] = useState<ScanMarginSize>('narrow');
  const [orientation, setOrientation] = useState<ScanOrientation>('auto');
  const [addPageNumbers, setAddPageNumbers] = useState(true);
  const [ocrLang, setOcrLang] = useState<OcrLanguage>(
    language === 'bn' ? 'eng+ben' : 'eng'
  );

  const [saving, setSaving] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{
    page: number;
    total: number;
    pct: number;
  } | null>(null);
  const [applyBatchNotice, setApplyBatchNotice] = useState<string | null>(null);

  const smoothedBoundsRef = useRef<DocumentBoundsResult | null>(null);
  const stableLockTicksRef = useRef<number>(0);
  const lastAutoSnapRef = useRef<number>(0);

  // Prefer Doc Pro cleanly if user kept legacy default 'magic' or explicit choice
  const initialFilter: ScanFilter = defaultFilter || 'docPro';

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
    setTorchSupported(false);
    setTorchOn(false);
    setLiveBounds(null);
    smoothedBoundsRef.current = null;
    stableLockTicksRef.current = 0;
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()?.[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  };

  const startCamera = async (overrideFacing?: 'environment' | 'user') => {
    setCameraError(null);
    const targetFacing = overrideFacing ?? facingMode;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    try {
      let stream: MediaStream;
      try {
        // Request highest available 4K / UHD camera stream first
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: targetFacing },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: targetFacing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()?.[0];
      const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorchSupported(Boolean(caps?.torch));
      setTorchOn(false);
      setCameraActive(true);
      setStep('capture');
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 60);
    } catch {
      setCameraError(
        language === 'bn'
          ? 'লাইভ ক্যামেরা চালু করা যায়নি বা অনুমতি দেওয়া হয়নি। "গ্যালারি থেকে নিন" ব্যবহার করুন।'
          : 'Live camera unavailable or permission denied. Use "Choose Photo" to scan from camera/gallery.'
      );
    }
  };

  const ingestSourceCanvas = (
    rawCanvas: HTMLCanvasElement,
    options?: {
      stayInCamera?: boolean;
      overrideSensitivity?: EdgeSensitivity;
      hintBounds?: DocumentBoundsResult | null;
      tier?: ScanResolutionTier;
    }
  ) => {
    const sens = options?.overrideSensitivity ?? edgeSensitivity;
    const tier = options?.tier ?? resolutionTier;
    const targetMaxDim = getResolutionMaxDim(tier);
    const detected = autoCropDefault
      ? options?.hintBounds && options.hintBounds.confidence >= 0.52
        ? options.hintBounds
        : detectDocumentBoundsWithConfidence(rawCanvas, sens)
      : {
          corners: [
            { x: 0.02, y: 0.02 },
            { x: 0.98, y: 0.02 },
            { x: 0.98, y: 0.98 },
            { x: 0.02, y: 0.98 },
          ] as [Point2D, Point2D, Point2D, Point2D],
          confidence: 1,
          sideLocked: { top: true, right: true, bottom: true, left: true },
        };

    const warped = perspectiveWarpCanvas(rawCanvas, detected.corners, {
      maxDim: targetMaxDim,
      allowUpscale: tier !== 'standard',
    });
    const chosenFilter = initialFilter;
    const shadowClean = getDefaultShadowForFilter(chosenFilter);
    const processedUrl = applyScanEnhancement(warped, {
      filter: chosenFilter,
      brightness: 0,
      contrast: 8,
      shadowClean,
      sharpen: true,
      rotation: 0,
      jpegQuality: tier === 'ultra' ? 0.96 : 0.94,
    });

    const newItem: ScannedPageItem = {
      id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      rawCanvas,
      rawPreviewUrl: rawCanvas.toDataURL('image/jpeg', 0.84),
      warpedCanvas: warped,
      warpedOriginalUrl: renderRotatedPreviewUrl(warped, 0),
      corners: detected.corners,
      sideLocked: detected.sideLocked,
      filter: chosenFilter,
      brightness: 0,
      contrast: 8,
      shadowClean,
      sharpen: true,
      rotation: 0,
      processedUrl,
    };

    setPages((prev) => {
      const next = [...prev, newItem];
      setActiveIdx(next.length - 1);
      return next;
    });

    if (!options?.stayInCamera) {
      setStep('crop');
    }
  };

  const captureFromVideo = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight || capturing) return;
    setCapturing(true);
    const lockedHint = smoothedBoundsRef.current;
    const maxCap = getResolutionMaxDim(resolutionTier);

    try {
      let c: HTMLCanvasElement | null = null;

      // Attempt native full-sensor ImageCapture.takePhoto() when available on track
      const track = streamRef.current?.getVideoTracks()?.[0];
      const ImageCaptureCtor = (
        window as unknown as {
          ImageCapture?: new (track: MediaStreamTrack) => {
            takePhoto?: () => Promise<Blob>;
          };
        }
      ).ImageCapture;

      if (track && ImageCaptureCtor) {
        try {
          const ic = new ImageCaptureCtor(track);
          if (typeof ic.takePhoto === 'function') {
            const blob = await ic.takePhoto();
            const bitmapUrl = URL.createObjectURL(blob);
            try {
              const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('ImageCapture decode failed'));
                im.src = bitmapUrl;
              });
              let cw = img.naturalWidth || video.videoWidth;
              let ch = img.naturalHeight || video.videoHeight;
              if (cw > maxCap || ch > maxCap) {
                const s = maxCap / Math.max(cw, ch);
                cw = Math.round(cw * s);
                ch = Math.round(ch * s);
              }
              c = document.createElement('canvas');
              c.width = cw;
              c.height = ch;
              c.getContext('2d')!.drawImage(img, 0, 0, cw, ch);
            } finally {
              URL.revokeObjectURL(bitmapUrl);
            }
          }
        } catch {
          c = null;
        }
      }

      // Fallback: full-resolution live video stream frame capture (up to 3508px)
      if (!c) {
        c = document.createElement('canvas');
        let cw = video.videoWidth;
        let ch = video.videoHeight;
        if (cw > maxCap || ch > maxCap) {
          const s = maxCap / Math.max(cw, ch);
          cw = Math.round(cw * s);
          ch = Math.round(ch * s);
        }
        c.width = cw;
        c.height = ch;
        c.getContext('2d')!.drawImage(video, 0, 0, cw, ch);
      }

      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 160);
      stableLockTicksRef.current = 0;

      const capturedCanvas = c;
      if (continuousMode) {
        requestAnimationFrame(() => {
          ingestSourceCanvas(capturedCanvas, { stayInCamera: true, hintBounds: lockedHint });
        });
      } else {
        stopCamera();
        requestAnimationFrame(() => {
          ingestSourceCanvas(capturedCanvas, { stayInCamera: false, hintBounds: lockedHint });
        });
      }
    } finally {
      setCapturing(false);
    }
  };

  // Real-time 4-side & 4-corner live camera sensor loop with EMA smoothing & Auto-Capture
  useEffect(() => {
    if (!cameraActive || step !== 'capture') return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth || video.videoHeight === 0) return;
      if (!probeCanvasRef.current) {
        probeCanvasRef.current = document.createElement('canvas');
      }
      const probe = probeCanvasRef.current;
      const pw = 240;
      const ph = Math.max(135, Math.round((video.videoHeight / video.videoWidth) * pw));
      if (probe.width !== pw || probe.height !== ph) {
        probe.width = pw;
        probe.height = ph;
      }
      const pctx = probe.getContext('2d');
      if (!pctx) return;
      pctx.drawImage(video, 0, 0, pw, ph);
      const raw = detectDocumentBoundsWithConfidence(probe, edgeSensitivity);

      const prev = smoothedBoundsRef.current;
      let nextBounds = raw;
      if (prev && raw.confidence >= 0.45 && prev.confidence >= 0.45) {
        const maxJump = Math.max(
          ...raw.corners.map((c, idx) =>
            Math.hypot(c.x - prev.corners[idx].x, c.y - prev.corners[idx].y)
          )
        );
        if (maxJump < 0.16) {
          const alpha = 0.42;
          nextBounds = {
            ...raw,
            corners: raw.corners.map((c, idx) => ({
              x: prev.corners[idx].x + (c.x - prev.corners[idx].x) * alpha,
              y: prev.corners[idx].y + (c.y - prev.corners[idx].y) * alpha,
            })) as [Point2D, Point2D, Point2D, Point2D],
          };
        }
      }
      smoothedBoundsRef.current = nextBounds;
      setLiveBounds(nextBounds);

      const lockedCount =
        (nextBounds.sideLocked.top ? 1 : 0) +
        (nextBounds.sideLocked.right ? 1 : 0) +
        (nextBounds.sideLocked.bottom ? 1 : 0) +
        (nextBounds.sideLocked.left ? 1 : 0);

      if (autoCapture && lockedCount === 4 && nextBounds.confidence >= 0.62) {
        stableLockTicksRef.current += 1;
        const now = Date.now();
        if (stableLockTicksRef.current >= 5 && now - lastAutoSnapRef.current > 2400) {
          lastAutoSnapRef.current = now;
          void captureFromVideo();
        }
      } else {
        stableLockTicksRef.current = 0;
      }
    }, 170);
    return () => clearInterval(id);
  }, [cameraActive, step, edgeSensitivity, autoCapture, continuousMode, resolutionTier]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const isMultiBatch = files.length > 1;
    const maxDim = Math.max(2480, getResolutionMaxDim(resolutionTier));

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Failed to read image'));
          reader.readAsDataURL(file);
        });
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('Failed to decode image'));
          image.src = dataUrl;
        });

        let w = img.naturalWidth || 1600;
        let h = img.naturalHeight || 2200;
        if (w > maxDim || h > maxDim) {
          const s = maxDim / Math.max(w, h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.drawImage(img, 0, 0, w, h);
        ingestSourceCanvas(c, { stayInCamera: isMultiBatch });
      } catch {
        // Skip unreadable image file without blocking batch
      }
    }

    if (isMultiBatch) {
      setStep('review');
    }
  };

  const activePage = pages[activeIdx];

  const reprocessActivePage = (
    patch: Partial<ScannedPageItem>,
    overrideTier?: ScanResolutionTier
  ) => {
    if (!activePage) return;
    const tier = overrideTier ?? resolutionTier;
    const updated = { ...activePage, ...patch };
    if (patch.filter && patch.shadowClean === undefined) {
      updated.shadowClean = getDefaultShadowForFilter(patch.filter);
    }
    const warped =
      patch.corners !== undefined || overrideTier !== undefined
        ? perspectiveWarpCanvas(updated.rawCanvas, updated.corners, {
            maxDim: getResolutionMaxDim(tier),
            allowUpscale: tier !== 'standard',
          })
        : updated.warpedCanvas;
    updated.warpedCanvas = warped;
    if (
      patch.corners !== undefined ||
      patch.rotation !== undefined ||
      overrideTier !== undefined
    ) {
      updated.warpedOriginalUrl = renderRotatedPreviewUrl(warped, updated.rotation);
    }
    updated.processedUrl = applyScanEnhancement(warped, {
      filter: updated.filter,
      brightness: updated.brightness,
      contrast: updated.contrast,
      shadowClean: updated.shadowClean,
      sharpen: updated.sharpen,
      rotation: updated.rotation,
      jpegQuality: tier === 'ultra' ? 0.96 : 0.94,
    });
    setPages((prev) => prev.map((p, i) => (i === activeIdx ? updated : p)));
  };

  const handleResolutionTierChange = (nextTier: ScanResolutionTier) => {
    setResolutionTier(nextTier);
    if (pages.length === 0) return;
    const maxDim = getResolutionMaxDim(nextTier);
    setPages((prev) =>
      prev.map((p) => {
        const warped = perspectiveWarpCanvas(p.rawCanvas, p.corners, {
          maxDim,
          allowUpscale: nextTier !== 'standard',
        });
        return {
          ...p,
          warpedCanvas: warped,
          warpedOriginalUrl: renderRotatedPreviewUrl(warped, p.rotation),
          processedUrl: applyScanEnhancement(warped, {
            filter: p.filter,
            brightness: p.brightness,
            contrast: p.contrast,
            shadowClean: p.shadowClean,
            sharpen: p.sharpen,
            rotation: p.rotation,
            jpegQuality: nextTier === 'ultra' ? 0.96 : 0.94,
          }),
        };
      })
    );
  };

  const applyEnhancementsToAll = () => {
    if (!activePage || pages.length <= 1) return;
    const { filter, brightness, contrast, shadowClean, sharpen } = activePage;
    const jq = resolutionTier === 'ultra' ? 0.96 : 0.94;
    setPages((prev) =>
      prev.map((p) => {
        const nextUrl = applyScanEnhancement(p.warpedCanvas, {
          filter,
          brightness,
          contrast,
          shadowClean,
          sharpen,
          rotation: p.rotation,
          jpegQuality: jq,
        });
        return {
          ...p,
          filter,
          brightness,
          contrast,
          shadowClean,
          sharpen,
          processedUrl: nextUrl,
        };
      })
    );
    setApplyBatchNotice(t.scanner.applyToAllDone);
    setTimeout(() => setApplyBatchNotice(null), 2400);
  };

  // Render live zoomed magnifier loupe while dragging crop handles
  useEffect(() => {
    if (!loupeFocus || !activePage || !loupeCanvasRef.current) return;
    const lc = loupeCanvasRef.current;
    const lctx = lc.getContext('2d');
    if (!lctx) return;
    const size = 104;
    lc.width = size;
    lc.height = size;
    const src = activePage.rawCanvas;
    const cx = loupeFocus.x * src.width;
    const cy = loupeFocus.y * src.height;
    const sampleRadius = Math.max(48, Math.round(Math.min(src.width, src.height) * 0.08));

    lctx.fillStyle = '#0F172A';
    lctx.fillRect(0, 0, size, size);
    lctx.drawImage(
      src,
      cx - sampleRadius,
      cy - sampleRadius,
      sampleRadius * 2,
      sampleRadius * 2,
      0,
      0,
      size,
      size
    );
    // Crosshair reticle
    lctx.strokeStyle = '#06B6D4';
    lctx.lineWidth = 1.5;
    lctx.beginPath();
    lctx.moveTo(size / 2, 10);
    lctx.lineTo(size / 2, size - 10);
    lctx.moveTo(10, size / 2);
    lctx.lineTo(size - 10, size / 2);
    lctx.stroke();
    lctx.beginPath();
    lctx.arc(size / 2, size / 2, 4, 0, Math.PI * 2);
    lctx.stroke();
  }, [loupeFocus, activePage]);

  const handleCropPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragTarget || !cropBoxRef.current || !activePage) return;
    const rect = cropBoxRef.current.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));

    if (dragTarget.type === 'corner') {
      const nextCorners = [...activePage.corners] as [Point2D, Point2D, Point2D, Point2D];
      nextCorners[dragTarget.index] = { x: nx, y: ny };
      setLoupeFocus({ x: nx, y: ny });
      setPages((prev) =>
        prev.map((p, i) => (i === activeIdx ? { ...p, corners: nextCorners } : p))
      );
      return;
    }

    const dx = nx - dragTarget.startX;
    const dy = ny - dragTarget.startY;
    const base = dragTarget.origCorners.map((pt) => ({ ...pt })) as [
      Point2D,
      Point2D,
      Point2D,
      Point2D
    ];
    const clamp = (v: number) => Math.max(0.01, Math.min(0.99, v));

    if (dragTarget.edge === 'top') {
      base[0].y = clamp(base[0].y + dy);
      base[1].y = clamp(base[1].y + dy);
      setLoupeFocus({
        x: (base[0].x + base[1].x) / 2,
        y: (base[0].y + base[1].y) / 2,
      });
    } else if (dragTarget.edge === 'bottom') {
      base[2].y = clamp(base[2].y + dy);
      base[3].y = clamp(base[3].y + dy);
      setLoupeFocus({
        x: (base[2].x + base[3].x) / 2,
        y: (base[2].y + base[3].y) / 2,
      });
    } else if (dragTarget.edge === 'left') {
      base[0].x = clamp(base[0].x + dx);
      base[3].x = clamp(base[3].x + dx);
      setLoupeFocus({
        x: (base[0].x + base[3].x) / 2,
        y: (base[0].y + base[3].y) / 2,
      });
    } else if (dragTarget.edge === 'right') {
      base[1].x = clamp(base[1].x + dx);
      base[2].x = clamp(base[2].x + dx);
      setLoupeFocus({
        x: (base[1].x + base[2].x) / 2,
        y: (base[1].y + base[2].y) / 2,
      });
    }
    setPages((prev) =>
      prev.map((p, i) => (i === activeIdx ? { ...p, corners: base } : p))
    );
  };

  const runAutoDetectOnActive = (sens: EdgeSensitivity = edgeSensitivity) => {
    if (!activePage) return;
    const res = detectDocumentBoundsWithConfidence(activePage.rawCanvas, sens);
    setPages((prev) =>
      prev.map((p, i) =>
        i === activeIdx
          ? { ...p, corners: res.corners, sideLocked: res.sideLocked }
          : p
      )
    );
  };

  const resetFullFrameOnActive = () => {
    if (!activePage) return;
    setPages((prev) =>
      prev.map((p, i) =>
        i === activeIdx
          ? {
              ...p,
              corners: [
                { x: 0.01, y: 0.01 },
                { x: 0.99, y: 0.01 },
                { x: 0.99, y: 0.99 },
                { x: 0.01, y: 0.99 },
              ],
              sideLocked: { top: true, right: true, bottom: true, left: true },
            }
          : p
      )
    );
  };

  const applyCropAndProceed = () => {
    if (!activePage) return;
    reprocessActivePage({ corners: activePage.corners });
    setStep('review');
  };

  const compileOptions: ScanCompileOptions = useMemo(
    () => ({
      paperSize,
      margin: marginSize,
      orientation,
      addPageNumbers: paperSize !== 'fit' && addPageNumbers,
      title: docTitle.trim() || `Document_${new Date().toISOString().slice(0, 10)}`,
    }),
    [paperSize, marginSize, orientation, addPageNumbers, docTitle]
  );

  const buildSanitizedPdfName = (suffix = '') => {
    const base = (docTitle.trim() || `Document_${new Date().toISOString().slice(0, 10)}`)
      .replace(/\.pdf$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    return `${base}${suffix}.pdf`;
  };

  const persistPdfDocument = async (
    pdfBytes: ArrayBuffer,
    filename: string,
    note: string,
    nextAction: ScannerNextAction
  ) => {
    const thumb = await renderPageThumbnail(pdfBytes, 1, 220).catch(
      () => pages[0].processedUrl
    );
    const now = Date.now();
    const newDoc: DocumentRecord = {
      id: `doc_scan_${now}`,
      name: filename,
      origin: 'scanned',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      sizeBytes: pdfBytes.byteLength,
      pageCount: pages.length,
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
          note,
          sizeBytes: pdfBytes.byteLength,
          pdfBytes: cloneBuffer(pdfBytes),
        },
      ],
    };
    await onSaveScannedPdf(newDoc, nextAction);
  };

  const handleSaveStandardPdf = async (nextAction: ScannerNextAction) => {
    if (pages.length === 0 || saving) return;
    setSaving(true);
    try {
      const pdfBytes = await compileScannedPagesToPdf(
        pages.map((p) => p.processedUrl),
        compileOptions
      );
      await persistPdfDocument(
        pdfBytes,
        buildSanitizedPdfName(),
        `Scanned ${pages.length} page(s) · ${paperSize.toUpperCase()}`,
        nextAction
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSearchablePdf = async () => {
    if (pages.length === 0 || saving) return;
    setSaving(true);
    setOcrProgress({ page: 1, total: pages.length, pct: 0 });
    try {
      const texts = await runOnDeviceOcrBatch(
        pages.map((p) => p.processedUrl),
        ocrLang,
        (pageIdx, pct) => {
          setOcrProgress({ page: pageIdx + 1, total: pages.length, pct });
        }
      );
      const pdfBytes = await createSearchablePdfFromOcr(
        pages.map((p, i) => ({
          imageDataUrl: p.processedUrl,
          ocrText: texts[i] || '',
        })),
        compileOptions
      );
      await persistPdfDocument(
        pdfBytes,
        buildSanitizedPdfName('_Searchable'),
        `Searchable OCR Scan (${pages.length} page${pages.length > 1 ? 's' : ''})`,
        'viewer'
      );
    } catch {
      emitAppToast({
        message:
          language === 'bn'
            ? 'সার্চেবল পিডিএফ তৈরি করা যায়নি। পুনরায় চেষ্টা করুন।'
            : 'Could not generate searchable PDF. Please retry.',
        variant: 'error',
      });
    } finally {
      setOcrProgress(null);
      setSaving(false);
    }
  };

  const handleConvertToWord = async () => {
    if (pages.length === 0 || saving || !onOpenInWordCreator) return;
    setSaving(true);
    setOcrProgress({ page: 1, total: pages.length, pct: 0 });
    try {
      const texts = await runOnDeviceOcrBatch(
        pages.map((p) => p.processedUrl),
        ocrLang,
        (pageIdx, pct) => {
          setOcrProgress({ page: pageIdx + 1, total: pages.length, pct });
        }
      );
      const heading = escapeHtml(docTitle.trim() || 'Scanned Document');
      const sections = texts.map((txt, idx) => {
        const paragraphs = txt
          .split(/\n\s*\n/)
          .map((block) => block.trim())
          .filter(Boolean)
          .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
          .join('');
        const body = paragraphs || '<p></p>';
        return pages.length > 1
          ? `<h2>${language === 'bn' ? `পৃষ্ঠা ${idx + 1}` : `Page ${idx + 1}`}</h2>${body}`
          : body;
      });
      const html = `<h1>${heading}</h1>${sections.join('')}`;
      stopCamera();
      onOpenInWordCreator(html);
    } catch {
      emitAppToast({
        message:
          language === 'bn'
            ? 'ওয়ার্ড ডকুমেন্ট তৈরি করা যায়নি।'
            : 'Could not extract document text for Word export.',
        variant: 'error',
      });
    } finally {
      setOcrProgress(null);
      setSaving(false);
    }
  };

  const handleDownloadActiveHdImage = async () => {
    if (!activePage) return;
    // Generate lossless PNG at current warped resolution for maximum print/image quality
    const pngUrl = applyScanEnhancement(activePage.warpedCanvas, {
      filter: activePage.filter,
      brightness: activePage.brightness,
      contrast: activePage.contrast,
      shadowClean: activePage.shadowClean,
      sharpen: activePage.sharpen,
      rotation: activePage.rotation,
      outputFormat: 'png',
    });
    const base = (docTitle.trim() || 'Scanned_Page')
      .replace(/\.pdf$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const filename =
      pages.length > 1 ? `${base}_Page_${activeIdx + 1}.png` : `${base}.png`;
    await saveBufferToDeviceStorage(dataUrlToBuffer(pngUrl), filename, 'image/png');
  };

  const sensOptions: Array<{ id: EdgeSensitivity; label: string }> = [
    { id: 'standard', label: language === 'bn' ? 'স্বাভাবিক' : 'Normal' },
    { id: 'high', label: language === 'bn' ? 'উচ্চ' : 'High' },
    { id: 'max', label: language === 'bn' ? 'সর্বোচ্চ' : 'Max' },
  ];

  const resOptions: Array<{ id: ScanResolutionTier; label: string }> = [
    { id: 'standard', label: t.scanner.resStandard },
    { id: 'high', label: t.scanner.resHigh },
    { id: 'ultra', label: t.scanner.resUltra },
  ];

  const lockedSidesCount = liveBounds
    ? (liveBounds.sideLocked.top ? 1 : 0) +
      (liveBounds.sideLocked.right ? 1 : 0) +
      (liveBounds.sideLocked.bottom ? 1 : 0) +
      (liveBounds.sideLocked.left ? 1 : 0)
    : 0;

  const activeDims = useMemo(() => {
    if (!activePage) return { w: 0, h: 0 };
    const swap = activePage.rotation % 180 !== 0;
    return {
      w: swap ? activePage.warpedCanvas.height : activePage.warpedCanvas.width,
      h: swap ? activePage.warpedCanvas.width : activePage.warpedCanvas.height,
    };
  }, [activePage]);

  const activeResolutionLabel =
    resOptions.find((r) => r.id === resolutionTier)?.label || t.scanner.resUltra;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#0F172A] text-white">
      <header className="flex items-center justify-between px-3 py-2.5 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            aria-label="Close scanner"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-800 shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-sm font-bold truncate">
              {t.scanner.title}
            </h1>
            <p className="text-[11px] font-mono tabular-nums text-slate-400 truncate">
              {pages.length} {t.scanner.pagesScanned} · {activeResolutionLabel}
            </p>
          </div>
        </div>

        {pages.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                stopCamera();
                void handleSaveSearchablePdf();
              }}
              disabled={saving}
              className="min-h-[40px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              <ScanText className="w-4 h-4 text-[#06B6D4]" />
              <span className="hidden sm:inline">{t.scanner.runOcr}</span>
            </button>
            <button
              onClick={() => {
                stopCamera();
                void handleSaveStandardPdf('viewer');
              }}
              disabled={saving}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#2563EB] hover:bg-blue-600 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              <span>
                {saving
                  ? language === 'bn'
                    ? 'তৈরি হচ্ছে...'
                    : 'Saving...'
                  : t.scanner.saveAsPdf}
              </span>
            </button>
          </div>
        )}
      </header>

      {/* Progress banner for Searchable PDF / Word OCR generation */}
      {ocrProgress && (
        <div className="px-4 py-2 bg-slate-900/95 border-b border-cyan-500/30 flex items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-2 text-cyan-300 font-medium">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>
              {language === 'bn'
                ? `ডকুমেন্ট টেক্সট প্রসেস হচ্ছে: পৃষ্ঠা ${ocrProgress.page}/${ocrProgress.total}`
                : `Recognizing document text: Page ${ocrProgress.page}/${ocrProgress.total}`}
            </span>
          </div>
          <span className="font-mono tabular-nums font-bold text-cyan-300">
            {ocrProgress.pct}%
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-start lg:justify-center p-3 sm:p-4">
        {step === 'capture' && (
          <div className="w-full max-w-lg my-auto space-y-3">
            {cameraActive ? (
              <div className="space-y-2.5">
                {/* Mode, Auto-Capture, Grid & Edge Sensor Controls */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 px-1">
                  <div className="flex items-center gap-1">
                    <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5">
                      <button
                        type="button"
                        onClick={() => setContinuousMode(true)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap transition-colors ${
                          continuousMode
                            ? 'bg-[#2563EB] text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        <Layers className="w-3.5 h-3.5" />
                        <span>{language === 'bn' ? 'ধারাবাহিক' : 'Batch'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setContinuousMode(false)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors ${
                          !continuousMode
                            ? 'bg-[#2563EB] text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        <span>{language === 'bn' ? 'একক' : 'Single'}</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setAutoCapture((v) => !v)}
                      className={`px-2.5 py-1.5 rounded-xl border text-[11px] font-semibold whitespace-nowrap transition-colors ${
                        autoCapture
                          ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {language === 'bn' ? 'অটো' : 'Auto'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowGrid((v) => !v)}
                      title={t.scanner.gridGuide}
                      aria-label={t.scanner.gridGuide}
                      className={`p-1.5 rounded-xl border transition-colors ${
                        showGrid
                          ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <Grid3x3 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5">
                      {sensOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setEdgeSensitivity(opt.id)}
                          className={`px-2 py-1.5 rounded-lg text-[10.5px] font-semibold whitespace-nowrap transition-colors ${
                            edgeSensitivity === opt.id
                              ? 'bg-[#06B6D4] text-slate-950'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {torchSupported && (
                      <button
                        type="button"
                        onClick={toggleTorch}
                        aria-label="Toggle Flashlight"
                        className={`p-1.5 rounded-xl border transition-colors ${
                          torchOn
                            ? 'bg-amber-400 text-slate-950 border-amber-300'
                            : 'bg-slate-900 border-slate-800 text-slate-300'
                        }`}
                      >
                        <Zap className="w-4 h-4" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
                        setFacingMode(nextFacing);
                        void startCamera(nextFacing);
                      }}
                      aria-label="Switch Camera"
                      className="p-1.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Live Camera Viewfinder with 4-Side & 4-Corner Auto Edge Sensor */}
                <div className="relative rounded-3xl overflow-hidden bg-black border border-slate-700 aspect-[3/4] max-h-[68vh] w-full flex items-center justify-center">
                  <div
                    className={`relative ${videoAspect < 0.75 ? 'h-full' : 'w-full'}`}
                    style={{ aspectRatio: String(videoAspect) }}
                  >
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.videoWidth && v.videoHeight) {
                          setVideoAspect(v.videoWidth / v.videoHeight);
                        }
                      }}
                      className="w-full h-full block object-fill"
                    />

                    {/* Optional alignment grid */}
                    {showGrid && (
                      <svg
                        className="pointer-events-none absolute inset-0 w-full h-full"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                      >
                        <line x1="33.33" y1="0" x2="33.33" y2="100" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
                        <line x1="66.66" y1="0" x2="66.66" y2="100" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
                        <line x1="0" y1="33.33" x2="100" y2="33.33" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
                        <line x1="0" y1="66.66" x2="100" y2="66.66" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
                      </svg>
                    )}

                    {/* Live 4-side & 4-corner detection overlay */}
                    <svg
                      className="pointer-events-none absolute inset-0 w-full h-full"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                    >
                      {liveBounds ? (
                        <>
                          <polygon
                            points={liveBounds.corners
                              .map((c) => `${c.x * 100},${c.y * 100}`)
                              .join(' ')}
                            fill={
                              lockedSidesCount >= 3
                                ? 'rgba(16, 185, 129, 0.12)'
                                : 'rgba(6, 182, 212, 0.08)'
                            }
                          />
                          <line
                            x1={liveBounds.corners[0].x * 100}
                            y1={liveBounds.corners[0].y * 100}
                            x2={liveBounds.corners[1].x * 100}
                            y2={liveBounds.corners[1].y * 100}
                            stroke={liveBounds.sideLocked.top ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.top ? undefined : '2 1.5'}
                          />
                          <line
                            x1={liveBounds.corners[1].x * 100}
                            y1={liveBounds.corners[1].y * 100}
                            x2={liveBounds.corners[2].x * 100}
                            y2={liveBounds.corners[2].y * 100}
                            stroke={liveBounds.sideLocked.right ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.right ? undefined : '2 1.5'}
                          />
                          <line
                            x1={liveBounds.corners[2].x * 100}
                            y1={liveBounds.corners[2].y * 100}
                            x2={liveBounds.corners[3].x * 100}
                            y2={liveBounds.corners[3].y * 100}
                            stroke={liveBounds.sideLocked.bottom ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.bottom ? undefined : '2 1.5'}
                          />
                          <line
                            x1={liveBounds.corners[3].x * 100}
                            y1={liveBounds.corners[3].y * 100}
                            x2={liveBounds.corners[0].x * 100}
                            y2={liveBounds.corners[0].y * 100}
                            stroke={liveBounds.sideLocked.left ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.left ? undefined : '2 1.5'}
                          />
                          {liveBounds.corners.map((c, idx) => (
                            <circle
                              key={idx}
                              cx={c.x * 100}
                              cy={c.y * 100}
                              r="1.9"
                              fill={lockedSidesCount >= 3 ? '#10B981' : '#06B6D4'}
                              stroke="#FFFFFF"
                              strokeWidth="0.6"
                            />
                          ))}
                        </>
                      ) : (
                        <rect
                          x="6"
                          y="6"
                          width="88"
                          height="88"
                          rx="3"
                          fill="none"
                          stroke="rgba(6, 182, 212, 0.7)"
                          strokeWidth="0.7"
                          strokeDasharray="2 2"
                        />
                      )}
                    </svg>
                  </div>

                  {captureFlash && (
                    <div className="pointer-events-none absolute inset-0 bg-white/60 transition-opacity" />
                  )}

                  {/* Top Live Sensor Status */}
                  <div className="pointer-events-none absolute top-3 inset-x-3 flex items-center justify-between gap-2">
                    <div className="px-2.5 py-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[11px] font-semibold flex items-center gap-1.5">
                      <ScanLine
                        className={`w-3.5 h-3.5 ${
                          lockedSidesCount >= 3 ? 'text-emerald-400' : 'text-cyan-400'
                        }`}
                      />
                      <span>
                        {lockedSidesCount >= 3
                          ? language === 'bn'
                            ? '৪ প্রান্ত ও কোণা শনাক্ত'
                            : '4 Corners Locked'
                          : language === 'bn'
                          ? 'কাগজের প্রান্ত খুঁজছে...'
                          : 'Detecting edges...'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 px-2 py-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[10px] font-mono tabular-nums font-bold">
                      {(
                        [
                          ['L', liveBounds?.sideLocked.left],
                          ['T', liveBounds?.sideLocked.top],
                          ['R', liveBounds?.sideLocked.right],
                          ['B', liveBounds?.sideLocked.bottom],
                        ] as Array<[string, boolean | undefined]>
                      ).map(([lbl, ok]) => (
                        <span
                          key={lbl}
                          className={`px-1 rounded ${
                            ok ? 'bg-emerald-500/30 text-emerald-300' : 'text-slate-400'
                          }`}
                        >
                          {lbl}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Bottom Capture Bar */}
                  <div className="absolute bottom-3 inset-x-3 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={pages.length === 0}
                      onClick={() => {
                        stopCamera();
                        setStep('review');
                      }}
                      className="min-w-[72px] h-12 px-2 rounded-2xl bg-black/75 border border-white/15 backdrop-blur-md flex items-center gap-2 disabled:opacity-40"
                    >
                      {pages.length > 0 ? (
                        <>
                          <img
                            src={pages[pages.length - 1].processedUrl}
                            alt="Last scan"
                            className="w-8 h-9 rounded-lg object-cover"
                          />
                          <span className="text-xs font-mono tabular-nums font-bold text-white pr-1">
                            {pages.length}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-slate-400 mx-auto">0</span>
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={capturing}
                      onClick={() => void captureFromVideo()}
                      aria-label={t.scanner.capturePhoto}
                      className="w-16 h-16 rounded-full bg-white border-4 border-[#2563EB] shadow-xl active:scale-95 transition-transform flex items-center justify-center disabled:opacity-70"
                    >
                      <span className="w-11 h-11 rounded-full border border-slate-300" />
                    </button>

                    {pages.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          stopCamera();
                          setStep('review');
                        }}
                        className="min-w-[76px] h-12 px-3 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs flex items-center justify-center gap-1 shadow-lg whitespace-nowrap"
                      >
                        <Check className="w-4 h-4" />
                        <span>
                          {language === 'bn' ? `শেষ (${pages.length})` : `Done (${pages.length})`}
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={stopCamera}
                        className="min-w-[76px] h-12 px-3 rounded-2xl bg-black/75 border border-white/15 text-xs font-semibold text-slate-200 whitespace-nowrap"
                      >
                        {language === 'bn' ? 'বাতিল' : 'Cancel'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-5 sm:p-6 text-center space-y-4">
                <div className="w-16 h-16 rounded-2xl bg-[#2563EB]/20 text-[#38BDF8] flex items-center justify-center mx-auto">
                  <Camera className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold">
                    {language === 'bn'
                      ? 'হাই-রেজুলেশন ডকুমেন্ট স্ক্যান করুন'
                      : 'High-Resolution Document Scanner'}
                  </h2>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    {language === 'bn'
                      ? '৩০০ DPI আল্ট্রা-শার্প আউটপুট, ছায়া ও আলো সমন্বয়, স্বয়ংক্রিয় প্রান্ত শনাক্ত ও সরাসরি পরিপূর্ণ A4 ডকুমেন্ট তৈরি।'
                      : '300 DPI ultra-sharp capture, automatic shadow removal, 4-corner edge detection, and complete A4 document framing.'}
                  </p>
                </div>

                {/* Output Resolution Selector */}
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-slate-800/70 border border-slate-700/70 text-xs">
                  <span className="text-slate-300 font-medium whitespace-nowrap">
                    {t.scanner.resolutionLabel}:
                  </span>
                  <div className="flex items-center gap-1">
                    {resOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleResolutionTierChange(opt.id)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors ${
                          resolutionTier === opt.id
                            ? 'bg-[#2563EB] text-white'
                            : 'bg-slate-900 text-slate-300 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Edge Sensor Sensitivity Selector */}
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-slate-800/70 border border-slate-700/70 text-xs">
                  <span className="text-slate-300 font-medium whitespace-nowrap">
                    {language === 'bn' ? 'এজ সেন্সর:' : 'Edge Sensor:'}
                  </span>
                  <div className="flex items-center gap-1">
                    {sensOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setEdgeSensitivity(opt.id)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors ${
                          edgeSensitivity === opt.id
                            ? 'bg-[#06B6D4] text-slate-950'
                            : 'bg-slate-900 text-slate-300 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {cameraError && (
                  <p className="text-xs text-amber-300 bg-amber-950/50 border border-amber-800/60 rounded-xl p-2.5">
                    {cameraError}
                  </p>
                )}

                <div className="grid grid-cols-1 gap-2.5">
                  <button
                    onClick={() => void startCamera()}
                    className="w-full min-h-[48px] rounded-xl bg-[#2563EB] hover:bg-blue-600 font-semibold text-sm flex items-center justify-center gap-2 transition-colors"
                  >
                    <Camera className="w-4 h-4" />
                    {t.scanner.openCamera}
                  </button>
                  <label className="w-full min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors">
                    <ImagePlus className="w-4 h-4 text-[#06B6D4]" />
                    <span>{t.scanner.uploadPhoto}</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      multiple
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                  {pages.length > 0 && (
                    <button
                      onClick={() => setStep('review')}
                      className="w-full min-h-[46px] rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-semibold text-sm flex items-center justify-center gap-2"
                    >
                      <Check className="w-4 h-4" />
                      <span>
                        {language === 'bn'
                          ? `${pages.length}টি স্ক্যান করা পৃষ্ঠা দেখুন`
                          : `Review ${pages.length} Scanned Page${pages.length > 1 ? 's' : ''}`}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'crop' && activePage && (
          <div className="w-full max-w-xl my-auto flex flex-col items-center space-y-3">
            <div className="w-full flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
              <span>
                {language === 'bn'
                  ? '৪ কোণা বা প্রান্ত টেনে কাগজ ঠিক করুন'
                  : 'Drag 4 corners or edges to straighten page'}
              </span>
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-0.5">
                {sensOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setEdgeSensitivity(opt.id);
                      runAutoDetectOnActive(opt.id);
                    }}
                    className={`px-2 py-1 rounded text-[10.5px] font-semibold whitespace-nowrap ${
                      edgeSensitivity === opt.id
                        ? 'bg-[#06B6D4] text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={cropBoxRef}
              onPointerMove={handleCropPointerMove}
              onPointerUp={() => {
                setDragTarget(null);
                setLoupeFocus(null);
              }}
              onPointerCancel={() => {
                setDragTarget(null);
                setLoupeFocus(null);
              }}
              className="relative max-w-full touch-none select-none rounded-xl overflow-hidden border border-slate-700 bg-black"
              style={{
                width: Math.min(460, typeof window !== 'undefined' ? window.innerWidth - 32 : 460),
                aspectRatio: `${activePage.rawCanvas.width} / ${activePage.rawCanvas.height}`,
              }}
            >
              <img
                src={activePage.rawPreviewUrl}
                alt="Raw scan"
                className="w-full h-full object-contain block pointer-events-none"
              />
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <polygon
                  points={activePage.corners.map((c) => `${c.x * 100},${c.y * 100}`).join(' ')}
                  fill="rgba(6, 182, 212, 0.14)"
                />
                <line
                  x1={activePage.corners[0].x * 100}
                  y1={activePage.corners[0].y * 100}
                  x2={activePage.corners[1].x * 100}
                  y2={activePage.corners[1].y * 100}
                  stroke={activePage.sideLocked?.top ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
                <line
                  x1={activePage.corners[1].x * 100}
                  y1={activePage.corners[1].y * 100}
                  x2={activePage.corners[2].x * 100}
                  y2={activePage.corners[2].y * 100}
                  stroke={activePage.sideLocked?.right ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
                <line
                  x1={activePage.corners[2].x * 100}
                  y1={activePage.corners[2].y * 100}
                  x2={activePage.corners[3].x * 100}
                  y2={activePage.corners[3].y * 100}
                  stroke={activePage.sideLocked?.bottom ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
                <line
                  x1={activePage.corners[3].x * 100}
                  y1={activePage.corners[3].y * 100}
                  x2={activePage.corners[0].x * 100}
                  y2={activePage.corners[0].y * 100}
                  stroke={activePage.sideLocked?.left ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
              </svg>

              {/* Touch Precision Magnifier Loupe */}
              {loupeFocus && (
                <div
                  className={`pointer-events-none absolute top-2.5 ${
                    loupeFocus.x < 0.45 ? 'right-2.5' : 'left-2.5'
                  } w-[104px] h-[104px] rounded-full border-2 border-[#06B6D4] shadow-2xl overflow-hidden bg-slate-950 z-20`}
                >
                  <canvas ref={loupeCanvasRef} className="w-full h-full block" />
                </div>
              )}

              {/* 4 Corner Handles */}
              {activePage.corners.map((c, idx) => (
                <button
                  key={`c-${idx}`}
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    cropBoxRef.current?.setPointerCapture?.(e.pointerId);
                    setLoupeFocus(c);
                    setDragTarget({ type: 'corner', index: idx });
                  }}
                  style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
                  aria-label={`Corner ${idx + 1}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-[#2563EB] border-2 border-white shadow-lg cursor-grab active:scale-110"
                />
              ))}

              {/* 4 Side Midpoint Edge Handles */}
              {(
                [
                  { edge: 'top', a: 0, b: 1, horiz: true },
                  { edge: 'right', a: 1, b: 2, horiz: false },
                  { edge: 'bottom', a: 2, b: 3, horiz: true },
                  { edge: 'left', a: 3, b: 0, horiz: false },
                ] as const
              ).map(({ edge, a, b, horiz }) => {
                const mx = ((activePage.corners[a].x + activePage.corners[b].x) / 2) * 100;
                const my = ((activePage.corners[a].y + activePage.corners[b].y) / 2) * 100;
                return (
                  <button
                    key={`e-${edge}`}
                    type="button"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (!cropBoxRef.current) return;
                      cropBoxRef.current.setPointerCapture?.(e.pointerId);
                      const rect = cropBoxRef.current.getBoundingClientRect();
                      const sx = (e.clientX - rect.left) / rect.width;
                      const sy = (e.clientY - rect.top) / rect.height;
                      setLoupeFocus({ x: mx / 100, y: my / 100 });
                      setDragTarget({
                        type: 'edge',
                        edge,
                        startX: sx,
                        startY: sy,
                        origCorners: activePage.corners.map((p) => ({ ...p })) as [
                          Point2D,
                          Point2D,
                          Point2D,
                          Point2D
                        ],
                      });
                    }}
                    style={{ left: `${mx}%`, top: `${my}%` }}
                    aria-label={`${edge} edge handle`}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#06B6D4] border-2 border-white shadow-md cursor-grab active:scale-110 ${
                      horiz ? 'w-9 h-4' : 'w-4 h-9'
                    }`}
                  />
                );
              })}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full max-w-lg">
              <button
                type="button"
                onClick={() => runAutoDetectOnActive(edgeSensitivity)}
                className="min-h-[44px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Sparkles className="w-4 h-4 text-[#06B6D4]" />
                {t.scanner.autoDetect}
              </button>
              <button
                type="button"
                onClick={resetFullFrameOnActive}
                className="min-h-[44px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Maximize2 className="w-4 h-4 text-slate-300" />
                {t.scanner.fullFrame}
              </button>
              <button
                type="button"
                onClick={() =>
                  reprocessActivePage({ rotation: (activePage.rotation + 90) % 360 })
                }
                className="min-h-[44px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <RotateCw className="w-4 h-4 text-slate-300" />
                {t.scanner.rotate}
              </button>
              <button
                type="button"
                onClick={applyCropAndProceed}
                className="min-h-[44px] px-3 rounded-xl bg-[#2563EB] hover:bg-blue-600 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Check className="w-4 h-4" />
                {t.scanner.applyWarp}
              </button>
            </div>
          </div>
        )}

        {step === 'review' && activePage && (
          <div className="w-full max-w-6xl space-y-4">
            {/* Multi-page horizontal strip */}
            {pages.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar w-full pb-1">
                {pages.map((p, idx) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setCompareOriginal(false);
                      setActiveIdx(idx);
                    }}
                    className={`relative shrink-0 w-16 h-20 rounded-xl overflow-hidden border-2 transition-colors ${
                      idx === activeIdx
                        ? 'border-[#06B6D4]'
                        : 'border-slate-700 opacity-75 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={p.processedUrl}
                      alt={`Page ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/75 text-[10px] font-mono tabular-nums">
                      {idx + 1}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,1fr)] gap-4 items-start">
              {/* Left Column: Preview Stage & Page Actions */}
              <div className="space-y-3">
                <div className="relative bg-slate-950 rounded-2xl p-3 border border-slate-800 flex flex-col items-center justify-center">
                  {/* Live Framed Document Sheet Preview */}
                  <div
                    className={`relative flex items-center justify-center overflow-hidden rounded-lg transition-all ${
                      paperSize !== 'fit' && marginSize !== 'none'
                        ? `bg-white shadow-xl ${
                            marginSize === 'standard' ? 'p-4 sm:p-5' : 'p-2 sm:p-2.5'
                          }`
                        : ''
                    }`}
                  >
                    <img
                      src={
                        compareOriginal
                          ? activePage.warpedOriginalUrl
                          : activePage.processedUrl
                      }
                      alt="Enhanced document preview"
                      className="max-h-[48vh] lg:max-h-[58vh] w-auto object-contain rounded"
                    />
                  </div>

                  {/* Preview Controls & Clean Unboxed Metadata */}
                  <div className="w-full flex flex-wrap items-center justify-between gap-2 pt-3 mt-2 border-t border-slate-800/80 text-xs">
                    <div className="flex items-center gap-2 text-slate-400 font-mono tabular-nums">
                      <span>
                        {activeDims.w} × {activeDims.h} px
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{activeResolutionLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{paperSize.toUpperCase()}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCompareOriginal((v) => !v)}
                      className={`min-h-[34px] px-2.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                        compareOriginal
                          ? 'bg-amber-500 text-slate-950 border-amber-400'
                          : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-slate-500'
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>{t.scanner.compareOriginal}</span>
                    </button>
                  </div>
                </div>

                {/* Page Toolbar */}
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                  <button
                    type="button"
                    onClick={() =>
                      reprocessActivePage({ rotation: (activePage.rotation + 90) % 360 })
                    }
                    className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                  >
                    <RotateCw className="w-3.5 h-3.5" /> {t.scanner.rotate}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep('crop')}
                    className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                  >
                    <Crop className="w-3.5 h-3.5" /> {t.scanner.adjustCrop}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const clone: ScannedPageItem = {
                        ...activePage,
                        id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                      };
                      setPages((prev) => {
                        const next = [
                          ...prev.slice(0, activeIdx + 1),
                          clone,
                          ...prev.slice(activeIdx + 1),
                        ];
                        setActiveIdx(activeIdx + 1);
                        return next;
                      });
                    }}
                    className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                  >
                    <Copy className="w-3.5 h-3.5" /> {t.scanner.duplicatePage}
                  </button>
                  {pages.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (activeIdx === 0) return;
                          const copy = [...pages];
                          [copy[activeIdx - 1], copy[activeIdx]] = [
                            copy[activeIdx],
                            copy[activeIdx - 1],
                          ];
                          setPages(copy);
                          setActiveIdx(activeIdx - 1);
                        }}
                        className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 shrink-0"
                        aria-label="Move page earlier"
                      >
                        <ArrowUp className="w-4 h-4 -rotate-90" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (activeIdx === pages.length - 1) return;
                          const copy = [...pages];
                          [copy[activeIdx + 1], copy[activeIdx]] = [
                            copy[activeIdx],
                            copy[activeIdx + 1],
                          ];
                          setPages(copy);
                          setActiveIdx(activeIdx + 1);
                        }}
                        className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 shrink-0"
                        aria-label="Move page later"
                      >
                        <ArrowDown className="w-4 h-4 -rotate-90" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const next = pages.filter((_, i) => i !== activeIdx);
                      setPages(next);
                      if (next.length === 0) setStep('capture');
                      else setActiveIdx(Math.max(0, activeIdx - 1));
                    }}
                    className="min-h-[42px] px-3 rounded-xl bg-rose-950/70 hover:bg-rose-900/80 text-rose-300 text-xs font-semibold flex items-center gap-1 shrink-0 whitespace-nowrap"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {t.scanner.deletePage}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStep('capture');
                      void startCamera();
                    }}
                    className="min-h-[42px] px-3 rounded-xl bg-[#2563EB] hover:bg-blue-600 text-white text-xs font-semibold flex items-center gap-1 shrink-0 whitespace-nowrap"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>{language === 'bn' ? '+ পরের পেজ' : '+ Scan Next'}</span>
                  </button>
                  <label className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1 shrink-0 cursor-pointer whitespace-nowrap">
                    <ImagePlus className="w-3.5 h-3.5 text-[#06B6D4]" />
                    <span>{language === 'bn' ? '+ ছবি যোগ' : '+ Photo'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {/* Right Column: Image Studio Enhancement + Complete Document Options */}
              <div className="space-y-3">
                {/* Filter & Quality Studio */}
                <div className="w-full rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3.5">
                  <div className="grid grid-cols-5 gap-1.5">
                    {(['docPro', 'magic', 'color', 'grayscale', 'bw'] as ScanFilter[]).map(
                      (f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => reprocessActivePage({ filter: f })}
                          className={`min-h-[40px] px-1.5 rounded-xl text-[11px] font-semibold whitespace-nowrap truncate transition-colors ${
                            activePage.filter === f
                              ? 'bg-[#2563EB] text-white'
                              : 'bg-slate-800 text-slate-300 hover:text-white'
                          }`}
                        >
                          {t.scanner.filters[f]}
                        </button>
                      )
                    )}
                  </div>

                  {/* Resolution Switcher inside Review */}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400 font-medium whitespace-nowrap">
                      {t.scanner.resolutionLabel}
                    </span>
                    <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-xl p-0.5">
                      {resOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => handleResolutionTierChange(opt.id)}
                          className={`px-2 py-1 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors ${
                            resolutionTier === opt.id
                              ? 'bg-[#2563EB] text-white'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Shadow Removal + Brightness + Contrast Sliders */}
                  <div className="space-y-2.5 text-xs">
                    <label className="block space-y-1">
                      <span className="flex items-center justify-between text-slate-300">
                        <span className="flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-[#06B6D4]" />
                          {t.scanner.shadowClean}
                        </span>
                        <span className="font-mono tabular-nums">{activePage.shadowClean}%</span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={activePage.shadowClean}
                        onChange={(e) =>
                          reprocessActivePage({ shadowClean: Number(e.target.value) })
                        }
                        className="w-full accent-[#06B6D4]"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1">
                        <span className="flex items-center justify-between text-slate-400">
                          <span className="flex items-center gap-1">
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            {t.scanner.brightness}
                          </span>
                          <span className="font-mono tabular-nums">{activePage.brightness}</span>
                        </span>
                        <input
                          type="range"
                          min={-40}
                          max={40}
                          value={activePage.brightness}
                          onChange={(e) =>
                            reprocessActivePage({ brightness: Number(e.target.value) })
                          }
                          className="w-full accent-[#2563EB]"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="flex items-center justify-between text-slate-400">
                          <span>{t.scanner.contrast}</span>
                          <span className="font-mono tabular-nums">{activePage.contrast}</span>
                        </span>
                        <input
                          type="range"
                          min={-30}
                          max={50}
                          value={activePage.contrast}
                          onChange={(e) =>
                            reprocessActivePage({ contrast: Number(e.target.value) })
                          }
                          className="w-full accent-[#2563EB]"
                        />
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => reprocessActivePage({ sharpen: !activePage.sharpen })}
                      className={`min-h-[38px] px-3 rounded-xl text-xs font-semibold whitespace-nowrap ${
                        activePage.sharpen
                          ? 'bg-[#06B6D4]/20 text-[#38BDF8] border border-[#06B6D4]/40'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {t.scanner.sharpen}:{' '}
                      {activePage.sharpen
                        ? language === 'bn'
                          ? 'চালু'
                          : 'On'
                        : language === 'bn'
                        ? 'বন্ধ'
                        : 'Off'}
                    </button>

                    {pages.length > 1 && (
                      <button
                        type="button"
                        onClick={applyEnhancementsToAll}
                        className="min-h-[38px] px-3 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        <span>{t.scanner.applyToAll}</span>
                      </button>
                    )}
                  </div>
                  {applyBatchNotice && (
                    <p className="text-[11px] font-semibold text-emerald-400">
                      {applyBatchNotice}
                    </p>
                  )}
                </div>

                {/* Complete Document Builder & Multi-Format Export */}
                <div className="w-full rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3.5 text-xs">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-sm font-bold text-white">
                      {t.scanner.docSetupTitle}
                    </h2>
                    <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                      {pages.length} {language === 'bn' ? 'পৃষ্ঠা' : pages.length > 1 ? 'pages' : 'page'}
                    </span>
                  </div>

                  {/* Document Title */}
                  <label className="block space-y-1">
                    <span className="text-slate-400 font-medium">{t.scanner.docTitleLabel}</span>
                    <input
                      type="text"
                      value={docTitle}
                      onChange={(e) => setDocTitle(e.target.value)}
                      placeholder="Document_2026"
                      className="w-full min-h-[40px] px-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs focus:outline-none focus:border-[#2563EB]"
                    />
                  </label>

                  {/* Paper Size Framing */}
                  <div className="space-y-1.5">
                    <span className="text-slate-400 font-medium block">
                      {t.scanner.paperSizeLabel}
                    </span>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(
                        [
                          { id: 'a4', label: t.scanner.paperA4 },
                          { id: 'letter', label: t.scanner.paperLetter },
                          { id: 'legal', label: t.scanner.paperLegal },
                          { id: 'fit', label: t.scanner.paperFit },
                        ] as Array<{ id: ScanPaperSize; label: string }>
                      ).map((ps) => (
                        <button
                          key={ps.id}
                          type="button"
                          onClick={() => setPaperSize(ps.id)}
                          className={`min-h-[36px] rounded-xl font-semibold whitespace-nowrap transition-colors ${
                            paperSize === ps.id
                              ? 'bg-[#2563EB] text-white'
                              : 'bg-slate-800 text-slate-300 hover:text-white'
                          }`}
                        >
                          {ps.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {paperSize !== 'fit' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <span className="text-slate-400 font-medium block">
                          {t.scanner.marginsLabel}
                        </span>
                        <div className="grid grid-cols-3 gap-1">
                          {(
                            [
                              { id: 'none', label: t.scanner.marginNone },
                              { id: 'narrow', label: t.scanner.marginNarrow },
                              { id: 'standard', label: t.scanner.marginStandard },
                            ] as Array<{ id: ScanMarginSize; label: string }>
                          ).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setMarginSize(m.id)}
                              className={`min-h-[34px] px-1 rounded-lg text-[11px] font-semibold whitespace-nowrap truncate ${
                                marginSize === m.id
                                  ? 'bg-[#06B6D4] text-slate-950'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <span className="text-slate-400 font-medium block">
                          {t.scanner.orientationLabel}
                        </span>
                        <div className="grid grid-cols-3 gap-1">
                          {(
                            [
                              { id: 'auto', label: t.scanner.orientAuto },
                              { id: 'portrait', label: t.scanner.orientPortrait },
                              { id: 'landscape', label: t.scanner.orientLandscape },
                            ] as Array<{ id: ScanOrientation; label: string }>
                          ).map((o) => (
                            <button
                              key={o.id}
                              type="button"
                              onClick={() => setOrientation(o.id)}
                              className={`min-h-[34px] px-1 rounded-lg text-[11px] font-semibold whitespace-nowrap truncate ${
                                orientation === o.id
                                  ? 'bg-[#06B6D4] text-slate-950'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Footer Page Numbers + OCR Language */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                    {paperSize !== 'fit' && (
                      <label className="flex items-center gap-2 cursor-pointer text-slate-300 font-medium">
                        <input
                          type="checkbox"
                          checked={addPageNumbers}
                          onChange={(e) => setAddPageNumbers(e.target.checked)}
                          className="w-4 h-4 accent-[#2563EB]"
                        />
                        <span>{t.scanner.pageNumbersLabel}</span>
                      </label>
                    )}

                    <div className="flex items-center gap-1 ml-auto">
                      {(
                        [
                          { id: 'eng', label: 'EN' },
                          { id: 'ben', label: 'বাংলা' },
                          { id: 'eng+ben', label: 'EN+বাং' },
                        ] as Array<{ id: OcrLanguage; label: string }>
                      ).map((ol) => (
                        <button
                          key={ol.id}
                          type="button"
                          onClick={() => setOcrLang(ol.id)}
                          className={`px-2 py-1 rounded-lg text-[10.5px] font-semibold whitespace-nowrap ${
                            ocrLang === ol.id
                              ? 'bg-slate-700 text-cyan-300 border border-cyan-500/40'
                              : 'bg-slate-800/80 text-slate-400'
                          }`}
                        >
                          {ol.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Complete Document Output Action Buttons */}
                  <div className="space-y-2 pt-1">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        stopCamera();
                        void handleSaveStandardPdf('viewer');
                      }}
                      className="w-full min-h-[46px] rounded-xl bg-[#2563EB] hover:bg-blue-600 text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                      {saving && !ocrProgress ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Check className="w-4 h-4" />
                      )}
                      <span>{t.scanner.saveAsPdf}</span>
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          stopCamera();
                          void handleSaveSearchablePdf();
                        }}
                        className="min-h-[42px] px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                      >
                        <ScanText className="w-4 h-4 text-[#06B6D4] shrink-0" />
                        <span className="truncate">{t.scanner.exportSearchablePdf}</span>
                      </button>

                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          stopCamera();
                          void handleSaveStandardPdf('editor');
                        }}
                        className="min-h-[42px] px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                      >
                        <Pencil className="w-4 h-4 text-[#38BDF8] shrink-0" />
                        <span className="truncate">{t.scanner.editInPdfEditor}</span>
                      </button>

                      {onOpenInWordCreator && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void handleConvertToWord()}
                          className="min-h-[42px] px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                        >
                          <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span className="truncate">{t.scanner.exportWordDoc}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleDownloadActiveHdImage()}
                        className="min-h-[42px] px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                      >
                        <Download className="w-4 h-4 text-amber-400 shrink-0" />
                        <span className="truncate">{t.scanner.downloadImage}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
