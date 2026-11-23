// The side panel from 64em (CLIENT-SPEC 11.7): "Game score" (a column per hand, up for us,
// down for them), "Hand log" (the sentences of this hand with a suit or team mark), the
// table's tools and the keys line. Blocks are separated by thin rules, not boxes.

import type { VNode } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { suitOf } from '../../../engine/src/cards.ts';
import { Icon } from '../components/icons.tsx';
import { SuitGlyph } from '../deck/Card.tsx';
import { SUIT_KEYS } from '../deck/geometry.ts';
import { isKnownCard, teamLabel, type Names } from '../game-text.ts';
import { t } from '../i18n.ts';
import { useStoreSelect, type FeedItem } from '../store.ts';
import { feedSentence } from './Announcer.tsx';
import type { Model } from './model.ts';
import { KeysSwitch } from '../components/KeysSwitch.tsx';
import { Tools } from './Tools.tsx';

function feedText(item: FeedItem, n: Names): string {
  const s = feedSentence(item, n);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The feed items of the hand on screen: from its last deal on. */
export function handLog(feed: readonly FeedItem[]): FeedItem[] {
  let start = 0;
  for (let i = feed.length - 1; i >= 0; i--) {
    const it = feed[i];
    if (it.kind === 'event' && it.e.t === 'deal') {
      start = i;
      break;
    }
  }
  return feed.slice(start);
}

function LogIcon({ item }: { item: FeedItem }) {
  if (item.kind === 'phrase') return <span class="hand-log__dot" />;
  const e = item.e;
  if (e.t === 'play' && !e.faceDown && isKnownCard(e.card)) return <SuitGlyph suit={SUIT_KEYS[suitOf(e.card)]} plain />;
  if (e.t === 'raise' || e.t === 'accept' || e.t === 'run') return <b class="hand-log__t">T</b>;
  if (e.t === 'signal') return <Icon name="eye" />;
  return <span class="hand-log__dot" />;
}

function teamOf(item: FeedItem, m: Model): 'us' | 'them' | undefined {
  if (item.kind === 'phrase') return (item.seat & 1) === m.team ? 'us' : 'them';
  const e = item.e;
  if ('seat' in e) return (e.seat & 1) === m.team ? 'us' : 'them';
  if (e.t === 'round' && e.winnerSeat >= 0 && e.result !== 2) return (e.winnerSeat & 1) === m.team ? 'us' : 'them';
  if ((e.t === 'hand' || e.t === 'game' || e.t === 'match') && e.winner >= 0) return e.winner === m.team ? 'us' : 'them';
  return undefined;
}

function History({ m }: { m: Model }) {
  const v = m.v;
  const hist = v.history.filter((h) => h.matchNo === v.matchNo);
  // After a reload mid match only the hands seen since are known.
  const partial = (hist.length ? hist[0].handIndex : v.handIndex) > 0;
  // The same names as the score band: Nós and Eles in 2 against 2, Você and the opponent in 1 against 1.
  const team = (w: number) => (m.n === 2 ? teamLabel(m.names, w) : w === m.team ? t('board.team.us') : t('board.team.them'));
  const current = v.dealt && !v.handResult && !v.over && !m.ended;
  return (
    <>
      <div class="history" data-testid="hand-history">
        <div class="history__axis" aria-hidden="true">
          <span>{m.n === 2 ? teamLabel(m.names, m.team) : t('team.us')}</span>
          <span>{m.n === 2 ? teamLabel(m.names, 1 - m.team) : t('team.them')}</span>
        </div>
        <ol class="history__hands">
          {hist.map((h) => (
            <li key={h.handIndex} data-t={h.winner < 0 ? 'tie' : h.winner === m.team ? 'us' : 'them'} style={{ '--p': String(Math.min(h.points, 6)) }}>
              <span class="sr-only">{h.winner < 0 ? t('board.hist.tie', { n: h.handIndex + 1 }) : t('board.hist.hand', { n: h.handIndex + 1, team: team(h.winner), p: h.points })}</span>
            </li>
          ))}
          {current ? (
            <li class="is-now">
              <span class="sr-only">{t('board.hist.now', { v: v.value })}</span>
            </li>
          ) : null}
        </ol>
        <div class="history__total" aria-hidden="true">
          <b class="is-us">{v.score[m.team]}</b>
          <b class="is-them">{v.score[1 - m.team]}</b>
        </div>
      </div>
      <p class="side-panel__note">{t('board.side.histnote')}</p>
      {partial ? <p class="side-panel__note">{t('board.history.partial')}</p> : null}
    </>
  );
}

function HandLog({ m }: { m: Model }) {
  const feed = useStoreSelect((s) => s.feed);
  useStoreSelect((s) => s.lang);
  const items = handLog(feed);
  const list = useRef<HTMLOListElement>(null);
  // Whether the list showed its last line before this update: then it follows the newest line (a
  // person who scrolled up to read stays where they are). The top mask fades the older lines.
  const atEnd = useRef(true);
  const last = items.length ? items[items.length - 1].id : 0;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [last, items.length]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const follow = () => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return (
    <ol
      class="hand-log"
      data-testid="hand-log"
      ref={list}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {items.length === 0 ? (
        <li class="hand-log__empty">
          <span class="hand-log__ic" aria-hidden="true">
            <span class="hand-log__dot" />
          </span>
          <span>{t('board.log.empty')}</span>
        </li>
      ) : (
        items.map((it) => {
          const strong = it.kind === 'event' && (it.e.t === 'round' || it.e.t === 'hand' || it.e.t === 'raise' || it.e.t === 'game' || it.e.t === 'match');
          return (
            <li key={it.id} data-t={teamOf(it, m)} class={strong ? 'is-strong' : undefined}>
              <span class="hand-log__ic" aria-hidden="true">
                <LogIcon item={it} />
              </span>
              <span>{feedText(it, m.names)}</span>
            </li>
          );
        })
      )}
    </ol>
  );
}

export function SidePanel({ m, coach }: { m: Model; coach?: (() => VNode) | null }) {
  const keysOn = useStoreSelect((s) => s.keysOn);
  return (
    <aside class="side-panel" data-testid="side-panel" aria-labelledby="side-panel-title">
      <h2 id="side-panel-title" class="sr-only">
        {t('board.side.label')}
      </h2>
      {coach ? <div class="side-panel__coach">{coach()}</div> : null}
      <section class="side-panel__block">
        <h3 class="side-panel__title">{t('board.side.history')}</h3>
        <History m={m} />
      </section>
      <section class="side-panel__block side-panel__block--log">
        <h3 class="side-panel__title">{t('board.side.log')}</h3>
        <HandLog m={m} />
      </section>
      <div class="side-panel__foot">
        <Tools />
        <KeysSwitch testid="keys-switch-panel" class="side-panel__keys kbd-only" />
        <p class="keys kbd-only" hidden={!keysOn}>
          <kbd>1</kbd>
          <kbd>2</kbd>
          <kbd>3</kbd> {t('board.keys.cards')} · <kbd>T</kbd> {t('board.keys.truco')} · <kbd>A</kbd> {t('board.keys.accept')} · <kbd>C</kbd> {t('board.keys.run')} · <kbd>E</kbd>{' '}
          {t('board.keys.cover')} · <kbd>R</kbd> {t('board.keys.rules')}
        </p>
      </div>
    </aside>
  );
}
