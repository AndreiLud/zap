// Shared pieces of the end-to-end tests: one Player per browser context (one device), a recorder
// of every WebSocket message the page receives, the human check, rooms, a play loop that clicks
// like a person, and the checks that each page only ever holds its own hand.
//
// The tests drive the page only through the data-testid contract and accessible names; the
// recorded messages are read to check what the server sent, never to decide for the page.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { devices, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page, type WebSocket as PwWebSocket } from '@playwright/test';
import type { ServerMsg } from '../../../shared/protocol.ts';
import { ADULT_KEY, NOTICE_KEY, NOTICE_VERSION } from '../../../web/src/consent-keys.ts';

export type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
export type GameMsg = Extract<ServerMsg, { t: 'game' }>;

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8788';
export const SHOTS_DIR = fileURLToPath(new URL('../../../_local/e2e-shots/', import.meta.url));
mkdirSync(SHOTS_DIR, { recursive: true });

/** Waiting times of the end-to-end site (ROOM_TIME_SCALE 0.05). */
export const SCALE = 0.05;
export const GRACE_MS = 20_000 * SCALE;
export const ABANDON_MS = 120_000 * SCALE;
export const turnMs = (seconds: number) => seconds * 1000 * SCALE;

export const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;
const SIGNAL_NAMES = ['zap', 'copas', 'espadilha', 'picafumo', 'tres', 'nada'] as const;
const SUIT_SYMBOLS = /[♦♠♥♣]/;

export const PHONE: BrowserContextOptions = { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } };
export const DESKTOP: BrowserContextOptions = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------------------------------------------
// Card names, as the page reads them to screen readers (aria-label of hand-card-N).

