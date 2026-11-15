import { PDFDocument } from 'pdf-lib';

export interface Point2D {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export type ScanFilter = 'color' | 'magic' | 'grayscale' | 'bw';

export type EdgeSensitivity = 'standard' | 'high' | 'max';

export interface DocumentBoundsResult {
  corners: [Point2D, Point2D, Point2D, Point2D];
  confidence: number; // 0..1
  sideLocked: {
    top: boolean;
    right: boolean;
    bottom: boolean;
    left: boolean;
  };
}

interface EdgeCandidate {
  indep: number; // y for vertical lines, x for horizontal lines
  dep: number;   // x for vertical lines, y for horizontal lines
  weight: number;
}

/**
 * Fits dep = m * indep + c using deterministic consensus (RANSAC-style) + weighted least squares.
 */
function fitRobustEdgeLine(
  pts: EdgeCandidate[],
  fallbackDep: number,
  tolerance = 3.5
): { m: number; c: number; inlierRatio: number } {
  if (pts.length < 6) {
    return { m: 0, c: fallbackDep, inlierRatio: 0 };
  }

  let bestInliers: EdgeCandidate[] = [];
  let bestScore = -1;
  const n = pts.length;
  const step = Math.max(1, Math.floor(n / 10));

  for (let i = 0; i < n; i += step) {
    for (let j = Math.min(n - 1, i + step * 2); j < n; j += step) {
      const di = pts[j].indep - pts[i].indep;
      if (Math.abs(di) < 8) continue;
      const m = (pts[j].dep - pts[i].dep) / di;
      // Paper edges rarely tilt beyond ~35 degrees in normal scanning
      if (Math.abs(m) > 0.72) continue;
      const c = pts[i].dep - m * pts[i].indep;

      let score = 0;
      const inliers: EdgeCandidate[] = [];
      for (let k = 0; k < n; k++) {
        const pred = m * pts[k].indep + c;
        const err = Math.abs(pts[k].dep - pred);
        if (err <= tolerance) {
          score += pts[k].weight * (1 - err / (tolerance + 1));
          inliers.push(pts[k]);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestInliers = inliers;
      }
    }
  }

  if (bestInliers.length < 5) {
    // Median fallback
    const sorted = [...pts].sort((a, b) => a.dep - b.dep);
    const med = sorted[Math.floor(sorted.length / 2)].dep;
    return { m: 0, c: med, inlierRatio: pts.length / 80 };
  }

  // Weighted least squares refinement on inliers
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of bestInliers) {
    const w = Math.max(0.1, p.weight);
    sw += w;
    sx += w * p.indep;
    sy += w * p.dep;
    sxx += w * p.indep * p.indep;
    sxy += w * p.indep * p.dep;
  }
  const denom = sw * sxx - sx * sx;
  let m = Math.abs(denom) > 1e-6 ? (sw * sxy - sx * sy) / denom : 0;
  if (Math.abs(m) > 0.72) m = 0;
  const c = (sy - m * sx) / (sw || 1);

  return {
    m,
    c,
    inlierRatio: Math.min(1, bestInliers.length / Math.max(12, n * 0.7)),
  };
}

function intersectLines(
  vLine: { m: number; c: number }, // x = mV * y + cV
  hLine: { m: number; c: number }  // y = mH * x + cH
): { x: number; y: number } {
  const denom = 1 - vLine.m * hLine.m;
  if (Math.abs(denom) < 1e-4) {
    return { x: vLine.c, y: hLine.c };
  }
  const x = (vLine.m * hLine.c + vLine.c) / denom;
  const y = hLine.m * x + hLine.c;
  return { x, y };
}

/**
 * High-sensitivity 4-side & 4-corner document edge sensor:
 * Combines 3x3 smoothed luminance + RGB color contrast gradients, adaptive percentile
 * thresholding, outermost-side scanning (left, right, top, bottom), and RANSAC line intersection.
 */
export function detectDocumentBoundsWithConfidence(
  sourceCanvas: HTMLCanvasElement,
  sensitivity: EdgeSensitivity = 'high'
): DocumentBoundsResult {
  const w = 200;
  const h = Math.max(110, Math.min(320, Math.round((sourceCanvas.height / Math.max(1, sourceCanvas.width)) * w)));
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

  // 3x3 Gaussian-like blur suppresses interior printed text noise while preserving paper edges
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      blur[y * w + x] =
        (gray[ym * w + xm] +
          2 * gray[ym * w + x] +
          gray[ym * w + xp] +
          2 * gray[y * w + xm] +
          4 * gray[y * w + x] +
          2 * gray[y * w + xp] +
          gray[yp * w + xm] +
          2 * gray[yp * w + x] +
          gray[yp * w + xp]) /
        16;
    }
  }

  // Directional Sobel gradients combining luminance + RGB color step
  const gxArr = new Float32Array(w * h);
  const gyArr = new Float32Array(w * h);
  let sumGx = 0;
  let sumGy = 0;
  let count = 0;

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const lumGx =
        -blur[(y - 1) * w + (x - 1)] +
        blur[(y - 1) * w + (x + 1)] -
        2 * blur[y * w + (x - 1)] +
        2 * blur[y * w + (x + 1)] -
        blur[(y + 1) * w + (x - 1)] +
        blur[(y + 1) * w + (x + 1)];
      const lumGy =
        -blur[(y - 1) * w + (x - 1)] -
        2 * blur[(y - 1) * w + x] -
        blur[(y - 1) * w + (x + 1)] +
        blur[(y + 1) * w + (x - 1)] +
        2 * blur[(y + 1) * w + x] +
        blur[(y + 1) * w + (x + 1)];

      // Color contrast across edge (catches white paper vs colored desk even at similar luminance)
      const iL = (y * w + (x - 2)) * 4;
      const iR = (y * w + (x + 2)) * 4;
      const colDx =
        Math.abs(data[iR] - data[iL]) +
        Math.abs(data[iR + 1] - data[iL + 1]) +
        Math.abs(data[iR + 2] - data[iL + 2]);

      const iT = ((y - 2) * w + x) * 4;
      const iB = ((y + 2) * w + x) * 4;
      const colDy =
        Math.abs(data[iB] - data[iT]) +
        Math.abs(data[iB + 1] - data[iT + 1]) +
        Math.abs(data[iB + 2] - data[iT + 2]);

      const gxVal = Math.abs(lumGx) + colDx * 0.45;
      const gyVal = Math.abs(lumGy) + colDy * 0.45;
      gxArr[i] = gxVal;
      gyArr[i] = gyVal;
      sumGx += gxVal;
      sumGy += gyVal;
      count++;
    }
  }

  const meanGx = sumGx / Math.max(1, count);
  const meanGy = sumGy / Math.max(1, count);
  const mult = sensitivity === 'max' ? 1.05 : sensitivity === 'high' ? 1.35 : 1.75;
  const floorVal = sensitivity === 'max' ? 18 : sensitivity === 'high' ? 28 : 42;
  const threshX = Math.max(floorVal, meanGx * mult);
  const threshY = Math.max(floorVal, meanGy * mult);

  const leftPts: EdgeCandidate[] = [];
  const rightPts: EdgeCandidate[] = [];
  const topPts: EdgeCandidate[] = [];
  const bottomPts: EdgeCandidate[] = [];

  const yStart = Math.floor(h * 0.08);
  const yEnd = Math.floor(h * 0.92);
  const xLeftMax = Math.floor(w * 0.46);
  const xRightMin = Math.ceil(w * 0.54);

  // Scan rows across outer zones with inward-paper contrast bonus (prevents interior text or outer specks from stealing lock)
  for (let y = yStart; y <= yEnd; y += 2) {
    let bestL: EdgeCandidate | null = null;
    for (let x = 3; x <= xLeftMax; x++) {
      const idx = y * w + x;
      const vertDom = gxArr[idx] - gyArr[idx] * 0.18;
      if (vertDom > threshX) {
        const outLum = blur[y * w + Math.max(0, x - 3)];
        const inLum = blur[y * w + Math.min(w - 1, x + 3)];
        const paperBonus = inLum > outLum + 5 ? 1.38 : 1.0;
        const candidateScore = vertDom * paperBonus * (1.2 - (x / w) * 0.45);
        if (!bestL || candidateScore > bestL.weight) {
          bestL = { indep: y, dep: x, weight: candidateScore };
        }
      }
    }
    if (bestL) leftPts.push(bestL);

    let bestR: EdgeCandidate | null = null;
    for (let x = w - 4; x >= xRightMin; x--) {
      const idx = y * w + x;
      const vertDom = gxArr[idx] - gyArr[idx] * 0.18;
      if (vertDom > threshX) {
        const outLum = blur[y * w + Math.min(w - 1, x + 3)];
        const inLum = blur[y * w + Math.max(0, x - 3)];
        const paperBonus = inLum > outLum + 5 ? 1.38 : 1.0;
        const candidateScore = vertDom * paperBonus * (1.2 - ((w - x) / w) * 0.45);
        if (!bestR || candidateScore > bestR.weight) {
          bestR = { indep: y, dep: x, weight: candidateScore };
        }
      }
    }
    if (bestR) rightPts.push(bestR);
  }

  const xStart = Math.floor(w * 0.08);
  const xEnd = Math.floor(w * 0.92);
  const yTopMax = Math.floor(h * 0.46);
  const yBotMin = Math.ceil(h * 0.54);

  // Scan columns across outer zones for Top and Bottom physical paper boundaries
  for (let x = xStart; x <= xEnd; x += 2) {
    let bestT: EdgeCandidate | null = null;
    for (let y = 3; y <= yTopMax; y++) {
      const idx = y * w + x;
      const horizDom = gyArr[idx] - gxArr[idx] * 0.18;
      if (horizDom > threshY) {
        const outLum = blur[Math.max(0, y - 3) * w + x];
        const inLum = blur[Math.min(h - 1, y + 3) * w + x];
        const paperBonus = inLum > outLum + 5 ? 1.38 : 1.0;
        const candidateScore = horizDom * paperBonus * (1.2 - (y / h) * 0.45);
        if (!bestT || candidateScore > bestT.weight) {
          bestT = { indep: x, dep: y, weight: candidateScore };
        }
      }
    }
    if (bestT) topPts.push(bestT);

    let bestB: EdgeCandidate | null = null;
    for (let y = h - 4; y >= yBotMin; y--) {
      const idx = y * w + x;
      const horizDom = gyArr[idx] - gxArr[idx] * 0.18;
      if (horizDom > threshY) {
        const outLum = blur[Math.min(h - 1, y + 3) * w + x];
        const inLum = blur[Math.max(0, y - 3) * w + x];
        const paperBonus = inLum > outLum + 5 ? 1.38 : 1.0;
        const candidateScore = horizDom * paperBonus * (1.2 - ((h - y) / h) * 0.45);
        if (!bestB || candidateScore > bestB.weight) {
          bestB = { indep: x, dep: y, weight: candidateScore };
        }
      }
    }
    if (bestB) bottomPts.push(bestB);
  }

  const leftLine = fitRobustEdgeLine(leftPts, w * 0.06);
  const rightLine = fitRobustEdgeLine(rightPts, w * 0.94);
  const topLine = fitRobustEdgeLine(topPts, h * 0.06);
  const bottomLine = fitRobustEdgeLine(bottomPts, h * 0.94);

  const rawTL = intersectLines(leftLine, topLine);
  const rawTR = intersectLines(rightLine, topLine);
  const rawBR = intersectLines(rightLine, bottomLine);
  const rawBL = intersectLines(leftLine, bottomLine);

  const clampPt = (px: number, py: number): Point2D => ({
    x: Math.max(0.015, Math.min(0.985, px / w)),
    y: Math.max(0.015, Math.min(0.985, py / h)),
  });

  const tl = clampPt(rawTL.x, rawTL.y);
  const tr = clampPt(rawTR.x, rawTR.y);
  const br = clampPt(rawBR.x, rawBR.y);
  const bl = clampPt(rawBL.x, rawBL.y);

  const sideLocked = {
    left: leftPts.length >= 10 && leftLine.inlierRatio >= 0.3,
    right: rightPts.length >= 10 && rightLine.inlierRatio >= 0.3,
    top: topPts.length >= 10 && topLine.inlierRatio >= 0.3,
    bottom: bottomPts.length >= 10 && bottomLine.inlierRatio >= 0.3,
  };

  // Validate sane convex ordering & minimum paper size
  const validQuad =
    tr.x - tl.x >= 0.22 &&
    br.x - bl.x >= 0.22 &&
    bl.y - tl.y >= 0.22 &&
    br.y - tr.y >= 0.22;

  if (!validQuad) {
    return {
      corners: [
        { x: 0.06, y: 0.06 },
        { x: 0.94, y: 0.06 },
        { x: 0.94, y: 0.94 },
        { x: 0.06, y: 0.94 },
      ],
      confidence: 0.15,
      sideLocked: { top: false, right: false, bottom: false, left: false },
    };
  }

  const lockedCount =
    (sideLocked.left ? 1 : 0) +
    (sideLocked.right ? 1 : 0) +
    (sideLocked.top ? 1 : 0) +
    (sideLocked.bottom ? 1 : 0);
  const avgInlier =
    (leftLine.inlierRatio + rightLine.inlierRatio + topLine.inlierRatio + bottomLine.inlierRatio) / 4;
  const confidence = Math.max(0.15, Math.min(1, lockedCount * 0.18 + avgInlier * 0.28));

  return {
    corners: [tl, tr, br, bl],
    confidence,
    sideLocked,
  };
}

