// Chapter 3 of the plan, how the AI plays (DATA-SPEC 4.8, F20 to F23): truco and bluff by hand
// strength for every character (sim.json run B), the decision map of Zap, the characters of the
// version in play with their measured scores and intervals (_local/m6/claims.md 10), and four
// memorable hands of Zap against Zap in the replay viewer. The viewer and replays.json load with a
// second dynamic import when F23 comes within 800 px of the viewport (DATA-SPEC 1.2).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { PersonaId } from '../../../../ai/src/personas.ts';
import { Avatar } from '../../components/pieces.tsx';
import { PERSONA_NAMES } from '../../game-text.ts';
import { t, type Key } from '../../i18n.ts';
import { DotInterval, refEven } from '../charts/DotInterval.tsx';
import { Figure, Segmented, type TableData } from '../charts/Figure.tsx';
import { Heatmap, stepLabels } from '../charts/Heatmap.tsx';
import { SmallMultiples } from '../charts/SmallMultiples.tsx';
import { stepTicks, widen } from '../charts/scales.ts';
import { bluffTitle, charactersTitle, mapTitle, say, type StrongWeak } from '../findings.ts';
import { digitsFor, fmt, halfWidth, type Format } from '../format.ts';
import { td, tdText } from '../i18n-data.ts';
import type { ReplayChoice, ReplayData } from '../ReplayViewer.tsx';
import { sample, tipRange, upTo, type Est } from '../words.ts';
import simJson from '../generated/sim.json' with { type: 'json' };
import { useData } from '../load.ts';
import { answerTitle, characterSet, servedVersion, summaryOf, type CharacterNumbers, type SummaryLoad } from './chapter-data.ts';
import { Chapter, FV, pctCells } from './chapter.tsx';

interface Rate {
  n: number;
  p: number;
  lo: number;
  hi: number;
}

interface PlaySim {
  personas: PersonaId[];
  bins: number;
  matchesPerPersona: number;
  decisions: { asking: number; answering: number };
  raiseByStrength: Record<string, Rate[]>;
  raiseMap: Rate[][];
  answerMap: Rate[][];
  strongWeak: Record<string, { strong: Rate; weak: Rate }>;
}

const SIM = simJson as unknown as { provenance: { measuredAt: string; model: { version: string } }; play: PlaySim };
const PLAY = SIM.play;
const simDate = () => Date.parse(SIM.provenance.measuredAt);

/** The characters in the order of their designed difficulty, Zap last (the reference). */
const CAST: PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];

const est = (r: Rate): Est => ({ mean: r.p, lo: r.lo, hi: r.hi });
const digitsOf = (e: Est) => (digitsFor(halfWidth(e.lo, e.hi)) === 1 ? 1 : 0);

/** A strength bin as the range of the estimate it holds: "de 0% a 11%". */
const binRange = (f: Format, b: number) => f.range(b / PLAY.bins, (b + 1) / PLAY.bins, 0);

// ------------------------------------------------------------------------------------------------
// F20 Truco and bluff by hand strength

