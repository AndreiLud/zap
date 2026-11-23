// Small pieces shared by the rules page and the quick rules dialog: text with components in its
// placeholders, the plural of "tento", the manilha star, the order of the ten ranks in one line and
// the four manilha cards with their names.

import type { ComponentChildren } from 'preact';
import { rankOf, suitOf } from '../../../engine/src/cards.ts';
import { Card, RankText } from '../deck/Card.tsx';
import { RANK_TEXTS } from '../deck/geometry.ts';
import { MANILHA_IDS } from '../deck/names.ts';
import { cardName } from '../game-text.ts';
import { t, type Key, type Vars } from '../i18n.ts';

/**
 * A translated sentence whose {placeholders} are components (a rank with its drawn Q, a bold
 * value). Plain text placeholders still come through `vars`. No markup is parsed.
 */
export function tx(key: Key, parts: Record<string, ComponentChildren>, vars?: Vars): ComponentChildren[] {
  const text = t(key, vars);
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (!(m[1] in parts)) continue;
    out.push(text.slice(last, m.index));
    out.push(parts[m[1]]);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** "1 tento", "3 tentos" ("1 point", "3 points"). */
export function tentos(n: number): string {
  return t(n === 1 ? 'rulebook.tentos.one' : 'rulebook.tentos.other', { n });
}

/** "seis, nove e doze" from a list of words. */
export function joinWords(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} ${t('rulebook.and')} ${words[words.length - 1]}`;
}

/** The spoken name of a rank alone: "6", "dama", "rei". */
export function rankWord(rank: number): string {
  return t(`rank.${rank}` as Key);
}

/** "o 7 de copas" / "the 7 of hearts". */
export function cardWithArticle(card: number): string {
  return t('card.of', { rank: t(`rank.the.${rankOf(card)}` as Key), suit: t(`suit.${suitOf(card)}` as Key) });
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The four point star of the manilha seal, as a glyph next to text. */
export function Star({ class: cls }: { class?: string }) {
  return (
    <svg class={`star${cls ? ` ${cls}` : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 0l2.2 5.8L16 8l-5.8 2.2L8 16l-2.2-5.8L0 8l5.8-2.2Z" />
    </svg>
  );
}

/** A rank set in type (the Q with its tail). */
export function Rank({ rank }: { rank: number }) {
  return <RankText rank={RANK_TEXTS[rank]} />;
}

/**
 * The ten ranks in one line of ten equal columns, strongest first, the manilha rank starred and
 * filled (shape and color, so color is never the only cue). One image for screen readers.
 */
export function OrderLine({ order, manilhaRank, label }: { order: readonly number[]; manilhaRank: number | null; label: string }) {
  return (
    <div class="order-line">
      <div class="order-line__ranks" role="img" aria-label={label}>
        {order.map((r) => (
          <span key={r} class={`order-line__rank${r === manilhaRank ? ' is-manilha' : ''}`} aria-hidden="true">
            {r === manilhaRank ? <Star /> : null}
            <Rank rank={r} />
          </span>
        ))}
      </div>
      <p class="order-line__axis" aria-hidden="true">
        <span>{t('rulebook.order.hi')}</span>
        <span>{t('rulebook.order.lo')}</span>
      </p>
    </div>
  );
}

/** The accessible text of an order line: "7 (manilha), 3, 2, ás, rei...". */
export function orderLabel(order: readonly number[], manilhaRank: number | null): string {
  const list = order.map((r) => (r === manilhaRank ? `${rankWord(r)} (${t('rulebook.star')})` : rankWord(r))).join(', ');
  return t('rulebook.m.order.aria', { list });
}

/** The name of the manilha a card would be: zap, copas, espadilha or pica-fumo. */
export function manilhaName(card: number): string {
  return t(`glossary.${MANILHA_IDS[suitOf(card)]}.name` as Key);
}

/**
 * The four manilhas as cards with their names and card names, strongest first. `size` "big" on the
 * rules page, "small" in the dialog (a short list in two columns).
 */
export function ManilhaCards({ cards, size, label, tips, animate }: { cards: readonly number[]; size: 'big' | 'small'; label: string; tips?: boolean; animate?: number }) {
  return (
    <ol class={`manilha-cards manilha-cards--${size}`} aria-label={label} key={animate}>
      {cards.map((c, i) => (
        <li key={c} class="manilha-cards__item" style={{ '--i': String(i) }}>
          <span class="manilha-cards__card">
            <Card card={c} manilha />
          </span>
          <span class="manilha-cards__text">
            <b>{manilhaName(c)}</b>
            <small>{cardName(c)}</small>
            {tips && i === 0 ? <span class="manilha-cards__tip">{t('rulebook.order.hi')}</span> : null}
            {tips && i === cards.length - 1 ? <span class="manilha-cards__tip">{t('rulebook.order.lo')}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
