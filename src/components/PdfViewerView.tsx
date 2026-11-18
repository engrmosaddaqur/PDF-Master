import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  BookOpen,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FileCheck2,
  Layers,
  ListTree,
  Maximize2,
  Minimize2,
  Moon,
  RotateCw,
  Search,
  Share2,
  Sun,
  TextCursorInput,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react';
import type {
  AppLanguage,
  DocumentRecord,
  ExtractedTextRun,
  PdfFormFieldDescriptor,
} from '../types';
import { getT } from '../i18n/translations';
import {
  applyPdfFormFieldValues,
  cancelCanvasRender,
  cloneBuffer,
  extractDocumentPagesText,
  extractPageTextBoxes,
  extractPdfFormFields,
  extractPdfOutline,
  extractSinglePageText,
  getPdfPageDimension,
  type PdfOutlineEntry,
  renderPageThumbnail,
  renderPageToCanvas,
  rotateAllPages,
} from '../services/pdfEngine';
import {
  emitAppToast,
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

type ReadingMode = 'normal' | 'sepia' | 'night';

const ThumbGridTile: React.FC<{
  pdfBytes: ArrayBuffer;
  pageNumber: number;
  isActive: boolean;
  isBookmarked: boolean;
  onSelect: (p: number) => void;
}> = React.memo(({ pdfBytes, pageNumber, isActive, isBookmarked, onSelect }) => {
  const hostRef = useRef<HTMLButtonElement | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let active = true;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          renderPageThumbnail(pdfBytes, pageNumber, 130)
            .then((url) => {
              if (active) setThumbUrl(url);
            })
            .catch(() => {});
        }
      },
      { rootMargin: '200px' }
    );
    obs.observe(el);
    return () => {
      active = false;
      obs.disconnect();
    };
  }, [pdfBytes, pageNumber]);

  return (
    <button
      ref={hostRef}
      type="button"
      onClick={() => onSelect(pageNumber)}
      className={`rounded-xl p-1.5 border-2 text-left transition-all ${
        isActive
          ? 'border-[#2563EB] bg-[#2563EB]/10 shadow-md'
          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70'
      }`}
    >
      <div className="aspect-[3/4] rounded-lg bg-white overflow-hidden relative flex items-center justify-center">
        {thumbUrl ? (
          <img src={thumbUrl} alt={`P${pageNumber}`} className="w-full h-full object-contain" />
        ) : (
          <span className="text-[11px] font-mono-nums text-slate-400">{pageNumber}</span>
        )}
        {isBookmarked && (
          <span className="absolute top-1 right-1 p-0.5 rounded bg-[#2563EB] text-white">
            <Bookmark className="w-2.5 h-2.5 fill-current" />
          </span>
        )}
      </div>
      <p className="mt-1 text-center text-[11px] font-mono-nums font-bold text-slate-700 dark:text-slate-200">
        {pageNumber}
      </p>
    </button>
  );
});

