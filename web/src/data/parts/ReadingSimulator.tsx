// F5 "O que ele conta, mão a mão" (DATA-SPEC 4.5): an explainer the reader plays with. Up to ten
// hands of one opponent; for each, the reader says whether they called truco. Three bars on one
// scale: the raw share (K / H), what the reading takes from it, (K + alpha p) / (H + alpha), which
// starts at the population value p and moves toward the raw share as hands pile up, and p itself as
// a tick. Below, the evidence (here, the hands with a truco) and how much the safety net lets the
// play move with it (budget(n) / bmax, ai/src/safety.ts): nothing without evidence, half at nHalf.
//
// alpha and p come from facts (design.alpha, priors of paulista 1 against 1), bmax and nHalf from
// the safety net. The default sequence is the spec's illustration.

import { useState } from 'preact/hooks';
import { budget } from '../../../../ai/src/safety.ts';
import { t } from '../../i18n.ts';
import { Figure } from '../charts/Figure.tsx';
import type { Format } from '../format.ts';
import { td } from '../i18n-data.ts';
import { READING, ms, useData } from '../load.ts';

/** The spec's default: pediu, não, pediu, pediu, não, pediu, pediu, não, pediu, pediu. */
export const DEFAULT_HANDS: readonly boolean[] = [true, false, true, true, false, true, true, false, true, true];
const SEGMENT = 'paulista-2';

export interface SimStep {
  /** Hands seen (H) and hands with a truco (K). */
  h: number;
  k: number;
  /** K / H, null before the first hand. */
  raw: number | null;
  /** (K + alpha p) / (H + alpha): the population value pulled toward what was seen. */
  read: number;
  /** budget(K) / bmax, null without a safety net. */
  room: number | null;
}

/** The reading after each prefix of the sequence (index 0: no hand yet). Pure; tested. */
export function simulate(hands: readonly boolean[], alpha: number, p: number, net: { bmax: number; nHalf: number } | null): SimStep[] {
  const out: SimStep[] = [];
  let k = 0;
  for (let h = 0; h <= hands.length; h++) {
    if (h > 0 && hands[h - 1]) k++;
    out.push({ h, k, raw: h ? k / h : null, read: (k + alpha * p) / (h + alpha), room: net ? budget(k, net) / net.bmax : null });
  }
  return out;
}

function line(f: Format, s: SimStep): string {
  if (s.h === 0) return t('data.read.f5.read0', { read: f.pct(s.read, 0) });
  return t(s.h === 1 ? 'data.read.f5.read.one' : 'data.read.f5.read', { h: f.int(s.h), raw: f.pct(s.raw ?? 0, 0), read: f.pct(s.read, 0) });
}

function Bar({ label, value, text, cls, tick }: { label: string; value: number | null; text: string; cls: string; tick?: number }) {
  return (
    <div class={`dp-sim__bar ${cls}`}>
      <span class="dp-sim__label">{label}</span>
      <span class="dp-sim__track">
        {value !== null ? <b style={{ width: `${(value * 100).toFixed(1)}%` }} /> : null}
        {tick !== undefined ? <i class="dp-sim__tick" style={{ left: `${(tick * 100).toFixed(1)}%` }} /> : null}
      </span>
      <span class="dp-sim__val">{text}</span>
    </div>
  );
}

