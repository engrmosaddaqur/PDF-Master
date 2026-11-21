import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Eraser, ImagePlus, PenTool, ShieldCheck, Trash2, Undo2, X } from 'lucide-react';
import type { AppLanguage, SavedSignature } from '../types';
import { deleteSignature, getAllSignatures, saveSignature } from '../services/storageService';

interface SignatureModalProps {
  open: boolean;
  language?: AppLanguage;
  onClose: () => void;
  onSelectSignature: (opts: {
    dataUrl: string;
    signerName: string;
    dateStr: string;
    attachIntegritySeal: boolean;
  }) => void;
}

interface StrokeRecord {
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

export const SignatureModal: React.FC<SignatureModalProps> = ({
  open,
  language = 'en',
  onClose,
  onSelectSignature,
}) => {
  const bn = language === 'bn';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tab, setTab] = useState<'draw' | 'saved' | 'upload'>('draw');
  const [penColor, setPenColor] = useState('#142B4A');
  const [penWidth, setPenWidth] = useState(3);
  const [strokes, setStrokes] = useState<StrokeRecord[]>([]);
  const activeStrokeRef = useRef<StrokeRecord | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [includeDate, setIncludeDate] = useState(true);
  const [attachSeal, setAttachSeal] = useState(true);
  const [removeWhiteBg, setRemoveWhiteBg] = useState(true);
  const [savedSigs, setSavedSigs] = useState<SavedSignature[]>([]);
  const [saveForReuse, setSaveForReuse] = useState(true);

  useEffect(() => {
    if (!open) return;
    getAllSignatures().then(setSavedSigs).catch(() => {});
  }, [open]);

