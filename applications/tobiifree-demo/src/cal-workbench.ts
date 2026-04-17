// Calibration workbench: post-calibration validation, client-side
// polynomial correction fit, persistent bundles, residual visualization.
//
// Plugs into the existing GazeModel pipeline in main.ts — this module
// doesn't render gaze itself; it produces GazeModel objects that
// modelPredict() can consume.

import type { DisplayArea, GazeSample, Source } from 'tobiifree-sdk-ts';

export type V2 = { x: number; y: number };

export type GazeModel = {
  featureNames: string[];
  polyDegree: number;
  weights: number[][];
  inputMean: number[];
  inputStd: number[];
  trainingDisplayArea?: DisplayArea;
};

export type TestPoint = {
  target: V2;
  measured: V2;
  samples: V2[];
  captured_at: number;
};

export type ResidualStats = {
  n: number;
  mean_norm: number;
  p95_norm: number;
  max_norm: number;
  per_point_err_norm: number[];
};

export type CalBundle = {
  id: string;
  timestamp: number;
  label: string;
  display_area: DisplayArea;
  screen_rect: { w_mm: number; h_mm: number; cx_mm: number; cy_mm: number; cz_mm: number; tilt_mm: number };
  viewport_px: { w: number; h: number };
  cal_blob_b64: string | null;
  test_points: TestPoint[];
  fit_model: GazeModel | null;
  fit_kind: 'none' | 'affine' | 'poly2' | 'poly3';
  pre_fit: ResidualStats;
  post_fit: ResidualStats | null;
};

// ── Test-point layouts ──────────────────────────────────────────────

export type Layout = 5 | 9 | 13;

export function makeTestGrid(layout: Layout, margin = 0.12): V2[] {
  if (layout === 5) {
    return [
      { x: margin, y: margin },
      { x: 1 - margin, y: margin },
      { x: 0.5, y: 0.5 },
      { x: margin, y: 1 - margin },
      { x: 1 - margin, y: 1 - margin },
    ];
  }
  if (layout === 9) {
    const steps = [margin, 0.5, 1 - margin];
    const out: V2[] = [];
    for (const y of steps) for (const x of steps) out.push({ x, y });
    return out;
  }
  // 13: 9-grid + 4 edge midpoints at half margin
  const steps = [margin, 0.5, 1 - margin];
  const out: V2[] = [];
  for (const y of steps) for (const x of steps) out.push({ x, y });
  const mid = (margin + 0.5) / 2;
  const mid2 = (0.5 + 1 - margin) / 2;
  out.push({ x: mid, y: 0.5 }, { x: mid2, y: 0.5 }, { x: 0.5, y: mid }, { x: 0.5, y: mid2 });
  return out;
}

// ── Validation run: collects N samples per point via subscribeToGaze ─

export type RunTestOpts = {
  tracker: Source;
  points: V2[];
  overlay: HTMLDivElement;
  dot: HTMLDivElement;
  status: HTMLDivElement;
  viewportW: number;
  viewportH: number;
  captureMs?: number;
};

export async function runValidationTest(opts: RunTestOpts): Promise<TestPoint[]> {
  const { tracker, points, overlay, dot, status, viewportW, viewportH } = opts;
  const captureMs = opts.captureMs ?? 700;

  let buffer: V2[] = [];
  let collecting = false;
  const unsub = tracker.subscribeToGaze((s: GazeSample) => {
    if (!collecting) return;
    const p = s.gaze_point_2d_norm ?? s.gaze_point_2d_L_norm ?? s.gaze_point_2d_R_norm;
    const valid = s.validity_L === 0 || s.validity_R === 0;
    if (p && valid) buffer.push({ x: p.x, y: p.y });
  });

  let cancelled = false;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelled = true; };
  window.addEventListener('keydown', onKey);

  const results: TestPoint[] = [];
  try {
    for (let i = 0; i < points.length; i++) {
      if (cancelled) break;
      const target = points[i]!;
      dot.style.left = `${target.x * viewportW}px`;
      dot.style.top = `${target.y * viewportH}px`;
      dot.style.display = 'block';
      dot.classList.remove('collecting');
      status.textContent = `Test ${i + 1}/${points.length} — look at the dot, then click · Esc to cancel`;

      const clicked = await new Promise<boolean>((resolve) => {
        const onClick = () => { overlay.removeEventListener('click', onClick); resolve(true); };
        overlay.addEventListener('click', onClick, { once: true });
      });
      if (cancelled || !clicked) break;

      dot.classList.add('collecting');
      status.textContent = `Test ${i + 1}/${points.length} — holding…`;
      buffer = [];
      collecting = true;
      await new Promise(r => setTimeout(r, captureMs));
      collecting = false;
      dot.classList.remove('collecting');

      const measured = medianXY(buffer);
      results.push({
        target,
        measured: measured ?? { x: NaN, y: NaN },
        samples: buffer.slice(),
        captured_at: Date.now(),
      });
    }
  } finally {
    window.removeEventListener('keydown', onKey);
    dot.style.display = 'none';
    unsub();
  }
  return results;
}

