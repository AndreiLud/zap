// Cloudflare Turnstile, loaded only when a human check is needed (explicit rendering).

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface WidgetHandlers {
  onToken(token: string): void;
  onError(): void;
}

/**
 * Renders the widget into el and returns a function that removes it. The action ("play",
 * "delete" or "recover") is checked by the server, so a token works only for what it was made for.
 */
export async function renderWidget(el: HTMLElement, siteKey: string, language: string, action: string, h: WidgetHandlers): Promise<{ remove(): void; reset(): void }> {
  const ts = await loadTurnstile();
  const id = ts.render(el, {
    sitekey: siteKey,
    language,
    action,
    callback: (token: string) => h.onToken(token),
    'error-callback': () => h.onError(),
    'expired-callback': () => ts.reset(id),
  });
  return {
    remove: () => ts.remove(id),
    reset: () => ts.reset(id),
  };
}
