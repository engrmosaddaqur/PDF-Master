import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Layers,
  Maximize2,
  Minimize2,
  RotateCw,
  Search,
  Share2,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import {
  cancelCanvasRender,
  extractDocumentPagesText,
  extractSinglePageText,
  getPdfPageDimension,
  renderPageToCanvas,
  rotateAllPages,
} from '../services/pdfEngine';
import {
  saveBufferToDeviceStorage,
  shareBufferNativeOrWeb,
} from '../services/deviceFileActions';
import { usePdfPinchZoom } from '../hooks/usePdfPinchZoom';

interface PdfViewerViewProps {
  doc: DocumentRecord;
  language: AppLanguage;
  defaultViewMode: 'continuous' | 'single';
  onClose: () => void;
  onUpdateDoc: (updated: DocumentRecord) => Promise<void>;
  onOpenEditor: () => void;
  onOpenOrganizer: () => void;
}

const LazyPageCanvas: React.FC<{
  pdfBytes: ArrayBuffer;
  pageNumber: number;
  scale: number;
  renderScale: number;
  rotation: number;
  isBookmarked: boolean;
  defaultDims: { width: number; height: number };
  shouldRender: boolean;
  registerPageRef: (pageNumber: number, el: HTMLDivElement | null) => void;
}> = React.memo(
  ({
    pdfBytes,
    pageNumber,
    scale,
    renderScale,
    rotation,
    isBookmarked,
    defaultDims,
    shouldRender,
    registerPageRef,
  }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [rendering, setRendering] = useState(shouldRender);
    const [hasRendered, setHasRendered] = useState(false);
    const [dims, setDims] = useState<{ width: number; height: number }>(defaultDims);

    useEffect(() => {
      setDims(defaultDims);
    }, [defaultDims.width, defaultDims.height]);

    useEffect(() => {
      setHasRendered(false);
    }, [pdfBytes, pageNumber]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!shouldRender) {
        if (canvas) {
          cancelCanvasRender(canvas);
          if (canvas.width > 0) {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        setHasRendered(false);
        setRendering(false);
        return;
      }

      if (!canvas) return;
      let active = true;
      setRendering(true);
      renderPageToCanvas(pdfBytes, pageNumber, canvas, renderScale, rotation)
        .then((res) => {
          if (active && res.unscaledWidth > 0 && res.unscaledHeight > 0) {
            setDims((prev) =>
              Math.abs(prev.width - res.unscaledWidth) < 0.5 &&
              Math.abs(prev.height - res.unscaledHeight) < 0.5
                ? prev
                : { width: res.unscaledWidth, height: res.unscaledHeight }
            );
            setHasRendered(true);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (active) setRendering(false);
        });
      return () => {
        active = false;
      };
    }, [shouldRender, pdfBytes, pageNumber, renderScale, rotation]);

    const boxW = Math.max(120, Math.floor(dims.width * scale));
    const boxH = Math.max(160, Math.floor(dims.height * scale));

    return (
      <div
        data-page={pageNumber}
        ref={(el) => registerPageRef(pageNumber, el)}
        style={{ width: boxW, height: boxH, contain: 'layout style paint' }}
        className="relative mx-auto my-3 bg-white shadow-md rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0"
      >
        {(!shouldRender || (rendering && !hasRendered)) && (
          <div className="absolute inset-0 bg-slate-100/70 dark:bg-slate-800/70 flex items-center justify-center z-10 pointer-events-none">
            <span className="text-xs font-mono-nums text-slate-500">Page {pageNumber}</span>
          </div>
        )}
        {isBookmarked && (
          <div className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-[#2563EB] text-white shadow">
            <Bookmark className="w-3.5 h-3.5 fill-current" />
          </div>
        )}
        {shouldRender && <canvas ref={canvasRef} className="block w-full h-full" />}
      </div>
    );
  }
);

export const PdfViewerView: React.FC<PdfViewerViewProps> = ({
  doc,
  language,
  defaultViewMode,
  onClose,
  onUpdateDoc,
  onOpenEditor,
  onOpenOrganizer,
}) => {
  const t = getT(language);
  const [viewMode, setViewMode] = useState<'continuous' | 'single'>(defaultViewMode);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageJumpInput, setPageJumpInput] = useState('1');
  const [scale, setScale] = useState<number>(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return w < 640 ? Math.max(0.55, Math.min(1.0, (w - 32) / 595)) : 1.05;
  });
  const [renderScale, setRenderScale] = useState(scale);
  const [extraRotation, setExtraRotation] = useState(0);
  const [defaultPageDims, setDefaultPageDims] = useState({ width: 595, height: 842 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pageTexts, setPageTexts] = useState<Array<{ pageNumber: number; text: string }>>([]);
  const [indexingSearch, setIndexingSearch] = useState(false);
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [showTextModal, setShowTextModal] = useState(false);
  const [currentPageText, setCurrentPageText] = useState('');
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1, 2, 3]));

  const viewerRootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Single debounced renderScale at parent level instead of N per-page timers
  useEffect(() => {
    const id = setTimeout(() => setRenderScale(scale), 100);
    return () => clearTimeout(id);
  }, [scale]);

  usePdfPinchZoom({
    rootRef: viewerRootRef,
    scrollRef: containerRef,
    contentRef: scrollContentRef,
    scale,
    setScale,
    minScale: 0.35,
    maxScale: 3.5,
    dragPan: 'mouse',
    doubleTapZoom: true,
  });

  const registerPageRef = useCallback((pNum: number, el: HTMLDivElement | null) => {
    if (el) {
      pageRefs.current.set(pNum, el);
    } else {
      pageRefs.current.delete(pNum);
    }
  }, []);

  // Two shared IntersectionObservers instead of 2*N observers for fast 150+ page scrolling
  useEffect(() => {
    if (viewMode !== 'continuous' || !scrollRootEl) return;

    const renderObserver = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const p = Number((entry.target as HTMLElement).dataset.page);
            if (!p) continue;
            if (entry.isIntersecting) {
              if (!next.has(p)) {
                next.add(p);
                changed = true;
              }
            } else if (next.has(p) && p > 2) {
              next.delete(p);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: scrollRootEl, rootMargin: '850px 0px' }
    );

    const currentObserver = new IntersectionObserver(
      (entries) => {
        let bestPage: number | null = null;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= bestRatio) {
            const p = Number((entry.target as HTMLElement).dataset.page);
            if (p) {
              bestRatio = entry.intersectionRatio;
              bestPage = p;
            }
          }
        }
        if (bestPage !== null) {
          setCurrentPage(bestPage);
        }
      },
      { root: scrollRootEl, threshold: [0.25, 0.55] }
    );

    pageRefs.current.forEach((el) => {
      renderObserver.observe(el);
      currentObserver.observe(el);
    });

    return () => {
      renderObserver.disconnect();
      currentObserver.disconnect();
    };
  }, [viewMode, scrollRootEl, doc.id, doc.pageCount]);

  useEffect(() => {
    setPageJumpInput(String(currentPage));
  }, [currentPage]);

  // Read page 1 dimensions once for accurate placeholder geometry across large PDFs
  useEffect(() => {
    let active = true;
    setPageTexts([]);
    getPdfPageDimension(doc.pdfBytes, 1, extraRotation)
      .then((dims) => {
        if (active) setDefaultPageDims(dims);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [doc.id, doc.pdfBytes, extraRotation]);

  // Lazy-extract all page texts only when user opens search
  useEffect(() => {
    if (!showSearch || pageTexts.length > 0) return;
    let active = true;
    setIndexingSearch(true);
    extractDocumentPagesText(doc.pdfBytes)
      .then((texts) => {
        if (active) setPageTexts(texts);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIndexingSearch(false);
      });
    return () => {
      active = false;
    };
  }, [showSearch, pageTexts.length, doc.pdfBytes]);

  // Extract current page text on demand when Copy Text modal opens
  useEffect(() => {
    if (!showTextModal) return;
    let active = true;
    const cached = pageTexts.find((p) => p.pageNumber === currentPage)?.text;
    if (cached !== undefined) {
      setCurrentPageText(cached);
      return;
    }
    extractSinglePageText(doc.pdfBytes, currentPage)
      .then((txt) => {
        if (active) setCurrentPageText(txt);
      })
      .catch(() => {
        if (active) setCurrentPageText('');
      });
    return () => {
      active = false;
    };
  }, [showTextModal, currentPage, doc.pdfBytes, pageTexts]);

  const jumpToPage = useCallback(
    (targetPage: number) => {
      const safe = Math.max(1, Math.min(doc.pageCount, targetPage));
      setCurrentPage(safe);
      if (viewMode === 'continuous') {
        const el = pageRefs.current.get(safe);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [doc.pageCount, viewMode]
  );

  // Keyboard arrow / PageUp / PageDown / Home / End navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showTextModal) return;
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
      const c = containerRef.current;

      if (e.key === 'Escape' && isFullscreen) {
        e.preventDefault();
        setIsFullscreen(false);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (viewMode === 'continuous' && c && c.scrollHeight > c.clientHeight + 4) {
          c.scrollBy({ top: 140, behavior: 'auto' });
        } else {
          jumpToPage(currentPage + 1);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (viewMode === 'continuous' && c && c.scrollHeight > c.clientHeight + 4) {
          c.scrollBy({ top: -140, behavior: 'auto' });
        } else {
          jumpToPage(currentPage - 1);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (c && c.scrollWidth > c.clientWidth + 10 && c.scrollLeft + c.clientWidth < c.scrollWidth - 4) {
          c.scrollBy({ left: 100, behavior: 'auto' });
        } else {
          jumpToPage(currentPage + 1);
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (c && c.scrollWidth > c.clientWidth + 10 && c.scrollLeft > 4) {
          c.scrollBy({ left: -100, behavior: 'auto' });
        } else {
          jumpToPage(currentPage - 1);
        }
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        jumpToPage(currentPage + 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        jumpToPage(currentPage - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        jumpToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        jumpToPage(doc.pageCount);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showTextModal, isFullscreen, viewMode, currentPage, doc.pageCount, jumpToPage]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchMatches([]);
      return;
    }
    const q = searchQuery.toLowerCase();
    const hits = pageTexts
      .filter((p) => p.text.toLowerCase().includes(q))
      .map((p) => p.pageNumber);
    setSearchMatches(hits);
    if (hits.length > 0 && !hits.includes(currentPage)) {
      jumpToPage(hits[0]);
    }
  }, [searchQuery, pageTexts]);

  const bookmarks = doc.bookmarks || [];
  const isCurrentBookmarked = bookmarks.includes(currentPage);

  const toggleBookmark = async () => {
    const next = isCurrentBookmarked
      ? bookmarks.filter((p) => p !== currentPage)
      : [...bookmarks, currentPage].sort((a, b) => a - b);
    await onUpdateDoc({ ...doc, bookmarks: next, updatedAt: Date.now() });
  };

  const handleRotateSave = async () => {
    const nextRot = (extraRotation + 90) % 360;
    setExtraRotation(nextRot);
    const rotatedBytes = await rotateAllPages(doc.pdfBytes, 90);
    await onUpdateDoc({
      ...doc,
      pdfBytes: rotatedBytes,
      sizeBytes: rotatedBytes.byteLength,
      updatedAt: Date.now(),
    });
    setExtraRotation(0);
  };

  const handleFitWidth = () => {
    const cw = containerRef.current?.clientWidth || window.innerWidth;
    setScale(Math.max(0.35, Math.min(3.0, Number(((cw - 32) / defaultPageDims.width).toFixed(2)))));
  };

  const handleFitPage = () => {
    const ch = containerRef.current?.clientHeight || window.innerHeight - 160;
    setScale(Math.max(0.35, Math.min(3.0, Number(((ch - 32) / defaultPageDims.height).toFixed(2)))));
  };

  const handleShare = async () => {
    await shareBufferNativeOrWeb(doc.pdfBytes, doc.name, 'application/pdf');
    await onUpdateDoc({ ...doc, isShared: true });
  };

  return (
    <div
      ref={viewerRootRef}
      style={{ touchAction: 'pan-x pan-y' }}
      className="fixed inset-0 z-40 flex flex-col bg-[#F1F5F9] dark:bg-[#0B1120]"
    >
      {/* Top Bar */}
      {!isFullscreen && (
        <header className="flex items-center justify-between gap-2 px-3 py-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={onClose}
              aria-label="Back"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-[#142B4A] dark:text-white truncate max-w-[180px] sm:max-w-xs">
                {doc.name}
              </h1>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = parseInt(pageJumpInput, 10);
                  if (!Number.isNaN(parsed)) jumpToPage(parsed);
                }}
                className="flex items-center gap-1 text-[11px] font-mono-nums text-slate-500"
              >
                <span>{t.viewer.page}</span>
                <input
                  type="number"
                  min={1}
                  max={doc.pageCount}
                  value={pageJumpInput}
                  onChange={(e) => setPageJumpInput(e.target.value)}
                  onBlur={() => {
                    const parsed = parseInt(pageJumpInput, 10);
                    if (!Number.isNaN(parsed) && parsed !== currentPage) {
                      jumpToPage(parsed);
                    } else {
                      setPageJumpInput(String(currentPage));
                    }
                  }}
                  aria-label="Jump to page number"
                  className="w-11 px-1 py-0.5 text-center rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
                />
                <span>
                  {t.viewer.of} {doc.pageCount} · {Math.round(scale * 100)}%
                </span>
              </form>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setShowSearch((v) => !v)}
              aria-label="Search PDF"
              className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl transition-colors ${
                showSearch
                  ? 'bg-[#2563EB]/10 text-[#2563EB]'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Search className="w-5 h-5" />
            </button>
            <button
              onClick={toggleBookmark}
              aria-label={t.viewer.bookmark}
              className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl transition-colors ${
                isCurrentBookmarked
                  ? 'text-[#2563EB]'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Bookmark className={`w-5 h-5 ${isCurrentBookmarked ? 'fill-current' : ''}`} />
            </button>
            <button
              onClick={handleShare}
              aria-label={t.viewer.share}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Share2 className="w-5 h-5" />
            </button>
            <button
              onClick={() => setIsFullscreen(true)}
              aria-label="Fullscreen"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Maximize2 className="w-5 h-5" />
            </button>
          </div>
        </header>
      )}

      {/* Search Bar */}
      {showSearch && !isFullscreen && (
        <div className="px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={indexingSearch ? 'Indexing pages for search...' : t.viewer.searchInPdf}
            autoFocus
            className="flex-1 min-h-[38px] bg-transparent text-sm text-slate-900 dark:text-white focus:outline-none"
          />
          {searchQuery && (
            <span className="text-xs font-mono-nums text-slate-500 whitespace-nowrap">
              {searchMatches.length} {searchMatches.length === 1 ? 'page' : 'pages'}
            </span>
          )}
          {searchMatches.length > 0 && (
            <div className="flex items-center gap-1">
              {searchMatches.slice(0, 5).map((p) => (
                <button
                  key={p}
                  onClick={() => jumpToPage(p)}
                  className={`px-2 py-1 rounded-md text-xs font-mono-nums font-semibold ${
                    currentPage === p
                      ? 'bg-[#2563EB] text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  P{p}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              setShowSearch(false);
              setSearchQuery('');
            }}
            className="min-h-[36px] min-w-[36px] flex items-center justify-center text-slate-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Secondary Reading Controls */}
      {!isFullscreen && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar shrink-0">
          <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 shrink-0">
            <button
              onClick={() => setViewMode('continuous')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap ${
                viewMode === 'continuous'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              {t.viewer.continuous}
            </button>
            <button
              onClick={() => setViewMode('single')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap ${
                viewMode === 'single'
                  ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              {t.viewer.single}
            </button>
          </div>

          <button
            onClick={() => setScale((s) => Math.max(0.35, Number((s - 0.15).toFixed(2))))}
            aria-label="Zoom out"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shrink-0"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setScale((s) => Math.min(3.5, Number((s + 0.15).toFixed(2))))}
            aria-label="Zoom in"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shrink-0"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={handleFitWidth}
            className="px-2.5 min-h-[36px] rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0"
          >
            {t.viewer.fitWidth}
          </button>
          <button
            onClick={handleFitPage}
            className="px-2.5 min-h-[36px] rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0"
          >
            {t.viewer.fitPage}
          </button>
          <button
            onClick={handleRotateSave}
            className="px-2.5 min-h-[36px] rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            <RotateCw className="w-3.5 h-3.5" />
            {t.viewer.rotate}
          </button>
          <button
            onClick={() => setShowTextModal(true)}
            className="px-2.5 min-h-[36px] rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            <Copy className="w-3.5 h-3.5" />
            {t.viewer.copyText}
          </button>
          <button
            onClick={() => void saveBufferToDeviceStorage(doc.pdfBytes, doc.name, 'application/pdf')}
            className="px-2.5 min-h-[36px] rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            {t.viewer.download}
          </button>
        </div>
      )}

      {/* Bookmarked Pages Quick Jump Bar */}
      {!isFullscreen && bookmarks.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar shrink-0">
          <span className="text-[11px] font-semibold text-slate-500 flex items-center gap-1 shrink-0">
            <Bookmark className="w-3 h-3 text-[#2563EB] fill-current" />
            Bookmarks:
          </span>
          {bookmarks.map((bp) => (
            <button
              key={bp}
              onClick={() => jumpToPage(bp)}
              className={`px-2 py-0.5 rounded-md text-[11px] font-mono-nums font-semibold shrink-0 ${
                currentPage === bp
                  ? 'bg-[#2563EB] text-white'
                  : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
              }`}
            >
              P{bp}
            </button>
          ))}
        </div>
      )}

      {/* Fullscreen Exit Floating Button */}
      {isFullscreen && (
        <button
          onClick={() => setIsFullscreen(false)}
          aria-label="Exit fullscreen"
          className="fixed top-4 right-4 z-50 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-slate-900/80 text-white shadow-lg backdrop-blur"
        >
          <Minimize2 className="w-5 h-5" />
        </button>
      )}

      {/* PDF Canvas Viewport */}
      <div
        ref={(el) => {
          containerRef.current = el;
          setScrollRootEl(el);
        }}
        style={{
          touchAction: 'pan-x pan-y',
          overscrollBehavior: 'contain',
          scrollBehavior: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
        className="flex-1 overflow-auto cursor-grab"
      >
        {viewMode === 'single' ? (
          <div
            ref={scrollContentRef}
            className="min-w-full min-h-full w-fit px-3 sm:px-6 py-4 flex flex-col items-center"
          >
            <LazyPageCanvas
              pdfBytes={doc.pdfBytes}
              pageNumber={currentPage}
              scale={scale}
              renderScale={renderScale}
              rotation={extraRotation}
              isBookmarked={isCurrentBookmarked}
              defaultDims={defaultPageDims}
              shouldRender
              registerPageRef={registerPageRef}
            />
          </div>
        ) : (
          <div
            ref={scrollContentRef}
            className="min-w-full min-h-full w-fit px-3 sm:px-6 py-4 flex flex-col items-center"
          >
            {Array.from({ length: doc.pageCount }, (_, i) => i + 1).map((pNum) => (
              <LazyPageCanvas
                key={pNum}
                pdfBytes={doc.pdfBytes}
                pageNumber={pNum}
                scale={scale}
                renderScale={renderScale}
                rotation={extraRotation}
                isBookmarked={bookmarks.includes(pNum)}
                defaultDims={defaultPageDims}
                shouldRender={pNum <= 2 || visiblePages.has(pNum) || Math.abs(pNum - currentPage) <= 1}
                registerPageRef={registerPageRef}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom Action & Page Navigation Bar */}
      {!isFullscreen && (
        <footer className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 px-3 py-2 pb-safe shrink-0">
          {doc.pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
              <button
                onClick={() => jumpToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                className="min-h-[40px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-40"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <input
                type="range"
                min={1}
                max={doc.pageCount}
                value={currentPage}
                onChange={(e) => jumpToPage(Number(e.target.value))}
                className="flex-1 accent-[#2563EB]"
              />
              <button
                onClick={() => jumpToPage(currentPage + 1)}
                disabled={currentPage >= doc.pageCount}
                className="min-h-[40px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-40"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onOpenEditor}
              className="min-h-[44px] rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
            >
              <Edit3 className="w-4 h-4" />
              <span>{t.viewer.editMode}</span>
            </button>
            <button
              onClick={onOpenOrganizer}
              className="min-h-[44px] rounded-xl bg-slate-100 dark:bg-slate-800 text-[#142B4A] dark:text-slate-100 text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
            >
              <Layers className="w-4 h-4" />
              <span>{t.viewer.organize}</span>
            </button>
          </div>
        </footer>
      )}

      {/* Extract & Copy Text Sheet */}
      {showTextModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                Page {currentPage} Text
              </h3>
              <button
                onClick={() => setShowTextModal(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <textarea
              readOnly
              value={currentPageText || 'No selectable embedded text on this page. Try running OCR.'}
              className="flex-1 min-h-[220px] p-3 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-200 focus:outline-none"
            />
            <button
              onClick={() => {
                navigator.clipboard.writeText(currentPageText);
                setCopiedNotice(true);
                setTimeout(() => setCopiedNotice(false), 1800);
              }}
              disabled={!currentPageText}
              className="mt-3 w-full min-h-[46px] rounded-xl bg-[#2563EB] disabled:opacity-40 text-white text-sm font-semibold"
            >
              {copiedNotice ? 'Copied to Clipboard' : 'Copy Page Text'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