function readLocale(file: string): Record<string, string> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../../locales/${file}`, import.meta.url)), 'utf8')) as Record<string, string>;
}

/** Every text of one language: the shared file and every area file (legal included), as the client merges them. */
export function texts(lang: 'pt' | 'en'): Record<string, string> {
  const suffix = lang === 'pt' ? 'pt-BR' : 'en';
  const dir = fileURLToPath(new URL('../../../locales/', import.meta.url));
  const out: Record<string, string> = { ...readLocale(`${suffix}.json`) };
  for (const name of readdirSync(dir)) if (new RegExp(`^[a-z]+\\.${suffix}\\.json$`).test(name)) Object.assign(out, readLocale(name));
  return out;
}

const CARD_BY_NAME = new Map<string, number>();
for (const dict of [readLocale('pt-BR.json'), readLocale('en.json')]) {
  for (let rank = 0; rank < 10; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      const name = dict['card.of'].replace('{rank}', dict[`rank.${rank}`]).replace('{suit}', dict[`suit.${suit}`]);
      CARD_BY_NAME.set(name.toLowerCase(), rank * 4 + suit);
    }
  }
}

/** Card id from the accessible name of a hand card ("7 de copas, manilha"), or null when hidden. */
export function cardFromLabel(label: string): number | null {
  const name = label.split(',')[0].trim().toLowerCase();
  return CARD_BY_NAME.get(name) ?? null;
}

// -------------------------------------------------------------------------------------------------
// One device

interface Rec {
  at: number;
  page: number;
  msg: ServerMsg;
}

interface DomSample {
  page: number;
  matchNo: number;
  handIndex: number;
  cards: number[];
}

export interface TableState {
  ended: boolean;
  accept: boolean;
  run: boolean;
  raise: boolean;
  cards: number[];
  signals: string[];
  labels: (string | null)[];
  seatText: (string | null)[];
  /** For each seat, the data-card values of the SVG cards drawn inside seat-N (-1 is a back). */
  seatCards: number[][];
}

export class Player {
  readonly name: string;
  readonly ctx: BrowserContext;
  page!: Page;
  /** Every message received, on every page this device opened. */
  readonly recs: Rec[] = [];
  readonly sent: { page: number; data: string }[] = [];
  readonly sockets: PwWebSocket[] = [];
  readonly errors: string[] = [];
  readonly samples: DomSample[] = [];
  /** Problems found while sampling the screen; checked at the end of each test. */
  readonly problems: string[] = [];
  /** Content Security Policy violations reported by the site's pages (CLIENT-SPEC 17); close() fails the test on any. */
  readonly csp: string[] = [];
  pageNo = 0;
  moves = 0;

  private constructor(name: string, ctx: BrowserContext) {
    this.name = name;
    this.ctx = ctx;
  }

  /**
   * A new device. By default it already answered the age gate (18 or older) and read the notice,
   * as a person who played before; fresh: true starts from a browser that never answered.
   */
  static async create(browser: Browser, name: string, options: BrowserContextOptions, o: { fresh?: boolean } = {}): Promise<Player> {
    const ctx = await browser.newContext({ ...options, baseURL: BASE_URL, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', acceptDownloads: true });
    if (!o.fresh) {
      // Once per tab, and only on the site itself (not in the Turnstile frame): a later "Apagar meus
      // dados" in the same tab still finds the answers gone after a reload.
      await ctx.addInitScript(
        ([adultKey, noticeKey, version, origin]) => {
          try {
            if (location.origin !== origin) return;
            if (!sessionStorage.getItem('zap-e2e-consent')) {
              localStorage.setItem(adultKey, '1');
              localStorage.setItem(noticeKey, version);
              sessionStorage.setItem('zap-e2e-consent', '1');
            }
          } catch {
            // about:blank and other pages without storage.
          }
        },
        [ADULT_KEY, NOTICE_KEY, NOTICE_VERSION, new URL(BASE_URL).origin] as const,
      );
    }
    // Each device checks in from its own address, so the per-address limit of the human check
    // and of recovery (10 a minute) does not couple devices. Only our own API sees this header.
    const ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    await ctx.route(/\/api\/(session|recover)$/, async (route) => {
      const headers = { ...(await route.request().allHeaders()), 'cf-connecting-ip': ip };
      await route.continue({ headers });
    });
    const p = new Player(name, ctx);
    await p.openPage();
    return p;
  }

  /** Opens a new tab in this device and starts recording its WebSocket. */
  async openPage(): Promise<Page> {
    const page = await this.ctx.newPage();
    const no = ++this.pageNo;
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/api/rooms/')) return;
      this.sockets.push(ws);
      ws.on('framereceived', ({ payload }) => {
        const text = typeof payload === 'string' ? payload : payload.toString('utf8');
        if (text === '{"t":"pong"}') return;
        try {
          this.recs.push({ at: Date.now(), page: no, msg: JSON.parse(text) as ServerMsg });
        } catch {
          this.problems.push(`${this.name}: a message that is not JSON: ${text.slice(0, 80)}`);
        }
      });
      ws.on('framesent', ({ payload }) => {
        this.sent.push({ page: no, data: typeof payload === 'string' ? payload : payload.toString('utf8') });
      });
    });
    page.on('pageerror', (e) => this.errors.push(`${this.name} page ${no}: ${e.message}`));
    // Every violation of the site's Content Security Policy is a problem (CLIENT-SPEC 17): the
    // listener runs in the site's own frames only, not in the Turnstile frame.
    await page.exposeBinding('__zapCspViolation', (_src, text: string) => {
      const line = `${this.name} page ${no}: CSP violation: ${text}`;
      this.csp.push(line);
      this.problems.push(line);
    });
    await page.addInitScript((origin: string) => {
      if (location.origin !== origin) return;
      document.addEventListener('securitypolicyviolation', (e) => {
        const report = (window as unknown as { __zapCspViolation?: (t: string) => void }).__zapCspViolation;
        report?.(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || location.pathname}:${e.lineNumber}`);
      });
    }, new URL(BASE_URL).origin);
    this.page = page;
    return page;
  }

  /** Closes the device; a page that broke the Content Security Policy fails the test. */
  async close(): Promise<void> {
    expect.soft(this.csp, `${this.name}: Content Security Policy violations`).toEqual([]);
    await this.ctx.close().catch(() => {});
  }

  roomMsgs(page = this.pageNo): RoomMsg[] {
    return this.recs.filter((r) => r.page === page && r.msg.t === 'room').map((r) => r.msg as RoomMsg);
  }

  gameMsgs(page = this.pageNo): GameMsg[] {
    return this.recs.filter((r) => r.page === page && r.msg.t === 'game').map((r) => r.msg as GameMsg);
  }

  lastRoom(): RoomMsg | null {
    const all = this.roomMsgs();
    return all.length ? all[all.length - 1] : null;
  }

  lastGame(): GameMsg | null {
    const all = this.gameMsgs();
    return all.length ? all[all.length - 1] : null;
  }

  /** This device's seat, as the server last said. */
  get seat(): number {
    const you = this.lastRoom()?.you;
    if (you === null || you === undefined) throw new Error(`${this.name} has no seat`);
    return you;
  }

  /** Waits until the server sends a game message newer than seq. */
  async waitForSeqAbove(seq: number, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if ((this.lastGame()?.seq ?? -1) > seq) return true;
      await sleep(15);
    }
    return false;
  }

  async shot(name: string): Promise<void> {
    await this.page.screenshot({ path: `${SHOTS_DIR}${name}.png`, fullPage: true }).catch(() => {});
  }

  /**
   * Checks what the screen shows against the last game message: the hand on screen is this
   * seat's own hand, and no other seat shows a card face (except the partner's cards in a mão
   * de onze, which the server sends only to that team).
   */
  checkScreen(st: TableState): void {
    const g = this.lastGame();
    if (!g) return;
    const shown = st.labels.filter((l): l is string => l !== null).map(cardFromLabel);
    const known = shown.filter((c): c is number => c !== null);
    const own = new Set(g.obs.hand.filter((c) => c >= 0));
    // The view may be one message behind the recorder; a stale sample is dropped, not judged.
    if (known.some((c) => !own.has(c))) return;
    if (known.length) this.samples.push({ page: this.pageNo, matchNo: g.matchNo, handIndex: g.obs.handIndex, cards: known });
    const you = g.obs.seat;
    st.seatText.forEach((text, seat) => {
      if (text === null || seat === you) return;
      const partnerVisible = g.obs.partnerHand !== null && seat === (you + 2) % 4;
      if (partnerVisible) return;
      if (SUIT_SYMBOLS.test(text)) this.problems.push(`${this.name}: seat ${seat} shows a card face on screen: "${text}"`);
      // Cards are SVG: a face shows as data-card at or above 0 inside the seat.
      const faces = (st.seatCards[seat] ?? []).filter((c) => c >= 0);
      if (faces.length) this.problems.push(`${this.name}: seat ${seat} shows card faces on screen: ${faces.join(',')}`);
    });
  }
}

