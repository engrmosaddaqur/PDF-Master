import { PDFDocument } from 'pdf-lib';

export interface Point2D {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export type ScanFilter = 'color' | 'magic' | 'grayscale' | 'bw';

/**
 * Estimates document boundary quadrilateral using luminance + Sobel edge energy
 * on a downscaled preview canvas. Falls back cleanly to slight inset margins.
 */
export function detectDocumentBounds(sourceCanvas: HTMLCanvasElement): [Point2D, Point2D, Point2D, Point2D] {
  const w = 160;
  const h = Math.max(80, Math.round((sourceCanvas.height / sourceCanvas.width) * w));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d')!;
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  let minX = w * 0.12;
  let maxX = w * 0.88;
  let minY = h * 0.1;
  let maxY = h * 0.9;

  // Compute edge strength via Sobel gradient
  const edges: Array<{ x: number; y: number; mag: number }> = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const gx =
        -gray[(y - 1) * w + (x - 1)] +
        gray[(y - 1) * w + (x + 1)] -
        2 * gray[y * w + (x - 1)] +
        2 * gray[y * w + (x + 1)] -
        gray[(y + 1) * w + (x - 1)] +
        gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] -
        2 * gray[(y - 1) * w + x] -
        gray[(y - 1) * w + (x + 1)] +
        gray[(y + 1) * w + (x - 1)] +
        2 * gray[(y + 1) * w + x] +
        gray[(y + 1) * w + (x + 1)];
      const mag = Math.hypot(gx, gy);
      if (mag > 110) {
        edges.push({ x, y, mag });
      }
    }
  }

  if (edges.length > 40) {
    // Score extreme corners (TL, TR, BR, BL) weighted by edge magnitude
    let tl = { x: minX, y: minY, score: -Infinity };
    let tr = { x: maxX, y: minY, score: -Infinity };
    let br = { x: maxX, y: maxY, score: -Infinity };
    let bl = { x: minX, y: maxY, score: -Infinity };

    for (const e of edges) {
      const sTL = (w - e.x) + (h - e.y) + e.mag * 0.05;
      const sTR = e.x + (h - e.y) + e.mag * 0.05;
      const sBR = e.x + e.y + e.mag * 0.05;
      const sBL = (w - e.x) + e.y + e.mag * 0.05;
      if (sTL > tl.score && e.x < w * 0.45 && e.y < h * 0.45) tl = { x: e.x, y: e.y, score: sTL };
      if (sTR > tr.score && e.x > w * 0.55 && e.y < h * 0.45) tr = { x: e.x, y: e.y, score: sTR };
      if (sBR > br.score && e.x > w * 0.55 && e.y > h * 0.55) br = { x: e.x, y: e.y, score: sBR };
      if (sBL > bl.score && e.x < w * 0.45 && e.y > h * 0.55) bl = { x: e.x, y: e.y, score: sBL };
    }

    return [
      { x: Math.max(0.02, Math.min(0.45, tl.x / w)), y: Math.max(0.02, Math.min(0.45, tl.y / h)) },
      { x: Math.min(0.98, Math.max(0.55, tr.x / w)), y: Math.max(0.02, Math.min(0.45, tr.y / h)) },
      { x: Math.min(0.98, Math.max(0.55, br.x / w)), y: Math.min(0.98, Math.max(0.55, br.y / h)) },
      { x: Math.max(0.02, Math.min(0.45, bl.x / w)), y: Math.min(0.98, Math.max(0.55, bl.y / h)) },
    ];
  }

  return [
    { x: 0.06, y: 0.06 },
    { x: 0.94, y: 0.06 },
    { x: 0.94, y: 0.94 },
    { x: 0.06, y: 0.94 },
  ];
}

/**
 * Solves 8x8 linear system for planar projective homography mapping destination (u,v) -> source (x,y).
 */
function solveHomography(
  srcPts: Array<[number, number]>,
  dstPts: Array<[number, number]>
): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = srcPts[i];
    const [dx, dy] = dstPts[i];
    A.push([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy]);
    b.push(sx);
    A.push([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy]);
    b.push(sy);
  }

  // Gaussian elimination with partial pivoting
  const n = 8;
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[maxRow][col])) maxRow = r;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [b[col], b[maxRow]] = [b[maxRow], b[col]];

    const pivot = A[col][col] || 1e-10;
    for (let c = col; c < n; c++) A[col][c] /= pivot;
    b[col] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      for (let c = col; c < n; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }
  return [...b, 1];
}

/**
 * Warps a 4-corner quadrilateral from sourceCanvas into a straightened rectangular document canvas.
 */