export function ReadingSimulator() {
  const { f, reads } = useData();
  const [hands, setHands] = useState<boolean[]>([...DEFAULT_HANDS]);
  const [said, setSaid] = useState('');
  const design = READING.design;
  const prior = READING.priors?.segments[SEGMENT]?.raise;
  const net = READING.safetyNet;
  const max = DEFAULT_HANDS.length;
  const title = t('data.read.f5.h', { n: f.int(max) });
  if (!design || prior === undefined || !READING.priors) {
    return <Figure id="leitura-conta" title={title} summary={title} state={{ kind: 'notMeasured' }} />;
  }
  const alpha = design.alpha;
  const steps = simulate(hands, alpha, prior, net ? { bmax: net.bmax, nHalf: net.nHalf } : null);
  const now = steps[steps.length - 1];
  const change = (next: boolean[]) => {
    setHands(next);
    const s = simulate(next, alpha, prior, net)[next.length];
    setSaid(line(f, s));
  };
  const pop = f.pct(prior, 0);
  return (
    <Figure
      id="leitura-conta"
      title={title}
      sub={td(reads ? 'data.read.f5.p' : 'data.read.f5.p.test')}
      summary={title}
      plain
      reserve={360}
      reading={line(f, now)}
      source={td('data.src.f5', { file: READING.priors.file, date: f.date(ms(READING.priors.measuredAt)), matches: f.int(READING.priors.matchesPerSegment) })}
      table={{
        columns: [
          { label: t('data.th.hand') },
          { label: t('data.th.called') },
          { label: t('data.th.raw'), numeric: true },
          { label: t('data.th.read'), numeric: true },
          ...(net ? [{ label: t('data.th.room'), numeric: true }] : []),
        ],
        rows: steps.map((s) => [
          s.h === 0 ? t('data.read.f5.start') : f.int(s.h),
          s.h === 0 ? '' : t(hands[s.h - 1] ? 'data.read.f5.called' : 'data.read.f5.notCalled'),
          s.raw === null ? '' : f.pct(s.raw, 0),
          f.pct(s.read, 0),
          ...(s.room === null ? [] : [f.pct(s.room, 0)]),
        ]),
      }}
    >
      <div class="dp-sim" data-testid="reading-sim">
        <div class="dp-sim__hands" role="group" aria-label={t('data.read.f5.hands')}>
          {hands.map((called, i) => (
            <button
              key={i}
              type="button"
              class="dp-sim__chip"
              aria-pressed={called}
              aria-label={t(called ? 'data.read.f5.chip.on' : 'data.read.f5.chip.off', { h: f.int(i + 1) })}
              onClick={() => change(hands.map((c, j) => (j === i ? !c : c)))}
            >
              <span aria-hidden="true">{f.int(i + 1)}</span>
              <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                {called ? <path d="M2 6.5l2.5 2.5L10 3.5" /> : <circle cx="6" cy="6" r="3.5" />}
              </svg>
            </button>
          ))}
        </div>
        <div class="dp-sim__add">
          <button type="button" class="btn btn--quiet" disabled={hands.length >= max} onClick={() => change([...hands, true])}>
            {t('data.read.f5.call')}
          </button>
          <button type="button" class="btn btn--quiet" disabled={hands.length >= max} onClick={() => change([...hands, false])}>
            {t('data.read.f5.noCall')}
          </button>
          <button type="button" class="btn btn--quiet" disabled={hands.length === 0} onClick={() => change([])}>
            {t('data.read.f5.reset')}
          </button>
        </div>
        <div class="dp-sim__bars">
          <Bar label={t('data.read.f5.rawLabel')} value={now.raw} text={now.raw === null ? t('data.read.f5.noHands') : f.pct(now.raw, 0)} cls="is-raw" />
          <Bar label={t('data.read.f5.readLabel')} value={now.read} text={f.pct(now.read, 0)} cls="is-read" tick={prior} />
          <p class="dp-sim__pop">
            <i aria-hidden="true" />
            {td('data.read.f5.pop', { p: pop })}
          </p>
        </div>
        <div class="dp-sim__room">
          <p class="dp-sim__n">
            <span>{t('data.read.f5.evidence')}</span>
            <b>{f.int(now.k)}</b>
          </p>
          {now.room !== null ? (
            <Bar label={t('data.read.f5.roomLabel')} value={now.room} text={t('data.read.f5.ofMax', { p: f.pct(now.room, 0) })} cls="is-room" />
          ) : (
            <p class="dp-note">{t('data.state.notMeasured')}</p>
          )}
        </div>
        <p class="sr-only" aria-live="polite">
          {said}
        </p>
      </div>
    </Figure>
  );
}