export async function newPlayers(browser: Browser, specs: [string, BrowserContextOptions][]): Promise<Player[]> {
  return Promise.all(specs.map(([name, opts]) => Player.create(browser, name, opts)));
}

// -------------------------------------------------------------------------------------------------
// Human check, rooms and seats

/** The human check: the Turnstile dialog opens, passes with the test key and closes by itself. */
export async function passHumanCheck(page: Page): Promise<void> {
  const widget = page.getByTestId('turnstile');
  await expect(widget, 'the human check dialog opens').toBeVisible({ timeout: 15_000 });
  await expect(widget, 'Turnstile passes and the dialog closes').toBeHidden({ timeout: 60_000 });
}

export type TurnChoice = '15' | '30' | '60' | 'none';

/**
 * Quick play from the Play page (/jogar), which must be open: picks the mode tile (1 against 1 or
 * 2 against 2) and presses "Play now" (play.play). The age gate, the notice and the human check follow.
 */
export async function startSolo(page: Page, players: 2 | 4): Promise<void> {
  await page.getByTestId(players === 2 ? 'mode-1x1' : 'mode-2x2').click();
  await page.getByTestId('play-now').click();
}

/** Creates a room from the room mode of the Play page and returns its code (the owner sits at seat 0). */
export async function createRoom(p: Player, o: { players: 2 | 4; variant?: 'paulista' | 'mineiro'; turn: TurnChoice }): Promise<string> {
  const page = p.page;
  await page.goto('/jogar');
  await page.getByTestId('mode-room').click();
  await page.getByTestId(`variant-${o.variant ?? 'paulista'}`).click();
  await page.getByTestId('room-players').selectOption(String(o.players));
  await page.getByTestId('room-turn').selectOption(o.turn);
  await page.getByTestId('create-room-submit').click();
  await passHumanCheck(page);
  const codeEl = page.getByTestId('room-code');
  await expect(codeEl).toBeVisible({ timeout: 20_000 });
  const code = (await codeEl.innerText()).trim();
  expect(code).toMatch(CODE_RE);
  await expect(page).toHaveURL(new RegExp(`[?&]sala=${code}$`));
  await expect(page.getByTestId('invite-link')).toContainText(`/s/${code}`);
  await expect(page.getByTestId('start-button')).toBeVisible();
  return code;
}

