// Records the README's hero GIFs from the real site running locally: a quick play match of 1
// against 1 against the AI (a card is played, the person calls truco, the AI answers, preferably by
// raising back, the hand ends and its points are counted), then about one second of the data
// page's first figure, the learning cycle. Two steps, each in its own container
// (tools/media/README.md):
//
//   shoot   Playwright screenshots of the page at a steady rate (each frame keeps the time it was
//           taken), into .cache/media/<lang>/. Needs the Playwright image and the local site.
//   encode  The frames into one looping GIF with ffmpeg (palettegen and paletteuse): the frame
//           times are turned into a constant rate, the picture scaled to the output width. Writes
//           project_docs/media/zap-<lang>.gif and prints its size and duration, read back from the
//           GIF file itself. Needs an image with ffmpeg 5 or newer and Node 22.18 or newer.
//
// The match is real: the deal comes from the server's random seed and the AI decides on its own,
// so every run gives another hand. The site must be a local one (wrangler dev with the Turnstile
// test keys): the human check passes by itself there.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Page } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRAMES_ROOT = join(ROOT, '.cache', 'media');
const OUT_DIR = join(ROOT, 'project_docs', 'media');

type Lang = 'pt' | 'en';

interface Options {
  langs: Lang[];
  base: string;
  /** Output frames per second (the GIF's delay is 100 / fps centiseconds). */
  fps: number;
  /** Width of the GIF in pixels; the height follows the viewport's ratio. */
  width: number;
  /** Colors of the GIF's one palette. */
  colors: number;
  viewport: { width: number; height: number };
  /** Seconds of the data page's cycle figure at the end. */
  dataSeconds: number;
  /** Shortest and longest GIF accepted, in seconds; a longer hand is left out (another deal). */
  minSeconds: number;
  maxSeconds: number;
  /** Matches to start before giving up, and hands to play in each. */
  tries: number;
  hands: number;
  /** Largest GIF accepted, in bytes. */
  maxBytes: number;
  /** Optional facts file (the format of tools/docs/facts-docs.ts) to receive sizes and durations. */
  facts: string | null;
}

