// Sound stays silent where the spec says (CLIENT-SPEC 15.1): nothing plays before a person's first
// gesture (the guided demo plays a whole hand by itself and opens no audio at all), and with "Som e
// vibração" off no audio opens even while the person taps through the hand. Switched on again, the
// next taps make the context and the table's sounds start. The switch is on by default. On a
// desktop, where there is no menu sheet, the header holds the same switch as a round button.

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, PHONE, Player, guidedTap } from './support/zap.ts';

interface AudioLog {
  contexts: number;
  starts: number;
  running: boolean;
}

/**
 * Counts every AudioContext the page makes and every sound source it starts. Playwright's Chromium
 * reports a user activation from the first navigation on (navigator.userActivation.hasBeenActive is
 * true before any input), which a person's visit never has; the page here sees what a fresh visit
 * sees: no activation until the first real (trusted) press or key.
 */
async function countAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let active = false;
    const activation = {
      get hasBeenActive() {
        return active;
      },
      get isActive() {
        return active;
      },
    };
    Object.defineProperty(Navigator.prototype, 'userActivation', { get: () => activation, configurable: true });
    for (const type of ['pointerdown', 'keydown']) {
      window.addEventListener(type, (e) => {
        if (e.isTrusted) active = true;
      }, true);
    }
    const w = window as unknown as { __zapAudio: { contexts: AudioContext[]; starts: number } };
    w.__zapAudio = { contexts: [], starts: 0 };
    const Original = window.AudioContext;
    if (!Original) return;
    class Counted extends Original {
      constructor(o?: AudioContextOptions) {
        super(o);
        w.__zapAudio.contexts.push(this);
      }
    }
    window.AudioContext = Counted;
    for (const proto of [AudioBufferSourceNode.prototype, OscillatorNode.prototype]) {
      const start = proto.start;
      proto.start = function (this: AudioScheduledSourceNode, ...args: [number?, number?, number?]) {
        w.__zapAudio.starts++;
        return (start as (...a: unknown[]) => void).apply(this, args);
      } as typeof proto.start;
    }
  });
}

const audio = (page: Page): Promise<AudioLog> =>
  page.evaluate(() => {
    const a = (window as unknown as { __zapAudio: { contexts: AudioContext[]; starts: number } }).__zapAudio;
    return { contexts: a.contexts.length, starts: a.starts, running: a.contexts.some((c) => c.state === 'running') };
  });

test('no sound before a gesture, none with the switch off, and sound again when it is on', async ({ browser }) => {
  test.setTimeout(150_000);
  const me = await Player.create(browser, 'Ears', PHONE);
  const page = me.page;
  await countAudio(page);
  try {
    await test.step('the guided demo plays a whole hand with no gesture: no audio opens', async () => {
      await page.goto('/jogar/guiada?demo=1');
      await page.waitForFunction(() => (window as unknown as { __zapDemoDone?: boolean }).__zapDemoDone === true, null, { timeout: 60_000 });
      expect(await audio(page)).toEqual({ contexts: 0, starts: 0, running: false });
    });

    await test.step('the switch is on by default; switched off, taps through the hand open no audio', async () => {
      await page.goto('/jogar/guiada');
      await page.getByTestId('menu-button').click();
      const sw = page.getByTestId('sound-switch');
      await expect(sw).toBeChecked();
      await sw.uncheck();
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => localStorage.getItem('zap-sound'))).toBe('0');
      await page.reload();
      await page.getByTestId('guided-start').tap();
      let cards = 0;
      const until = Date.now() + 30_000;
      while (cards < 2 && Date.now() < until) {
        const tap = await guidedTap(page).catch(() => null);
        if (tap === 'card') cards++;
        if (!tap) await page.waitForTimeout(100);
      }
      expect(cards).toBe(2);
      expect(await audio(page)).toEqual({ contexts: 0, starts: 0, running: false });
    });

    await test.step('switched on, the next taps open the audio and the table sounds play', async () => {
      await page.getByTestId('menu-button').click();
      await page.getByTestId('sound-switch').check();
      await page.keyboard.press('Escape');
      let cards = 0;
      const until = Date.now() + 30_000;
      while (cards < 1 && Date.now() < until) {
        const tap = await guidedTap(page).catch(() => null);
        if (tap === 'card') cards++;
        if (!tap) await page.waitForTimeout(100);
      }
      await expect.poll(async () => (await audio(page)).contexts, { timeout: 5_000 }).toBe(1);
      await expect.poll(async () => (await audio(page)).running, { timeout: 5_000 }).toBe(true);
      await expect.poll(async () => (await audio(page)).starts, { timeout: 10_000 }).toBeGreaterThan(0);
    });
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});

test('the desktop header holds the sound switch, with the same memory as the menu sheet', async ({ browser }) => {
  const desk = await Player.create(browser, 'Desk', DESKTOP);
  const page = desk.page;
  try {
    await page.goto('/jogar');
    const toggle = page.getByTestId('sound-toggle');
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId('menu-button')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('zap-sound'))).toBe('0');
    await page.reload();
    await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('sound-toggle').click();
    await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('zap-sound'))).not.toBe('0');
    expect(desk.errors).toEqual([]);
  } finally {
    await desk.close();
  }
});