/** Joins a room by typing its code in the room mode of the Play page; the server seats the person in the first free seat. */
export async function joinByCode(p: Player, code: string): Promise<void> {
  const page = p.page;
  await page.goto('/jogar?modo=sala');
  await page.getByTestId('join-code-input').fill(code.toLowerCase());
  await page.getByTestId('join-submit').click();
  await passHumanCheck(page);
  await expect(page.getByTestId('room-code')).toHaveText(code, { timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`[?&]sala=${code}$`));
}

/** Joins a room through its invite link (/s/CODE redirects to /?sala=CODE). */
export async function joinByInvite(p: Player, invite: string, code: string): Promise<void> {
  const page = p.page;
  await page.goto(invite);
  await passHumanCheck(page);
  await expect(page.getByTestId('room-code')).toHaveText(code, { timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`[?&]sala=${code}$`));
}

/**
 * A table tool (report, mute, leave). From 64em it sits in the side panel; below 64em in the menu
 * sheet's group "This table" (shell.sheet.table), so the menu opens first.
 */
export async function tableTool(page: Page, testid: string): Promise<Locator> {
  const menu = page.getByTestId('menu-button');
  if (await menu.isVisible()) {
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
    await expect(page.getByTestId('site-sheet')).toBeVisible();
  }
  return page.getByTestId(testid);
}

export async function expectSeat(page: Page, seat: number, attrs: { kind?: string; connected?: boolean; aiPlaying?: boolean }, timeout = 10_000): Promise<void> {
  const el = page.getByTestId(`seat-${seat}`);
  if (attrs.kind !== undefined) await expect(el, `seat ${seat} kind`).toHaveAttribute('data-kind', attrs.kind, { timeout });
  if (attrs.connected !== undefined) await expect(el, `seat ${seat} connected`).toHaveAttribute('data-connected', String(attrs.connected), { timeout });
  if (attrs.aiPlaying !== undefined) await expect(el, `seat ${seat} AI playing`).toHaveAttribute('data-ai-playing', String(attrs.aiPlaying), { timeout });
}

/** Waits until this page shows the table of a running match with its own cards. */
export async function expectTable(p: Player, timeout = 15_000): Promise<void> {
  await expect(p.page.getByTestId('turn-indicator')).toBeVisible({ timeout });
  await expect(p.page.getByTestId('score')).toBeVisible();
}

/**
 * Waits for a seat state that may last only a moment (a grace of 1 s here): checks on every
 * frame instead of the slower polling of expect().
 */
