import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface Point2D {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export type ScanFilter = 'docPro' | 'color' | 'magic' | 'grayscale' | 'bw';

export type EdgeSensitivity = 'standard' | 'high' | 'max';

export type ScanResolutionTier = 'standard' | 'high' | 'ultra';

export type ScanPaperSize = 'fit' | 'a4' | 'letter' | 'legal';

export type ScanMarginSize = 'none' | 'narrow' | 'standard';

export type ScanOrientation = 'auto' | 'portrait' | 'landscape';

export interface ScanCompileOptions {
  paperSize?: ScanPaperSize;
  margin?: ScanMarginSize;
  orientation?: ScanOrientation;
  addPageNumbers?: boolean;
  title?: string;
}

export function getResolutionMaxDim(tier: ScanResolutionTier): number {
  if (tier === 'standard') return 1600;
  if (tier === 'high') return 2480;
  return 3508; // 300 DPI A4 print resolution
}

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
 * Warps a 4-corner quadrilateral from sourceCanvas into a straightened rectangular document canvas
 * with configurable output resolution (up to 3508px / 300 DPI A4).
 */
export function perspectiveWarpCanvas(
  sourceCanvas: HTMLCanvasElement,
  corners: [Point2D, Point2D, Point2D, Point2D],
  options?: {
    maxDim?: number;
    allowUpscale?: boolean;
  }
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
  const nativeMax = Math.max(outW, outH);
  const maxDim = options?.maxDim ?? 2480;

  if (outW > maxDim || outH > maxDim) {
    const scale = maxDim / nativeMax;
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  } else if (options?.allowUpscale && nativeMax >= 640 && nativeMax < maxDim) {
    // Allow clean up-to-1.5x super-sampling toward requested target DPI without soft over-stretching
    const upScale = Math.min(1.5, maxDim / nativeMax);
    outW = Math.round(outW * upScale);
    outH = Math.round(outH * upScale);
  }

  outW = Math.max(240, outW);
  outH = Math.max(240, outH);

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
 * Estimates the smooth paper illumination surface (shadows, lamp glare, ambient tint)
 * using downsampled morphological local-max envelope + 2-pass separable box smoothing.
 * Dividing pixels by this surface eliminates hand/phone shadows while preserving ink & color.
 */
function estimatePaperIlluminationMap(
  data: Uint8ClampedArray,
  w: number,
  h: number
): { bw: number; bh: number; bgR: Float32Array; bgG: Float32Array; bgB: Float32Array } {
  const bw = Math.min(160, Math.max(48, Math.round(w / 10)));
  const bh = Math.min(220, Math.max(48, Math.round((h / Math.max(1, w)) * bw)));
  const len = bw * bh;

  const r0 = new Float32Array(len);
  const g0 = new Float32Array(len);
  const b0 = new Float32Array(len);

  for (let by = 0; by < bh; by++) {
    const sy = Math.min(h - 1, Math.round((by / Math.max(1, bh - 1)) * (h - 1)));
    const rowOff = sy * w;
    for (let bx = 0; bx < bw; bx++) {
      const sx = Math.min(w - 1, Math.round((bx / Math.max(1, bw - 1)) * (w - 1)));
      const idx = (rowOff + sx) * 4;
      const bi = by * bw + bx;
      r0[bi] = data[idx];
      g0[bi] = data[idx + 1];
      b0[bi] = data[idx + 2];
    }
  }

  // Separable local-maximum dilation (radius 8 on ~160px grid spans ~10% page width)
  const rMax = 8;
  const maxTempR = new Float32Array(len);
  const maxTempG = new Float32Array(len);
  const maxTempB = new Float32Array(len);
  const maxOutR = new Float32Array(len);
  const maxOutG = new Float32Array(len);
  const maxOutB = new Float32Array(len);

  for (let y = 0; y < bh; y++) {
    const row = y * bw;
    for (let x = 0; x < bw; x++) {
      const xStart = Math.max(0, x - rMax);
      const xEnd = Math.min(bw - 1, x + rMax);
      let mr = 0, mg = 0, mb = 0;
      for (let xx = xStart; xx <= xEnd; xx++) {
        const i = row + xx;
        if (r0[i] > mr) mr = r0[i];
        if (g0[i] > mg) mg = g0[i];
        if (b0[i] > mb) mb = b0[i];
      }
      maxTempR[row + x] = mr;
      maxTempG[row + x] = mg;
      maxTempB[row + x] = mb;
    }
  }

  for (let y = 0; y < bh; y++) {
    const yStart = Math.max(0, y - rMax);
    const yEnd = Math.min(bh - 1, y + rMax);
    for (let x = 0; x < bw; x++) {
      let mr = 0, mg = 0, mb = 0;
      for (let yy = yStart; yy <= yEnd; yy++) {
        const i = yy * bw + x;
        if (maxTempR[i] > mr) mr = maxTempR[i];
        if (maxTempG[i] > mg) mg = maxTempG[i];
        if (maxTempB[i] > mb) mb = maxTempB[i];
      }
      const o = y * bw + x;
      maxOutR[o] = mr;
      maxOutG[o] = mg;
      maxOutB[o] = mb;
    }
  }

  // Smooth the dilated paper surface with 2 separable box-blur passes
  const rBlur = 6;
  const smoothPass = (src: Float32Array, dst: Float32Array) => {
    const tmp = new Float32Array(len);
    for (let y = 0; y < bh; y++) {
      const row = y * bw;
      for (let x = 0; x < bw; x++) {
        const x1 = Math.max(0, x - rBlur);
        const x2 = Math.min(bw - 1, x + rBlur);
        let sum = 0;
        for (let xx = x1; xx <= x2; xx++) sum += src[row + xx];
        tmp[row + x] = sum / (x2 - x1 + 1);
      }
    }
    for (let y = 0; y < bh; y++) {
      const y1 = Math.max(0, y - rBlur);
      const y2 = Math.min(bh - 1, y + rBlur);
      const cnt = y2 - y1 + 1;
      for (let x = 0; x < bw; x++) {
        let sum = 0;
        for (let yy = y1; yy <= y2; yy++) sum += tmp[yy * bw + x];
        dst[y * bw + x] = sum / cnt;
      }
    }
  };

  const pass1R = new Float32Array(len);
  const pass1G = new Float32Array(len);
  const pass1B = new Float32Array(len);
  const bgR = new Float32Array(len);
  const bgG = new Float32Array(len);
  const bgB = new Float32Array(len);

  smoothPass(maxOutR, pass1R);
  smoothPass(maxOutG, pass1G);
  smoothPass(maxOutB, pass1B);
  smoothPass(pass1R, bgR);
  smoothPass(pass1G, bgG);
  smoothPass(pass1B, bgB);

  return { bw, bh, bgR, bgG, bgB };
}

/**
 * Applies studio document enhancement: illumination/shadow normalization, crisp text contrast,
 * soft white-paper balance, anti-aliased B&W thresholding, and thresholded unsharp masking.
 */
export function applyScanEnhancement(
  sourceCanvas: HTMLCanvasElement,
  opts: {
    filter: ScanFilter;
    brightness: number; // -50 .. +50
    contrast: number; // -50 .. +50
    shadowClean?: number; // 0 .. 100
    sharpen: boolean;
    rotation: number; // 0, 90, 180, 270
    outputFormat?: 'jpeg' | 'png';
    jpegQuality?: number;
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

  const defaultShadow =
    opts.filter === 'docPro'
      ? 85
      : opts.filter === 'magic'
      ? 75
      : opts.filter === 'bw'
      ? 65
      : opts.filter === 'grayscale'
      ? 50
      : 10;
  const shadowStrength = Math.max(0, Math.min(1, (opts.shadowClean ?? defaultShadow) / 100));

  // Illumination surface normalization removes uneven lighting & phone shadows
  if (shadowStrength > 0.01) {
    const { bw, bh, bgR, bgG, bgB } = estimatePaperIlluminationMap(data, w, h);
    const scaleX = (bw - 1) / Math.max(1, w - 1);
    const scaleY = (bh - 1) / Math.max(1, h - 1);

    for (let y = 0; y < h; y++) {
      const fy = y * scaleY;
      const y0 = Math.min(bh - 2, fy | 0);
      const wy = fy - y0;
      const wy0 = 1 - wy;
      const row0 = y0 * bw;
      const row1 = row0 + bw;

      for (let x = 0; x < w; x++) {
        const fx = x * scaleX;
        const x0 = Math.min(bw - 2, fx | 0);
        const wx = fx - x0;
        const wx0 = 1 - wx;

        const w00 = wx0 * wy0;
        const w10 = wx * wy0;
        const w01 = wx0 * wy;
        const w11 = wx * wy;

        const i00 = row0 + x0;
        const i10 = i00 + 1;
        const i01 = row1 + x0;
        const i11 = i01 + 1;

        const lr = Math.max(48, bgR[i00] * w00 + bgR[i10] * w10 + bgR[i01] * w01 + bgR[i11] * w11);
        const lg = Math.max(48, bgG[i00] * w00 + bgG[i10] * w10 + bgG[i01] * w01 + bgG[i11] * w11);
        const lb = Math.max(48, bgB[i00] * w00 + bgB[i10] * w10 + bgB[i01] * w01 + bgB[i11] * w11);

        const idx = (y * w + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const nr = Math.min(255, (r / lr) * 252);
        const ng = Math.min(255, (g / lg) * 252);
        const nb = Math.min(255, (b / lb) * 252);

        data[idx] = r + (nr - r) * shadowStrength;
        data[idx + 1] = g + (ng - g) * shadowStrength;
        data[idx + 2] = b + (nb - b) * shadowStrength;
      }
    }
  }

  const contrastFactor = (259 * (opts.contrast + 255)) / (255 * (259 - opts.contrast));

  if (opts.filter === 'bw') {
    // Anti-aliased adaptive integral-image local thresholding for razor-sharp, shadow-free B&W documents
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

    const radius = Math.max(12, Math.round(Math.min(w, h) * 0.024));
    const t = 0.11;
    const softBand = 16;
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
        const thresh = mean * (1 - t);
        const lum = gray[y * w + x];

        let val: number;
        if (lum >= thresh + softBand * 0.5) {
          val = 255;
        } else if (lum <= thresh - softBand * 0.5) {
          val = 14;
        } else {
          const u = (lum - (thresh - softBand * 0.5)) / softBand;
          val = Math.round(14 + u * u * (3 - 2 * u) * (255 - 14));
        }

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

      if (opts.filter === 'docPro') {
        // Snap bright paper highlights softly to pure white & deepen ink strokes cleanly
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 224) {
          const lift = Math.min(1, (lum - 224) / 22);
          r = r + (255 - r) * lift;
          g = g + (255 - g) * lift;
          b = b + (255 - b) * lift;
        } else {
          r = 1.18 * (r - 128) + 122;
          g = 1.18 * (g - 128) + 122;
          b = 1.18 * (b - 128) + 122;
        }
      } else if (opts.filter === 'magic') {
        // Vivid document contrast + rich colors for stamps, receipts & charts
        r = 1.24 * (r - 128) + 132;
        g = 1.24 * (g - 128) + 132;
        b = 1.24 * (b - 128) + 132;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum + (r - lum) * 1.15;
        g = lum + (g - lum) * 1.15;
        b = lum + (b - lum) * 1.15;
      }

      r = contrastFactor * (r - 128) + 128 + opts.brightness;
      g = contrastFactor * (g - 128) + 128 + opts.brightness;
      b = contrastFactor * (b - 128) + 128 + opts.brightness;

      if (opts.filter === 'grayscale') {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = g = b = lum > 226 ? 255 : lum;
      }

      data[i] = Math.max(0, Math.min(255, r));
      data[i + 1] = Math.max(0, Math.min(255, g));
      data[i + 2] = Math.max(0, Math.min(255, b));
    }
  }

  if (opts.sharpen) {
    // Edge-thresholded Gaussian Unsharp Mask: sharpens text strokes without amplifying blank-paper grain
    const copy = new Uint8ClampedArray(data);
    const amount = opts.filter === 'bw' ? 0.5 : 0.72;
    const edgeThresh = 6;
    const rowStride = w * 4;
    for (let y = 1; y < h - 1; y++) {
      const yOff = y * rowStride;
      const ymOff = yOff - rowStride;
      const ypOff = yOff + rowStride;
      for (let x = 1; x < w - 1; x++) {
        const idx = yOff + x * 4;
        const xL = idx - 4;
        const xR = idx + 4;
        const ym = ymOff + x * 4;
        const yp = ypOff + x * 4;
        for (let c = 0; c < 3; c++) {
          const orig = copy[idx + c];
          const blurred =
            (copy[ym - 4 + c] +
              2 * copy[ym + c] +
              copy[ym + 4 + c] +
              2 * copy[xL + c] +
              4 * orig +
              2 * copy[xR + c] +
              copy[yp - 4 + c] +
              2 * copy[yp + c] +
              copy[yp + 4 + c]) /
            16;
          const detail = orig - blurred;
          if (detail > edgeThresh || detail < -edgeThresh) {
            const val = orig + detail * amount;
            data[idx + c] = val < 0 ? 0 : val > 255 ? 255 : val;
          }
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  if (opts.outputFormat === 'png') {
    return canvas.toDataURL('image/png');
  }
  return canvas.toDataURL('image/jpeg', opts.jpegQuality ?? 0.95);
}

const PAPER_DIMS_PT: Record<Exclude<ScanPaperSize, 'fit'>, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
};

export function resolveScanPageDimensions(
  imgWidth: number,
  imgHeight: number,
  options?: ScanCompileOptions
): {
  pageW: number;
  pageH: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  footerReserve: number;
} {
  const paperSize = options?.paperSize ?? 'fit';
  const marginMode = options?.margin ?? 'none';
  const orientation = options?.orientation ?? 'auto';
  const safeImgW = Math.max(1, imgWidth);
  const safeImgH = Math.max(1, imgHeight);

  if (paperSize === 'fit') {
    const pageW = 595.28;
    const pageH = (safeImgH / safeImgW) * pageW;
    return {
      pageW,
      pageH,
      drawX: 0,
      drawY: 0,
      drawW: pageW,
      drawH: pageH,
      footerReserve: 0,
    };
  }

  const [baseW, baseH] = PAPER_DIMS_PT[paperSize];
  const isLandscape =
    orientation === 'landscape' || (orientation === 'auto' && safeImgW > safeImgH * 1.06);
  const pageW = isLandscape ? baseH : baseW;
  const pageH = isLandscape ? baseW : baseH;
  const marginPt = marginMode === 'standard' ? 38 : marginMode === 'narrow' ? 20 : 0;
  const footerReserve = options?.addPageNumbers ? 20 : 0;

  const availW = Math.max(40, pageW - marginPt * 2);
  const availH = Math.max(40, pageH - marginPt * 2 - footerReserve);
  const scale = Math.min(availW / safeImgW, availH / safeImgH);
  const drawW = safeImgW * scale;
  const drawH = safeImgH * scale;
  const drawX = (pageW - drawW) / 2;
  const drawY = footerReserve + marginPt + (availH - drawH) / 2;

  return { pageW, pageH, drawX, drawY, drawW, drawH, footerReserve };
}

export async function compileScannedPagesToPdf(
  pageDataUrls: string[],
  options?: ScanCompileOptions
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const totalPages = pageDataUrls.length;
  const font = options?.addPageNumbers ? await doc.embedFont(StandardFonts.Helvetica) : null;

  for (let i = 0; i < totalPages; i++) {
    const dataUrl = pageDataUrls[i];
    const base64 = dataUrl.split(',')[1];
    if (!base64) continue;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const img = dataUrl.includes('image/png')
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);

    const layout = resolveScanPageDimensions(img.width, img.height, options);
    const page = doc.addPage([layout.pageW, layout.pageH]);

    // Crisp pure white sheet background for framed paper sizes
    if ((options?.paperSize ?? 'fit') !== 'fit') {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: layout.pageW,
        height: layout.pageH,
        color: rgb(1, 1, 1),
      });
    }

    page.drawImage(img, {
      x: layout.drawX,
      y: layout.drawY,
      width: layout.drawW,
      height: layout.drawH,
    });

    if (font && options?.addPageNumbers && (options.paperSize ?? 'fit') !== 'fit') {
      const label = `${i + 1} / ${totalPages}`;
      const textWidth = font.widthOfTextAtSize(label, 9);
      page.drawText(label, {
        x: (layout.pageW - textWidth) / 2,
        y: 10,
        size: 9,
        font,
        color: rgb(0.39, 0.45, 0.54),
      });
    }
  }

  if (options?.title?.trim()) {
    doc.setTitle(options.title.trim());
  }
  doc.setProducer('PDF MASTER High-Res Document Scanner');
  const out = await doc.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
