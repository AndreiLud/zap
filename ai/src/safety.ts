// Decision-time safety net of the adaptive network: how far the policy that reads the opponent
// may move away from the policy with no evidence about the opponent (the same network with the
// statistics block at its empty value). The allowed distance is a KL budget that grows with the
// evidence n behind the decision: none without evidence, half of bmax at n = nHalf.
//
// When the network wants to move further, the two action distributions are mixed geometrically,
// pi_lambda proportional to pi0^(1 - lambda) * pi1^lambda, with the largest lambda whose KL to pi0
// fits the budget. KL(pi_lambda || pi0) grows with lambda (its derivative is lambda times a
// variance), so bisection finds it.

export interface SafetyNet {
  /** Budget limit in nats; Infinity turns the net off (the raw network plays). */
  bmax: number;
  /** Evidence at which the budget reaches half of bmax. */
  nHalf: number;
}

/** A finite safety net: bmax and nHalf finite and positive. */
export function isSafetyNet(a: unknown): a is SafetyNet {
  if (!a || typeof a !== 'object') return false;
  const { bmax, nHalf } = a as { bmax?: unknown; nHalf?: unknown };
  return typeof bmax === 'number' && typeof nHalf === 'number' && Number.isFinite(bmax) && bmax > 0 && Number.isFinite(nHalf) && nHalf > 0;
}

/**
 * Whether a model may be served with live statistics: true for models that read no statistics,
 * and for features v2 only when the file carries a finite safety net (meta.adapt). A v2 file
 * without one (a training snapshot, or an export without --adapt) would move on the statistics
 * with no budget at all, so the room plays it with the statistics at no evidence instead. A
 * v2-self file (the trained explorer of the explorer test) is never served live.
 */
export function servesLiveStats(header: { features: string; meta?: { adapt?: unknown } }): boolean {
  if (header.features === 'v2-self') return false;
  return header.features !== 'v2' || isSafetyNet(header.meta?.adapt);
}

/** KL budget for a decision with evidence n: 0 without evidence, bmax * n / (n + nHalf) otherwise. */
export function budget(n: number, s: SafetyNet): number {
  if (!(n > 0)) return 0;
  if (s.bmax === Infinity) return Infinity;
  return (s.bmax * n) / (n + s.nHalf);
}

/** Masked softmax at temperature 1 in float64. */
function softmax(l: ArrayLike<number>, mask: number, out: Float64Array): Float64Array {
  let max = -Infinity;
  for (let a = 0; a < l.length; a++) if (mask & (1 << a) && l[a] > max) max = l[a];
  let sum = 0;
  for (let a = 0; a < l.length; a++) {
    if (mask & (1 << a)) {
      const e = Math.exp(l[a] - max);
      out[a] = e;
      sum += e;
    } else out[a] = 0;
  }
  for (let a = 0; a < l.length; a++) out[a] /= sum;
  return out;
}

/** log of the masked softmax, legal actions only (illegal entries are left at 0). */
function logSoftmax(l: ArrayLike<number>, mask: number, out: Float64Array): Float64Array {
  let max = -Infinity;
  for (let a = 0; a < l.length; a++) if (mask & (1 << a) && l[a] > max) max = l[a];
  let sum = 0;
  for (let a = 0; a < l.length; a++) if (mask & (1 << a)) sum += Math.exp(l[a] - max);
  const lse = max + Math.log(sum);
  for (let a = 0; a < l.length; a++) out[a] = mask & (1 << a) ? l[a] - lse : 0;
  return out;
}

/** KL(softmax l1 || softmax l0) over the legal actions, in float64. */
export function klMasked(l1: ArrayLike<number>, l0: ArrayLike<number>, mask: number): number {
  const n = l1.length;
  const lp1 = logSoftmax(l1, mask, new Float64Array(n));
  const lp0 = logSoftmax(l0, mask, new Float64Array(n));
  let kl = 0;
  for (let a = 0; a < n; a++) if (mask & (1 << a)) kl += Math.exp(lp1[a]) * (lp1[a] - lp0[a]);
  return Math.max(0, kl);
}

export interface Blend {
  /** Weight of the policy with statistics: 1 when it fits the budget, 0 when nothing may move. */
  lambda: number;
  /** KL(pi_lambda || pi0) of the result. */
  kl: number;
  /** KL(pi1 || pi0) before the net. */
  klRaw: number;
  /** l0 + lambda (l1 - l0). */
  logits: Float64Array;
}

/**
 * Keeps the largest lambda in [0, 1] with KL(pi_lambda || pi0) <= b, where pi_lambda is the
 * masked softmax of l0 + lambda (l1 - l0). iters halvings of the interval (default 20).
 */
export function blend(l0: ArrayLike<number>, l1: ArrayLike<number>, mask: number, b: number, iters = 20): Blend {
  const n = l0.length;
  const mix = (lambda: number, out: Float64Array) => {
    for (let a = 0; a < n; a++) out[a] = l0[a] + lambda * (l1[a] - l0[a]);
    return out;
  };
  const klRaw = klMasked(l1, l0, mask);
  if (klRaw <= b) return { lambda: 1, kl: klRaw, klRaw, logits: mix(1, new Float64Array(n)) };
  if (!(b > 0)) return { lambda: 0, kl: 0, klRaw, logits: mix(0, new Float64Array(n)) };
  const tmp = new Float64Array(n);
  let lo = 0;
  let hi = 1;
  let klLo = 0;
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    const k = klMasked(mix(mid, tmp), l0, mask);
    if (k <= b) {
      lo = mid;
      klLo = k;
    } else hi = mid;
  }
  return { lambda: lo, kl: klLo, klRaw, logits: mix(lo, new Float64Array(n)) };
}

/** Total variation between two masked softmax distributions, and whether their most likely actions differ. */
export function moved(l: ArrayLike<number>, l0: ArrayLike<number>, mask: number): { tv: number; topChanged: boolean } {
  const n = l.length;
  const p = softmax(l, mask, new Float64Array(n));
  const p0 = softmax(l0, mask, new Float64Array(n));
  let tv = 0;
  let top = -1;
  let top0 = -1;
  for (let a = 0; a < n; a++) {
    if (!(mask & (1 << a))) continue;
    tv += Math.abs(p[a] - p0[a]);
    if (top < 0 || p[a] > p[top]) top = a;
    if (top0 < 0 || p0[a] > p0[top0]) top0 = a;
  }
  return { tv: tv / 2, topChanged: top !== top0 };
}