const LazyPageCanvas: React.FC<{
  pdfBytes: ArrayBuffer;
  pageNumber: number;
  scale: number;
  renderScale: number;
  rotation: number;
  readingMode: ReadingMode;
  textSelectEnabled: boolean;
  searchQuery: string;
  formFillMode: boolean;
  pageFormFields: PdfFormFieldDescriptor[];
  formValues: Record<string, { value: string; checked: boolean }>;
  onFormValueChange: (name: string, patch: { value?: string; checked?: boolean }) => void;
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
    readingMode,
    textSelectEnabled,
    searchQuery,
    formFillMode,
    pageFormFields,
    formValues,
    onFormValueChange,
    isBookmarked,
    defaultDims,
    shouldRender,
    registerPageRef,
  }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [rendering, setRendering] = useState(shouldRender);
    const [hasRendered, setHasRendered] = useState(false);
    const [dims, setDims] = useState<{ width: number; height: number }>(defaultDims);
    const [textBoxes, setTextBoxes] = useState<ExtractedTextRun[]>([]);

    useEffect(() => {
      setDims(defaultDims);
    }, [defaultDims.width, defaultDims.height]);

    useEffect(() => {
      setHasRendered(false);
      setTextBoxes([]);
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

    const needTextBoxes = shouldRender && (textSelectEnabled || searchQuery.trim().length > 0);
    useEffect(() => {
      if (!needTextBoxes) return;
      let active = true;
      extractPageTextBoxes(pdfBytes, pageNumber, rotation)
        .then((runs) => {
          if (active) setTextBoxes(runs);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, [needTextBoxes, pdfBytes, pageNumber, rotation]);

    const searchHighlightRects = useMemo(() => {
      const q = searchQuery.trim().toLowerCase();
      if (!q || textBoxes.length === 0) return [];
      const rects: Array<{ id: string; left: number; top: number; width: number; height: number }> = [];
      for (const box of textBoxes) {
        const lower = box.str.toLowerCase();
        let idx = lower.indexOf(q);
        while (idx !== -1) {
          const totalLen = Math.max(1, box.str.length);
          const startRatio = idx / totalLen;
          const lenRatio = q.length / totalLen;
          rects.push({
            id: `${box.id}_${idx}`,
            left: (box.x + box.width * startRatio) * scale,
            top: box.y * scale,
            width: Math.max(8, box.width * lenRatio * scale),
            height: Math.max(10, box.height * scale),
          });
          idx = lower.indexOf(q, idx + q.length);
        }
      }
      return rects;
    }, [searchQuery, textBoxes, scale]);

    const boxW = Math.max(120, Math.floor(dims.width * scale));
    const boxH = Math.max(160, Math.floor(dims.height * scale));
    const canvasFilter =
      readingMode === 'sepia'
        ? 'sepia(0.32) brightness(0.95) contrast(0.97)'
        : readingMode === 'night'
        ? 'invert(0.9) hue-rotate(180deg) contrast(0.94)'
        : undefined;

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
          <div className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-[#2563EB] text-white shadow pointer-events-none">
            <Bookmark className="w-3.5 h-3.5 fill-current" />
          </div>
        )}
        {shouldRender && (
          <canvas
            ref={canvasRef}
            style={canvasFilter ? { filter: canvasFilter } : undefined}
            className="block w-full h-full"
          />
        )}

        {/* Visual Search Match Highlights */}
        {searchHighlightRects.length > 0 && (
          <div className="absolute inset-0 pointer-events-none z-10">
            {searchHighlightRects.map((r) => (
              <div
                key={r.id}
                style={{
                  left: r.left,
                  top: r.top,
                  width: r.width,
                  height: r.height,
                }}
                className="absolute bg-amber-300/45 ring-1 ring-amber-500/80 rounded-[2px]"
              />
            ))}
          </div>
        )}

        {/* Direct Text Selection Overlay */}
        {textSelectEnabled && shouldRender && textBoxes.length > 0 && (
          <div
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            className="absolute inset-0 z-20 overflow-hidden select-text cursor-text"
          >
            {textBoxes.map((box) => (
              <span
                key={box.id}
                style={{
                  left: box.x * scale,
                  top: box.y * scale,
                  fontSize: Math.max(6, box.fontSize * scale),
                  lineHeight: 1.05,
                  width: Math.max(8, box.width * scale),
                  height: Math.max(8, box.height * scale),
                }}
                className="absolute whitespace-pre text-transparent selection:bg-blue-500/35 selection:text-transparent"
              >
                {box.str}
              </span>
            ))}
          </div>
        )}

        {/* Interactive AcroForm Fields Overlay */}
        {formFillMode && shouldRender && pageFormFields.length > 0 && (
          <div className="absolute inset-0 z-30 pointer-events-none">
            {pageFormFields.map((field, idx) => {
              const val = formValues[field.name] ?? {
                value: field.value,
                checked: field.checked,
              };
              const style: React.CSSProperties = {
                left: field.x * scale,
                top: field.y * scale,
                width: Math.max(16, field.width * scale),
                height: Math.max(16, field.height * scale),
              };
              if (field.kind === 'checkbox') {
                return (
                  <input
                    key={`${field.name}_${idx}`}
                    type="checkbox"
                    checked={Boolean(val.checked)}
                    onChange={(e) =>
                      onFormValueChange(field.name, {
                        checked: e.target.checked,
                        value: e.target.checked ? 'true' : 'false',
                      })
                    }
                    title={field.name}
                    style={style}
                    className="pointer-events-auto absolute accent-[#2563EB] cursor-pointer ring-2 ring-[#2563EB]/60 rounded bg-white/80"
                  />
                );
              }
              if (field.kind === 'dropdown' || field.kind === 'radio') {
                return (
                  <select
                    key={`${field.name}_${idx}`}
                    value={val.value}
                    onChange={(e) => onFormValueChange(field.name, { value: e.target.value })}
                    title={field.name}
                    style={{ ...style, fontSize: Math.max(10, Math.min(14, field.height * scale * 0.65)) }}
                    className="pointer-events-auto absolute px-1 rounded border-2 border-[#2563EB]/80 bg-blue-50/90 text-slate-900 focus:outline-none"
                  >
                    <option value="">--</option>
                    {(field.options || []).map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                );
              }
              return (
                <input
                  key={`${field.name}_${idx}`}
                  type="text"
                  value={val.value}
                  onChange={(e) => onFormValueChange(field.name, { value: e.target.value })}
                  placeholder={field.name}
                  title={field.name}
                  style={{ ...style, fontSize: Math.max(10, Math.min(14, field.height * scale * 0.65)) }}
                  className="pointer-events-auto absolute px-1.5 rounded border-2 border-[#2563EB]/80 bg-blue-50/90 text-slate-900 focus:outline-none focus:bg-white"
                />
              );
            })}
          </div>
        )}
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
  const initialPage = Math.max(1, Math.min(doc.pageCount, doc.lastReadPage || 1));
  const [viewMode, setViewMode] = useState<'continuous' | 'single'>(defaultViewMode);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [pageJumpInput, setPageJumpInput] = useState(String(initialPage));
  const [scale, setScale] = useState<number>(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return w < 640 ? Math.max(0.55, Math.min(1.0, (w - 32) / 595)) : 1.05;
  });
  const [renderScale, setRenderScale] = useState(scale);
  const [extraRotation, setExtraRotation] = useState(0);
  const [readingMode, setReadingMode] = useState<ReadingMode>('normal');
  const [textSelectEnabled, setTextSelectEnabled] = useState(false);
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
  const [visiblePages, setVisiblePages] = useState<Set<number>>(
    () => new Set([1, 2, initialPage, Math.min(doc.pageCount, initialPage + 1)])
  );

  // Outline & Thumbnail Drawer
  const [showNavDrawer, setShowNavDrawer] = useState(false);
  const [navDrawerTab, setNavDrawerTab] = useState<'thumbs' | 'outline'>('thumbs');
  const [outlineEntries, setOutlineEntries] = useState<PdfOutlineEntry[]>([]);
  const [outlineLoaded, setOutlineLoaded] = useState(false);

  // AcroForm interactive form filling
  const [formFields, setFormFields] = useState<PdfFormFieldDescriptor[]>([]);
  const [formFillMode, setFormFillMode] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, { value: string; checked: boolean }>>({});
  const [showFormListModal, setShowFormListModal] = useState(false);
  const [savingForm, setSavingForm] = useState(false);

  const viewerRootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const latestDocRef = useRef(doc);
  latestDocRef.current = doc;
  const latestPageRef = useRef(currentPage);
  latestPageRef.current = currentPage;
  const didInitialJumpRef = useRef(false);

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
    dragPan: textSelectEnabled || formFillMode ? false : 'mouse',
    doubleTapZoom: !textSelectEnabled && !formFillMode,
  });

  const registerPageRef = useCallback((pNum: number, el: HTMLDivElement | null) => {
    if (el) {
      pageRefs.current.set(pNum, el);
    } else {
      pageRefs.current.delete(pNum);
    }
  }, []);

  // Jump to lastReadPage on initial mount in continuous mode
  useEffect(() => {
    if (didInitialJumpRef.current || !scrollRootEl || viewMode !== 'continuous') return;
    didInitialJumpRef.current = true;
    if (initialPage > 1) {
      requestAnimationFrame(() => {
        const el = pageRefs.current.get(initialPage);
        el?.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    }
  }, [scrollRootEl, viewMode, initialPage]);

  // Persist lastReadPage debounced when page changes
  useEffect(() => {
    if (currentPage === (doc.lastReadPage || 1)) return;
    const id = setTimeout(() => {
      void onUpdateDoc({ ...latestDocRef.current, lastReadPage: currentPage });
    }, 1200);
    return () => clearTimeout(id);
  }, [currentPage, doc.id]);

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

  // Read page 1 dimensions once and detect interactive form fields
  useEffect(() => {
    let active = true;
    setPageTexts([]);
    setOutlineLoaded(false);
    setOutlineEntries([]);
    getPdfPageDimension(doc.pdfBytes, 1, extraRotation)
      .then((dims) => {
        if (active) setDefaultPageDims(dims);
      })
      .catch(() => {});

    extractPdfFormFields(doc.pdfBytes, extraRotation)
      .then((fields) => {
        if (!active) return;
        setFormFields(fields);
        const initVals: Record<string, { value: string; checked: boolean }> = {};
        for (const f of fields) {
          initVals[f.name] = { value: f.value, checked: f.checked };
        }
        setFormValues(initVals);
      })
      .catch(() => {
        if (active) setFormFields([]);
      });

    return () => {
      active = false;
    };
  }, [doc.id, doc.pdfBytes, extraRotation]);

  // Lazy-load PDF Outline when navigation drawer opens
  useEffect(() => {
    if (!showNavDrawer || outlineLoaded) return;
    let active = true;
    extractPdfOutline(doc.pdfBytes)
      .then((entries) => {
        if (active) {
          setOutlineEntries(entries);
          setOutlineLoaded(true);
        }
      })
      .catch(() => {
        if (active) setOutlineLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [showNavDrawer, outlineLoaded, doc.pdfBytes]);

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
      if (showTextModal || showNavDrawer || showFormListModal) return;
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
  }, [showTextModal, showNavDrawer, showFormListModal, isFullscreen, viewMode, currentPage, doc.pageCount, jumpToPage]);

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

  const handleClose = () => {
    if (latestPageRef.current !== (latestDocRef.current.lastReadPage || 1)) {
      void onUpdateDoc({ ...latestDocRef.current, lastReadPage: latestPageRef.current });
    }
    onClose();
  };

  const cycleReadingMode = () => {
    setReadingMode((m) => (m === 'normal' ? 'sepia' : m === 'sepia' ? 'night' : 'normal'));
  };

  const handleFormValueChange = useCallback(
    (name: string, patch: { value?: string; checked?: boolean }) => {
      setFormValues((prev) => {
        const cur = prev[name] || { value: '', checked: false };
        return {
          ...prev,
          [name]: {
            value: patch.value !== undefined ? patch.value : cur.value,
            checked: patch.checked !== undefined ? patch.checked : cur.checked,
          },
        };
      });
    },
    []
  );

  const handleSaveFilledForm = async (flatten: boolean) => {
    setSavingForm(true);
    try {
      const filledBytes = await applyPdfFormFieldValues(doc.pdfBytes, formValues, flatten);
      const thumb = await renderPageThumbnail(filledBytes, 1, 200).catch(() => doc.thumbnailDataUrl);
      const now = Date.now();
      await onUpdateDoc({
        ...doc,
        origin: 'edited',
        updatedAt: now,
        lastReadPage: currentPage,
        sizeBytes: filledBytes.byteLength,
        thumbnailDataUrl: thumb,
        pdfBytes: cloneBuffer(filledBytes),
        versions: [
          {
            id: `ver_${now}`,
            timestamp: now,
            note: flatten ? 'Saved flattened PDF form' : 'Updated fillable form fields',
            sizeBytes: filledBytes.byteLength,
            pdfBytes: cloneBuffer(filledBytes),
          },
          ...doc.versions,
        ],
      });
      setFormFillMode(false);
      setShowFormListModal(false);
      emitAppToast({
        message:
          language === 'bn'
            ? 'পূরণকৃত ফর্ম সফলভাবে সেভ হয়েছে।'
            : 'Filled PDF form saved to Vault.',
        variant: 'success',
      });
    } catch (err) {
      emitAppToast({
        message: err instanceof Error ? err.message : 'Failed to save form values.',
        variant: 'error',
      });
    } finally {
      setSavingForm(false);
    }
  };

  const uniqueFieldDescriptors = useMemo(() => {
    const map = new Map<string, PdfFormFieldDescriptor>();
    for (const f of formFields) {
      if (!map.has(f.name)) map.set(f.name, f);
    }
    return Array.from(map.values());
  }, [formFields]);

  return (
    <div
      ref={viewerRootRef}
      style={{ touchAction: 'pan-x pan-y' }}
      className={`fixed inset-0 z-40 flex flex-col ${
        readingMode === 'night'
          ? 'bg-[#090D16]'
          : readingMode === 'sepia'
          ? 'bg-[#EDE3D2]'
          : 'bg-[#F1F5F9] dark:bg-[#0B1120]'
      }`}
    >
      {/* Top Bar */}
      {!isFullscreen && (
        <header className="flex items-center justify-between gap-2 px-3 py-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={handleClose}
              aria-label="Back"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-[#142B4A] dark:text-white truncate max-w-[160px] sm:max-w-xs">
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
              onClick={() => setShowNavDrawer(true)}
              aria-label={t.viewer.outline}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <ListTree className="w-5 h-5" />
            </button>
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
            placeholder={
              indexingSearch
                ? language === 'bn'
                  ? 'সার্চের জন্য পৃষ্ঠা তৈরি হচ্ছে...'
                  : 'Indexing pages for search...'
                : t.viewer.searchInPdf
            }
            autoFocus
            className="flex-1 min-h-[38px] bg-transparent text-sm text-slate-900 dark:text-white focus:outline-none"
          />
          {searchQuery && (
            <span className="text-xs font-mono-nums text-slate-500 whitespace-nowrap">
              {searchMatches.length}{' '}
              {language === 'bn' ? 'পৃষ্ঠায়' : searchMatches.length === 1 ? 'page' : 'pages'}
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
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/85 dark:bg-slate-900/85 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar shrink-0">
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

          {/* Eye-Comfort Reading Mode */}
          <button
            onClick={cycleReadingMode}
            className={`px-2.5 min-h-[36px] rounded-lg text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0 ${
              readingMode === 'sepia'
                ? 'bg-amber-100 text-amber-900 border border-amber-300'
                : readingMode === 'night'
                ? 'bg-slate-800 text-cyan-300 border border-cyan-700'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
            }`}
          >
            {readingMode === 'night' ? (
              <Moon className="w-3.5 h-3.5" />
            ) : readingMode === 'sepia' ? (
              <BookOpen className="w-3.5 h-3.5" />
            ) : (
              <Sun className="w-3.5 h-3.5" />
            )}
            <span>
              {readingMode === 'night'
                ? t.viewer.nightMode
                : readingMode === 'sepia'
                ? t.viewer.sepiaMode
                : t.viewer.normalMode}
            </span>
          </button>

          {/* Direct Text Selection Toggle */}
          <button
            onClick={() => setTextSelectEnabled((v) => !v)}
            className={`px-2.5 min-h-[36px] rounded-lg text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0 ${
              textSelectEnabled
                ? 'bg-[#2563EB] text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
            }`}
          >
            <TextCursorInput className="w-3.5 h-3.5" />
            <span>{t.viewer.textSelect}</span>
          </button>

          {/* Fillable AcroForm Trigger when detected */}
          {formFields.length > 0 && (
            <button
              onClick={() => setFormFillMode((v) => !v)}
              className={`px-2.5 min-h-[36px] rounded-lg text-xs font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 ${
                formFillMode
                  ? 'bg-emerald-600 text-white'
                  : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700'
              }`}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              <span>
                {t.viewer.forms} ({uniqueFieldDescriptors.length})
              </span>
            </button>
          )}

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

      {/* AcroForm Active Banner */}
      {!isFullscreen && formFillMode && formFields.length > 0 && (
        <div className="px-3 py-2 bg-emerald-50 dark:bg-emerald-950/50 border-b border-emerald-200 dark:border-emerald-800 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-emerald-800 dark:text-emerald-200 flex items-center gap-1.5">
            <FileCheck2 className="w-4 h-4 shrink-0" />
            {language === 'bn'
              ? `ফর্ম পূরণ চালু আছে (${uniqueFieldDescriptors.length}টি ফিল্ড)`
              : `Form Fill Active (${uniqueFieldDescriptors.length} fields)`}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowFormListModal(true)}
              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 font-semibold text-slate-700 dark:text-slate-200"
            >
              {language === 'bn' ? 'তালিকায় দেখুন' : 'Field List'}
            </button>
            <button
              type="button"
              disabled={savingForm}
              onClick={() => void handleSaveFilledForm(false)}
              className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold disabled:opacity-50"
            >
              {t.viewer.saveForm}
            </button>
            <button
              type="button"
              disabled={savingForm}
              onClick={() => void handleSaveFilledForm(true)}
              className="px-2.5 py-1.5 rounded-lg bg-[#142B4A] text-white font-semibold disabled:opacity-50"
            >
              {t.viewer.saveFormFlat}
            </button>
          </div>
        </div>
      )}

      {/* Bookmarked Pages Quick Jump Bar */}
      {!isFullscreen && bookmarks.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar shrink-0">
          <span className="text-[11px] font-semibold text-slate-500 flex items-center gap-1 shrink-0">
            <Bookmark className="w-3 h-3 text-[#2563EB] fill-current" />
            {language === 'bn' ? 'বুকমার্ক:' : 'Bookmarks:'}
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
        className={`flex-1 overflow-auto ${textSelectEnabled ? 'cursor-text' : 'cursor-grab'}`}
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
              readingMode={readingMode}
              textSelectEnabled={textSelectEnabled}
              searchQuery={searchQuery}
              formFillMode={formFillMode}
              pageFormFields={formFields.filter((f) => f.pageNumber === currentPage)}
              formValues={formValues}
              onFormValueChange={handleFormValueChange}
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
                readingMode={readingMode}
                textSelectEnabled={textSelectEnabled}
                searchQuery={searchQuery}
                formFillMode={formFillMode}
                pageFormFields={formFields.filter((f) => f.pageNumber === pNum)}
                formValues={formValues}
                onFormValueChange={handleFormValueChange}
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

      {/* Outline & Thumbnail Grid Drawer */}
      {showNavDrawer && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-sm"
          onClick={() => setShowNavDrawer(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 flex flex-col shadow-2xl"
          >
            <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => setNavDrawerTab('thumbs')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    navDrawerTab === 'thumbs'
                      ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                      : 'text-slate-500'
                  }`}
                >
                  {t.viewer.thumbnails}
                </button>
                <button
                  type="button"
                  onClick={() => setNavDrawerTab('outline')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    navDrawerTab === 'outline'
                      ? 'bg-white dark:bg-slate-900 text-[#142B4A] dark:text-white shadow-sm'
                      : 'text-slate-500'
                  }`}
                >
                  {t.viewer.outlineTab}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowNavDrawer(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3.5">
              {navDrawerTab === 'thumbs' ? (
                <div className="grid grid-cols-3 gap-2.5">
                  {Array.from({ length: doc.pageCount }, (_, i) => i + 1).map((pNum) => (
                    <ThumbGridTile
                      key={pNum}
                      pdfBytes={doc.pdfBytes}
                      pageNumber={pNum}
                      isActive={currentPage === pNum}
                      isBookmarked={bookmarks.includes(pNum)}
                      onSelect={(p) => {
                        setShowNavDrawer(false);
                        jumpToPage(p);
                      }}
                    />
                  ))}
                </div>
              ) : outlineEntries.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-10">{t.viewer.noOutline}</p>
              ) : (
                <div className="space-y-1">
                  {outlineEntries.map((item, idx) => (
                    <button
                      key={`${item.title}_${idx}`}
                      type="button"
                      onClick={() => {
                        setShowNavDrawer(false);
                        jumpToPage(item.pageNumber);
                      }}
                      style={{ paddingLeft: `${10 + item.level * 14}px` }}
                      className="w-full py-2 pr-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-left flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate font-medium text-slate-800 dark:text-slate-200">
                        {item.title}
                      </span>
                      <span className="font-mono-nums text-[11px] text-slate-400 shrink-0">
                        P{item.pageNumber}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mobile-Friendly Form Field List Modal */}
      {showFormListModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm"
          onClick={() => setShowFormListModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl max-h-[82vh] flex flex-col space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {t.viewer.forms}
              </h3>
              <button
                onClick={() => setShowFormListModal(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              {uniqueFieldDescriptors.map((field) => {
                const val = formValues[field.name] ?? { value: field.value, checked: field.checked };
                return (
                  <div
                    key={field.name}
                    className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 space-y-1 text-xs"
                  >
                    <label className="font-semibold text-slate-700 dark:text-slate-200 flex items-center justify-between">
                      <span className="truncate">{field.name}</span>
                      <span className="text-[10px] font-mono-nums text-slate-400">
                        P{field.pageNumber}
                      </span>
                    </label>
                    {field.kind === 'checkbox' ? (
                      <label className="flex items-center gap-2 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={Boolean(val.checked)}
                          onChange={(e) =>
                            handleFormValueChange(field.name, {
                              checked: e.target.checked,
                              value: e.target.checked ? 'true' : 'false',
                            })
                          }
                          className="w-4 h-4 accent-[#2563EB]"
                        />
                        <span>{val.checked ? 'Checked' : 'Unchecked'}</span>
                      </label>
                    ) : field.kind === 'dropdown' || field.kind === 'radio' ? (
                      <select
                        value={val.value}
                        onChange={(e) => handleFormValueChange(field.name, { value: e.target.value })}
                        className="w-full min-h-[40px] px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        <option value="">-- Select --</option>
                        {(field.options || []).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={val.value}
                        onChange={(e) => handleFormValueChange(field.name, { value: e.target.value })}
                        className="w-full min-h-[40px] px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                disabled={savingForm}
                onClick={() => void handleSaveFilledForm(false)}
                className="min-h-[44px] rounded-xl bg-emerald-600 text-white text-xs font-semibold"
              >
                {t.viewer.saveForm}
              </button>
              <button
                type="button"
                disabled={savingForm}
                onClick={() => void handleSaveFilledForm(true)}
                className="min-h-[44px] rounded-xl bg-[#142B4A] text-white text-xs font-semibold"
              >
                {t.viewer.saveFormFlat}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Extract & Copy Text Sheet */}
      {showTextModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                {t.viewer.page} {currentPage}
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
              value={
                currentPageText ||
                (language === 'bn'
                  ? 'এই পৃষ্ঠায় সিলেক্টযোগ্য টেক্সট পাওয়া যায়নি। OCR ব্যবহার করুন।'
                  : 'No selectable embedded text on this page. Try running OCR.')
              }
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
              {copiedNotice
                ? language === 'bn'
                  ? 'কপি হয়েছে'
                  : 'Copied to Clipboard'
                : t.viewer.copyText}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
