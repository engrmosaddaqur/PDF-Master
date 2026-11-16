import { useEffect, useLayoutEffect, useRef } from 'react';
import type React from 'react';

interface UsePdfPinchZoomOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  scrollRef?: React.RefObject<HTMLElement | null>;
  /** Inner scrollable content wrapper scaled smoothly via GPU CSS transforms during active pinch/wheel */
  contentRef?: React.RefObject<HTMLElement | null>;
  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  minScale?: number;
  maxScale?: number;
  /** 'mouse' = desktop grab-pan; true/'all' = mouse + 1-finger touch drag pan */
  dragPan?: boolean | 'mouse' | 'all';
  /** Allow double-tap / double-click on viewer canvas to toggle 1x <-> 2x zoom centered at cursor */
  doubleTapZoom?: boolean;
}

interface VisualZoomSession {
  active: boolean;
  baseScale: number;
  targetScale: number;
  localX: number;
  localY: number;
  oldScrollWidth: number;
  endViewX: number;
  endViewY: number;
}

interface PinchState {
  startDist: number;
  startScale: number;
  lastMidX: number;
  lastMidY: number;
}

interface PendingZoomAnchor {
  prevScale: number;
  dxFromCenter: number;
  docY: number;
  viewX: number;
  viewY: number;
}

interface PanSession {
  active: boolean;
  mode: 'mouse' | 'touch';
  pointerId: number | null;
  lastX: number;
  lastY: number;
  vx: number;
  vy: number;
  lastTime: number;
}

function isInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, label, [role="button"], [data-no-pan="true"]'
    )
  );
}

/**
 * Provides desktop + mobile PDF zoom & unrestricted omnidirectional pan scrolling:
 * - 60/120fps GPU CSS transform preview during active 2-finger pinch & Ctrl/Cmd+Wheel/trackpad zoom
 *   (zero layout thrash across 100+ pages mid-gesture), atomically committed on settle/touchend.
 * - Multiplicative exponential wheel zoom with DOM_DELTA_LINE/PAGE normalization (smooth on every mouse/trackpad).
 * - Seamless 2-finger -> 1-finger pan handoff without losing the active touch gesture.
 * - Sub-pixel floating-point scroll accumulators + smooth kinetic inertia coasting.
 * - Optional double-tap / double-click focal zoom toggle.
 */