function options(argv: string[]): { command: string; o: Options } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: 'string', default: 'pt,en' },
      base: { type: 'string', default: process.env.ZAP_BASE ?? 'http://zap-dev-1:8787' },
      fps: { type: 'string', default: '10' },
      width: { type: 'string', default: '800' },
      colors: { type: 'string', default: '192' },
      viewport: { type: 'string', default: '1280x800' },
      'data-seconds': { type: 'string', default: '1' },
      'min-seconds': { type: 'string', default: '8' },
      'max-seconds': { type: 'string', default: '12' },
      tries: { type: 'string', default: '3' },
      hands: { type: 'string', default: '4' },
      'max-bytes': { type: 'string', default: String(3 * 1024 * 1024) },
      facts: { type: 'string' },
    },
  });
  const langs = values.lang.split(',').map((s) => s.trim());
  for (const l of langs) if (l !== 'pt' && l !== 'en') throw new Error(`--lang: pt, en or pt,en (got ${l})`);
  const [vw, vh] = values.viewport.split('x').map(Number);
  if (!(vw > 0 && vh > 0)) throw new Error('--viewport: <width>x<height>');
  return {
    command: positionals[0] ?? '',
    o: {
      langs: langs as Lang[],
      base: values.base.replace(/\/+$/, ''),
      fps: Number(values.fps),
      width: Number(values.width),
      colors: Number(values.colors),
      viewport: { width: vw, height: vh },
      dataSeconds: Number(values['data-seconds']),
      minSeconds: Number(values['min-seconds']),
      maxSeconds: Number(values['max-seconds']),
      tries: Number(values.tries),
      hands: Number(values.hands),
      maxBytes: Number(values['max-bytes']),
      facts: values.facts ? resolve(values.facts) : null,
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const framesDir = (lang: Lang) => join(FRAMES_ROOT, lang);

/** One saved frame and when it was taken, in ms from the start of the recording. */
interface Frame {
  file: string;
  at: number;
}

/** What happened during the recording, for the log (ms from the start). */
interface Mark {
  at: number;
  what: string;
}

interface Shot {
  frames: Frame[];
  marks: Mark[];
  /** When the recording ended (the last frame lasts until then). */
  end: number;
}

// -------------------------------------------------------------------------------------------------
// shoot

type Pg = Page;
type Ev = { t: string; seat?: number };

/**
 * Screenshots of one page at a steady rate into a folder, each frame with the time it was taken.
 * A slow screenshot does not shift the schedule: the next one is taken at once and keeps its time.
 */
class Recorder {
  readonly frames: Frame[] = [];
  readonly marks: Mark[] = [];
  private stopped = false;
  private loop: Promise<void> = Promise.resolve();
  private t0 = 0;

  readonly dir: string;
  private readonly page: Pg;
  private readonly fps: number;
  /** Time and file number of the first frame: a second part follows the first one. */
  private readonly offset: number;
  private readonly firstIndex: number;

  constructor(dir: string, page: Pg, fps: number, offset = 0, firstIndex = 0) {
    this.dir = dir;
    this.page = page;
    this.fps = fps;
    this.offset = offset;
    this.firstIndex = firstIndex;
  }

  now(): number {
    return this.offset + (performance.now() - this.t0);
  }

  mark(what: string, at = this.now()): void {
    this.marks.push({ at, what });
  }

  start(): this {
    mkdirSync(this.dir, { recursive: true });
    this.t0 = performance.now();
    const step = 1000 / this.fps;
    this.loop = (async () => {
      let next = this.offset;
      while (!this.stopped) {
        const at = this.now();
        const png = await this.page.screenshot({ type: 'png', caret: 'initial' });
        const file = `f${String(this.firstIndex + this.frames.length).padStart(5, '0')}.png`;
        writeFileSync(join(this.dir, file), png);
        this.frames.push({ file, at });
        next = Math.max(next + step, this.now());
        await sleep(Math.max(0, next - this.now()));
      }
    })();
    return this;
  }

  async stop(): Promise<Shot> {
    this.stopped = true;
    await this.loop;
    return { frames: this.frames, marks: this.marks.sort((x, y) => x.at - y.at), end: this.now() };
  }
}

/** The table's state, read in one step from the data-testid contract (as the e2e suite does). */
interface TableNow {
  mine: boolean;
  cards: number[];
  raise: boolean;
  accept: boolean;
  over: boolean;
}

async function tableNow(page: Pg): Promise<TableNow> {
  return page.evaluate(() => {
    const q = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    const enabled = (id: string) => {
      const b = q(id);
      return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    };
    const turn = q('turn-indicator');
    return {
      mine: !!turn && turn.getAttribute('data-mine') === 'true',
      cards: [0, 1, 2].filter((i) => enabled(`hand-card-${i}`)),
      raise: enabled('action-raise'),
      accept: enabled('action-accept'),
      over: !!q('match-result'),
    };
  });
}


/**
 * Seconds of the data page after a take: dataSeconds, or more when the hand was short (the AI ran
 * at once), so the GIF lasts at least minSeconds; never more than 3.
 */
function tailSeconds(takeMs: number, o: Options): number {
  return Math.min(3, Math.max(o.dataSeconds, o.minSeconds + 0.3 - takeMs / 1000));
}

/** One hand of the match, recorded from its deal to its result; the AI's answer to the person's truco, if any. */
interface Take {
  shot: Shot;
  dir: string;
  answer: string | null;
  /** The hand ended the match: the match result covers the table. */
  matchOver: boolean;
}

async function shoot(o: Options, lang: Lang): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const { ADULT_KEY, NOTICE_KEY, NOTICE_VERSION } = await import('../../web/src/consent-keys.ts');
  const { ROUTE_PATHS } = await import('../../web/src/routes.ts');
  const origin = new URL(o.base).origin;
  const root = framesDir(lang);
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-takes`, { recursive: true, force: true });
  const browser = await chromium.launch();
  let fallback: Take | null = null;
  let chosen: Take | null = null;
  try {
    const context = await browser.newContext({
      baseURL: o.base,
      viewport: o.viewport,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      locale: lang === 'pt' ? 'pt-BR' : 'en-US',
      timezoneId: 'America/Sao_Paulo',
    });
    // A person who already answered the age gate and read the notice, as on a second visit.
    await context.addInitScript(
      ([adultKey, noticeKey, version, own]) => {
        try {
          if (location.origin !== own) return;
          localStorage.setItem(adultKey, '1');
          localStorage.setItem(noticeKey, version);
        } catch {
          // Pages without storage.
        }
      },
      [ADULT_KEY, NOTICE_KEY, NOTICE_VERSION, origin] as const,
    );
    // Its own address for the per address limit of the human check (a local site reads this header).
    const ip = `198.18.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    await context.route(/\/api\/session$/, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), 'cf-connecting-ip': ip } }));

    // The data page, in its own tab, left on the cycle figure (clear of the sticky chapter nav).
    const data = await context.newPage();
    await data.goto(`${ROUTE_PATHS.data[lang]}#ciclo`);
    const cycle = data.locator('#ciclo');
    await cycle.waitFor({ state: 'visible', timeout: 30_000 });
    await data.evaluate(() => document.fonts.ready.then(() => undefined));
    // Centered, then moved down when the next heading would show cut at the bottom edge, as far as
    // the figure's own last line allows.
    await cycle.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      const next = [...document.querySelectorAll('h2, h3, h4')].find(
        (x) => !el.contains(x) && !!(el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) && x.getBoundingClientRect().height > 0,
      );
      if (!next) return;
      const top = next.getBoundingClientRect().top;
      const room = window.innerHeight - el.getBoundingClientRect().bottom;
      if (top < window.innerHeight && room > 0) window.scrollBy(0, -Math.min(window.innerHeight - top + 4, room));
    });

    for (let match = 1; match <= o.tries && !chosen; match++) {
      const page = await context.newPage();
      const events: { at: number; e: Ev }[] = [];
      let you = -1;
      page.on('websocket', (ws) => {
        ws.on('framereceived', ({ payload }) => {
          try {
            const msg = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8')) as { t?: string; you?: number | null; events?: { e: Ev }[] };
            if (msg.t === 'room' && typeof msg.you === 'number') you = msg.you;
            if (msg.t === 'game') for (const x of msg.events ?? []) events.push({ at: performance.now(), e: x.e });
          } catch {
            // Not JSON.
          }
        });
      });
      await page.goto(ROUTE_PATHS.play[lang]);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.getByTestId('mode-1x1').click();
      await page.getByTestId('play-now').click();
      // The human check opens unless this browser passed it less than 2 hours and 10 matches ago.
      const widget = page.getByTestId('turnstile');
      const table = page.getByTestId('turn-indicator');
      await widget.or(table).first().waitFor({ state: 'visible', timeout: 30_000 });
      await widget.waitFor({ state: 'hidden', timeout: 90_000 });
      await table.waitFor({ state: 'visible', timeout: 30_000 });

      for (let hand = 1; hand <= o.hands && !chosen; hand++) {
        if ((await tableNow(page)).over) break;
        if (hand > 1) {
          // Between hands: the take starts with the cards back in the deck, so it shows the next deal.
          await page.waitForFunction(() => document.querySelectorAll('[data-testid^="hand-card-"]').length === 0, undefined, { timeout: 5_000 }).catch(() => undefined);
        }
        const dir = join(`${root}-takes`, `m${match}h${hand}`);
        const take = await playHand(page, events, () => you, dir, o);
        const seconds = take.shot.end / 1000 + tailSeconds(take.shot.end, o);
        console.log(`${lang} match ${match} hand ${hand}: answer ${take.answer ?? 'none'}${take.matchOver ? ', match over' : ''}, ${seconds.toFixed(2)} s with the data page`);
        for (const m of take.shot.marks) console.log(`  ${(m.at / 1000).toFixed(2)} s  ${m.what}`);
        if (!take.answer || take.matchOver || seconds > o.maxSeconds) continue;
        // A raise back opens the TRUCO panel with the AI's call: the clearest answer. Any other answer
        // is kept in case no hand gives one.
        if (take.answer === 'raise') chosen = take;
        else fallback ??= take;
      }
      await page.close();
    }
    chosen ??= fallback;
    if (!chosen) throw new Error(`${lang}: no hand with an answer to truco within ${o.maxSeconds} s`);

    // The data page's tail, after the hand.
    await data.bringToFront();
    await data.waitForTimeout(300);
    const tail = new Recorder(chosen.dir, data, o.fps, chosen.shot.end, chosen.shot.frames.length).start();
    tail.mark('data page, cycle figure');
    await sleep(tailSeconds(chosen.shot.end, o) * 1000);
    const end = await tail.stop();
    const shot: Shot = { frames: [...chosen.shot.frames, ...end.frames], marks: [...chosen.shot.marks, ...end.marks], end: end.end };
    renameSync(chosen.dir, root);
    rmSync(`${root}-takes`, { recursive: true, force: true });
    writeFileSync(join(root, 'frames.json'), `${JSON.stringify({ lang, viewport: o.viewport, base: o.base, takenAt: new Date().toISOString(), answer: chosen.answer, ...shot }, null, 2)}\n`);
    console.log(`${lang}: kept the hand with the answer ${chosen.answer}, ${shot.frames.length} frames, ${(shot.end / 1000).toFixed(2)} s`);
    await context.close();
  } finally {
    await browser.close();
  }
}