function medianXY(samples: V2[]): V2 | null {
  if (samples.length === 0) return null;
  const xs = samples.map(s => s.x).sort((a, b) => a - b);
  const ys = samples.map(s => s.y).sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return { x: xs[mid]!, y: ys[mid]! };
}

// ── Residual stats ──────────────────────────────────────────────────

export function computeStats(points: TestPoint[], predict?: (m: V2) => V2 | null): ResidualStats {
  const errs: number[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.measured.x) || !Number.isFinite(p.measured.y)) continue;
    const m = predict ? (predict(p.measured) ?? p.measured) : p.measured;
    errs.push(Math.hypot(m.x - p.target.x, m.y - p.target.y));
  }
  errs.sort((a, b) => a - b);
  const n = errs.length;
  if (n === 0) return { n: 0, mean_norm: NaN, p95_norm: NaN, max_norm: NaN, per_point_err_norm: [] };
  const mean = errs.reduce((a, b) => a + b, 0) / n;
  const p95 = errs[Math.min(n - 1, Math.floor(n * 0.95))]!;
  const max = errs[n - 1]!;
  return { n, mean_norm: mean, p95_norm: p95, max_norm: max, per_point_err_norm: errs };
}

// ── Polynomial model fitting (matches main.ts modelPolyExpand) ──────

function polyExpand(x: number[], degree: number): number[] {
  if (degree === 1) return [...x, 1];
  const out = [...x];
  if (degree >= 2) {
    for (let i = 0; i < x.length; i++)
      for (let j = i; j < x.length; j++)
        out.push(x[i]! * x[j]!);
  }
  if (degree >= 3) {
    for (let i = 0; i < x.length; i++)
      for (let j = i; j < x.length; j++)
        for (let k = j; k < x.length; k++)
          out.push(x[i]! * x[j]! * x[k]!);
  }
  out.push(1);
  return out;
}

// Feature count for 2D input at given poly degree:
//  deg 1: 2 + 1 = 3
//  deg 2: 2 + 3 + 1 = 6
//  deg 3: 2 + 3 + 4 + 1 = 10
export function minPointsFor(degree: 1 | 2 | 3): number {
  return degree === 1 ? 3 : degree === 2 ? 6 : 10;
}

// Solve AX=B via Gaussian elimination (A is NxN, B is NxM).
// In-place on copies. Returns X as NxM, or null if singular.
function solveLinear(A: number[][], B: number[][]): number[][] | null {
  const n = A.length;
  const m = B[0]!.length;
  const a = A.map(r => r.slice());
  const b = B.map(r => r.slice());
  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (Math.abs(a[piv]![col]!) < 1e-12) return null;
    if (piv !== col) { [a[col], a[piv]] = [a[piv]!, a[col]!]; [b[col], b[piv]] = [b[piv]!, b[col]!]; }
    const inv = 1 / a[col]![col]!;
    for (let j = col; j < n; j++) a[col]![j]! *= inv;
    for (let j = 0; j < m; j++) b[col]![j]! *= inv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j < n; j++) a[r]![j]! -= f * a[col]![j]!;
      for (let j = 0; j < m; j++) b[r]![j]! -= f * b[col]![j]!;
    }
  }
  return b;
}

export function fitGazeModel(
  points: TestPoint[],
  degree: 1 | 2 | 3,
  trainingDisplayArea?: DisplayArea,
): GazeModel | null {
  const valid = points.filter(p => Number.isFinite(p.measured.x) && Number.isFinite(p.measured.y));
  if (valid.length < minPointsFor(degree)) return null;

  // Standardize inputs to [-1, 1] via fixed (0.5, 0.5) center — avoids
  // overfitting the mean/std to small sample sizes and keeps the fit
  // stable when test points are replayed later.
  const inputMean = [0.5, 0.5];
  const inputStd = [0.5, 0.5];
  const normed = valid.map(p => [
    (p.measured.x - inputMean[0]!) / inputStd[0]!,
    (p.measured.y - inputMean[1]!) / inputStd[1]!,
  ]);
  const X = normed.map(r => polyExpand(r, degree));
  const Y = valid.map(p => [p.target.x, p.target.y]);

  const M = X[0]!.length;
  // Normal equations: (XᵀX) W = (XᵀY)
  const XtX: number[][] = Array.from({ length: M }, () => new Array(M).fill(0));
  const XtY: number[][] = Array.from({ length: M }, () => new Array(2).fill(0));
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    const yi = Y[i]!;
    for (let a = 0; a < M; a++) {
      for (let b = 0; b < M; b++) XtX[a]![b]! += xi[a]! * xi[b]!;
      XtY[a]![0]! += xi[a]! * yi[0]!;
      XtY[a]![1]! += xi[a]! * yi[1]!;
    }
  }
  const W = solveLinear(XtX, XtY);
  if (!W) return null;

  const model: GazeModel = {
    featureNames: ['gaze_2d.x', 'gaze_2d.y'],
    polyDegree: degree,
    weights: W,
    inputMean,
    inputStd,
  };
  if (trainingDisplayArea) model.trainingDisplayArea = trainingDisplayArea;
  return model;
}