export function perspectiveWarpCanvas(
  sourceCanvas: HTMLCanvasElement,
  corners: [Point2D, Point2D, Point2D, Point2D]
): HTMLCanvasElement {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const srcPts: Array<[number, number]> = corners.map((c) => [c.x * sw, c.y * sh]);

  const topW = Math.hypot(srcPts[1][0] - srcPts[0][0], srcPts[1][1] - srcPts[0][1]);
  const botW = Math.hypot(srcPts[2][0] - srcPts[3][0], srcPts[2][1] - srcPts[3][1]);
  const leftH = Math.hypot(srcPts[3][0] - srcPts[0][0], srcPts[3][1] - srcPts[0][1]);
  const rightH = Math.hypot(srcPts[2][0] - srcPts[1][0], srcPts[2][1] - srcPts[1][1]);

  let outW = Math.round(Math.max(topW, botW));
  let outH = Math.round(Math.max(leftH, rightH));
  const maxDim = 1600;
  if (outW > maxDim || outH > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }
  outW = Math.max(200, outW);
  outH = Math.max(200, outH);

  const dstPts: Array<[number, number]> = [
    [0, 0],
    [outW - 1, 0],
    [outW - 1, outH - 1],
    [0, outH - 1],
  ];

  const H = solveHomography(srcPts, dstPts);
  const srcCtx = sourceCanvas.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, sw, sh).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d')!;
  const outImg = outCtx.createImageData(outW, outH);
  const dst = outImg.data;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denom = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / denom;
      const sy = (H[3] * x + H[4] * y + H[5]) / denom;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const outIdx = (y * outW + x) * 4;

      if (x0 >= 0 && x0 < sw - 1 && y0 >= 0 && y0 < sh - 1) {
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4;
        const i10 = i00 + 4;
        const i01 = ((y0 + 1) * sw + x0) * 4;
        const i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          const val =
            srcData[i00 + c] * (1 - fx) * (1 - fy) +
            srcData[i10 + c] * fx * (1 - fy) +
            srcData[i01 + c] * (1 - fx) * fy +
            srcData[i11 + c] * fx * fy;
          dst[outIdx + c] = Math.round(val);
        }
        dst[outIdx + 3] = 255;
      } else {
        dst[outIdx] = 255;
        dst[outIdx + 1] = 255;
        dst[outIdx + 2] = 255;
        dst[outIdx + 3] = 255;
      }
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

/**
 * Applies professional document enhancement filters (Magic Color, Grayscale, B&W Adaptive Threshold,
 * Shadow Reduction, Brightness/Contrast, and optional Sharpening).
 */
export function applyScanEnhancement(
  sourceCanvas: HTMLCanvasElement,
  opts: {
    filter: ScanFilter;
    brightness: number; // -50 .. +50
    contrast: number; // -50 .. +50
    sharpen: boolean;
    rotation: number; // 0, 90, 180, 270
  }
): string {
  const rot = ((opts.rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const w = swap ? sourceCanvas.height : sourceCanvas.width;
  const h = swap ? sourceCanvas.width : sourceCanvas.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  ctx.restore();

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const contrastFactor = (259 * (opts.contrast + 255)) / (255 * (259 - opts.contrast));

  if (opts.filter === 'bw') {
    // Adaptive integral-image local thresholding for shadow-free crisp B&W scan
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      let lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      lum = contrastFactor * (lum - 128) + 128 + opts.brightness;
      gray[i] = Math.max(0, Math.min(255, lum));
    }

    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let rowSum = 0;
      for (let x = 1; x <= w; x++) {
        rowSum += gray[(y - 1) * w + (x - 1)];
        integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
      }
    }

    const radius = Math.max(10, Math.round(Math.min(w, h) * 0.025));
    const t = 0.12;
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(w - 1, x + radius);
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum =
          integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
          integral[y1 * (w + 1) + (x2 + 1)] -
          integral[(y2 + 1) * (w + 1) + x1] +
          integral[y1 * (w + 1) + x1];
        const mean = sum / count;
        const val = gray[y * w + x] < mean * (1 - t) ? 18 : 255;
        const idx = (y * w + x) * 4;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
      }
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      if (opts.filter === 'magic') {
        // White paper background lift & shadow reduction + crisp text contrast
        r = Math.min(255, r * 1.12 + 16);
        g = Math.min(255, g * 1.12 + 16);
        b = Math.min(255, b * 1.12 + 16);
        r = 1.25 * (r - 128) + 128;
        g = 1.25 * (g - 128) + 128;
        b = 1.25 * (b - 128) + 128;
      }

      r = contrastFactor * (r - 128) + 128 + opts.brightness;
      g = contrastFactor * (g - 128) + 128 + opts.brightness;
      b = contrastFactor * (b - 128) + 128 + opts.brightness;

      if (opts.filter === 'grayscale') {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = g = b = lum;
      }

      data[i] = Math.max(0, Math.min(255, r));
      data[i + 1] = Math.max(0, Math.min(255, g));
      data[i + 2] = Math.max(0, Math.min(255, b));
    }
  }

  if (opts.sharpen) {
    const copy = new Uint8ClampedArray(data);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const val =
            5 * copy[idx + c] -
            copy[((y - 1) * w + x) * 4 + c] -
            copy[((y + 1) * w + x) * 4 + c] -
            copy[(y * w + (x - 1)) * 4 + c] -
            copy[(y * w + (x + 1)) * 4 + c];
          data[idx + c] = Math.max(0, Math.min(255, val));
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.9);
}

export async function compileScannedPagesToPdf(pageDataUrls: string[]): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (const dataUrl of pageDataUrls) {
    const base64 = dataUrl.split(',')[1];
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const img = dataUrl.includes('image/png')
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
    const widthPt = 595.28;
    const heightPt = (img.height / img.width) * widthPt;
    const page = doc.addPage([widthPt, heightPt]);
    page.drawImage(img, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  doc.setProducer('PDF MASTER Smart Document Scanner');
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