export async function waitForSeatState(page: Page, seat: number, attrs: { connected?: boolean; aiPlaying?: boolean; turnSeat?: number }, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    ([seat, connected, aiPlaying, turnSeat]) => {
      const el = document.querySelector(`[data-testid="seat-${seat}"]`);
      if (!el) return false;
      if (connected !== null && el.getAttribute('data-connected') !== String(connected)) return false;
      if (aiPlaying !== null && el.getAttribute('data-ai-playing') !== String(aiPlaying)) return false;
      if (turnSeat !== null && document.querySelector('[data-testid="turn-indicator"]')?.getAttribute('data-seat') !== String(turnSeat)) return false;
      return true;
    },
    [seat, attrs.connected ?? null, attrs.aiPlaying ?? null, attrs.turnSeat ?? null] as const,
    { polling: 'raf', timeout: timeoutMs },
  );
}

/** The seat made a move (card, bet, answer, mão de onze decision or signal) in this message. */
export function actsIn(g: GameMsg, seat: number): boolean {
  return g.events.some(({ e }) => 'seat' in e && e.seat === seat);
}

// -------------------------------------------------------------------------------------------------
// Playing

/** What a person does when it is their move: chances for each kind of answer. */
export interface Policy {
  /** Call truco (or the next bet) instead of playing a card, when allowed. */
  raise: number;
  /** When answering a bet: accept, run, otherwise raise again (or accept). */
  accept: number;
  run: number;
}

/** Bets often: matches end in a few hands. */
export const QUICK: Policy = { raise: 0.35, accept: 0.7, run: 0.15 };
/** Bets now and then and often runs: hands are worth 1 to 3 points, so a match lasts several hands. */
export const STEADY: Policy = { raise: 0.12, accept: 0.5, run: 0.4 };
/** Never bets and runs from every bet: hands stay cheap and the match lasts, for tests that need time. */
export const CALM: Policy = { raise: 0, accept: 0, run: 1 };

/**
 * Reads the table in one step and returns it when this page may act now (its turn, and a button
 * is enabled) or the match ended; null when nothing happened within timeoutMs.
 */
export async function waitForMove(page: Page, timeoutMs: number): Promise<TableState | null> {
  const handle = await page
    .waitForFunction(
      (signals: readonly string[]) => {
        const q = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
        // Hand cards use aria-disabled (focus stays on them between turns); buttons may use either.
        const enabled = (id: string) => {
          const b = q(id);
          return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
        };
        const ended = !!q('match-result');
        const turn = q('turn-indicator');
        const mine = !!turn && turn.getAttribute('data-mine') === 'true';
        const st = {
          ended,
          accept: enabled('action-accept'),
          run: enabled('action-run'),
          raise: enabled('action-raise'),
          cards: [0, 1, 2].filter((i) => enabled(`hand-card-${i}`)),
          signals: signals.filter((s) => enabled(`signal-${s}`)),
          labels: [0, 1, 2].map((i) => q(`hand-card-${i}`)?.getAttribute('aria-label') ?? null),
          seatText: [0, 1, 2, 3].map((i) => document.querySelector(`[data-testid="seat-${i}"]`)?.textContent ?? null),
          seatCards: [0, 1, 2, 3].map((i) => [...document.querySelectorAll(`[data-testid="seat-${i}"] [data-card]`)].map((e) => Number(e.getAttribute('data-card')))),
        };
        if (ended) return st;
        return mine && (st.accept || st.run || st.raise || st.cards.length > 0) ? st : false;
      },
      SIGNAL_NAMES,
      { polling: 30, timeout: timeoutMs },
    )
    .catch(() => null);
  if (!handle) return null;
  const st = (await handle.jsonValue()) as TableState;
  await handle.dispose().catch(() => {});
  return st;
}

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

export function choose(st: TableState, policy: Policy): string {
  if (st.accept || st.run) {
    const r = Math.random();
    if (st.accept && r < policy.accept) return 'action-accept';
    if (st.run && r < policy.accept + policy.run) return 'action-run';
    if (st.raise) return 'action-raise';
    return st.accept ? 'action-accept' : 'action-run';
  }
  if (st.raise && Math.random() < policy.raise) return 'action-raise';
  if (st.cards.length) return `hand-card-${pick(st.cards)}`;
  return 'action-raise';
}