// Predict just (norm_x, norm_y) → (corrected_x, corrected_y), used for
// residual visualization without running through the full modelPredict.
export function predictWithModel(m: GazeModel, measured: V2): V2 {
  const a = (measured.x - m.inputMean[0]!) / m.inputStd[0]!;
  const b = (measured.y - m.inputMean[1]!) / m.inputStd[1]!;
  const expanded = polyExpand([a, b], m.polyDegree);
  let px = 0, py = 0;
  for (let j = 0; j < m.weights.length; j++) {
    px += expanded[j]! * m.weights[j]![0]!;
    py += expanded[j]! * m.weights[j]![1]!;
  }
  return { x: px, y: py };
}

// ── Bundle persistence (localStorage) ───────────────────────────────

const BUNDLES_KEY = 'tobii_cal_bundles_v1';

export function listBundles(): CalBundle[] {
  try {
    const s = localStorage.getItem(BUNDLES_KEY);
    if (!s) return [];
    const arr = JSON.parse(s) as CalBundle[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveBundle(b: CalBundle): void {
  const all = listBundles().filter(x => x.id !== b.id);
  all.push(b);
  all.sort((a, b) => b.timestamp - a.timestamp);
  localStorage.setItem(BUNDLES_KEY, JSON.stringify(all));
}

export function loadBundle(id: string): CalBundle | null {
  return listBundles().find(b => b.id === id) ?? null;
}

export function deleteBundle(id: string): void {
  const all = listBundles().filter(x => x.id !== id);
  localStorage.setItem(BUNDLES_KEY, JSON.stringify(all));
}

export function newBundleId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `cal_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function exportBundleToFile(b: CalBundle): void {
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${b.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Residual SVG visualization ──────────────────────────────────────

export function renderResidualSvg(
  points: TestPoint[],
  predict: ((m: V2) => V2) | null,
  wPx: number,
  hPx: number,
): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(wPx));
  svg.setAttribute('height', String(hPx));
  svg.setAttribute('viewBox', `0 0 1 1`);
  svg.style.background = '#12131a';
  svg.style.border = '1px solid #2a2a36';
  svg.style.borderRadius = '4px';

  // Grid
  const grid = document.createElementNS(NS, 'g');
  grid.setAttribute('stroke', '#25262f');
  grid.setAttribute('stroke-width', '0.003');
  for (let i = 1; i < 4; i++) {
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', String(i / 4)); ln.setAttribute('x2', String(i / 4));
    ln.setAttribute('y1', '0'); ln.setAttribute('y2', '1');
    grid.appendChild(ln);
    const lh = document.createElementNS(NS, 'line');
    lh.setAttribute('x1', '0'); lh.setAttribute('x2', '1');
    lh.setAttribute('y1', String(i / 4)); lh.setAttribute('y2', String(i / 4));
    grid.appendChild(lh);
  }
  svg.appendChild(grid);

  for (const p of points) {
    if (!Number.isFinite(p.measured.x) || !Number.isFinite(p.measured.y)) continue;
    const end = predict ? predict(p.measured) : p.measured;
    const err = Math.hypot(end.x - p.target.x, end.y - p.target.y);
    const color = errColor(err);

    const arrow = document.createElementNS(NS, 'line');
    arrow.setAttribute('x1', String(p.target.x));
    arrow.setAttribute('y1', String(p.target.y));
    arrow.setAttribute('x2', String(end.x));
    arrow.setAttribute('y2', String(end.y));
    arrow.setAttribute('stroke', color);
    arrow.setAttribute('stroke-width', '0.006');
    arrow.setAttribute('stroke-linecap', 'round');
    svg.appendChild(arrow);

    const tgt = document.createElementNS(NS, 'circle');
    tgt.setAttribute('cx', String(p.target.x));
    tgt.setAttribute('cy', String(p.target.y));
    tgt.setAttribute('r', '0.010');
    tgt.setAttribute('fill', '#7df9a8');
    svg.appendChild(tgt);

    const meas = document.createElementNS(NS, 'circle');
    meas.setAttribute('cx', String(end.x));
    meas.setAttribute('cy', String(end.y));
    meas.setAttribute('r', '0.006');
    meas.setAttribute('fill', color);
    svg.appendChild(meas);
  }
  return svg;
}

function errColor(err_norm: number): string {
  // Hot-to-cold. 0 = green, 0.05 = yellow, 0.10+ = red.
  const t = Math.min(1, err_norm / 0.10);
  const r = Math.round(125 + t * 130);
  const g = Math.round(249 - t * 200);
  const b = Math.round(168 - t * 100);
  return `rgb(${r},${g},${b})`;
}
