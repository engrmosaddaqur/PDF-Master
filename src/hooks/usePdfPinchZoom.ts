import { useEffect, useLayoutEffect, useRef } from 'react';
import type React from 'react';

interface UsePdfPinchZoomOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  scrollRef?: React.RefObject<HTMLElement | null>;
  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  minScale?: number;
  maxScale?: number;
  /** 'mouse' = desktop grab-pan; true/'all' = mouse + 1-finger touch drag pan */
  dragPan?: boolean | 'mouse' | 'all';
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
 * - Two-finger pinch zoom anchored tightly around finger midpoint (via useLayoutEffect).
 * - Seamless 2-finger -> 1-finger pan handoff without losing the active touch gesture.
 * - Sub-pixel floating-point scroll accumulators + smooth kinetic inertia coasting.
 * - Mouse drag-to-pan (when dragPan is true, Spacebar is held, or middle mouse button).
 * - Ctrl/Cmd+Wheel zooms only the PDF around cursor; Shift+Wheel scrolls horizontally.
 */
export function usePdfPinchZoom({
  rootRef,
  scrollRef,
  scale,
  setScale,
  minScale = 0.35,
  maxScale = 3.5,
  dragPan = false,
}: UsePdfPinchZoomOptions) {
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const dragPanRef = useRef(dragPan);
  dragPanRef.current = dragPan;

  const pinchRef = useRef<PinchState | null>(null);
  const pendingAnchorRef = useRef<PendingZoomAnchor | null>(null);
  const virtualScrollRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const spaceHeldRef = useRef(false);
  const momentumRafRef = useRef<number | null>(null);

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

  // Synchronously preserve focal point right after React updates wrapper dimensions
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const scroller = scrollRef?.current;
    if (!anchor || !scroller) return;
    pendingAnchorRef.current = null;

    const ratio = scale / Math.max(0.01, anchor.prevScale);
    const newCenter = scroller.scrollWidth / 2;
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const targetLeft = Math.max(0, Math.min(maxLeft, newCenter + anchor.dxFromCenter * ratio - anchor.viewX));
    const targetTop = Math.max(0, Math.min(maxTop, anchor.docY * ratio - anchor.viewY));

    virtualScrollRef.current = { left: targetLeft, top: targetTop };
    scroller.scrollLeft = targetLeft;
    scroller.scrollTop = targetTop;
  }, [scale, scrollRef]);

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

      let curVx = vx; // px per ms
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
    };

    const onWheel = (e: WheelEvent) => {
      cancelMomentum();
      syncVirtualFromDom();
      if (e.ctrlKey || e.metaKey) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        const prev = scaleRef.current;
        const delta = Math.abs(e.deltaY) > 30 ? (e.deltaY < 0 ? 0.12 : -0.12) : -e.deltaY * 0.004;
        const next = clampScale(prev + delta);
        if (next !== prev) {
          recordAnchor(e.clientX, e.clientY, prev);
          setScale(next);
        }
        return;
      }
      if (e.shiftKey && e.deltaY !== 0 && Math.abs(e.deltaX) < 1) {
        const scroller = scrollRef?.current;
        if (scroller && scroller.scrollWidth > scroller.clientWidth) {
          if (e.cancelable) e.preventDefault();
          applyPanDelta(e.deltaY, 0);
        }
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      cancelMomentum();
      syncVirtualFromDom();
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        startPinch(e.touches);
        return;
      }
      // Single-finger drag pan inside custom Hand/Pan mode
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
          const prev = scaleRef.current;
          const next = clampScale(snap.startScale * ratio);

          const panDx = snap.lastMidX - mid.x;
          const panDy = snap.lastMidY - mid.y;
          const dt = Math.max(4, now - panSessionRef.current.lastTime);
          panSessionRef.current.vx = panSessionRef.current.vx * 0.4 + (panDx / dt) * 0.6;
          panSessionRef.current.vy = panSessionRef.current.vy * 0.4 + (panDy / dt) * 0.6;
          panSessionRef.current.lastTime = now;

          snap.lastMidX = mid.x;
          snap.lastMidY = mid.y;

          if (panDx !== 0 || panDy !== 0) {
            applyPanDelta(panDx, panDy);
          }

          if (Math.abs(next - prev) >= 0.004) {
            recordAnchor(mid.x, mid.y, prev);
            setScale(next);
          }
        }
        return;
      }

      // Single-finger continued pan (either seamless post-pinch handoff OR dragPan touch mode)
      if (e.touches.length === 1 && panSessionRef.current.active && panSessionRef.current.mode === 'touch') {
        const scroller = scrollRef?.current;
        if (!scroller) return;
        // Only intercept when content actually overflows or we're handing off from a pinch
        if (scroller.scrollWidth > scroller.clientWidth || scroller.scrollHeight > scroller.clientHeight) {
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
        // Seamless handoff from 2-finger pinch to 1-finger pan so panning never stalls mid-gesture
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
        const wasCustomPanning = Boolean(pinchRef.current || panSessionRef.current.active);
        const { vx, vy, lastTime } = panSessionRef.current;
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

    // Mouse drag-to-pan (middle mouse button anywhere, Space+drag, or primary drag when dragPan=true)
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
      root.removeEventListener('wheel', onWheel);
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
  }, [rootRef, scrollRef, setScale, minScale, maxScale]);
}
