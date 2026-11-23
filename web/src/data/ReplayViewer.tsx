// The replay viewer (DATA-SPEC F23 and the personal page, 5.2 and 5.6): one hand of a match, step
// by step. A small table seen from above (every hand face up in self play; on the personal page
// only the person's cards and the cards played face up), the cards played per round in the middle,
// the hand's value and the score; buttons "From the start", "Previous", "Next"; under it a line with
// the chance of winning the match that the AI estimated after each move, with a marker on the move
// shown. The move in words comes from the table's own event texts (game-text.ts).
//
// The engine rebuilds every state: replay() up to the hand's first move, then the log one move at
// a time. Left and right arrows step when the viewer has focus; Home and End jump; the move in
// words goes to the live region. Nothing plays by itself.

import '../styles/replay.css';
import type { MatchConfig } from '../../../engine/src/config.ts';
import { manilhaRankForVira, MINEIRO_MANILHAS, rankOf } from '../../../engine/src/cards.ts';
import { applyAction, cloneMatch, replay, TIE, type GameEvent, type MatchInit, type MatchState, type Play, type Round } from '../../../engine/src/engine.ts';
import type { PublicRoom } from '../../../shared/protocol.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Card, CardBack } from '../deck/Card.tsx';
import { describeEvent, type Names } from '../game-text.ts';
import { t, tn, type Key } from '../i18n.ts';
import { Segmented } from './charts/Figure.tsx';
import { buildLines } from './charts/LineBand.tsx';
import { fsScale } from './charts/scales.ts';
import { fmt } from './format.ts';

export interface ReplayAction {
  /** Index of the move in `log`. */
  i: number;
  seat: number;
  action: number;
  /** Team 0's estimated chance to win the match after this move; null without an estimate. */
  chance: number | null;
}

export interface ReplayData {
  id: string;
  config: MatchConfig;
  seed: string;
  init?: MatchInit;
  /** Every move from the match start to the end of the hand shown. */
  log: number[];
  handIndex: number;
  /** The moves of that hand, in log order. */
  actions: ReplayAction[];
}

export interface ReplayChoice {
  key: string;
  label: string;
  replay: ReplayData;
}

export interface ReplayViewerProps {
  /** A prefix for ids. */
  id: string;
  /** Tabs ("A virada", "O blefe"...) or the hands of one match; one choice shows no tabs. */
  choices: ReplayChoice[];
  /** Name of the choices group ("Choose the hand"). */
  choiceLabel?: string;
  /** Display name per seat. */
  names: string[];
  /** The person's seat (personal page), or -1 (self play). */
  you?: number;
  /**
   * all: every card face up (self play); mine: the person's cards and the cards played face up; end:
   * as mine during the hand, every card face up once the hand is over (a person alone with AIs).
   */
  reveal: Reveal;
  /** Whose chance the line shows (default team 0, or the person's team). */
  chanceTeam?: 0 | 1;
  /** The choice open at first. */
  initial?: string;
}

export type Reveal = 'all' | 'mine' | 'end';

export interface SeatView {
  seat: number;
  cards: number[];
  hidden: number;
}

export interface HandView {
  n: number;
  vira: number;
  isManilha: (c: number) => boolean;
  seats: SeatView[];
  rounds: Round[];
  value: number;
  score: [number, number];
  /** The hand is over (its summary is shown). */
  over: boolean;
}

const POS4 = ['bottom', 'right', 'top', 'left'] as const;
const POS2 = ['bottom', 'top'] as const;

/** The match right before the hand's first listed move. */
function handStart(r: ReplayData): MatchState {
  return replay(r.config, r.seed, r.log.slice(0, r.actions[0].i), r.init);
}

