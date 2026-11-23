// The table's screen reader log (CLIENT-SPEC 13): sentences said close together become one line,
// and a line already in the log is never rewritten (the log announces additions only).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLine, announcements, clearAnnouncements, say } from '../src/table/announce.ts';
import { ANNOUNCE_JOIN } from '../src/table/timing.ts';

describe('announcer lines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAnnouncements();
  });
  afterEach(() => {
    clearAnnouncements();
    vi.useRealTimers();
  });

  it('joins sentences said within ANNOUNCE_JOIN ms into one new line, in the order said', () => {
    say('Bento jogou o valete de paus.');
    vi.advanceTimersByTime(ANNOUNCE_JOIN - 10);
    say('Sua vez.');
    expect(announcements()).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(announcements().map((l) => l.text)).toEqual(['Bento jogou o valete de paus. Sua vez.']);
  });

  it('never rewrites a line already added: a later sentence is a new line', () => {
    say('Bento pediu truco!');
    vi.advanceTimersByTime(ANNOUNCE_JOIN);
    const first = announcements()[0];
    say('Você aceitou.');
    vi.advanceTimersByTime(ANNOUNCE_JOIN);
    const now = announcements();
    expect(now).toHaveLength(2);
    expect(now[0]).toBe(first);
    expect(now[1].text).toBe('Você aceitou.');
  });

  it('keeps the last six lines and ignores empty sentences', () => {
    let l = addLine([], '  ', 1);
    expect(l).toEqual([]);
    for (let i = 1; i <= 8; i++) l = addLine(l, `linha ${i}`, i);
    expect(l.map((x) => x.text)).toEqual(['linha 3', 'linha 4', 'linha 5', 'linha 6', 'linha 7', 'linha 8']);
  });

  it('clearing drops what was waiting', () => {
    say('Cartas na mesa.');
    clearAnnouncements();
    vi.advanceTimersByTime(ANNOUNCE_JOIN * 2);
    expect(announcements()).toEqual([]);
  });
});