/**
 * Plays one hand like a person while it is recorded: a card is played (by the AI or the person),
 * the person calls truco, takes any raise back, plays the rest, and the take ends a moment after
 * the points land on the score.
 */
async function playHand(page: Pg, events: { at: number; e: Ev }[], you: () => number, dir: string, o: Options): Promise<Take> {
  const rec = new Recorder(dir, page, o.fps).start();
  const t0 = performance.now();
  const rel = (at: number) => at - t0;
  const from = events.length;
  const since = (i: number) => events.slice(i);
  const has = (i: number, pred: (e: Ev) => boolean) => since(i).some((x) => pred(x.e));
  let played = false;
  let raised = -1;
  let raisedAt = 0;
  let end = 0;
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="hand-card-"]').length === 3, undefined, { timeout: 15_000 });
    rec.mark('cards dealt');
    const scoreBefore = await page.getByTestId('score').getAttribute('aria-label');
    await sleep(600);
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (has(from, (e) => e.t === 'hand')) break;
      const s = await tableNow(page);
      if (s.over) break;
      if (!s.mine) {
        await sleep(40);
        continue;
      }
      if (s.accept) {
        // The AI called or raised back: accept, so the hand goes on.
        await sleep(900);
        await page.getByTestId('action-accept').click();
        rec.mark('you accept');
      } else if (raised < 0 && s.raise && (played || has(from, (e) => e.t === 'play'))) {
        await sleep(350);
        raised = events.length;
        raisedAt = Date.now();
        await page.getByTestId('action-raise').click();
        rec.mark('you call truco');
      } else if (s.cards.length) {
        // A beat after the answer, so it can be read before the next card flies.
        if (raised >= 0) await sleep(Math.max(0, 1200 - (Date.now() - raisedAt)));
        await page.getByTestId(`hand-card-${s.cards[0]}`).click();
        played = true;
        rec.mark('you play a card');
      } else {
        await sleep(40);
        continue;
      }
      await sleep(250);
    }
    const hand = since(from).find((x) => x.e.t === 'hand');
    if (hand) rec.mark('the hand result reaches the page', rel(hand.at));
    // The page shows the result a little later (the server's display offsets): wait until the points
    // land on the score, then hold while "Hand over" and the AI's line show.
    await page
      .waitForFunction((before) => document.querySelector('[data-testid="score"]')?.getAttribute('aria-label') !== before, scoreBefore, { timeout: 6_000 })
      .catch(() => undefined);
    rec.mark('points on the score');
    // Until the cards go back to the deck, before the next deal.
    await sleep(1300);
  } finally {
    end = (await rec.stop()).end;
  }
  const answer = raised >= 0 ? since(raised).find((x) => x.e.seat !== you() && (x.e.t === 'accept' || x.e.t === 'run' || x.e.t === 'raise')) : undefined;
  if (answer) rec.mark(`the AI's answer reaches the page: ${answer.e.t}`, rel(answer.at));
  const shot: Shot = { frames: rec.frames, marks: rec.marks.sort((x, y) => x.at - y.at), end };
  return { shot, dir, answer: answer?.e.t ?? null, matchOver: (await tableNow(page)).over };
}

