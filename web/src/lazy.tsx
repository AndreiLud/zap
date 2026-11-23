// Code splitting without preact/compat: a component whose module loads on first render (or earlier,
// with preload()). Until it loads, the fallback renders (nothing by default). Used for the routes
// outside the table path (rules, guided, data, you, legal, not found), the table itself, the rules
// dialog and the age gate, so the entry chunk stays inside the budget of CLIENT-SPEC 18.

import type { ComponentChildren, ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export interface Lazy<P> {
  (props: P): ComponentChildren;
  /** Starts loading now (idle prefetch, or before a dialog opens). */
  preload(): Promise<ComponentType<P>>;
  /** True once the module is in. */
  readonly loaded: boolean;
}

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: (props: P) => ComponentChildren = () => null): Lazy<P> {
  let component: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = (): Promise<ComponentType<P>> => {
    pending ??= load().then(
      (c) => (component = c),
      (e: unknown) => {
        // A failed chunk (offline, a deploy in between) can be asked for again.
        pending = null;
        throw e;
      },
    );
    return pending;
  };
  function LazyComponent(props: P) {
    const [, tick] = useState(0);
    useEffect(() => {
      if (component) return;
      let live = true;
      preload().then(
        () => live && tick((x) => x + 1),
        () => {},
      );
      return () => {
        live = false;
      };
    }, []);
    const C = component;
    return C ? <C {...props} /> : fallback(props);
  }
  const out = LazyComponent as unknown as Lazy<P>;
  out.preload = preload;
  Object.defineProperty(out, 'loaded', { get: () => component !== null });
  return out;
}
