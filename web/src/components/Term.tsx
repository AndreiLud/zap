// A glossary term in running text (CLIENT-SPEC 10.6): a button with a dotted underline that opens a
// small popover with the definition (glossary.<id>.def) and a link to the full glossary on the
// rules page. Esc and light dismiss come from the Popover API ([popover="auto"]); no script needed
// to close it. On phones the popover sits at the bottom of the screen; from 64em it opens under its
// term with CSS anchor positioning where the browser has it (styles/term.css). Each term names
// its own anchor, so several terms on one page never share one.
//
// The link goes to the rules page with the hash #glossario-<id>; the rules page scrolls to that
// anchor when it mounts. At a table (a room or the guided match) the link opens in a new tab, so
// the match stays connected.
//
// The data pages (DATA-SPEC 3.4) add two optional props: `text` gives the name and definition of a
// term that lives outside the glossary area (data.term.<id>.*), and `more` replaces the link
// ({ href, label } with an optional click handler, or null for no link at all).

import '../styles/term.css';
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { navigate, urlFor } from '../actions.ts';
import { t, type Key } from '../i18n.ts';
import { store } from '../store.ts';

/** The id of a definition key, distributed over every key of the union. */
type DefinedTerm<K> = K extends `glossary.${infer I}.def` ? I : never;

/** Every term with a definition in locales/glossary.*.json. */
export type GlossaryId = DefinedTerm<Key>;

/** Where the popover's link goes and what it says. `onClick` runs instead of the default move. */
export interface TermMore {
  href: string;
  label: Key;
  onClick?: (e: MouseEvent) => void;
}

interface TermCommon {
  children?: ComponentChildren;
  /** Replaces the link to the rules glossary; null leaves the popover without a link. */
  more?: TermMore | null;
}

export type TermProps =
  | (TermCommon & { id: GlossaryId; text?: undefined })
  | (TermCommon & { id: string; text: { name: string; def: string } });

export function Term({ id, children, more, text }: TermProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const tipId = `term-${id}-${uid}`;
  const anchorName = `--${tipId}`;
  const anchor = `glossario-${id}`;
  const href = `${urlFor({ name: 'rules' })}#${anchor}`;
  const route = store.get().route.name;
  const atTable = route === 'room' || route === 'guided';
  const name = text ? text.name : t(`glossary.${id}.name` as Key);
  const def = text ? text.def : t(`glossary.${id}.def` as Key);
  const close = (el: EventTarget | null) => ((el as HTMLElement | null)?.closest('[popover]') as HTMLElement | null)?.hidePopover?.();
  return (
    <>
      <button type="button" class="term" popovertarget={tipId} style={{ 'anchor-name': anchorName }}>
        {children ?? name}
      </button>
      <span id={tipId} class="tip" popover="auto" role="note" style={{ 'position-anchor': anchorName }}>
        <span class="tip__def">{def}</span>
        {more === null ? null : more ? (
          <a
            class="tip__more"
            href={more.href}
            onClick={(e) => {
              if (!more.onClick || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              close(e.currentTarget);
              more.onClick(e);
            }}
          >
            {t(more.label)}
          </a>
        ) : (
          <a
            class="tip__more"
            href={href}
            target={atTable ? '_blank' : undefined}
            rel={atTable ? 'noopener' : undefined}
            onClick={(e) => {
              if (atTable || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              close(e.currentTarget);
              navigate({ name: 'rules' }, { hash: `#${anchor}` });
            }}
          >
            {t('glossary.more')}
            {atTable ? <span class="sr-only"> {t('link.newtab')}</span> : null}
          </a>
        )}
      </span>
    </>
  );
}