// -------------------------------------------------------------------------------------------------
// encode

/** Frame delays (centiseconds) and size of a GIF, read from the file: its logical screen and every Graphic Control Extension. */
function gifInfo(buf: Buffer): { width: number; height: number; frames: number; centiseconds: number } {
  if (buf.subarray(0, 6).toString('latin1') !== 'GIF89a') throw new Error('not a GIF89a file');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  let p = 13;
  const packed = buf[10];
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  const skipBlocks = () => {
    while (buf[p] !== 0) p += buf[p] + 1;
    p++;
  };
  let frames = 0;
  let centiseconds = 0;
  let delay = 0;
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) delay = buf.readUInt16LE(p + 2);
      skipBlocks();
    } else if (b === 0x2c) {
      const lp = buf[p + 8];
      p += 9;
      if (lp & 0x80) p += 3 * (1 << ((lp & 7) + 1));
      p++; // LZW minimum code size
      skipBlocks();
      frames++;
      centiseconds += delay;
      delay = 0;
    } else {
      throw new Error(`unexpected GIF block 0x${b.toString(16)} at ${p - 1}`);
    }
  }
  return { width, height, frames, centiseconds };
}

function encode(o: Options, lang: Lang): { bytes: number; seconds: number; frames: number; width: number; height: number } {
  const dir = framesDir(lang);
  const shot = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) as Shot;
  // The concat demuxer gives each frame the time until the next one; the fps filter then makes the
  // rate constant (a frame held longer is repeated, never sped up).
  const lines: string[] = ['ffconcat version 1.0'];
  shot.frames.forEach((f, i) => {
    const until = i + 1 < shot.frames.length ? shot.frames[i + 1].at : shot.end;
    lines.push(`file '${f.file}'`, `duration ${((until - f.at) / 1000).toFixed(4)}`);
  });
  // The demuxer drops the last duration without one more entry.
  lines.push(`file '${shot.frames[shot.frames.length - 1].file}'`);
  writeFileSync(join(dir, 'list.ffconcat'), `${lines.join('\n')}\n`);
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `zap-${lang}.gif`);
  const ffmpeg = (args: string[]) => {
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`ffmpeg failed (${run.status ?? run.error?.message})`);
  };
  // 1. A constant rate, the output width and one pixel format. Chromium writes some screenshots
  //    with an alpha channel; a format change in the middle would reset the palette filters below.
  const cfr = join(dir, 'cfr');
  rmSync(cfr, { recursive: true, force: true });
  mkdirSync(cfr);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(dir, 'list.ffconcat'), '-vf', `fps=${o.fps},scale=${o.width}:-2:flags=lanczos,format=rgb24`, '-start_number', '0', join(cfr, 'c%05d.png')]);
  // 2. One palette for the whole clip, then the GIF; a frame stores only the rectangle that changed.
  const filter = `split[a][b];[a]palettegen=max_colors=${o.colors}:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`;
  ffmpeg(['-framerate', String(o.fps), '-start_number', '0', '-i', join(cfr, 'c%05d.png'), '-filter_complex', filter, '-loop', '0', out]);
  const bytes = statSync(out).size;
  const info = gifInfo(readFileSync(out));
  const seconds = info.centiseconds / 100;
  console.log(`${out}: ${bytes} bytes, ${info.width} by ${info.height}, ${info.frames} frames, ${seconds.toFixed(2)} s`);
  if (bytes > o.maxBytes) throw new Error(`${out} is ${bytes} bytes, over ${o.maxBytes}`);
  return { bytes, seconds, frames: info.frames, width: info.width, height: info.height };
}