function handView(r: ReplayData, s: MatchState, reveal: Reveal, you: number): HandView {
  const live = !s.over && s.handIndex === r.handIndex;
  const sum = live ? null : s.history.find((h) => h.index === r.handIndex) ?? null;
  const vira = live ? s.hand.vira : (sum?.vira ?? -1);
  const variant = r.config.variant;
  const mRank = variant === 'paulista' && vira >= 0 ? manilhaRankForVira(vira) : -1;
  const isManilha = (c: number) => c >= 0 && (variant === 'mineiro' ? MINEIRO_MANILHAS.includes(c) : rankOf(c) === mRank);
  const rounds = live ? s.hand.rounds : (sum?.rounds ?? []);
  const played = new Set(rounds.flatMap((x) => x.plays.map((p) => p.card)));
  const seats: SeatView[] = [];
  for (let seat = 0; seat < s.n; seat++) {
    const inHand = live ? s.hand.cards[seat].filter((c) => c >= 0) : (sum?.dealt[seat] ?? []).filter((c) => !played.has(c));
    const open = reveal === 'all' || seat === you || (reveal === 'end' && !live);
    seats.push({ seat, cards: open ? inHand : [], hidden: open ? 0 : inHand.length });
  }
  const value = live ? s.hand.value : (sum?.result.points ?? 0);
  const score: [number, number] = live ? [s.score[0], s.score[1]] : sum ? [sum.scoreAfter[0], sum.scoreAfter[1]] : [s.score[0], s.score[1]];
  return { n: s.n, vira, isManilha, seats, rounds, value, score, over: !live };
}

/** The names of the two teams: the seat's name in 1 against 1, the two partners in 2 against 2. */
export function teamNamesOf(names: readonly string[], n: number): [string, string] {
  if (n === 2) return [names[0] ?? t('data.replay.team.0'), names[1] ?? t('data.replay.team.1')];
  const pair = (a: number, b: number) => (names[a] && names[b] ? t('data.replay.pair', { a: names[a], b: names[b] }) : t(`data.replay.team.${a & 1}` as Key));
  return [pair(0, 2), pair(1, 3)];
}

function sentence(e: GameEvent, n: Names, teams: [string, string]): string | null {
  if (e.t === 'deal') return null;
  // Without a person at the table, team sentences name the teams (the table's own words speak to
  // "you" and "us"); everything else is the table's own sentence.
  if (n.you < 0) {
    // A pair of partners takes the plural verb.
    const pair = n.players === 4;
    if (e.t === 'hand') {
      if (e.winner < 0) return t('ev.hand.tie');
      return t(pair ? 'data.replay.handWon.pair' : 'data.replay.handWon', { team: teams[e.winner], points: tn('points', e.points) });
    }
    if (e.t === 'game') return t(pair ? 'data.replay.gameWon.pair' : 'data.replay.gameWon', { team: teams[e.winner] });
    if (e.t === 'match') return t(pair ? 'data.replay.matchWon.pair' : 'data.replay.matchWon', { team: teams[e.winner] });
  }
  return describeEvent(e, n);
}

/**
 * Every state of a hand and every move in words: replay() up to the hand's first move, then the log
 * one move at a time (any move of the log between two listed actions is applied too, so the state
 * never drifts from the record). Index 0 is the hand's start; index j + 1 follows action j.
 */
export function replaySteps(r: ReplayData, seatNames: readonly string[], you: number, reveal: Reveal): { views: HandView[]; texts: string[] } {
  const players = r.config.players;
  const teams = teamNamesOf(seatNames, players);
  const room = { seats: seatNames.map((name, seat) => ({ seat, kind: seat === you ? 'human' : 'ai', name })) } as unknown as PublicRoom;
  const names: Names = { you, players, room, variant: r.config.variant };
  const s = handStart(r);
  const views: HandView[] = [handView(r, cloneMatch(s), reveal, you)];
  const texts: string[] = [t('data.replay.begin')];
  let at = r.actions[0].i;
  for (const a of r.actions) {
    const events: GameEvent[] = [];
    for (; at <= a.i && at < r.log.length; at++) applyAction(s, r.log[at] >> 4, r.log[at] & 15, events);
    texts.push(events.map((e) => sentence(e, names, teams)).filter((x): x is string => !!x).join(' '));
    views.push(handView(r, cloneMatch(s), reveal, you));
  }
  return { views, texts };
}

