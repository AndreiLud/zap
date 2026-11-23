// The interactive examples of the rules page (CLIENT-SPEC 10.6): "Quem ganha?" (two plain ranks),
// the vira lab (paulista) or the fixed manilhas (mineiro), the five cases of rounds and ties, and
// the truco call with its three answers. Every answer comes from rules/logic.ts, which reads the
// engine.

import { useState } from 'preact/hooks';
import type { Variant } from '../../../engine/src/config.ts';
import { Card } from '../deck/Card.tsx';
import { RANK_TEXTS } from '../deck/geometry.ts';
import { callName, cardName } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import {
  DEMO_IDLE,
  LADDER_CARDS,
  MINEIRO_FIXED,
  ROUND_CASES,
  STRONG_FIRST,
  demoAnswer,
  demoCall,
  demoCanRaise,
  duel,
  ladder,
  viraExample,
  type RoundMark,
  type TrucoDemo as Demo,
} from './logic.ts';
import { ManilhaCards, OrderLine, Rank, capitalize, orderLabel, rankWord, tentos, tx } from './parts.tsx';

const RANKS_WEAK_FIRST = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** A row of ten rank radios (a fieldset), used by the duel and the vira lab. */
function RankPicker(p: { name: string; legend: string; value: number; testid: (r: string) => string; label: (rank: number) => string; onPick(rank: number): void }) {
  return (
    <fieldset class="rank-picker">
      <legend>{p.legend}</legend>
      <div class="rank-picker__ranks">
        {RANKS_WEAK_FIRST.map((r) => (
          <label key={r} class="rank-picker__rank" data-testid={p.testid(RANK_TEXTS[r])}>
            <input type="radio" name={p.name} value={String(r)} checked={p.value === r} aria-label={p.label(r)} onChange={() => p.onPick(r)} />
            <span aria-hidden="true">
              <Rank rank={r} />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Card order: the ladder of plain cards and "Quem ganha?"

export function OrderLadder() {
  return (
    <div class="card-ladder-wrap">
      <ol class="card-ladder" aria-label={t('rulebook.order.list')}>
        {LADDER_CARDS.map((c, i) => (
          <li key={c} class="card-ladder__step">
            <span class="card-ladder__card">
              <Card card={c} />
            </span>
            <small>{capitalize(rankWord(STRONG_FIRST[i]))}</small>
            <span class="sr-only">{cardName(c)}</span>
          </li>
        ))}
      </ol>
      <p class="axis" aria-hidden="true">
        <span>{t('rulebook.order.hi')}</span>
        <i />
        <span>{t('rulebook.order.lo')}</span>
      </p>
    </div>
  );
}

export function OrderDuel() {
  const [a, setA] = useState(6);
  const [b, setB] = useState(4);
  const r = duel(a, b);
  const result =
    r === 'tie'
      ? t('rulebook.duel.tie')
      : t('rulebook.duel.win', {
          a: t(`rulebook.rank.the.${r === 'a' ? a : b}` as Key),
          b: t(`rulebook.rank.from.${r === 'a' ? b : a}` as Key),
        });
  return (
    <div class="example duel" data-testid="order-duel">
      <h3>{t('rulebook.duel.h')}</h3>
      <p class="example__hint">{t('rulebook.duel.p')}</p>
      <RankPicker name="duel-a" legend={t('rulebook.duel.a')} value={a} testid={(x) => `duel-a-${x}`} label={(x) => rankWord(x)} onPick={setA} />
      <RankPicker name="duel-b" legend={t('rulebook.duel.b')} value={b} testid={(x) => `duel-b-${x}`} label={(x) => rankWord(x)} onPick={setB} />
      <p class={`example__result duel__result${r === 'tie' ? ' is-tie' : ''}`} data-testid="duel-result" aria-live="polite">
        {result}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. The vira sets the manilha (paulista) / the fixed manilhas (mineiro)

export function ViraLab() {
  const [vira, setVira] = useState(2);
  const [changes, setChanges] = useState(0);
  const ex = viraExample(vira);
  const said = t('rulebook.m.say', { vira: cardName(ex.vira), pl: t(`rulebook.pl.${ex.manilhaRank}` as Key) });
  return (
    <div class="example vira-picker">
      <RankPicker
        name="vira"
        legend={t('rulebook.m.legend')}
        value={vira}
        testid={(x) => `vira-${x}`}
        label={(x) => t('rulebook.m.pick', { rank: rankWord(x) })}
        onPick={(r) => {
          setVira(r);
          setChanges((n) => n + 1);
        }}
      />
      <div class={`vira-picker__result${changes > 0 ? ' is-changed' : ''}`}>
        <figure class="vira-picker__vira" key={changes}>
          <span class="vira-picker__card">
            <Card card={ex.vira} />
          </span>
          <figcaption>{t('rulebook.m.vira')}</figcaption>
        </figure>
        <div class="vira-picker__says">
          <p class="vira-picker__is" data-testid="manilha-result">
            {tx('rulebook.m.is', {
              vira: <Rank rank={vira} />,
              manilha: (
                <span class="vira-picker__big">
                  <Rank rank={ex.manilhaRank} />
                </span>
              ),
            })}
          </p>
          <p class="vira-picker__note">
            {ex.wraps ? `${t('rulebook.m.wrap')} ` : ''}
            {t('rulebook.m.suits')}
          </p>
        </div>
        <ManilhaCards cards={ex.manilhas} size="big" label={t('rulebook.m.list')} tips animate={changes} />
      </div>
      <div class="vira-picker__order">
        <p>{t('rulebook.m.neworder')}</p>
        <OrderLine order={ex.order} manilhaRank={ex.manilhaRank} label={orderLabel(ex.order, ex.manilhaRank)} />
      </div>
      <p class="sr-only" aria-live="polite">
        {changes > 0 ? said : ''}
      </p>
    </div>
  );
}

export function FixedManilhas() {
  return (
    <div class="example fixed-manilhas">
      <ManilhaCards cards={MINEIRO_FIXED} size="big" label={t('rulebook.m.list')} tips />
      <p class="fixed-manilhas__note">{t('rulebook.m.plain.mineiro')}</p>
      <OrderLine order={STRONG_FIRST} manilhaRank={null} label={orderLabel(STRONG_FIRST, null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Rounds and ties: the five cases

function Mark({ m }: { m: RoundMark }) {
  if (m === null) return <span class="round-mark round-mark--skip">{t('rulebook.rounds.skip')}</span>;
  const key: Key = m === 'us' ? 'rulebook.rounds.us' : m === 'them' ? 'rulebook.rounds.them' : 'rulebook.rounds.tie';
  return <span class={`round-mark round-mark--${m}`}>{t(key)}</span>;
}

export function RoundsTable() {
  return (
    <div class="rounds-table-wrap">
      <table class="rounds-table">
        <caption>{t('rulebook.rounds.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('rulebook.rounds.col.1')}</th>
            <th scope="col">{t('rulebook.rounds.col.2')}</th>
            <th scope="col">{t('rulebook.rounds.col.3')}</th>
            <th scope="col">{t('rulebook.rounds.col.who')}</th>
            <th scope="col" class="rounds-table__why">
              {t('rulebook.rounds.col.why')}
            </th>
          </tr>
        </thead>
        <tbody>
          {ROUND_CASES.map((c) => (
            <tr key={c.id}>
              {c.rounds.map((m, i) => (
                <td key={i}>
                  <Mark m={m} />
                </td>
              ))}
              <td class="rounds-table__winner">
                {c.winner === 'nobody' ? <span class="round-mark round-mark--nobody">{t('rulebook.rounds.nobody')}</span> : <Mark m={c.winner} />}
              </td>
              <td class="rounds-table__why">{t(`rulebook.rounds.case.${c.id}` as Key)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. The truco call: three steps and the example

/** The value ladder as steps of growing height, the current one filled. */
export function Ladder({ values, on }: { values: readonly number[]; on: number }) {
  return (
    <span class="ladder" role="img" aria-label={t('rulebook.t.ladder', { list: values.join(', ') })}>
      {values.map((v, i) => (
        <span key={v} class={`ladder__step${i === on ? ' is-on' : ''}`} style={{ '--h': String(i) }} aria-hidden="true">
          {v}
        </span>
      ))}
    </span>
  );
}

function demoText(d: Demo, values: readonly number[]): string {
  if (d.end) {
    if (d.end.kind === 'accept') return t(d.end.by === 'us' ? 'rulebook.demo.accept.us' : 'rulebook.demo.accept.them', { value: tentos(d.end.value) });
    return t(d.end.by === 'us' ? 'rulebook.demo.run.us' : 'rulebook.demo.run.them', { points: tentos(d.end.points) });
  }
  if (d.pending === 0) return t('rulebook.demo.start', { value: tentos(values[0]) });
  const value = tentos(values[d.pending]);
  if (d.pending === 1) return t('rulebook.demo.called', { value });
  const call = callName(values[d.pending], d.pending, false);
  const text = t(d.caller === 'us' ? 'rulebook.demo.raise.us' : 'rulebook.demo.raise.them', { call, value });
  return demoCanRaise(d) ? text : `${text} ${t('rulebook.demo.top')}`;
}

export function TrucoDemo({ variant }: { variant: Variant }) {
  const values = ladder(variant);
  const [d, setD] = useState<Demo>(DEMO_IDLE);
  const answer = (a: 'accept' | 'run' | 'raise') => setD(demoAnswer(d, a, values));
  const shown = d.end ? (d.end.kind === 'accept' ? d.end.value : values[d.pending]) : values[d.pending];
  const on = values.indexOf(shown);
  const next = d.pending > 0 && demoCanRaise(d) ? values[d.pending + 1] : null;
  return (
    <div class="example truco-demo" data-testid="truco-demo">
      <h3>{t('rulebook.demo.h')}</h3>
      <Ladder values={values} on={on} />
      <p class="example__result" data-testid="truco-demo-result" aria-live="polite">
        {demoText(d, values)}
      </p>
      <div class="truco-demo__buttons">
        {d.pending === 0 ? (
          <button
            type="button"
            class="btn btn--bet"
            data-testid="truco-demo-call"
            onClick={() => setD(demoCall())}
          >
            {d.end ? t('rulebook.demo.again') : t('rulebook.demo.call')}
          </button>
        ) : (
          <div class="truco-demo__answers" role="group" aria-label={t('rulebook.demo.answers')}>
            <button type="button" class="btn btn--primary" data-testid="truco-demo-accept" onClick={() => answer('accept')}>
              {t('rulebook.demo.accept')}
            </button>
            <button type="button" class="btn" data-testid="truco-demo-run" onClick={() => answer('run')}>
              {t('rulebook.demo.run')}
            </button>
            {next !== null ? (
              <button type="button" class="btn btn--alert" data-testid="truco-demo-raise" onClick={() => answer('raise')}>
                {callName(next, d.pending + 1, true)}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