/**
 * Estimates document boundary quadrilateral using multi-side RANSAC edge sensing.
 */
export function detectDocumentBounds(
  sourceCanvas: HTMLCanvasElement,
  sensitivity: EdgeSensitivity = 'high'
): [Point2D, Point2D, Point2D, Point2D] {
  return detectDocumentBoundsWithConfidence(sourceCanvas, sensitivity).corners;
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
  const maxDim = 1360;
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
  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];

  const srcCtx = sourceCanvas.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, sw, sh).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d')!;
  const outImg = outCtx.createImageData(outW, outH);
  const dst = outImg.data;
  const swM1 = sw - 1;
  const shM1 = sh - 1;
  const stride = sw * 4;

  for (let y = 0; y < outH; y++) {
    const rowBaseSx = h1 * y + h2;
    const rowBaseSy = h4 * y + h5;
    const rowBaseD = h7 * y + h8;
    for (let x = 0; x < outW; x++) {
      const invD = 1 / (h6 * x + rowBaseD);
      const sx = (h0 * x + rowBaseSx) * invD;
      const sy = (h3 * x + rowBaseSy) * invD;

      const x0 = sx | 0;
      const y0 = sy | 0;
      const outIdx = (y * outW + x) * 4;

      if (sx >= 0 && x0 < swM1 && sy >= 0 && y0 < shM1) {
        const fx = sx - x0;
        const fy = sy - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const i00 = y0 * stride + x0 * 4;
        const i10 = i00 + 4;
        const i01 = i00 + stride;
        const i11 = i01 + 4;

        dst[outIdx] = (srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11 + 0.5) | 0;
        dst[outIdx + 1] = (srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11 + 0.5) | 0;
        dst[outIdx + 2] = (srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11 + 0.5) | 0;
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