/** Clicks one control and waits for the server's answer. Returns false when the click did not happen. */
export async function act(p: Player, testid: string): Promise<boolean> {
  const before = p.lastGame()?.seq ?? -1;
  const ok = await p.page
    .getByTestId(testid)
    .click({ timeout: 1_500 })
    .then(
      () => true,
      () => false,
    );
  if (!ok) return false;
  p.moves++;
  await p.waitForSeqAbove(before, 3_000);
  return true;
}

export interface LoopOptions {
  policy?: Policy;
  /** Stop when this returns true (checked between moves). */
  stop?: () => boolean;
  /** While this returns true the person does not act. */
  hold?: () => boolean;
  timeoutMs?: number;
}

/** Plays like a person (clicks a legal card or answers bets) until the match ends or stop() says so. */
export async function playLoop(p: Player, o: LoopOptions = {}): Promise<{ ended: boolean; moves: number }> {
  const policy = o.policy ?? QUICK;
  const until = Date.now() + (o.timeoutMs ?? 300_000);
  let moves = 0;
  while (Date.now() < until) {
    if (o.stop?.()) return { ended: false, moves };
    if (p.page.isClosed()) return { ended: false, moves };
    const st = await waitForMove(p.page, 500);
    if (!st) continue;
    if (st.ended) return { ended: true, moves };
    if (o.hold?.()) {
      await sleep(30);
      continue;
    }
    p.checkScreen(st);
    if (await act(p, choose(st, policy))) moves++;
  }
  throw new Error(`${p.name}: the match did not end in time (moves: ${moves})`);
}

/** Runs a play loop in the background; stop() ends it and waits for it. */
export function background(p: Player, o: Omit<LoopOptions, 'stop'> = {}): { stop(): Promise<void>; done: Promise<{ ended: boolean; moves: number }> } {
  let stopped = false;
  const done = playLoop(p, { ...o, stop: () => stopped });
  // A failure surfaces when the test awaits done or stop().
  done.catch(() => {});
  return {
    done,
    async stop() {
      stopped = true;
      await done;
    },
  };
}

// -------------------------------------------------------------------------------------------------
// What each page received

/** Score of the match as the page reads it to screen readers ("Placar: Nós 3, Eles 5"), as [team 0, team 1]. */
export async function shownScore(p: Player): Promise<[number, number]> {
  const label = (await p.page.getByTestId('score').getAttribute('aria-label')) ?? '';
  const m = /(\d+),[^,]*?(\d+)\s*$/.exec(label);
  if (!m) throw new Error(`${p.name}: cannot read the score from "${label}"`);
  const us = Number(m[1]);
  const them = Number(m[2]);
  return (p.seat & 1) === 0 ? [us, them] : [them, us];
}

interface HandKnowledge {
  own: Map<string, Set<number>>;
  partner: Map<string, Set<number>>;
  faceUp: Map<string, { seat: number; card: number }[]>;
}

const handKey = (matchNo: number, handIndex: number) => `${matchNo}:${handIndex}`;

function addTo<T>(m: Map<string, Set<T>>, key: string, xs: Iterable<T>): void {
  let s = m.get(key);
  if (!s) m.set(key, (s = new Set<T>()));
  for (const x of xs) s.add(x);
}

/**
 * Checks every game message one device received: it is addressed to its own seat, carries only
 * that seat's own cards, no face-down card of another seat, no partner cards outside a mão de onze
 * and no signal it did not catch. Returns what the seat knew, for the checks across devices.
 */