export function ReplayViewer(p: ReplayViewerProps) {
  const you = p.you ?? -1;
  const [choice, setChoice] = useState(p.initial ?? p.choices[0]?.key ?? '');
  const current = p.choices.find((c) => c.key === choice) ?? p.choices[0];
  const r = current?.replay;
  const total = r?.actions.length ?? 0;
  const [k, setK] = useState(-1);
  const [live, setLive] = useState('');
  useEffect(() => setK(-1), [choice]);

  const players = r?.config.players ?? 2;
  const teams = teamNamesOf(p.names, players);
  const chanceTeam = p.chanceTeam ?? (you >= 0 ? ((you & 1) as 0 | 1) : 0);

  // Every state and every move in words, once per hand.
  const steps = useMemo(() => (r && r.actions.length > 0 ? replaySteps(r, p.names, you, p.reveal) : null), [r, p.reveal, you, p.names.join('|')]);

  // The AI's estimate after a move, in words: the chance line's text alternative (WCAG 1.1.1).
  const chanceText = (v: number) => {
    const c = v >= 0 ? r?.actions[v]?.chance : null;
    if (c === null || c === undefined) return '';
    return t('data.replay.chanceNow', { team: teams[chanceTeam], p: fmt().pct(chanceTeam === 0 ? c : 1 - c, 0) });
  };
  const go = (next: number) => {
    const v = Math.max(-1, Math.min(total - 1, next));
    setK(v);
    if (steps) setLive([steps.texts[v + 1], chanceText(v)].filter(Boolean).join(' '));
  };

  if (!r || !steps) return null;
  const view = steps.views[k + 1];
  const f = fmt();
  const pos = players === 4 ? POS4 : POS2;
  const bottomSeat = you >= 0 ? you : 0;
  const where = (seat: number) => pos[(seat - bottomSeat + players) % players];
  const seatName = (seat: number) => p.names[seat] ?? t('seat.number', { n: seat + 1 });
  const showCard = (pl: Play) => p.reveal === 'all' || pl.seat === you || !pl.faceDown || (p.reveal === 'end' && view.over);

  return (
    <div class="replay">
      {p.choices.length > 1 ? (
        <Segmented label={p.choiceLabel ?? t('data.replay.choose')} value={current.key} options={p.choices.map((c) => ({ value: c.key, label: c.label }))} onChange={setChoice} />
      ) : null}
      <div
        class="replay__stage"
        role="group"
        aria-label={t('data.replay.label')}
        tabIndex={0}
        onKeyDown={(e) => {
          const map: Record<string, number> = { ArrowRight: k + 1, ArrowLeft: k - 1, Home: -1, End: total - 1 };
          if (!(e.key in map)) return;
          e.preventDefault();
          go(map[e.key]);
        }}
      >
        <div class={`replay__table replay__table--${players}`}>
          {view.seats.map((sv) => (
            <div key={sv.seat} class={`replay__seat replay__seat--${where(sv.seat)} replay__seat--t${sv.seat & 1}`}>
              <span class="replay__name">{seatName(sv.seat)}</span>
              <span class="replay__hand">
                {sv.cards.map((c) => (
                  <Card key={c} card={c} manilha={view.isManilha(c)} class="replay__card" />
                ))}
                {Array.from({ length: sv.hidden }, (_, i) => (
                  <CardBack key={`h${i}`} class="replay__card" />
                ))}
              </span>
            </div>
          ))}
          <div class="replay__middle">
            {view.vira >= 0 ? (
              <div class="replay__vira">
                <Card card={view.vira} class="replay__card" />
                <span>{t('data.replay.vira')}</span>
              </div>
            ) : null}
            <ol class="replay__rounds">
              {view.rounds.map((round, ri) =>
                round.plays.length === 0 ? null : (
                <li key={ri} class="replay__round">
                  <span class="replay__round-name">{t('data.replay.round', { ord: t(`ord.${Math.min(ri, 2)}` as Key) })}</span>
                  <span class="replay__plays">
                    {round.plays.map((pl) => {
                      const won = round.result !== -1 && round.result !== TIE && round.winnerSeat === pl.seat;
                      return (
                        <span key={pl.seat} class={`replay__play${won ? ' is-winner' : ''}${pl.faceDown ? ' is-covered' : ''}`}>
                          {showCard(pl) ? <Card card={pl.card} manilha={!pl.faceDown && view.isManilha(pl.card)} class="replay__card" /> : <CardBack class="replay__card" />}
                          <span class="replay__who">{seatName(pl.seat)}</span>
                          {pl.faceDown ? <span class="replay__tag">{t('data.replay.covered')}</span> : null}
                          {won ? <span class="replay__tag replay__tag--win">{t('data.replay.winner')}</span> : null}
                        </span>
                      );
                    })}
                  </span>
                </li>
                ),
              )}
            </ol>
          </div>
        </div>
        <p class="replay__status">
          <span>{t('data.replay.hand', { h: f.int(r.handIndex + 1) })}</span>
          <span>{t('data.replay.value', { v: f.int(view.value) })}</span>
          <span>{t('data.replay.score', { a: teams[0], x: f.int(view.score[0]), b: teams[1], y: f.int(view.score[1]) })}</span>
        </p>
        <p class="replay__move">
          <span class="replay__count">{k < 0 ? '' : t('data.replay.step', { i: f.int(k + 1), n: f.int(total) })}</span> {steps.texts[k + 1]}
          {chanceText(k) ? <span class="replay__chance-now"> {chanceText(k)}</span> : null}
        </p>
        {/* aria-disabled, not disabled: a control that turns itself off keeps the keyboard focus (WCAG 2.4.3). */}
        <div class="replay__controls">
          <button type="button" class="btn btn--quiet" aria-disabled={k < 0 ? 'true' : undefined} onClick={() => k >= 0 && go(-1)}>
            {t('data.replay.start')}
          </button>
          <button type="button" class="btn btn--quiet" aria-disabled={k < 0 ? 'true' : undefined} onClick={() => k >= 0 && go(k - 1)}>
            {t('data.replay.prev')}
          </button>
          <button type="button" class="btn btn--primary" aria-disabled={k >= total - 1 ? 'true' : undefined} onClick={() => k < total - 1 && go(k + 1)}>
            {t('data.replay.next')}
          </button>
        </div>
        <ChanceLine r={r} k={k} team={chanceTeam} teamName={teams[chanceTeam]} />
      </div>
      <p class="sr-only" aria-live="polite" id={`${p.id}-replay-live`}>
        {live}
      </p>
    </div>
  );
}