  const redrawAllStrokes = useCallback((list: StrokeRecord[], live?: StrokeRecord | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawOne = (st: StrokeRecord) => {
      if (st.points.length === 0) return;
      ctx.strokeStyle = st.color;
      ctx.fillStyle = st.color;
      ctx.lineWidth = st.width * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (st.points.length === 1) {
        ctx.beginPath();
        ctx.arc(st.points[0].x, st.points[0].y, st.width, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      ctx.beginPath();
      ctx.moveTo(st.points[0].x, st.points[0].y);
      for (let i = 1; i < st.points.length - 1; i++) {
        const midX = (st.points[i].x + st.points[i + 1].x) / 2;
        const midY = (st.points[i].y + st.points[i + 1].y) / 2;
        ctx.quadraticCurveTo(st.points[i].x, st.points[i].y, midX, midY);
      }
      const last = st.points[st.points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    };

    for (const s of list) drawOne(s);
    if (live) drawOne(live);
  }, []);

  useEffect(() => {
    if (open && tab === 'draw') {
      redrawAllStrokes(strokes, activeStrokeRef.current);
    }
  }, [open, tab, strokes, redrawAllStrokes]);

  if (!open) return null;

  const getPointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore synthetic capture issues
    }
    const pos = getPointerPos(e);
    const stroke: StrokeRecord = {
      color: penColor,
      width: penWidth,
      points: [pos],
    };
    activeStrokeRef.current = stroke;
    setIsDrawing(true);
    redrawAllStrokes(strokes, stroke);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !activeStrokeRef.current) return;
    const pos = getPointerPos(e);
    const pts = activeStrokeRef.current.points;
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= 1.5) {
      pts.push(pos);
      redrawAllStrokes(strokes, activeStrokeRef.current);
    }
  };

  const finalizeStroke = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const done = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (done && done.points.length > 0) {
      const next = [...strokes, done];
      setStrokes(next);
      redrawAllStrokes(next, null);
    }
  };

  const handleUndoStroke = () => {
    if (strokes.length === 0) return;
    const next = strokes.slice(0, -1);
    setStrokes(next);
    redrawAllStrokes(next, null);
  };

  const clearCanvas = () => {
    activeStrokeRef.current = null;
    setStrokes([]);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const hasStroke = strokes.length > 0 || isDrawing;

  const handleConfirmDrawn = async () => {
    const canvas = canvasRef.current;
    if (!canvas || strokes.length === 0) return;
    const dataUrl = canvas.toDataURL('image/png');
    if (saveForReuse) {
      const sig: SavedSignature = {
        id: `sig_${Date.now()}`,
        label: signerName.trim() || `${bn ? 'স্বাক্ষর' : 'Signature'} ${savedSigs.length + 1}`,
        dataUrl,
        type: 'drawn',
        createdAt: Date.now(),
      };
      await saveSignature(sig);
    }
    onSelectSignature({
      dataUrl,
      signerName: signerName.trim(),
      dateStr: includeDate ? new Date().toLocaleDateString() : '',
      attachIntegritySeal: attachSeal,
    });
  };

  const handleUploadImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rawUrl = reader.result as string;
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.min(600, img.naturalWidth || 400));
        c.height = Math.max(1, Math.round((c.width / (img.naturalWidth || 400)) * (img.naturalHeight || 200)));
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        if (removeWhiteBg) {
          const imData = ctx.getImageData(0, 0, c.width, c.height);
          const d = imData.data;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) {
              d[i + 3] = 0;
            }
          }
          ctx.putImageData(imData, 0, 0);
        }
        const cleanUrl = c.toDataURL('image/png');
        const sig: SavedSignature = {
          id: `sig_${Date.now()}`,
          label: signerName.trim() || file.name.replace(/\.[^.]+$/, ''),
          dataUrl: cleanUrl,
          type: 'image',
          createdAt: Date.now(),
        };
        await saveSignature(sig);
        setSavedSigs((prev) => [sig, ...prev]);
        onSelectSignature({
          dataUrl: cleanUrl,
          signerName: signerName.trim(),
          dateStr: includeDate ? new Date().toLocaleDateString() : '',
          attachIntegritySeal: attachSeal,
        });
      };
      img.src = rawUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl max-h-[92vh] flex flex-col">
        <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-3 sm:hidden" />

        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <PenTool className="w-5 h-5 text-[#2563EB]" />
            <h2 className="font-display text-lg font-bold text-[#142B4A] dark:text-white">
              {bn ? 'ডিজিটাল স্বাক্ষর' : 'Digital Signature'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {/* Segmented control */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
            <button
              onClick={() => setTab('draw')}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-colors ${
                tab === 'draw'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {bn ? 'আঁকুন' : 'Draw'}
            </button>
            <button
              onClick={() => setTab('saved')}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-colors ${
                tab === 'saved'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {bn ? 'সংরক্ষিত' : 'Saved'} ({savedSigs.length})
            </button>
            <button
              onClick={() => setTab('upload')}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-colors ${
                tab === 'upload'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {bn ? 'ছবি' : 'Image'}
            </button>
          </div>

          {/* Signer metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                {bn ? 'স্বাক্ষরকারীর নাম (ঐচ্ছিক)' : 'Signer Name (optional)'}
              </label>
              <input
                type="text"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder={bn ? 'যেমন: মোসাদ্দেক' : 'e.g. Tariq Hasan'}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
              />
            </div>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer min-h-[24px]">
                <input
                  type="checkbox"
                  checked={includeDate}
                  onChange={(e) => setIncludeDate(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB] rounded"
                />
                {bn ? 'তারিখ যোগ করুন' : 'Include Date'} ({new Date().toLocaleDateString()})
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer min-h-[24px]">
                <input
                  type="checkbox"
                  checked={attachSeal}
                  onChange={(e) => setAttachSeal(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB] rounded"
                />
                {bn ? 'SHA-256 ইন্টেগ্রিটি সিল' : 'Attach SHA-256 Integrity Seal'}
              </label>
            </div>
          </div>

          {tab === 'draw' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {['#142B4A', '#2563EB', '#0F172A', '#B91C1C'].map((c) => (
                    <button
                      key={c}
                      onClick={() => setPenColor(c)}
                      aria-label={`Color ${c}`}
                      className={`w-7 h-7 rounded-full border-2 transition-transform ${
                        penColor === c ? 'border-[#06B6D4] scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <select
                    value={penWidth}
                    onChange={(e) => setPenWidth(Number(e.target.value))}
                    className="ml-1 h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs"
                  >
                    <option value={2}>{bn ? 'চিকন' : 'Fine'}</option>
                    <option value={3}>{bn ? 'মাঝারি' : 'Medium'}</option>
                    <option value={5}>{bn ? 'মোটা' : 'Bold'}</option>
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleUndoStroke}
                    disabled={strokes.length === 0}
                    className="min-h-[38px] px-2.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
                  >
                    <Undo2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={clearCanvas}
                    className="min-h-[38px] px-2.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
                  >
                    <Eraser className="w-4 h-4" />
                    {bn ? 'মুছুন' : 'Clear'}
                  </button>
                </div>
              </div>

              <div className="relative rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white overflow-hidden">
                <canvas
                  ref={canvasRef}
                  width={680}
                  height={280}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finalizeStroke}
                  onPointerCancel={finalizeStroke}
                  className="w-full h-48 touch-none cursor-crosshair block"
                />
                {!hasStroke && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                    {bn ? 'আঙুল বা স্টাইলাস দিয়ে মসৃণভাবে স্বাক্ষর করুন' : 'Sign smoothly with your finger or stylus'}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveForReuse}
                  onChange={(e) => setSaveForReuse(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB]"
                />
                {bn ? 'পুনরায় ব্যবহারের জন্য ভল্টে সংরক্ষণ করুন' : 'Save signature securely in local Vault for reuse'}
              </label>

              <button
                onClick={handleConfirmDrawn}
                disabled={strokes.length === 0}
                className="w-full min-h-[48px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white font-semibold text-sm flex items-center justify-center gap-2"
              >
                <Check className="w-4 h-4" />
                {bn ? 'পিডিএফে স্বাক্ষর বসান' : 'Place Signature on PDF'}
              </button>
            </div>
          )}

          {tab === 'saved' && (
            <div className="space-y-2.5">
              {savedSigs.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  {bn ? 'এখনও কোনো স্বাক্ষর সংরক্ষিত নেই। প্রথমে একটি আঁকুন বা আপলোড করুন।' : 'No saved signatures yet. Draw or upload one first.'}
                </p>
              ) : (
                savedSigs.map((sig) => (
                  <div
                    key={sig.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60"
                  >
                    <button
                      onClick={() =>
                        onSelectSignature({
                          dataUrl: sig.dataUrl,
                          signerName: signerName.trim() || sig.label,
                          dateStr: includeDate ? new Date().toLocaleDateString() : '',
                          attachIntegritySeal: attachSeal,
                        })
                      }
                      className="flex-1 flex items-center gap-3 text-left min-h-[44px]"
                    >
                      <img
                        src={sig.dataUrl}
                        alt={sig.label}
                        className="h-12 w-28 object-contain bg-white rounded-lg p-1 border border-slate-200"
                      />
                      <div>
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">
                          {sig.label}
                        </p>
                        <p className="text-xs text-slate-500">
                          {sig.type === 'drawn' ? (bn ? 'হাতে আঁকা স্বাক্ষর' : 'Drawn signature') : (bn ? 'আপলোডকৃত ছবি' : 'Uploaded image')}
                        </p>
                      </div>
                    </button>
                    <button
                      onClick={async () => {
                        await deleteSignature(sig.id);
                        setSavedSigs((prev) => prev.filter((s) => s.id !== sig.id));
                      }}
                      aria-label="Delete saved signature"
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'upload' && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={removeWhiteBg}
                  onChange={(e) => setRemoveWhiteBg(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB]"
                />
                {bn ? 'সাদা কাগজের ব্যাকগ্রাউন্ড স্বয়ংক্রিয়ভাবে স্বচ্ছ করুন' : 'Automatically make white paper background transparent'}
              </label>
              <label className="flex flex-col items-center justify-center gap-2 p-8 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 cursor-pointer hover:border-[#2563EB] transition-colors">
                <ImagePlus className="w-8 h-8 text-[#2563EB]" />
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {bn ? 'স্বাক্ষরের ছবি বা PNG নির্বাচন করুন' : 'Upload Signature Photo or PNG'}
                </span>
                <span className="text-xs text-slate-500 text-center">
                  {bn ? 'যেকোনো PNG, JPG বা স্বাক্ষরের ছবি ব্যবহার করা যাবে' : 'Supports PNG, JPG, WebP, or camera signature photos'}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleUploadImage}
                  className="hidden"
                />
              </label>
            </div>
          )}

          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-xs text-slate-600 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 text-[#06B6D4] shrink-0 mt-0.5" />
            <p>
              {bn
                ? 'অঙ্কিত ও ছবির স্বাক্ষর ভিজ্যুয়াল মার্ক এবং ঐচ্ছিক SHA-256 ডকুমেন্ট ইন্টেগ্রিটি সিল সহ যুক্ত হয়।'
                : 'Drawn & image signatures embed as visual marks plus an optional SHA-256 cryptographic document integrity seal.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