export function auditMessages(p: Player, problems: string[]): HandKnowledge {
  const k: HandKnowledge = { own: new Map(), partner: new Map(), faceUp: new Map() };
  const youByPage = new Map<number, number | null>();
  for (const r of p.recs) {
    const m = r.msg;
    if (m.t === 'room') {
      youByPage.set(r.page, m.you);
      continue;
    }
    if (m.t !== 'game') continue;
    const you = youByPage.get(r.page);
    const o = m.obs;
    const where = `${p.name} match ${m.matchNo} hand ${o.handIndex} seq ${m.seq}`;
    if (you === null || you === undefined) {
      problems.push(`${where}: game message before the seat was known`);
      continue;
    }
    if (o.seat !== you) problems.push(`${where}: observation for seat ${o.seat}, but this device sits at ${you}`);
    if (o.hand.length !== 3 || o.hand.some((c) => !(c === -1 || c === -2 || (c >= 0 && c < 40)))) problems.push(`${where}: odd hand ${JSON.stringify(o.hand)}`);
    const onzeTeam = o.players === 4 && o.kind === 'onze' && o.options.onzeSeesPartner && (you & 1) === o.onzeTeam && !o.over;
    if (o.partnerHand !== null && !onzeTeam) problems.push(`${where}: partner cards outside a mão de onze of this team`);
    const key = handKey(m.matchNo, o.handIndex);
    addTo(k.own, key, o.hand.filter((c) => c >= 0));
    if (o.partnerHand) addTo(k.partner, key, o.partnerHand.filter((c) => c >= 0));
    for (const round of o.rounds) {
      for (const play of round.plays) {
        if (play.seat === you) {
          if (play.card >= 0) addTo(k.own, key, [play.card]);
        } else if (play.faceDown && play.card !== -1) {
          problems.push(`${where}: face-down card of seat ${play.seat} revealed (${play.card})`);
        } else if (!play.faceDown) {
          const list = k.faceUp.get(key) ?? [];
          list.push({ seat: play.seat, card: play.card });
          k.faceUp.set(key, list);
        }
      }
    }
    for (const te of m.events) {
      const e = te.e;
      if (e.t === 'play' && e.seat !== you && e.faceDown && e.card !== -1) problems.push(`${where}: face-down play of seat ${e.seat} revealed in an event`);
      if (e.t === 'signal' && o.options.signals !== 'all' && e.seenBy !== 0) problems.push(`${where}: signal event tells who caught it`);
    }
  }
  return k;
}

/**
 * Across the devices of one room: no card is in two hands at once, a face-up card on the table
 * belongs to the hand of the seat that played it, the partner cards of a mão de onze are the
 * partner's real cards, and the hands the screens showed match.
 */
