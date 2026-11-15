export type DiffOpType = 'equal' | 'added' | 'deleted';

export interface DiffLine {
  type: DiffOpType;
  text: string;
  pageA?: number;
  pageB?: number;
}

export interface PageComparisonResult {
  pageNumber: number;
  lines: DiffLine[];
  addedCount: number;
  deletedCount: number;
  unchangedCount: number;
}

function lcsDiffLines(linesA: string[], linesB: string[]): Array<{ type: DiffOpType; text: string }> {
  const m = linesA.length;
  const n = linesB.length;
  // Cap DP table safely for huge pages
  if (m * n > 250000) {
    const out: Array<{ type: DiffOpType; text: string }> = [];
    const setA = new Set(linesA);
    const setB = new Set(linesB);
    for (const l of linesA) {
      if (!setB.has(l)) out.push({ type: 'deleted', text: l });
      else out.push({ type: 'equal', text: l });
    }
    for (const l of linesB) {
      if (!setA.has(l)) out.push({ type: 'added', text: l });
    }
    return out;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (linesA[i] === linesB[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: Array<{ type: DiffOpType; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (linesA[i] === linesB[j]) {
      result.push({ type: 'equal', text: linesA[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'deleted', text: linesA[i] });
      i++;
    } else {
      result.push({ type: 'added', text: linesB[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: 'deleted', text: linesA[i++] });
  }
  while (j < n) {
    result.push({ type: 'added', text: linesB[j++] });
  }
  return result;
}

export function comparePdfPagesText(
  pagesA: Array<{ pageNumber: number; text: string }>,
  pagesB: Array<{ pageNumber: number; text: string }>
): {
  pages: PageComparisonResult[];
  totalAdded: number;
  totalDeleted: number;
  totalUnchanged: number;
} {
  const maxPages = Math.max(pagesA.length, pagesB.length);
  const results: PageComparisonResult[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let totalUnchanged = 0;

  for (let p = 1; p <= maxPages; p++) {
    const textA = pagesA[p - 1]?.text || '';
    const textB = pagesB[p - 1]?.text || '';
    const linesA = textA
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const linesB = textB
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const diff = lcsDiffLines(linesA, linesB);
    let addedCount = 0;
    let deletedCount = 0;
    let unchangedCount = 0;

    const mapped: DiffLine[] = diff.map((d) => {
      if (d.type === 'added') addedCount++;
      else if (d.type === 'deleted') deletedCount++;
      else unchangedCount++;
      return {
        type: d.type,
        text: d.text,
        pageA: d.type !== 'added' ? p : undefined,
        pageB: d.type !== 'deleted' ? p : undefined,
      };
    });

    totalAdded += addedCount;
    totalDeleted += deletedCount;
    totalUnchanged += unchangedCount;

    results.push({
      pageNumber: p,
      lines: mapped,
      addedCount,
      deletedCount,
      unchangedCount,
    });
  }

  return {
    pages: results,
    totalAdded,
    totalDeleted,
    totalUnchanged,
  };
}