function TrucoByStrength() {
  const f = fmt();
  const ids = [...PLAY.personas].sort((a, b) => (a === 'zap' ? -1 : b === 'zap' ? 1 : CAST.indexOf(a) - CAST.indexOf(b)));
  const rows: StrongWeak[] = ids.map((id) => ({ name: PERSONA_NAMES[id], isZap: id === 'zap', strong: est(PLAY.strongWeak[id].strong), weak: est(PLAY.strongWeak[id].weak) }));
  const found = bluffTitle(rows, f);
  const title = found ? say(f, found.title) : t('data.f20.none');
  const center = (b: number) => (b + 0.5) / PLAY.bins;
  const points = (id: string) => PLAY.raiseByStrength[id].map((c, b) => ({ x: center(b), y: c.p, lo: c.lo, hi: c.hi, detail: [binRange(f, b), sample(t, f, c.n)] }));
  const words = [t('data.f20.weak'), t('data.f20.mid'), t('data.f20.strong')];
  const table: TableData = {
    columns: [{ label: t('data.th.character') }, { label: t('data.th.strength') }, { label: t('data.th.called'), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.chances'), numeric: true }],
    rows: ids.flatMap((id) => PLAY.raiseByStrength[id].map((c, b) => [PERSONA_NAMES[id], binRange(f, b), ...pctCells(f, est(c), digitsOf(est(c))), f.int(c.n)])),
  };
  return (
    <Figure
      id="truco-forca"
      title={title}
      sub={td('data.f20.p')}
      legend={[
        { label: t('data.f20.legend.zap'), series: 0, shape: 'circle', line: true },
        { label: t('data.f22.legend.chars'), series: 2, shape: 'square', line: true },
      ]}
      summary={`${title} ${found?.reading ? say(f, found.reading) : ''}`}
      reading={found?.reading ? say(f, found.reading) : undefined}
      source={t('data.src.f20', { n: f.int(PLAY.decisions.asking), matches: f.int(PLAY.matchesPerPersona), date: f.date(simDate()) })}
      table={table}
      reserve={520}
    >
      <SmallMultiples
        panels={ids.map((id) => ({
          key: id,
          title: PERSONA_NAMES[id],
          lines: [{ key: id, label: PERSONA_NAMES[id], series: id === 'zap' ? (1 as const) : (2 as const), shape: id === 'zap' ? ('circle' as const) : ('square' as const), endLabel: null, points: points(id) }],
        }))}
        reference={{ key: 'zap', label: 'Zap', series: 0, points: points('zap').map(({ x, y }) => ({ x, y })) }}
        x={{ domain: [0, 1], ticks: [1 / 6, 1 / 2, 5 / 6], format: (v) => words[Math.min(2, Math.floor(v * 3))], label: t('data.f20.x') }}
        y={{ domain: [0, 1], ticks: [0, 0.5, 1], format: (v) => f.pct(v, 0) }}
        valueFormat={(v) => f.pct(v, 0)}
        xName={(x) => t('data.f20.point', { range: binRange(f, Math.min(PLAY.bins - 1, Math.floor(x * PLAY.bins))) })}
        zones={[{ from: 0, to: 1 / 3, label: tdText('data.f20.zone') }]}
        columns={{ phone: 2, wide: 3 }}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F21 The decision map

const BANDS = [0, 1, 2, 3, 4] as const;
const STEPS = [0, 1, 2, 3] as const;
/** Cut points of the "Pedir" view: Zap asks in 10% to 30% of its chances, so the fixed cuts of F15 would paint one color. */
const RAISE_CUTS = [0.1, 0.2, 0.3, 0.4] as const;

function DecisionMap() {
  const f = fmt();
  const [view, setView] = useState<'raise' | 'answer'>('raise');
  const bins = Array.from({ length: PLAY.bins }, (_, b) => b);
  const middle = bins.filter((b) => b >= 3 && b <= 5);
  const raiseTitle = say(f, mapTitle({ behind: middle.map((b) => PLAY.raiseMap[b][0]), ahead: middle.map((b) => PLAY.raiseMap[b][4]) }));
  const title = view === 'raise' ? raiseTitle : t(answerTitle(PLAY.answerMap));
  const rowLabels = view === 'raise' ? BANDS.map((i) => t(`data.f21.band.${i}` as Key)) : STEPS.map((i) => t(`data.f21.step.${i}` as Key));
  const cellOf = (r: number, b: number) => (view === 'raise' ? PLAY.raiseMap[b][r] : PLAY.answerMap[b][r]);
  const cells = rowLabels.map((_, r) => bins.map((b) => ({ value: cellOf(r, b).n > 0 ? cellOf(r, b).p : null, n: cellOf(r, b).n, detail: [sample(t, f, cellOf(r, b).n)] })));
  const cuts = view === 'raise' ? RAISE_CUTS : undefined;
  const table: TableData = {
    columns: [{ label: view === 'raise' ? t('data.f21.rows.raise') : t('data.f21.rows.answer') }, { label: t('data.th.strength') }, { label: view === 'raise' ? t('data.th.called') : t('data.th.stayed'), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.chances'), numeric: true }],
    rows: rowLabels.flatMap((label, r) => bins.map((b) => [label, binRange(f, b), ...pctCells(f, est(cellOf(r, b)), digitsOf(est(cellOf(r, b)))), f.int(cellOf(r, b).n)])),
  };
  return (
    <Figure
      id="mapa-decisao"
      title={title}
      sub={view === 'raise' ? t('data.f21.p') : t('data.f21.p.answer')}
      controls={
        <Segmented
          label={t('data.ctl.view')}
          value={view}
          options={[
            { value: 'raise', label: t('data.f21.view.raise') },
            { value: 'answer', label: t('data.f21.view.answer') },
          ]}
          onChange={setView}
        />
      }
      summary={title}
      source={t(view === 'raise' ? 'data.src.f21' : 'data.src.f21.answer', { n: f.int(cells.flat().reduce((a, c) => a + c.n, 0)), date: f.date(simDate()) })}
      table={table}
      reserve={360}
    >
      <Heatmap
        rows={rowLabels.map((label, r) => ({ key: `${r}`, label }))}
        cols={bins.map((b) => ({ key: `${b}`, label: f.int(b + 1) }))}
        cells={cells}
        cuts={cuts}
        format={(v) => f.pct(v, 0)}
        legend={stepLabels(f, cuts)}
        rowTitle={view === 'raise' ? t('data.f21.rows.raise') : t('data.f21.rows.answer')}
        colTitle={t('data.f21.cols')}
        cellName={(r, b) => t('data.f21.cell', { row: rowLabels[r], range: binRange(f, b) })}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F22 The characters

/**
 * One number per quantity (bluffRate and F20's weak share are the same rate): when sim.json measured
 * the version whose characters F22 shows, its weak share replaces the calibration's bluff rate.
 */
function withSimBluff(c: CharacterNumbers, version: string, source: string): CharacterNumbers {
  const sw = PLAY.strongWeak[c.id];
  if (!c.rates || !sw || source !== 'facts' || SIM.provenance.model.version !== version) return c;
  return { ...c, rates: { ...c.rates, bluffRate: sw.weak.p } };
}

const RATE_ROWS = [
  { key: 'trucoRate', label: 'data.f22.rate.truco' },
  { key: 'bluffRate', label: 'data.f22.rate.bluff' },
  { key: 'runRate', label: 'data.f22.rate.run' },
  { key: 'signalTruth', label: 'data.f22.rate.signal' },
] as const;

/** "fácil, cauteloso"; Zap's level and style say the same, so once. */
function levelStyle(id: PersonaId): string {
  const level = t(`persona.${id}.level` as Key);
  const style = t(`persona.${id}.style` as Key);
  return level === style ? level : t('data.f22.levelStyle', { level, style });
}

function CastCard({ c, zap, f, bound }: { c: CharacterNumbers; zap: CharacterNumbers | undefined; f: Format; bound: boolean }) {
  const id = c.id as PersonaId;
  const isZap = id === 'zap';
  const vs = c.vsZap;
  const margin = vs ? (bound ? upTo(t, f.pct((vs.hi - vs.lo) / 2, 1)) : f.range(vs.lo, vs.hi, digitsOf(vs))) : null;
  return (
    <li class={`cast__card${isZap ? ' cast__card--zap' : ''}`}>
      <div class="cast__who">
        <Avatar persona={id} />
        <div>
          <p class="cast__name">{PERSONA_NAMES[id]}</p>
          <p class="cast__style">{levelStyle(id)}</p>
        </div>
      </div>
      {c.rates ? (
        <dl class="cast__rates">
          {RATE_ROWS.map((r) => {
            const v = c.rates![r.key];
            const ref = !isZap && zap?.rates ? zap.rates[r.key] : null;
            return (
              <div key={r.key} class="cast__rate">
                <dt>{t(r.label)}</dt>
                <dd>
                  <span class="cast__bar" aria-hidden="true">
                    <span class={`cast__fill cast__fill--${isZap ? 's1' : 's2'}`} style={{ width: `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%` }} />
                    {ref !== null ? <span class="cast__tick" style={{ left: `${(Math.max(0, Math.min(1, ref)) * 100).toFixed(1)}%` }} /> : null}
                  </span>
                  <span class="cast__value">{f.pct(v, 0)}</span>
                  {ref !== null ? <span class="sr-only">{t('data.f22.zapRef', { p: f.pct(ref, 0) })}</span> : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {!c.rates && !vs ? <p class="cast__vs">{t('data.lab.noData')}</p> : null}
      {vs && !isZap ? <p class="cast__vs">{t('data.f22.vsZap', { p: f.pct(vs.mean, digitsOf(vs)), margin: margin ?? '' })}</p> : null}
      {vs && isZap ? <p class="cast__vs">{t('data.f22.control', { p: f.pct(vs.mean, digitsOf(vs)), margin: margin ?? '' })}</p> : null}
    </li>
  );
}

function Characters({ version, reads, load }: { version: string; reads: boolean; load: SummaryLoad }) {
  const f = fmt();
  const raw = characterSet(FV, summaryOf(load), version, reads, CAST);
  const set = raw ? { ...raw, chars: raw.chars.map((c) => withSimBluff(c, raw.version, raw.source)) } : null;
  const simBluff = !!raw && raw.source === 'facts' && SIM.provenance.model.version === raw.version;
  if (!set) return <Figure id="personagens" title={t('data.f22.none')} sub={t('data.f22.p')} summary={t('data.f22.none')} state={{ kind: 'notMeasured' }} />;
  const chars = set.chars.filter((c) => c.id !== 'zap' && c.vsZap).map((c) => ({ name: PERSONA_NAMES[c.id as PersonaId], est: c.vsZap! }));
  const zap = set.chars.find((c) => c.id === 'zap');
  const found = charactersTitle({ chars, control: zap?.vsZap ?? null }, f);
  const title = found ? say(f, found.title) : t('data.f22.none');
  const all = set.chars.flatMap((c) => (c.vsZap ? [c.vsZap.lo, c.vsZap.hi] : []));
  const domain = widen([0.2, 0.6], all, 0.1);
  const words = (lo: number, hi: number) => (set.source === 'summary' ? upTo(t, f.pct((hi - lo) / 2, 1)) : tipRange(t, f.pct(lo, 1), f.pct(hi, 1)));
  const sourceKey: Key = set.source === 'summary' ? 'data.src.f22.summary' : set.source === 'adaptive' ? 'data.src.f22.adaptive' : 'data.src.f22';
  const table: TableData = {
    columns: [
      { label: t('data.th.character') },
      { label: t('data.th.vsZap'), numeric: true },
      { label: set.source === 'summary' ? t('data.th.margin') : t('data.th.interval'), numeric: true },
      ...RATE_ROWS.map((r) => ({ label: t(r.label), numeric: true })),
    ],
    rows: set.chars.map((c) => [
      PERSONA_NAMES[c.id as PersonaId],
      c.vsZap ? f.pct(c.vsZap.mean, digitsOf(c.vsZap)) : t('data.lab.noData'),
      c.vsZap ? words(c.vsZap.lo, c.vsZap.hi) : '',
      ...RATE_ROWS.map((r) => (c.rates ? f.pct(c.rates[r.key], 1) : '')),
    ]),
  };
  return (
    <div class="cast-block">
      <Figure
        id="personagens"
        title={title}
        sub={t('data.f22.p')}
        legend={[
          { label: t('data.f22.legend.chars'), series: 2, shape: 'square' },
          { label: t('data.f22.legend.control'), series: 1, shape: 'circle' },
        ]}
        summary={`${title} ${found?.reading ? say(f, found.reading) : ''}`}
        reading={found?.reading ? say(f, found.reading) : undefined}
        source={`${t(sourceKey, { pairs: f.int(set.pairs ?? 0), v: set.version, date: f.date(set.measuredAt ?? 0) })}${simBluff ? ` ${t('data.src.f22.bluff')}` : ''}`}
        table={table}
        reserve={300}
      >
        <DotInterval
          rows={set.chars.flatMap((c) =>
            c.vsZap
              ? [
                  {
                    key: c.id,
                    label: c.id === 'zap' ? t('data.f22.controlRow') : PERSONA_NAMES[c.id as PersonaId],
                    strong: c.id === 'zap',
                    marks: [
                      {
                        series: c.id === 'zap' ? (1 as const) : (2 as const),
                        shape: c.id === 'zap' ? ('circle' as const) : ('square' as const),
                        mean: c.vsZap.mean,
                        lo: c.vsZap.lo,
                        hi: c.vsZap.hi,
                        value: f.pct(c.vsZap.mean, digitsOf(c.vsZap)),
                      },
                    ],
                  },
                ]
              : [],
          )}
          domain={domain}
          ticks={stepTicks(domain, 0.1)}
          format={(x) => f.pct(x, 0)}
          intervalText={words}
          refs={[refEven()]}
          axisLabel={t('data.f22.axis')}
        />
      </Figure>
      <ul class="cast" aria-label={t('data.f22.cards')}>
        {set.chars.map((c) => (
          <CastCard key={c.id} c={c} zap={zap} f={f} bound={set.source === 'summary'} />
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// F23 Memorable hands

type ViewerModule = typeof import('../ReplayViewer.tsx');
interface ReplayFile {
  provenance: { measuredAt: string };
  replays: (ReplayData & { segment: string })[];
}

const REPLAY_ORDER = ['virada', 'blefe', 'doze', 'onze'] as const;

/** Loads the viewer and replays.json once the figure comes within 800 px of the viewport. */
function useNear(margin: number): [preact.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near];
}

function MemorableHands() {
  const f = fmt();
  const [ref, near] = useNear(800);
  const [loaded, setLoaded] = useState<{ mod: ViewerModule; file: ReplayFile } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!near || loaded) return;
    let alive = true;
    Promise.all([import('../ReplayViewer.tsx'), import('../generated/replays.json')])
      .then(([mod, json]) => alive && setLoaded({ mod, file: (json as { default: unknown }).default as ReplayFile }))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [near, loaded]);
  const title = t('data.f23.h');
  const names = ['A', 'B', 'C', 'D'].map((s) => t('data.f23.seat', { s }));
  const choices: ReplayChoice[] = loaded
    ? REPLAY_ORDER.flatMap((id) => {
        const r = loaded.file.replays.find((x) => x.id === id);
        return r ? [{ key: id, label: t(`data.f23.${id}` as Key), replay: { id: r.id, config: r.config, seed: r.seed, log: r.log, handIndex: r.handIndex, actions: r.actions } }] : [];
      })
    : [];
  const Viewer = loaded?.mod.ReplayViewer;
  return (
    <div ref={ref}>
      <Figure
        id="maos-marcantes"
        title={title}
        sub={t('data.f23.p')}
        summary={title}
        state={failed ? { kind: 'unavailable' } : loaded && choices.length === 0 ? { kind: 'notMeasured' } : undefined}
        source={loaded ? t('data.src.f23', { date: f.date(Date.parse(loaded.file.provenance.measuredAt)) }) : undefined}
        reserve={560}
        plain
      >
        {Viewer && choices.length > 0 ? <Viewer id="mm" choices={choices} choiceLabel={t('data.f23.choose')} names={names} reveal="all" /> : <div class="chap-wait" />}
      </Figure>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// The chapter

export function Plays() {
  const d = useData();
  const version = servedVersion(d.served, FV.served.version);
  return (
    <Chapter id="como-joga" title={t('data.plays.h')}>
      <TrucoByStrength />
      <DecisionMap />
      <Characters version={version} reads={d.reads} load={d.summary} />
      <MemorableHands />
    </Chapter>
  );
}
