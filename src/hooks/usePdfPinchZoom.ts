import { useEffect, useRef } from 'react';
import type React from 'react';

interface UsePdfPinchZoomOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  scrollRef?: React.RefObject<HTMLElement | null>;
  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  minScale?: number;
  maxScale?: number;
}

interface PinchState {
  startDist: number;
  startScale: number;
  contentX: number;
  contentY: number;
}

/**
 * Intercepts Ctrl/Cmd+Wheel and two-finger pinch+pan gestures inside PDF workspaces
 * so ONLY the PDF document zooms around the fingers' midpoint and pans freely
 * in every direction, never zooming the surrounding screen or browser UI.
 */
export function usePdfPinchZoom({
  rootRef,
  scrollRef,
  scale,
  setScale,
  minScale = 0.35,
  maxScale = 3.5,
}: UsePdfPinchZoomOptions) {
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const pinchRef = useRef<PinchState | null>(null);
  const rafRef = useRef<number | null>(null);

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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

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
      const dist = getDist(t);
      const mid = getMid(t);
      const scroller = scrollRef?.current;
      let contentX = 0;
      let contentY = 0;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        contentX = scroller.scrollLeft + (mid.x - rect.left);
        contentY = scroller.scrollTop + (mid.y - rect.top);
      }
      pinchRef.current = {
        startDist: dist,
        startScale: scaleRef.current,
        contentX,
        contentY,
      };
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const step = e.deltaY < 0 ? 0.1 : -0.1;
        setScale((s) =>
          Math.max(minScale, Math.min(maxScale, Number((s + step).toFixed(2))))
        );
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        startPinch(e.touches);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
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
          const next = Math.max(
            minScale,
            Math.min(maxScale, Number((snap.startScale * ratio).toFixed(2)))
          );
          const scaleFactor = next / snap.startScale;

          setScale(next);

          const scroller = scrollRef?.current;
          if (scroller) {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
              const rect = scroller.getBoundingClientRect();
              scroller.scrollLeft = Math.max(0, snap.contentX * scaleFactor - (mid.x - rect.left));
              scroller.scrollTop = Math.max(0, snap.contentY * scaleFactor - (mid.y - rect.top));
            });
          }
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchRef.current = null;
      }
    };

    const onGesture = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('touchstart', onTouchStart, { passive: false });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    root.addEventListener('touchcancel', onTouchEnd, { passive: true });
    root.addEventListener('gesturestart', onGesture, { passive: false });
    root.addEventListener('gesturechange', onGesture, { passive: false });
    root.addEventListener('gestureend', onGesture, { passive: false });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchEnd);
      root.removeEventListener('gesturestart', onGesture);
      root.removeEventListener('gesturechange', onGesture);
      root.removeEventListener('gestureend', onGesture);
    };
  }, [rootRef, scrollRef, setScale, minScale, maxScale]);
}
