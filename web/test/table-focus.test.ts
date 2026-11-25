// Focus at the table never comes back to the game once the person left it (M15 spec 7, the flaky
// keys-off test): the turn's effect queues the focus for the next frame, and focusLater checks
// again when that frame runs. Here document and requestAnimationFrame are stand-ins, so the frame
// runs exactly when the test says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusLater, inGame } from '../src/table/focus.ts';

/** An element that is inside the given parts of the page (selectors as focus.ts asks for them). */
function el(inside: { table?: boolean; chrome?: boolean }) {
  return {
    focus: vi.fn(),
    closest: (sel: string) => {
      if (sel === 'main.table') return inside.table ? {} : null;
      return inside.chrome ? {} : null;
    },
  };
}

describe('focus at the table', () => {
  const body = el({});
  const doc = { activeElement: body as unknown, body, documentElement: el({}) };
  let frames: FrameRequestCallback[] = [];
  const runFrames = () => {
    const now = frames;
    frames = [];
    now.forEach((f) => f(0));
  };

  beforeEach(() => {
    frames = [];
    doc.activeElement = body;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('knows the game from the page chrome', () => {
    expect(inGame()).toBe(true);
    doc.activeElement = el({ table: true });
    expect(inGame()).toBe(true);
    doc.activeElement = el({});
    expect(inGame(), 'a footer link').toBe(false);
    doc.activeElement = el({ table: true, chrome: true });
    expect(inGame(), 'the side panel inside the table').toBe(false);
  });

  it('focuses the card at the next frame when focus is still on the page', () => {
    const card = el({ table: true });
    focusLater(() => card as unknown as HTMLElement);
    expect(card.focus).not.toHaveBeenCalled();
    runFrames();
    expect(card.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('focuses the card when focus moved inside the game meanwhile', () => {
    const card = el({ table: true });
    focusLater(() => card as unknown as HTMLElement);
    doc.activeElement = el({ table: true });
    runFrames();
    expect(card.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves focus on a footer link the person moved to before the frame ran', () => {
    const card = el({ table: true });
    focusLater(() => card as unknown as HTMLElement);
    doc.activeElement = el({});
    runFrames();
    expect(card.focus).not.toHaveBeenCalled();
  });

  it('leaves focus in the header or a dialog, and copes with a card that is gone', () => {
    const card = el({ table: true });
    focusLater(() => card as unknown as HTMLElement);
    doc.activeElement = el({ chrome: true });
    runFrames();
    expect(card.focus).not.toHaveBeenCalled();
    doc.activeElement = body;
    focusLater(() => null);
    expect(() => runFrames()).not.toThrow();
  });
});
