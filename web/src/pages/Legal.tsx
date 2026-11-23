// Privacidade, Termos and Como verificamos, rendered from locales/legal.*.json in file order, in
// the reading page look (pages/Doc.tsx, styles/page.css): a cover with the title, the version and
// the lede, then numbered sections with thin rules.
//
// Page keys have three parts (legal.<page>.title, updated, lede). Section keys have four,
// legal.<page>.<section>.<item>: "title" is the heading, pN a paragraph, liN a list item
// (consecutive ones form one list), ifContact and ifNoContact depend on the privacy contact
// (from /api/config), and go<Target> is a link.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { usePageFocus } from '../page-focus.ts';
import { api } from '../api.ts';
import { ExternalLink, Link, SOURCE_URL } from '../components/common.tsx';
import { legalKeys, t, type Key, type LegalKey } from '../i18n.ts';
import type { LegalRoute } from '../routes.ts';
import type { AppState } from '../store.ts';
import { TileStrip, sectionNumber } from './Doc.tsx';

export type LegalPageId = LegalRoute;

const EXTERNAL: Record<string, string> = {
  goLia: `${SOURCE_URL}/blob/main/project_docs/privacy-lia.md`,
  goCloudflare: 'https://www.cloudflare.com/privacypolicy/',
};
const INTERNAL: Record<string, LegalRoute | 'you'> = { goYou: 'you', goPrivacy: 'privacy', goTerms: 'terms', goVerify: 'verify' };

interface Section {
  id: string;
  keys: Key[];
}

function sectionsOf(page: LegalPageId): Section[] {
  const out: Section[] = [];
  for (const k of legalKeys(`legal.${page}.`)) {
    const parts = k.split('.');
    if (parts.length !== 4) continue;
    const id = parts[2];
    let sec = out[out.length - 1];
    if (!sec || sec.id !== id) out.push((sec = { id, keys: [] }));
    sec.keys.push(k);
  }
  return out;
}

/**
 * The privacy contact from /api/config: undefined while loading (or not asked yet), null when
 * there is none. The call carries nothing about the person; enabled waits for a reason to ask.
 */
export function usePrivacyContact(enabled = true): string | null | undefined {
  const [contact, setContact] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.config().then(
      (c) => live && setContact(c.privacyContact || null),
      () => live && setContact(null),
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return contact;
}

export { usePageFocus };

function renderItems(page: LegalPageId, sec: Section, index: number, contact: string | null | undefined): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let list: ComponentChildren[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul-${out.length}`} class="doc__list">{list}</ul>);
    list = [];
  };
  for (const k of sec.keys) {
    const item = k.split('.')[3];
    if (/^li\d+$/.test(item)) {
      list.push(<li key={k}>{t(k)}</li>);
      continue;
    }
    flush();
    if (item === 'title') {
      out.push(
        <div key={k} class="doc__head">
          <span class="doc__num" aria-hidden="true">
            {sectionNumber(index)}
          </span>
          <h2 id={`${page}-${sec.id}`}>{t(k)}</h2>
        </div>,
      );
    }
    else if (/^p\d+$/.test(item)) out.push(<p key={k}>{t(k)}</p>);
    else if (item === 'ifContact') {
      if (contact) out.push(<p key={k}>{t(k, { contact })}</p>);
    } else if (item === 'ifNoContact') {
      if (contact === null) out.push(<p key={k}>{t(k)}</p>);
    } else if (item in EXTERNAL) {
      out.push(
        <p key={k} class="doc__go">
          <ExternalLink href={EXTERNAL[item]}>{t(k)}</ExternalLink>
        </p>,
      );
    } else if (item in INTERNAL) {
      out.push(
        <p key={k} class="doc__go">
          <Link to={{ name: INTERNAL[item] }}>{t(k)}</Link>
        </p>,
      );
    } else {
      out.push(<p key={k}>{t(k)}</p>);
    }
  }
  flush();
  return out;
}

/** A different tile strip per page, the same on every load. */
const STRIP_SEED: Record<LegalPageId, number> = { privacy: 1811, terms: 1922, verify: 2026 };

export function LegalPage({ page, s }: { page: LegalPageId; s: AppState }) {
  const contact = usePrivacyContact();
  const title = usePageFocus(page);
  const has = (k: string) => legalKeys(k).includes(k as LegalKey);
  const sections = sectionsOf(page);
  return (
    <main id="main" class="page doc legal" data-testid={`page-${page}`}>
      <header class="doc__cover">
        <h1 ref={title} tabIndex={-1}>
          {t(`legal.${page}.title`)}
        </h1>
        {has(`legal.${page}.updated`) ? <p class="doc__updated">{t(`legal.${page}.updated` as Key)}</p> : null}
        <p class="doc__lede">{t(`legal.${page}.lede`)}</p>
        <TileStrip seed={STRIP_SEED[page]} />
      </header>
      {sections.map((sec, i) => (
        <section key={sec.id} class="doc__section legal__section" aria-labelledby={`${page}-${sec.id}`}>
          {renderItems(page, sec, i, contact)}
        </section>
      ))}
    </main>
  );
}
