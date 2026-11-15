import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Check,
  Crop,
  ImagePlus,
  RotateCw,
  ScanText,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import {
  applyScanEnhancement,
  compileScannedPagesToPdf,
  detectDocumentBounds,
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
  filter: ScanFilter;
  brightness: number;
  contrast: number;
  sharpen: boolean;
  rotation: number;
  processedUrl: string;
}

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

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pages, setPages] = useState<ScannedPageItem[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [step, setStep] = useState<'capture' | 'crop' | 'review'>('capture');
  const [draggingCorner, setDraggingCorner] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 60);
    } catch {
      setCameraError(
        'Live camera unavailable or permission denied. Use "Choose Photo" to scan from camera/gallery.'
      );
    }
  };

  const ingestSourceCanvas = (rawCanvas: HTMLCanvasElement) => {
    const corners: [Point2D, Point2D, Point2D, Point2D] = autoCropDefault
      ? detectDocumentBounds(rawCanvas)
      : [
          { x: 0.05, y: 0.05 },
          { x: 0.95, y: 0.05 },
          { x: 0.95, y: 0.95 },
          { x: 0.05, y: 0.95 },
        ];
    const warped = perspectiveWarpCanvas(rawCanvas, corners);
    const processedUrl = applyScanEnhancement(warped, {
      filter: defaultFilter,
      brightness: 0,
      contrast: 10,
      sharpen: true,
      rotation: 0,
    });

    const newItem: ScannedPageItem = {
      id: `scan_${Date.now()}`,
      rawCanvas,
      corners,
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
    setStep('crop');
  };

  const captureFromVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 960;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    stopCamera();
    ingestSourceCanvas(c);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    files.forEach((file) => {
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
          ingestSourceCanvas(c);
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

  const handleCornerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingCorner === null || !cropBoxRef.current || !activePage) return;
    const rect = cropBoxRef.current.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));
    const nextCorners = [...activePage.corners] as [Point2D, Point2D, Point2D, Point2D];
    nextCorners[draggingCorner] = { x: nx, y: ny };
    setPages((prev) =>
      prev.map((p, i) => (i === activeIdx ? { ...p, corners: nextCorners } : p))
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
      const thumb = await renderPageThumbnail(pdfBytes, 1, 200).catch(() => pages[0].processedUrl);
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
              onClick={() => handleSave(true)}
              disabled={saving}
              className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-xs font-semibold flex items-center gap-1.5"
            >
              <ScanText className="w-4 h-4 text-[#06B6D4]" />
              <span className="hidden sm:inline">{t.scanner.runOcr}</span>
            </button>
            <button
              onClick={() => handleSave(false)}
              disabled={saving}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#2563EB] text-xs font-semibold flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>{saving ? 'Saving...' : t.scanner.saveAsPdf}</span>
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-4">
        {step === 'capture' && (
          <div className="w-full max-w-md space-y-4">
            {cameraActive ? (
              <div className="relative rounded-3xl overflow-hidden bg-black border border-slate-700 aspect-[3/4]">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {/* Document alignment guide overlay */}
                <div className="pointer-events-none absolute inset-6 border-2 border-dashed border-[#06B6D4]/80 rounded-2xl" />
                <div className="absolute bottom-4 inset-x-0 flex items-center justify-center gap-4">
                  <button
                    onClick={captureFromVideo}
                    aria-label={t.scanner.capturePhoto}
                    className="w-16 h-16 rounded-full bg-white border-4 border-[#2563EB] shadow-xl active:scale-95 transition-transform"
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6 text-center space-y-4">
                <div className="w-16 h-16 rounded-2xl bg-[#2563EB]/20 text-[#38BDF8] flex items-center justify-center mx-auto">
                  <Camera className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold">Capture Document Page</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Auto-edge detection, perspective warp, shadow removal, and Magic Color filters run locally.
                  </p>
                </div>

                {cameraError && (
                  <p className="text-xs text-amber-300 bg-amber-950/50 border border-amber-800/60 rounded-xl p-2.5">
                    {cameraError}
                  </p>
                )}

                <div className="grid grid-cols-1 gap-2.5">
                  <button
                    onClick={startCamera}
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
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'crop' && activePage && (
          <div className="w-full max-w-lg flex flex-col items-center space-y-4">
            <p className="text-xs text-slate-300">
              Drag the 4 corner handles to refine document perspective crop
            </p>
            <div
              ref={cropBoxRef}
              onPointerMove={handleCornerPointerMove}
              onPointerUp={() => setDraggingCorner(null)}
              onPointerCancel={() => setDraggingCorner(null)}
              className="relative max-w-full touch-none select-none rounded-xl overflow-hidden border border-slate-700"
              style={{
                width: Math.min(420, window.innerWidth - 32),
                aspectRatio: `${activePage.rawCanvas.width} / ${activePage.rawCanvas.height}`,
              }}
            >
              <img
                src={activePage.rawCanvas.toDataURL('image/jpeg', 0.75)}
                alt="Raw scan"
                className="w-full h-full object-contain block pointer-events-none"
              />
              <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                <polygon
                  points={activePage.corners.map((c) => `${c.x * 100},${c.y * 100}`).join(' ')}
                  fill="rgba(6, 182, 212, 0.14)"
                  stroke="#06B6D4"
                  strokeWidth="0.8"
                />
              </svg>
              {activePage.corners.map((c, idx) => (
                <button
                  key={idx}
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    cropBoxRef.current?.setPointerCapture?.(e.pointerId);
                    setDraggingCorner(idx);
                  }}
                  style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
                  aria-label={`Corner ${idx + 1}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-[#2563EB] border-2 border-white shadow-lg cursor-grab active:scale-110"
                />
              ))}
            </div>

            <div className="flex items-center gap-3 w-full max-w-sm">
              <button
                onClick={() => {
                  const auto = detectDocumentBounds(activePage.rawCanvas);
                  setPages((prev) =>
                    prev.map((p, i) => (i === activeIdx ? { ...p, corners: auto } : p))
                  );
                }}
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
                    <img src={p.processedUrl} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
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
                  onClick={() => reprocessActivePage({ rotation: (activePage.rotation + 90) % 360 })}
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
                    activePage.sharpen ? 'bg-[#06B6D4]/20 text-[#38BDF8]' : 'bg-slate-800 text-slate-300'
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
                        [copy[activeIdx - 1], copy[activeIdx]] = [copy[activeIdx], copy[activeIdx - 1]];
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
                        [copy[activeIdx + 1], copy[activeIdx]] = [copy[activeIdx], copy[activeIdx + 1]];
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
                  onClick={() => setStep('capture')}
                  className="min-h-[40px] px-3 rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center gap-1 shrink-0"
                >
                  <Camera className="w-3.5 h-3.5" /> + Add Page
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