export function usePdfPinchZoom({
  rootRef,
  scrollRef,
  contentRef,
  scale,
  setScale,
  minScale = 0.35,
  maxScale = 3.5,
  dragPan = false,
  doubleTapZoom = false,
}: UsePdfPinchZoomOptions) {
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const dragPanRef = useRef(dragPan);
  dragPanRef.current = dragPan;

  const doubleTapRef = useRef(doubleTapZoom);
  doubleTapRef.current = doubleTapZoom;

  const pinchRef = useRef<PinchState | null>(null);
  const pendingAnchorRef = useRef<PendingZoomAnchor | null>(null);
  const virtualScrollRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const spaceHeldRef = useRef(false);
  const momentumRafRef = useRef<number | null>(null);
  const wheelSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visualZoomRef = useRef<VisualZoomSession>({
    active: false,
    baseScale: scale,
    targetScale: scale,
    localX: 0,
    localY: 0,
    oldScrollWidth: 0,
    endViewX: 0,
    endViewY: 0,
  });

  const panSessionRef = useRef<PanSession>({
    active: false,
    mode: 'mouse',
    pointerId: null,
    lastX: 0,
    lastY: 0,
    vx: 0,
    vy: 0,
    lastTime: 0,
  });

  // Lock browser-level viewport pinch while the PDF viewer/editor is open
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const prevMeta = meta?.getAttribute('content') ?? null;
    if (meta) {
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
      );
    }

    const prevHtmlTouch = document.documentElement.style.touchAction;
    const prevBodyTouch = document.body.style.touchAction;
    document.documentElement.style.touchAction = 'pan-x pan-y';
    document.body.style.touchAction = 'pan-x pan-y';

    return () => {
      if (meta && prevMeta !== null) {
        meta.setAttribute('content', prevMeta);
      }
      document.documentElement.style.touchAction = prevHtmlTouch;
      document.body.style.touchAction = prevBodyTouch;
    };
  }, []);

  // Track Spacebar for instant desktop drag-to-pan in any editor mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isInteractiveElement(e.target)) {
        spaceHeldRef.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
      }
    };
    const onBlur = () => {
      spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Synchronously clear GPU transform and preserve focal point right after React updates wrapper dimensions
  useLayoutEffect(() => {
    const contentEl = contentRef?.current;
    if (contentEl && !visualZoomRef.current.active) {
      contentEl.style.transform = '';
      contentEl.style.transformOrigin = '';
      contentEl.style.willChange = '';
    }

    const anchor = pendingAnchorRef.current;
    const scroller = scrollRef?.current;
    if (!anchor || !scroller) return;
    pendingAnchorRef.current = null;

    const ratio = scale / Math.max(0.01, anchor.prevScale);
    const newCenter = scroller.scrollWidth / 2;
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const targetLeft = Math.max(
      0,
      Math.min(maxLeft, newCenter + anchor.dxFromCenter * ratio - anchor.viewX)
    );
    const targetTop = Math.max(0, Math.min(maxTop, anchor.docY * ratio - anchor.viewY));

    virtualScrollRef.current = { left: targetLeft, top: targetTop };
    scroller.scrollLeft = targetLeft;
    scroller.scrollTop = targetTop;
  }, [scale, scrollRef, contentRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const cancelMomentum = () => {
      if (momentumRafRef.current !== null) {
        cancelAnimationFrame(momentumRafRef.current);
        momentumRafRef.current = null;
      }
    };

    const syncVirtualFromDom = () => {
      const scroller = scrollRef?.current;
      if (!scroller) return;
      virtualScrollRef.current = {
        left: scroller.scrollLeft,
        top: scroller.scrollTop,
      };
    };

    const clearVisualTransform = () => {
      const contentEl = contentRef?.current;
      if (contentEl) {
        contentEl.style.transform = '';
        contentEl.style.transformOrigin = '';
        contentEl.style.willChange = '';
      }
    };

    const applyPanDelta = (dx: number, dy: number) => {
      const scroller = scrollRef?.current;
      if (!scroller) return;
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextLeft = Math.max(0, Math.min(maxLeft, virtualScrollRef.current.left + dx));
      const nextTop = Math.max(0, Math.min(maxTop, virtualScrollRef.current.top + dy));
      virtualScrollRef.current = { left: nextLeft, top: nextTop };
      scroller.scrollLeft = nextLeft;
      scroller.scrollTop = nextTop;
    };

    const startMomentum = (vx: number, vy: number) => {
      cancelMomentum();
      const scroller = scrollRef?.current;
      if (!scroller) return;
      if (Math.hypot(vx, vy) < 0.08) return;

      let curVx = vx;
      let curVy = vy;
      let lastTs = performance.now();

      const step = (ts: number) => {
        const dt = Math.min(32, Math.max(4, ts - lastTs));
        lastTs = ts;

        const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const prevLeft = virtualScrollRef.current.left;
        const prevTop = virtualScrollRef.current.top;

        const nextLeft = Math.max(0, Math.min(maxLeft, prevLeft + curVx * dt));
        const nextTop = Math.max(0, Math.min(maxTop, prevTop + curVy * dt));

        virtualScrollRef.current = { left: nextLeft, top: nextTop };
        scroller.scrollLeft = nextLeft;
        scroller.scrollTop = nextTop;

        if (nextLeft === 0 || nextLeft === maxLeft) curVx = 0;
        if (nextTop === 0 || nextTop === maxTop) curVy = 0;

        const decay = Math.pow(0.93, dt / 16);
        curVx *= decay;
        curVy *= decay;

        if (Math.hypot(curVx, curVy) > 0.025) {
          momentumRafRef.current = requestAnimationFrame(step);
        } else {
          momentumRafRef.current = null;
        }
      };

      momentumRafRef.current = requestAnimationFrame(step);
    };

    const clampScale = (val: number) =>
      Math.max(minScale, Math.min(maxScale, Number(val.toFixed(3))));

    const recordAnchor = (clientX: number, clientY: number, prevScale: number) => {
      const scroller = scrollRef?.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const viewX = clientX - rect.left;
      const viewY = clientY - rect.top;
      const docX = virtualScrollRef.current.left + viewX;
      const docY = virtualScrollRef.current.top + viewY;
      pendingAnchorRef.current = {
        prevScale,
        dxFromCenter: docX - scroller.scrollWidth / 2,
        docY,
        viewX,
        viewY,
      };
    };

    const beginVisualZoom = (clientX: number, clientY: number) => {
      const scroller = scrollRef?.current;
      const contentEl = contentRef?.current;
      if (!scroller || !contentEl) return false;
      const rect = scroller.getBoundingClientRect();
      const viewX = clientX - rect.left;
      const viewY = clientY - rect.top;
      visualZoomRef.current = {
        active: true,
        baseScale: scaleRef.current,
        targetScale: scaleRef.current,
        localX: scroller.scrollLeft + viewX,
        localY: scroller.scrollTop + viewY,
        oldScrollWidth: scroller.scrollWidth,
        endViewX: viewX,
        endViewY: viewY,
      };
      contentEl.style.willChange = 'transform';
      contentEl.style.transformOrigin = '0 0';
      return true;
    };

    const updateVisualZoom = (nextScale: number, clientX: number, clientY: number) => {
      const scroller = scrollRef?.current;
      const contentEl = contentRef?.current;
      const vz = visualZoomRef.current;
      if (!scroller || !contentEl || !vz.active) return;

      const rect = scroller.getBoundingClientRect();
      const curViewX = clientX - rect.left;
      const curViewY = clientY - rect.top;

      // Re-anchor local point smoothly when cursor moves across viewport between wheel ticks
      const ratio = nextScale / Math.max(0.01, vz.baseScale);
      const desiredScrolledX = scroller.scrollLeft + curViewX;
      const desiredScrolledY = scroller.scrollTop + curViewY;
      const tx = desiredScrolledX - vz.localX * ratio;
      const ty = desiredScrolledY - vz.localY * ratio;

      vz.targetScale = nextScale;
      vz.endViewX = curViewX;
      vz.endViewY = curViewY;
      contentEl.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${ratio.toFixed(4)})`;
    };

    const commitVisualZoom = () => {
      if (wheelSettleTimerRef.current) {
        clearTimeout(wheelSettleTimerRef.current);
        wheelSettleTimerRef.current = null;
      }
      const vz = visualZoomRef.current;
      if (!vz.active) return;
      vz.active = false;

      const scroller = scrollRef?.current;
      const finalScale = vz.targetScale;

      if (!scroller || Math.abs(finalScale - scaleRef.current) < 0.002) {
        clearVisualTransform();
        if (scroller) {
          const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const targetLeft = Math.max(0, Math.min(maxLeft, vz.localX - vz.endViewX));
          const targetTop = Math.max(0, Math.min(maxTop, vz.localY - vz.endViewY));
          scroller.scrollLeft = targetLeft;
          scroller.scrollTop = targetTop;
          virtualScrollRef.current = { left: targetLeft, top: targetTop };
        }
        return;
      }

      pendingAnchorRef.current = {
        prevScale: vz.baseScale,
        dxFromCenter: vz.localX - vz.oldScrollWidth / 2,
        docY: vz.localY,
        viewX: vz.endViewX,
        viewY: vz.endViewY,
      };
      setScale(finalScale);
    };

    const getDist = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.max(1, Math.hypot(dx, dy));
    };

    const getMid = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    });

    const startPinch = (t: TouchList) => {
      cancelMomentum();
      if (wheelSettleTimerRef.current) {
        clearTimeout(wheelSettleTimerRef.current);
        wheelSettleTimerRef.current = null;
      }
      if (visualZoomRef.current.active) {
        commitVisualZoom();
      }
      syncVirtualFromDom();
      const dist = getDist(t);
      const mid = getMid(t);
      pinchRef.current = {
        startDist: dist,
        startScale: scaleRef.current,
        lastMidX: mid.x,
        lastMidY: mid.y,
      };
      panSessionRef.current = {
        active: false,
        mode: 'touch',
        pointerId: null,
        lastX: mid.x,
        lastY: mid.y,
        vx: 0,
        vy: 0,
        lastTime: performance.now(),
      };
      if (scrollRef?.current) {
        scrollRef.current.style.touchAction = 'none';
      }
      beginVisualZoom(mid.x, mid.y);
    };

    const onWheel = (e: WheelEvent) => {
      cancelMomentum();
      if (e.ctrlKey || e.metaKey) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();

        // Normalize DOM_DELTA_LINE (1) & DOM_DELTA_PAGE (2) -> pixels so standard & Firefox wheels both scale predictably
        const rawDeltaY =
          e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        const clampedDelta = Math.max(-180, Math.min(180, rawDeltaY));
        const factor = Math.exp(-clampedDelta * 0.0026);

        if (contentRef?.current && scrollRef?.current) {
          if (!visualZoomRef.current.active) {
            beginVisualZoom(e.clientX, e.clientY);
          } else {
            // If cursor moved significantly to a new spot on the page, rebase anchor cleanly onto current transformed view
            const scroller = scrollRef.current;
            const rect = scroller.getBoundingClientRect();
            const curViewX = e.clientX - rect.left;
            const curViewY = e.clientY - rect.top;
            if (
              Math.hypot(
                curViewX - visualZoomRef.current.endViewX,
                curViewY - visualZoomRef.current.endViewY
              ) > 18
            ) {
              const vz = visualZoomRef.current;
              const prevRatio = vz.targetScale / Math.max(0.01, vz.baseScale);
              const dX = curViewX - vz.endViewX;
              const dY = curViewY - vz.endViewY;
              vz.localX += dX / prevRatio;
              vz.localY += dY / prevRatio;
              vz.endViewX = curViewX;
              vz.endViewY = curViewY;
            }
          }
          const next = clampScale(visualZoomRef.current.targetScale * factor);
          updateVisualZoom(next, e.clientX, e.clientY);

          if (wheelSettleTimerRef.current) clearTimeout(wheelSettleTimerRef.current);
          wheelSettleTimerRef.current = setTimeout(() => {
            commitVisualZoom();
          }, 95);
        } else {
          syncVirtualFromDom();
          const prev = scaleRef.current;
          const next = clampScale(prev * factor);
          if (next !== prev) {
            recordAnchor(e.clientX, e.clientY, prev);
            setScale(next);
          }
        }
        return;
      }

      if (visualZoomRef.current.active) {
        commitVisualZoom();
      }
      syncVirtualFromDom();

      if (e.shiftKey && e.deltaY !== 0 && Math.abs(e.deltaX) < 1) {
        const scroller = scrollRef?.current;
        if (scroller && scroller.scrollWidth > scroller.clientWidth) {
          if (e.cancelable) e.preventDefault();
          const deltaPx = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
          applyPanDelta(deltaPx, 0);
        }
      }
    };

    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const triggerDoubleTapAt = (clientX: number, clientY: number) => {
      syncVirtualFromDom();
      const prev = scaleRef.current;
      const mobileBase =
        typeof window !== 'undefined' && window.innerWidth < 640
          ? Math.max(0.55, Math.min(1.0, (window.innerWidth - 32) / 595))
          : 1.05;
      const next = prev > 1.4 ? clampScale(mobileBase) : clampScale(Math.max(1.85, prev * 1.75));
      if (Math.abs(next - prev) >= 0.02) {
        recordAnchor(clientX, clientY, prev);
        setScale(next);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      cancelMomentum();
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        startPinch(e.touches);
        return;
      }

      if (e.touches.length === 1 && doubleTapRef.current && !isInteractiveElement(e.target)) {
        const now = performance.now();
        const tx = e.touches[0].clientX;
        const ty = e.touches[0].clientY;
        const scroller = scrollRef?.current;
        if (
          scroller &&
          e.target instanceof Node &&
          scroller.contains(e.target) &&
          now - lastTapTime < 280 &&
          Math.hypot(tx - lastTapX, ty - lastTapY) < 26
        ) {
          lastTapTime = 0;
          if (e.cancelable) e.preventDefault();
          triggerDoubleTapAt(tx, ty);
          return;
        }
        lastTapTime = now;
        lastTapX = tx;
        lastTapY = ty;
      }

      syncVirtualFromDom();
      const touchDragEnabled = dragPanRef.current === true || dragPanRef.current === 'all';
      if (e.touches.length === 1 && touchDragEnabled) {
        const scroller = scrollRef?.current;
        if (scroller && e.target instanceof Node && scroller.contains(e.target)) {
          if (dragPanRef.current !== 'all' && isInteractiveElement(e.target)) return;
          panSessionRef.current = {
            active: true,
            mode: 'touch',
            pointerId: null,
            lastX: e.touches[0].clientX,
            lastY: e.touches[0].clientY,
            vx: 0,
            vy: 0,
            lastTime: performance.now(),
          };
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const now = performance.now();
      if (e.touches.length >= 2) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (e.touches.length === 2) {
          if (!pinchRef.current) {
            startPinch(e.touches);
            return;
          }
          const snap = pinchRef.current;
          const dist = getDist(e.touches);
          const mid = getMid(e.touches);
          const ratio = dist / snap.startDist;
          const next = clampScale(snap.startScale * ratio);

          const panDx = snap.lastMidX - mid.x;
          const panDy = snap.lastMidY - mid.y;
          const dt = Math.max(4, now - panSessionRef.current.lastTime);
          panSessionRef.current.vx = panSessionRef.current.vx * 0.4 + (panDx / dt) * 0.6;
          panSessionRef.current.vy = panSessionRef.current.vy * 0.4 + (panDy / dt) * 0.6;
          panSessionRef.current.lastTime = now;

          snap.lastMidX = mid.x;
          snap.lastMidY = mid.y;

          if (contentRef?.current && visualZoomRef.current.active) {
            updateVisualZoom(next, mid.x, mid.y);
          } else {
            const prev = scaleRef.current;
            if (panDx !== 0 || panDy !== 0) {
              applyPanDelta(panDx, panDy);
            }
            if (Math.abs(next - prev) >= 0.004) {
              recordAnchor(mid.x, mid.y, prev);
              setScale(next);
            }
          }
        }
        return;
      }

      if (
        e.touches.length === 1 &&
        panSessionRef.current.active &&
        panSessionRef.current.mode === 'touch'
      ) {
        const scroller = scrollRef?.current;
        if (!scroller) return;
        if (
          scroller.scrollWidth > scroller.clientWidth ||
          scroller.scrollHeight > scroller.clientHeight
        ) {
          if (e.cancelable) e.preventDefault();
          const tx = e.touches[0].clientX;
          const ty = e.touches[0].clientY;
          const dx = panSessionRef.current.lastX - tx;
          const dy = panSessionRef.current.lastY - ty;
          const dt = Math.max(4, now - panSessionRef.current.lastTime);
          panSessionRef.current.vx = panSessionRef.current.vx * 0.35 + (dx / dt) * 0.65;
          panSessionRef.current.vy = panSessionRef.current.vy * 0.35 + (dy / dt) * 0.65;
          panSessionRef.current.lastX = tx;
          panSessionRef.current.lastY = ty;
          panSessionRef.current.lastTime = now;
          applyPanDelta(dx, dy);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 1 && pinchRef.current) {
        commitVisualZoom();
        pinchRef.current = null;
        syncVirtualFromDom();
        panSessionRef.current = {
          active: true,
          mode: 'touch',
          pointerId: null,
          lastX: e.touches[0].clientX,
          lastY: e.touches[0].clientY,
          vx: panSessionRef.current.vx,
          vy: panSessionRef.current.vy,
          lastTime: performance.now(),
        };
        return;
      }

      if (e.touches.length === 0) {
        const wasPinching = Boolean(pinchRef.current);
        const wasCustomPanning = Boolean(wasPinching || panSessionRef.current.active);
        const { vx, vy, lastTime } = panSessionRef.current;
        if (wasPinching) {
          commitVisualZoom();
        }
        pinchRef.current = null;
        panSessionRef.current.active = false;
        if (scrollRef?.current) {
          scrollRef.current.style.touchAction = 'pan-x pan-y';
        }
        if (wasCustomPanning && performance.now() - lastTime < 90) {
          startMomentum(vx, vy);
        }
      }
    };

    const onDblClick = (e: MouseEvent) => {
      if (!doubleTapRef.current || isInteractiveElement(e.target)) return;
      const scroller = scrollRef?.current;
      if (!scroller || !(e.target instanceof Node) || !scroller.contains(e.target)) return;
      triggerDoubleTapAt(e.clientX, e.clientY);
    };

    const onMouseDown = (e: MouseEvent) => {
      const scroller = scrollRef?.current;
      if (!scroller) return;
      if (!(e.target instanceof Node) || !scroller.contains(e.target)) return;

      const isMiddle = e.button === 1;
      const isLeftPan = e.button === 0 && (Boolean(dragPanRef.current) || spaceHeldRef.current);
      if (!isMiddle && !isLeftPan) return;
      if (!isMiddle && dragPanRef.current !== 'all' && isInteractiveElement(e.target)) return;

      const canScroll =
        scroller.scrollWidth > scroller.clientWidth + 2 ||
        scroller.scrollHeight > scroller.clientHeight + 2;
      if (!canScroll) return;

      cancelMomentum();
      if (visualZoomRef.current.active) {
        commitVisualZoom();
      }
      syncVirtualFromDom();
      e.preventDefault();
      panSessionRef.current = {
        active: true,
        mode: 'mouse',
        pointerId: null,
        lastX: e.clientX,
        lastY: e.clientY,
        vx: 0,
        vy: 0,
        lastTime: performance.now(),
      };
      scroller.style.cursor = 'grabbing';
      scroller.style.userSelect = 'none';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!panSessionRef.current.active || panSessionRef.current.mode !== 'mouse') return;
      const now = performance.now();
      const dx = panSessionRef.current.lastX - e.clientX;
      const dy = panSessionRef.current.lastY - e.clientY;
      const dt = Math.max(4, now - panSessionRef.current.lastTime);
      panSessionRef.current.vx = panSessionRef.current.vx * 0.35 + (dx / dt) * 0.65;
      panSessionRef.current.vy = panSessionRef.current.vy * 0.35 + (dy / dt) * 0.65;
      panSessionRef.current.lastX = e.clientX;
      panSessionRef.current.lastY = e.clientY;
      panSessionRef.current.lastTime = now;
      applyPanDelta(dx, dy);
    };

    const onMouseUp = () => {
      if (!panSessionRef.current.active || panSessionRef.current.mode !== 'mouse') return;
      const { vx, vy, lastTime } = panSessionRef.current;
      panSessionRef.current.active = false;
      const scroller = scrollRef?.current;
      if (scroller) {
        scroller.style.cursor = '';
        scroller.style.userSelect = '';
      }
      if (performance.now() - lastTime < 90) {
        startMomentum(vx, vy);
      }
    };

    const onGesture = (e: Event) => {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };

    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('dblclick', onDblClick);
    root.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
    root.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    root.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    root.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
    root.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    root.addEventListener('gesturestart', onGesture, { passive: false });
    root.addEventListener('gesturechange', onGesture, { passive: false });
    root.addEventListener('gestureend', onGesture, { passive: false });

    return () => {
      cancelMomentum();
      if (wheelSettleTimerRef.current) clearTimeout(wheelSettleTimerRef.current);
      clearVisualTransform();
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('dblclick', onDblClick);
      root.removeEventListener('touchstart', onTouchStart, { capture: true });
      root.removeEventListener('touchmove', onTouchMove, { capture: true });
      root.removeEventListener('touchend', onTouchEnd, { capture: true });
      root.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      root.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      root.removeEventListener('gesturestart', onGesture);
      root.removeEventListener('gesturechange', onGesture);
      root.removeEventListener('gestureend', onGesture);
    };
  }, [rootRef, scrollRef, contentRef, setScale, minScale, maxScale]);
}
