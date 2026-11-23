import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { navigate, urlFor } from '../actions.ts';
import { t } from '../i18n.ts';
import type { AppState, Route } from '../store.ts';
// The connection badge is shared by the lobby, the opening screen and the table.
import '../styles/conn.css';

export const SOURCE_URL = 'https://github.com/AndreiLud/zap';

export function portfolioUrl(lang: 'pt' | 'en'): string {
  return lang === 'en' ? 'https://andreiludescher.com/en' : 'https://andreiludescher.com';
}

/**
 * A link inside the site: a real address (new tab, copy link), navigated in place on a plain click.
 * `current` marks the current page ("page") or the section the page sits in ("true").
 */
export function Link(props: {
  to: Route;
  class?: string;
  testid?: string;
  current?: 'page' | 'true';
  ariaLabel?: string;
  onNavigate?(): void;
  children: ComponentChildren;
}) {
  return (
    <a
      href={urlFor(props.to)}
      class={props.class}
      data-testid={props.testid}
      aria-current={props.current}
      aria-label={props.ariaLabel}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        props.onNavigate?.();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

/** A link that opens in a new tab, with the hidden "(opens in a new tab)" for screen readers. */
export function ExternalLink(props: { href: string; class?: string; testid?: string; children: ComponentChildren }) {
  return (
    <a href={props.href} class={props.class} target="_blank" rel="noopener" data-testid={props.testid}>
      {props.children}
      <span class="sr-only"> {t('link.newtab')}</span>
    </a>
  );
}

/** A native modal dialog: Esc closes it, focus stays inside while it is open. */
export function Dialog(props: { open: boolean; onClose(): void; labelledBy: string; class?: string; testid?: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} class={props.class ?? 'dialog'} aria-labelledby={props.labelledBy} data-testid={props.testid} onClose={() => props.open && props.onClose()}>
      {props.open ? props.children : null}
    </dialog>
  );
}

export function ConnStatus({ s }: { s: AppState }) {
  const state = s.conn === 'online' ? 'online' : s.conn === 'offline' ? 'offline' : 'reconnecting';
  const key = s.conn === 'online' ? 'conn.online' : s.conn === 'offline' ? 'conn.offline' : s.conn === 'connecting' ? 'conn.connecting' : 'conn.reconnecting';
  return (
    <p class={`conn conn-${state}`} data-testid="conn-status" data-state={state} role="status">
      <span class="dot" aria-hidden="true" />
      <span class="conn-text">{t(key)}</span>
    </p>
  );
}