/** Adds the measured values to a facts file in the format of tools/docs/facts-docs.ts (keys of other runs stay). */
function writeFacts(path: string, lang: Lang, m: ReturnType<typeof encode>, o: Options): void {
  const old = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const measuredAt = new Date().toISOString();
  const file = `project_docs/media/zap-${lang}.gif`;
  const source = `node tools/media/record-gif.ts encode --lang ${lang} --fps ${o.fps} --width ${o.width} (${file}, read back from the file)`;
  const entry = (value: number, unit: string, note: string) => ({ value, unit, source, measuredAt, kind: 'measured', note });
  const add: Record<string, unknown> = {
    [`media.gif.${lang}.bytes`]: entry(m.bytes, 'bytes', `size of ${file}`),
    [`media.gif.${lang}.seconds`]: entry(m.seconds, 's', `sum of the frame delays of ${file}`),
    [`media.gif.${lang}.frames`]: entry(m.frames, 'frames', `frames in ${file}`),
    [`media.gif.${lang}.width`]: entry(m.width, 'px', `width of ${file}`),
    [`media.gif.${lang}.height`]: entry(m.height, 'px', `height of ${file}`),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...old, ...add }, null, 2)}\n`);
  console.log(`${path}: ${Object.keys(add).join(', ')}`);
}

// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, o } = options(process.argv.slice(2));
  if (command === 'shoot') {
    for (const lang of o.langs) await shoot(o, lang);
  } else if (command === 'encode') {
    for (const lang of o.langs) {
      const m = encode(o, lang);
      if (m.seconds > o.maxSeconds || m.seconds < o.minSeconds) throw new Error(`zap-${lang}.gif lasts ${m.seconds} s, not from ${o.minSeconds} to ${o.maxSeconds}`);
      if (o.facts) writeFacts(o.facts, lang, m, o);
    }
  } else {
    console.error('usage: node tools/media/record-gif.ts shoot|encode [--lang pt,en] [--base http://zap-dev-1:8787] [--fps 10] [--width 800] [--facts <file>]');
    process.exit(2);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
