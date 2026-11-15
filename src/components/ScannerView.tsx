import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  Check,
  Crop,
  ImagePlus,
  Layers,
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
  type DocumentBoundsResult,
  type EdgeSensitivity,
  perspectiveWarpCanvas,
  type Point2D,
  type ScanFilter,
} from '../services/imageProcessing';
import { cloneBuffer, renderPageThumbnail } from '../services/pdfEngine';

interface ScannerViewProps {
  language: AppLanguage;
  autoCropDefault: boolean;
  defaultFilter: ScanFilter;
  onClose: () => void;
  onSaveScannedPdf: (doc: DocumentRecord, openOcrAfter?: boolean) => Promise<void>;
}

interface ScannedPageItem {
  id: string;
  rawCanvas: HTMLCanvasElement;
  corners: [Point2D, Point2D, Point2D, Point2D];
  sideLocked: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  filter: ScanFilter;
  brightness: number;
  contrast: number;
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

export const ScannerView: React.FC<ScannerViewProps> = ({
  language,
  autoCropDefault,
  defaultFilter,
  onClose,
  onSaveScannedPdf,
}) => {
  const t = getT(language);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cropBoxRef = useRef<HTMLDivElement | null>(null);
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [continuousMode, setContinuousMode] = useState(true);
  const [autoCapture, setAutoCapture] = useState(false);
  const [edgeSensitivity, setEdgeSensitivity] = useState<EdgeSensitivity>('high');
  const [liveBounds, setLiveBounds] = useState<DocumentBoundsResult | null>(null);
  const [videoAspect, setVideoAspect] = useState<number>(3 / 4);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [pages, setPages] = useState<ScannedPageItem[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [step, setStep] = useState<'capture' | 'crop' | 'review'>('capture');
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const smoothedBoundsRef = useRef<DocumentBoundsResult | null>(null);
  const stableLockTicksRef = useRef<number>(0);
  const lastAutoSnapRef = useRef<number>(0);

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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: targetFacing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
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
    }
  ) => {
    const sens = options?.overrideSensitivity ?? edgeSensitivity;
    const detected = autoCropDefault
      ? options?.hintBounds && options.hintBounds.confidence >= 0.52
        ? options.hintBounds
        : detectDocumentBoundsWithConfidence(rawCanvas, sens)
      : {
          corners: [
            { x: 0.05, y: 0.05 },
            { x: 0.95, y: 0.05 },
            { x: 0.95, y: 0.95 },
            { x: 0.05, y: 0.95 },
          ] as [Point2D, Point2D, Point2D, Point2D],
          confidence: 1,
          sideLocked: { top: true, right: true, bottom: true, left: true },
        };

    const warped = perspectiveWarpCanvas(rawCanvas, detected.corners);
    const processedUrl = applyScanEnhancement(warped, {
      filter: defaultFilter,
      brightness: 0,
      contrast: 10,
      sharpen: true,
      rotation: 0,
    });

    const newItem: ScannedPageItem = {
      id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      rawCanvas,
      corners: detected.corners,
      sideLocked: detected.sideLocked,
      filter: defaultFilter,
      brightness: 0,
      contrast: 10,
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

  const captureFromVideo = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const c = document.createElement('canvas');
    const maxCap = 1440;
    let cw = video.videoWidth;
    let ch = video.videoHeight;
    if (cw > maxCap || ch > maxCap) {
      const s = maxCap / Math.max(cw, ch);
      cw = Math.round(cw * s);
      ch = Math.round(ch * s);
    }
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(video, 0, 0, cw, ch);

    const lockedHint = smoothedBoundsRef.current;
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 160);
    stableLockTicksRef.current = 0;

    if (continuousMode) {
      // Yield one animation frame so flash renders cleanly while keeping camera open for next page
      requestAnimationFrame(() => {
        ingestSourceCanvas(c, { stayInCamera: true, hintBounds: lockedHint });
      });
    } else {
      stopCamera();
      requestAnimationFrame(() => {
        ingestSourceCanvas(c, { stayInCamera: false, hintBounds: lockedHint });
      });
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
          captureFromVideo();
        }
      } else {
        stableLockTicksRef.current = 0;
      }
    }, 170);
    return () => clearInterval(id);
  }, [cameraActive, step, edgeSensitivity, autoCapture, continuousMode]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const isMultiBatch = files.length > 1;
    files.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 1600;
          let w = img.naturalWidth || 1000;
          let h = img.naturalHeight || 1300;
          if (w > maxDim || h > maxDim) {
            const s = maxDim / Math.max(w, h);
            w = Math.round(w * s);
            h = Math.round(h * s);
          }
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d')!.drawImage(img, 0, 0, w, h);
          ingestSourceCanvas(c, { stayInCamera: isMultiBatch && idx < files.length - 1 });
          if (isMultiBatch && idx === files.length - 1) {
            setStep('review');
          }
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const activePage = pages[activeIdx];

  const reprocessActivePage = (patch: Partial<ScannedPageItem>) => {
    if (!activePage) return;
    const updated = { ...activePage, ...patch };
    const warped = perspectiveWarpCanvas(updated.rawCanvas, updated.corners);
    updated.processedUrl = applyScanEnhancement(warped, {
      filter: updated.filter,
      brightness: updated.brightness,
      contrast: updated.contrast,
      sharpen: updated.sharpen,
      rotation: updated.rotation,
    });
    setPages((prev) => prev.map((p, i) => (i === activeIdx ? updated : p)));
  };

  const handleCropPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragTarget || !cropBoxRef.current || !activePage) return;
    const rect = cropBoxRef.current.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));

    if (dragTarget.type === 'corner') {
      const nextCorners = [...activePage.corners] as [Point2D, Point2D, Point2D, Point2D];
      nextCorners[dragTarget.index] = { x: nx, y: ny };
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
    } else if (dragTarget.edge === 'bottom') {
      base[2].y = clamp(base[2].y + dy);
      base[3].y = clamp(base[3].y + dy);
    } else if (dragTarget.edge === 'left') {
      base[0].x = clamp(base[0].x + dx);
      base[3].x = clamp(base[3].x + dx);
    } else if (dragTarget.edge === 'right') {
      base[1].x = clamp(base[1].x + dx);
      base[2].x = clamp(base[2].x + dx);
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

  const applyCropAndProceed = () => {
    if (!activePage) return;
    reprocessActivePage({});
    setStep('review');
  };

  const handleSave = async (openOcrAfter: boolean) => {
    if (pages.length === 0) return;
    setSaving(true);
    try {
      const pdfBytes = await compileScannedPagesToPdf(pages.map((p) => p.processedUrl));
      const thumb = await renderPageThumbnail(pdfBytes, 1, 200).catch(
        () => pages[0].processedUrl
      );
      const now = Date.now();
      const newDoc: DocumentRecord = {
        id: `doc_scan_${now}`,
        name: `Scan_${new Date(now).toISOString().slice(0, 10)}.pdf`,
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
            note: `Scanned ${pages.length} page(s)`,
            sizeBytes: pdfBytes.byteLength,
            pdfBytes: cloneBuffer(pdfBytes),
          },
        ],
      };
      await onSaveScannedPdf(newDoc, openOcrAfter);
    } finally {
      setSaving(false);
    }
  };

  const sensOptions: Array<{ id: EdgeSensitivity; label: string }> = [
    { id: 'standard', label: language === 'bn' ? 'স্বাভাবিক' : 'Normal' },
    { id: 'high', label: language === 'bn' ? 'উচ্চ' : 'High' },
    { id: 'max', label: language === 'bn' ? 'সর্বোচ্চ' : 'Max' },
  ];

  const lockedSidesCount = liveBounds
    ? (liveBounds.sideLocked.top ? 1 : 0) +
      (liveBounds.sideLocked.right ? 1 : 0) +
      (liveBounds.sideLocked.bottom ? 1 : 0) +
      (liveBounds.sideLocked.left ? 1 : 0)
    : 0;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#0F172A] text-white">
      <header className="flex items-center justify-between px-3 py-2.5 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="font-display text-sm font-bold">{t.scanner.title}</h1>
            <p className="text-[11px] font-mono-nums text-slate-400">
              {pages.length} {t.scanner.pagesScanned}
            </p>
          </div>
        </div>

        {pages.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                stopCamera();
                handleSave(true);
              }}
              disabled={saving}
              className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-xs font-semibold flex items-center gap-1.5"
            >
              <ScanText className="w-4 h-4 text-[#06B6D4]" />
              <span className="hidden sm:inline">{t.scanner.runOcr}</span>
            </button>
            <button
              onClick={() => {
                stopCamera();
                handleSave(false);
              }}
              disabled={saving}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#2563EB] text-xs font-semibold flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>{saving ? 'Saving...' : t.scanner.saveAsPdf}</span>
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-3 sm:p-4">
        {step === 'capture' && (
          <div className="w-full max-w-md space-y-3">
            {cameraActive ? (
              <div className="space-y-3">
                {/* Mode, Auto-Capture & Edge Sensor Controls */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 px-1">
                  <div className="flex items-center gap-1">
                    <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5">
                      <button
                        type="button"
                        onClick={() => setContinuousMode(true)}
                        className={`px-2 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
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
                        className={`px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
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
                      className={`px-2 py-1.5 rounded-xl border text-[11px] font-semibold transition-colors ${
                        autoCapture
                          ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {language === 'bn' ? 'অটো' : 'Auto'}
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5">
                      {sensOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setEdgeSensitivity(opt.id)}
                          className={`px-2 py-1.5 rounded-lg text-[10.5px] font-semibold transition-colors ${
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
                <div className="relative rounded-3xl overflow-hidden bg-black border border-slate-700 aspect-[3/4] max-h-[70vh] w-full flex items-center justify-center">
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
                          {/* Top side line (0 -> 1) */}
                          <line
                            x1={liveBounds.corners[0].x * 100}
                            y1={liveBounds.corners[0].y * 100}
                            x2={liveBounds.corners[1].x * 100}
                            y2={liveBounds.corners[1].y * 100}
                            stroke={liveBounds.sideLocked.top ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.top ? undefined : '2 1.5'}
                          />
                          {/* Right side line (1 -> 2) */}
                          <line
                            x1={liveBounds.corners[1].x * 100}
                            y1={liveBounds.corners[1].y * 100}
                            x2={liveBounds.corners[2].x * 100}
                            y2={liveBounds.corners[2].y * 100}
                            stroke={liveBounds.sideLocked.right ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.right ? undefined : '2 1.5'}
                          />
                          {/* Bottom side line (2 -> 3) */}
                          <line
                            x1={liveBounds.corners[2].x * 100}
                            y1={liveBounds.corners[2].y * 100}
                            x2={liveBounds.corners[3].x * 100}
                            y2={liveBounds.corners[3].y * 100}
                            stroke={liveBounds.sideLocked.bottom ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.bottom ? undefined : '2 1.5'}
                          />
                          {/* Left side line (3 -> 0) */}
                          <line
                            x1={liveBounds.corners[3].x * 100}
                            y1={liveBounds.corners[3].y * 100}
                            x2={liveBounds.corners[0].x * 100}
                            y2={liveBounds.corners[0].y * 100}
                            stroke={liveBounds.sideLocked.left ? '#10B981' : '#06B6D4'}
                            strokeWidth="0.9"
                            strokeDasharray={liveBounds.sideLocked.left ? undefined : '2 1.5'}
                          />
                          {/* 4 Corner Target Nodes */}
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

                  {/* Shutter flash feedback */}
                  {captureFlash && (
                    <div className="pointer-events-none absolute inset-0 bg-white/60 transition-opacity" />
                  )}

                  {/* Top Live Sensor Status Badge */}
                  <div className="pointer-events-none absolute top-3 inset-x-3 flex items-center justify-between gap-2">
                    <div className="px-2.5 py-1 rounded-full bg-black/70 backdrop-blur-md border border-white/10 text-[11px] font-semibold flex items-center gap-1.5">
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

                    {/* Individual T / R / B / L Side Indicators */}
                    <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-black/70 backdrop-blur-md border border-white/10 text-[10px] font-mono-nums font-bold">
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

                  {/* Bottom Capture Bar (Supports Continuous 1->2->3 Camera Scanning) */}
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
                          <span className="text-xs font-mono-nums font-bold text-white pr-1">
                            {pages.length}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-slate-400 mx-auto">0</span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={captureFromVideo}
                      aria-label={t.scanner.capturePhoto}
                      className="w-16 h-16 rounded-full bg-white border-4 border-[#2563EB] shadow-xl active:scale-95 transition-transform flex items-center justify-center"
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
                        className="min-w-[76px] h-12 px-3 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs flex items-center justify-center gap-1 shadow-lg"
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
                        className="min-w-[76px] h-12 px-3 rounded-2xl bg-black/75 border border-white/15 text-xs font-semibold text-slate-200"
                      >
                        {language === 'bn' ? 'বাতিল' : 'Cancel'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6 text-center space-y-4">
                <div className="w-16 h-16 rounded-2xl bg-[#2563EB]/20 text-[#38BDF8] flex items-center justify-center mx-auto">
                  <Camera className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold">
                    {language === 'bn' ? 'ডকুমেন্ট পেজ স্ক্যান করুন' : 'Capture Document Pages'}
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    {language === 'bn'
                      ? 'উচ্চ-সংবেদনশীল বাম/ডান/উপর/নিচ প্রান্ত ও ৪ কোণা সেন্সর এবং একের পর এক ক্যামেরা স্ক্যান।'
                      : 'High-sensitivity 4-side & 4-corner auto edge sensor with continuous multi-page camera scanning.'}
                  </p>
                </div>

                {/* Sensor Sensitivity Selector */}
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-slate-800/70 border border-slate-700/70 text-xs">
                  <span className="text-slate-300 font-medium">
                    {language === 'bn' ? 'এজ ডিটেক্ট সেন্সর:' : 'Edge Sensor:'}
                  </span>
                  <div className="flex items-center gap-1">
                    {sensOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setEdgeSensitivity(opt.id)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                          edgeSensitivity === opt.id
                            ? 'bg-[#06B6D4] text-slate-950'
                            : 'bg-slate-900 text-slate-300'
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
                    onClick={() => startCamera()}
                    className="w-full min-h-[48px] rounded-xl bg-[#2563EB] font-semibold text-sm flex items-center justify-center gap-2"
                  >
                    <Camera className="w-4 h-4" />
                    {t.scanner.openCamera}
                  </button>
                  <label className="w-full min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer">
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
          <div className="w-full max-w-lg flex flex-col items-center space-y-3">
            <div className="w-full flex items-center justify-between gap-2 text-xs text-slate-300">
              <span>
                {language === 'bn'
                  ? '৪ কোণা বা বাম/ডান/উপর/নিচ প্রান্ত টেনে ঠিক করুন'
                  : 'Drag 4 corners or Top/Bottom/Left/Right edges'}
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
                    className={`px-2 py-1 rounded text-[10px] font-semibold ${
                      edgeSensitivity === opt.id
                        ? 'bg-[#06B6D4] text-slate-950'
                        : 'text-slate-400'
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
              onPointerUp={() => setDragTarget(null)}
              onPointerCancel={() => setDragTarget(null)}
              className="relative max-w-full touch-none select-none rounded-xl overflow-hidden border border-slate-700"
              style={{
                width: Math.min(420, window.innerWidth - 32),
                aspectRatio: `${activePage.rawCanvas.width} / ${activePage.rawCanvas.height}`,
              }}
            >
              <img
                src={activePage.rawCanvas.toDataURL('image/jpeg', 0.78)}
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
                {/* Top (0->1) */}
                <line
                  x1={activePage.corners[0].x * 100}
                  y1={activePage.corners[0].y * 100}
                  x2={activePage.corners[1].x * 100}
                  y2={activePage.corners[1].y * 100}
                  stroke={activePage.sideLocked?.top ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
                {/* Right (1->2) */}
                <line
                  x1={activePage.corners[1].x * 100}
                  y1={activePage.corners[1].y * 100}
                  x2={activePage.corners[2].x * 100}
                  y2={activePage.corners[2].y * 100}
                  stroke={activePage.sideLocked?.right ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
                {/* Bottom (2->3) */}
                <line
                  x1={activePage.corners[2].x * 100}
                  y1={activePage.corners[2].y * 100}
                  x2={activePage.corners[3].x * 100}
                  y2={activePage.corners[3].y * 100}
                  stroke={activePage.sideLocked?.bottom ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
                {/* Left (3->0) */}
                <line
                  x1={activePage.corners[3].x * 100}
                  y1={activePage.corners[3].y * 100}
                  x2={activePage.corners[0].x * 100}
                  y2={activePage.corners[0].y * 100}
                  stroke={activePage.sideLocked?.left ? '#10B981' : '#06B6D4'}
                  strokeWidth="0.9"
                />
              </svg>

              {/* 4 Corner Handles */}
              {activePage.corners.map((c, idx) => (
                <button
                  key={`c-${idx}`}
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    cropBoxRef.current?.setPointerCapture?.(e.pointerId);
                    setDragTarget({ type: 'corner', index: idx });
                  }}
                  style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
                  aria-label={`Corner ${idx + 1}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-[#2563EB] border-2 border-white shadow-lg cursor-grab active:scale-110"
                />
              ))}

              {/* 4 Side Midpoint Edge Handles (Top, Right, Bottom, Left) */}
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
                      horiz ? 'w-8 h-3.5' : 'w-3.5 h-8'
                    }`}
                  />
                );
              })}
            </div>

            <div className="flex items-center gap-2.5 w-full max-w-sm">
              <button
                onClick={() => runAutoDetectOnActive(edgeSensitivity)}
                className="flex-1 min-h-[46px] rounded-xl bg-slate-800 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Sparkles className="w-4 h-4 text-[#06B6D4]" />
                {t.scanner.autoDetect}
              </button>
              <button
                onClick={applyCropAndProceed}
                className="flex-1 min-h-[46px] rounded-xl bg-[#2563EB] text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                Apply Warp
              </button>
            </div>
          </div>
        )}

        {step === 'review' && activePage && (
          <div className="w-full max-w-2xl flex flex-col items-center space-y-4">
            {/* Multi-page horizontal strip */}
            {pages.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar w-full pb-1">
                {pages.map((p, idx) => (
                  <button
                    key={p.id}
                    onClick={() => setActiveIdx(idx)}
                    className={`relative shrink-0 w-16 h-20 rounded-xl overflow-hidden border-2 ${
                      idx === activeIdx ? 'border-[#06B6D4]' : 'border-slate-700 opacity-70'
                    }`}
                  >
                    <img
                      src={p.processedUrl}
                      alt={`Page ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute bottom-1 right-1 px-1 rounded bg-black/70 text-[10px] font-mono-nums">
                      {idx + 1}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="relative bg-slate-950 rounded-2xl p-2 border border-slate-800 max-h-[46vh] overflow-hidden flex items-center justify-center">
              <img
                src={activePage.processedUrl}
                alt="Enhanced scan"
                className="max-h-[43vh] w-auto object-contain rounded-lg"
              />
            </div>

            {/* Filter & Enhancement Controls */}
            <div className="w-full rounded-2xl bg-slate-900 border border-slate-800 p-3.5 space-y-3">
              <div className="grid grid-cols-4 gap-1.5">
                {(['color', 'magic', 'grayscale', 'bw'] as ScanFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => reprocessActivePage({ filter: f })}
                    className={`min-h-[40px] rounded-xl text-xs font-semibold transition-colors ${
                      activePage.filter === f
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {t.scanner.filters[f]}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="flex items-center justify-between text-slate-400">
                    <span className="flex items-center gap-1">
                      <SlidersHorizontal className="w-3.5 h-3.5" /> Brightness
                    </span>
                    <span className="font-mono-nums">{activePage.brightness}</span>
                  </span>
                  <input
                    type="range"
                    min={-40}
                    max={40}
                    value={activePage.brightness}
                    onChange={(e) => reprocessActivePage({ brightness: Number(e.target.value) })}
                    className="w-full accent-[#2563EB]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="flex items-center justify-between text-slate-400">
                    <span>Contrast</span>
                    <span className="font-mono-nums">{activePage.contrast}</span>
                  </span>
                  <input
                    type="range"
                    min={-30}
                    max={50}
                    value={activePage.contrast}
                    onChange={(e) => reprocessActivePage({ contrast: Number(e.target.value) })}
                    className="w-full accent-[#2563EB]"
                  />
                </label>
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-1">
                <button
                  onClick={() =>
                    reprocessActivePage({ rotation: (activePage.rotation + 90) % 360 })
                  }
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-xs font-semibold flex items-center gap-1.5 shrink-0"
                >
                  <RotateCw className="w-3.5 h-3.5" /> Rotate
                </button>
                <button
                  onClick={() => setStep('crop')}
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-xs font-semibold flex items-center gap-1.5 shrink-0"
                >
                  <Crop className="w-3.5 h-3.5" /> Adjust Crop
                </button>
                <button
                  onClick={() => reprocessActivePage({ sharpen: !activePage.sharpen })}
                  className={`min-h-[40px] px-3 rounded-xl text-xs font-semibold shrink-0 ${
                    activePage.sharpen
                      ? 'bg-[#06B6D4]/20 text-[#38BDF8]'
                      : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  Sharpen: {activePage.sharpen ? 'On' : 'Off'}
                </button>
                {pages.length > 1 && (
                  <>
                    <button
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
                      className="min-h-[40px] px-2.5 rounded-xl bg-slate-800 shrink-0"
                      aria-label="Move earlier"
                    >
                      <ArrowUp className="w-4 h-4 -rotate-90" />
                    </button>
                    <button
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
                      className="min-h-[40px] px-2.5 rounded-xl bg-slate-800 shrink-0"
                      aria-label="Move later"
                    >
                      <ArrowDown className="w-4 h-4 -rotate-90" />
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    const next = pages.filter((_, i) => i !== activeIdx);
                    setPages(next);
                    if (next.length === 0) setStep('capture');
                    else setActiveIdx(Math.max(0, activeIdx - 1));
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-rose-950/60 text-rose-300 text-xs font-semibold flex items-center gap-1 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
                <button
                  onClick={() => {
                    setStep('capture');
                    void startCamera();
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1 shrink-0"
                >
                  <Camera className="w-3.5 h-3.5" />{' '}
                  {language === 'bn' ? '+ পরের পেজ' : '+ Scan Next'}
                </button>
                <label className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold flex items-center gap-1 shrink-0 cursor-pointer">
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
          </div>
        )}
      </div>
    </div>
  );
};