/** The AI's estimated chance after each move, 0% to 100%, with the move shown marked. */
function ChanceLine({ r, k, team, teamName }: { r: ReplayData; k: number; team: 0 | 1; teamName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.round(el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const f = fmt();
  const fs = fsScale();
  const points = r.actions
    .map((a, j) => (a.chance === null ? null : { x: j + 1, y: team === 0 ? a.chance : 1 - a.chance }))
    .filter((q): q is { x: number; y: number } => q !== null);
  const H = Math.ceil(130 * Math.max(1, fs * 0.9));
  const label = t('data.replay.chance', { team: teamName });
  const at = points.find((q) => q.x === k + 1);
  const out =
    w > 0
      ? buildLines(
          {
            series: [{ key: 'chance', label, series: 1, points, dots: true, endLabel: null }],
            x: { domain: [1, Math.max(2, r.actions.length)], ticks: [], format: (v) => f.int(v) },
            y: { domain: [0, 1], ticks: [0, 0.5, 1], format: (v) => f.pct(v, 0) },
            valueFormat: (v) => f.pct(v, 0),
            refs: [{ value: 0.5, label: t('data.lab.even') }],
            current: k >= 0 ? k + 1 : null,
            markers: k >= 0 ? [{ x: k + 1, label: at ? f.pct(at.y, 0) : t('data.replay.noEstimate'), strong: true }] : [],
          },
          { x: 0, y: 0, w, h: H, fs, active: -1, k0: 0, yAxis: true, xAxis: false, right: 8 },
        )
      : null;
  return (
    <figure class="replay__chance">
      <figcaption class="replay__chance-title">{label}</figcaption>
      <div ref={ref} class="replay__chance-plot">
        {out ? (
          <svg class="plot" viewBox={`0 0 ${w} ${H}`} width={w} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
            {out.nodes}
          </svg>
        ) : null}
      </div>
    </figure>
  );
}