export function auditRoom(players: Player[]): { problems: string[]; hands: number; sharedHands: number } {
  const problems: string[] = [];
  const know = players.map((p) => auditMessages(p, problems));
  const seats = players.map((p) => p.seat);
  const keys = new Set(know.flatMap((k) => [...k.own.keys()]));
  for (const key of keys) {
    for (let i = 0; i < players.length; i++) {
      const a = know[i].own.get(key);
      if (!a) continue;
      if (a.size > 3) problems.push(`${players[i].name} ${key}: more than three own cards: ${[...a].join(',')}`);
      for (let j = i + 1; j < players.length; j++) {
        const b = know[j].own.get(key);
        if (!b) continue;
        const both = [...a].filter((c) => b.has(c));
        if (both.length) problems.push(`${key}: ${players[i].name} and ${players[j].name} both received card(s) ${both.join(',')}`);
      }
    }
    for (let i = 0; i < players.length; i++) {
      for (const play of know[i].faceUp.get(key) ?? []) {
        const owner = seats.indexOf(play.seat);
        const ownerCards = owner >= 0 ? know[owner].own.get(key) : undefined;
        if (ownerCards && !ownerCards.has(play.card)) problems.push(`${key}: ${players[i].name} saw seat ${play.seat} play ${play.card}, not in that seat's hand`);
      }
      const partnerCards = know[i].partner.get(key);
      if (partnerCards) {
        const partner = seats.indexOf((seats[i] + 2) % 4);
        const real = partner >= 0 ? know[partner].own.get(key) : undefined;
        if (real) for (const c of partnerCards) if (!real.has(c)) problems.push(`${key}: ${players[i].name} was told partner card ${c}, not in the partner's hand`);
      }
    }
  }
  // What the screens showed: each page's hand on screen is its own hand from the server, and no
  // two screens showed the same card in a hand during the same deal.
  const shown = new Map<string, Map<number, Set<number>>>();
  players.forEach((p, i) => {
    for (const s of p.samples) {
      const key = handKey(s.matchNo, s.handIndex);
      const own = know[i].own.get(key);
      for (const c of s.cards) if (own && !own.has(c)) problems.push(`${p.name} ${key}: card ${c} on screen is not its own`);
      const byPlayer = shown.get(key) ?? new Map<number, Set<number>>();
      const set = byPlayer.get(i) ?? new Set<number>();
      for (const c of s.cards) set.add(c);
      byPlayer.set(i, set);
      shown.set(key, byPlayer);
    }
  });
  for (const [key, byPlayer] of shown) {
    const entries = [...byPlayer];
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        const both = [...entries[a][1]].filter((c) => entries[b][1].has(c));
        if (both.length) problems.push(`${key}: screens of ${players[entries[a][0]].name} and ${players[entries[b][0]].name} both showed ${both.join(',')}`);
      }
    }
  }
  for (const p of players) problems.push(...p.problems, ...p.errors);
  // How many hands were compared: all of them, and those every device of the room received.
  const sharedHands = [...keys].filter((key) => know.every((k) => (k.own.get(key)?.size ?? 0) > 0)).length;
  return { problems, hands: keys.size, sharedHands };
}

/**
 * One tap of the guided practice hand: "Continuar", the answer to a truco, or the suggested card.
 * Returns what was tapped, or null when nothing could be tapped yet.
 */
export async function guidedTap(page: Page): Promise<'continuar' | 'aceito' | 'card' | null> {
  const next = page.getByTestId('coach-next');
  if (await next.isVisible()) {
    await next.tap();
    return 'continuar';
  }
  const accept = page.getByTestId('action-accept');
  if ((await accept.isVisible()) && (await accept.getAttribute('aria-disabled')) !== 'true') {
    await accept.tap();
    return 'aceito';
  }
  const suggested = page.locator('[data-testid^="hand-card-"][data-suggest]:not([aria-disabled="true"])');
  if (await suggested.count()) {
    await suggested.first().tap();
    return 'card';
  }
  return null;
}

/** Seconds a whole step took, for the logs. */
export function since(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
}

// -------------------------------------------------------------------------------------------------
// Contrast

/**
 * WCAG contrast of an element's text against what is behind it: the backgrounds of its ancestors
 * composited from the root down, and the opacity of every ancestor applied to the text. Entrance
 * animations of the element and its ancestors are finished first, so a fade caught halfway does
 * not count (the text is read once it is there).
 */
export async function textContrast(el: Locator): Promise<number> {
  return el.evaluate((node: Element) => {
    for (const a of document.getAnimations()) {
      const target = (a.effect as KeyframeEffect | null)?.target;
      if (target && target.contains(node) && a.effect?.getTiming().iterations !== Infinity) a.finish();
    }
    const parse = (c: string): number[] => {
      const srgb = c.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const over = (top: number[], below: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + below[i] * (1 - top[3])).concat(1);
    const chain: Element[] = [];
    for (let e: Element | null = node; e; e = e.parentElement) chain.unshift(e);
    let bg = [255, 255, 255, 1];
    let opacity = 1;
    for (const e of chain) {
      const cs = getComputedStyle(e);
      bg = over(parse(cs.backgroundColor), bg);
      opacity *= Number(cs.opacity);
    }
    const c = parse(getComputedStyle(node).color);
    const fg = over([c[0], c[1], c[2], c[3] * opacity], bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });
}
