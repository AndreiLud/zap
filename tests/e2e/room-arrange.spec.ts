// The owner arranges the table of a room with friends (M15 spec 6.3 to 6.6): one select per seat in
// the lobby moves a friend, reserves a character or frees a seat, without losing the focus; a start
// sent right after a change carries it; after the match only the owner plays again or changes the
// table, friends read that they wait, and "Mudar a mesa" takes everyone back to the lobby with the
// finished match gone; a late friend takes the freed seat and the next match plays the new table.

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, PHONE, Player, QUICK, STEADY, auditRoom, createRoom, expectSeat, expectTable, expectTeams, joinByCode, newPlayers, playLoop, since, sleep } from './support/zap.ts';

/** The data-testid of the focused element, or null. */
const focusedId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);

/** The boxes of the lobby's two team groups, in page order. */
const teamBoxes = (page: Page) =>
  page.locator('.lobby__teams > [role="group"]').evaluateAll((gs) =>
    gs.map((g) => {
      const r = g.getBoundingClientRect();
      return { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
    }),
  );

test('the owner arranges the table before and after a match, and friends wait for the owner', async ({ browser }) => {
  test.setTimeout(480_000);
  const players = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  const [ana, beto] = players;
  let caio: Player | null = null;
  let code = '';
  try {
    await test.step('Ana creates a 2 against 2 room with 60 s per move and Beto joins: only Ana has the selects', async () => {
      code = await createRoom(ana, { players: 4, turn: '60' });
      await joinByCode(beto, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      expect(beto.seat).toBe(1);
      for (const seat of [0, 1, 2, 3]) await expect(ana.page.getByTestId(`arrange-${seat}`)).toBeVisible();
      await expect(
        ana.page.getByText(
          'Você arruma a mesa: escolha quem senta em cada cadeira. Cada grupo é uma dupla: cadeiras 1 e 3 contra 2 e 4. Para trocar alguém de dupla, escolha essa pessoa em uma cadeira do outro grupo.',
        ),
      ).toBeVisible();
      // The seats by team (M17), each page from its own seat: Ana's team is seats 1 and 3, Beto's 2 and 4.
      await expectTeams(ana.page, [0, 2], [1, 3]);
      await expectTeams(beto.page, [1, 3], [0, 2]);
      // On the desktop the two groups stand side by side, Nós on the left; on the phone Nós comes first, above Eles.
      const [us, them] = await teamBoxes(ana.page);
      expect(us.right, 'Nós left of Eles').toBeLessThanOrEqual(them.x);
      expect(Math.abs(us.y - them.y), 'Nós and Eles on one row').toBeLessThan(1);
      const [bUs, bThem] = await teamBoxes(beto.page);
      expect(bUs.bottom, 'Nós above Eles on the phone').toBeLessThanOrEqual(bThem.y);
      await ana.shot('m15-room-teams-owner-desktop');
      await beto.shot('m15-room-teams-friend-phone');
      await expect(beto.page.locator('[data-testid^="arrange-"]')).toHaveCount(0);
      // The default plan: Lia on seat 2 and Zap on seat 3, both free for a friend.
      await expect(beto.page.getByTestId('seat-3')).toContainText('se ficar vazia, joga o Zap');
      await expect(beto.page.getByTestId('seat-2')).toContainText('se ficar vazia, joga a Lia');
      await expect(beto.page.getByTestId('sit-2')).toBeVisible();
      await expect(ana.page.getByTestId('sit-2')).toHaveCount(0);
      // Beto waits for the owner; the owner's leave closes the room.
      await expect(beto.page.getByTestId('wait-owner')).toHaveText('Esperando quem criou a sala começar.');
      await expect(beto.page.getByTestId('start-button')).toHaveCount(0);
      await expect(ana.page.getByTestId('leave-button')).toHaveText('Fechar a sala');
      await expect(beto.page.getByTestId('leave-button')).toHaveText('Sair da sala');
      await ana.shot('m15-room-owner-lobby-desktop');
    });

    await test.step('Ana puts Beto on seat 2, in her team: Beto is told the team changed, seat 1 is free again with its own character', async () => {
      await ana.page.getByTestId('arrange-2').selectOption('seat:1');
      await expectSeat(ana.page, 2, { kind: 'human', connected: true });
      await expect.poll(() => beto.lastRoom()?.you).toBe(2);
      // Seat 2 to seat 3 crosses to the other group: the line says the team changed, not only the seat.
      await expect(beto.page.getByTestId('lobby-said')).toHaveText('Quem criou a sala mudou você para a cadeira 3, na outra dupla.');
      await expectSeat(beto.page, 1, { kind: 'empty' });
      await expect(beto.page.getByTestId('seat-1')).toContainText('se ficar vazia, joga a Iara');
      expect(ana.lastRoom()!.room.seats[1].persona).toBe('iara');
      // Beto changed team: on Ana's page he is now in Nós, and on his own Ana is.
      await expect(ana.page.locator('[data-side="us"] [data-testid="seat-2"]')).toHaveAttribute('data-kind', 'human');
      await expect(ana.page.locator('[data-side="them"] [data-testid="seat-1"]')).toHaveAttribute('data-kind', 'empty');
      await expectTeams(beto.page, [0, 2], [1, 3]);
      await beto.shot('m15-room-friend-moved-phone');
      await beto.shot('m15-room-teams-friend-moved-phone');
      await ana.shot('m15-room-teams-owner-moved-desktop');
    });

    await test.step('by keyboard, Ana reserves Lia on seat 1 and the focus stays on that select', async () => {
      const select = ana.page.getByTestId('arrange-1');
      await select.focus();
      for (let i = 0; i < 8 && (await select.inputValue()) !== 'ai:lia'; i++) await ana.page.keyboard.press('ArrowDown');
      expect(await select.inputValue()).toBe('ai:lia');
      await expectSeat(ana.page, 1, { kind: 'ai' });
      await expect(ana.page.getByTestId('seat-1')).toContainText('Lia');
      await expect(select).toBeFocused();
      expect(await focusedId(ana.page)).toBe('arrange-1');
      expect(ana.lastRoom()!.room.seats[1]).toMatchObject({ kind: 'ai', persona: 'lia' });
      // The owner hears what changed (a polite live region).
      await expect(ana.page.getByTestId('lobby-said')).toContainText('Cadeira 2: Lia, IA.');
    });

    await test.step('Ana picks Otávio for seat 3 and starts at once: the start carries the change', async () => {
      await ana.page.getByTestId('arrange-3').selectOption('ai:otavio');
      await ana.page.getByTestId('start-button').click();
      for (const p of players) await expectTable(p);
      const room = ana.lastRoom()!.room;
      expect(room.status).toBe('playing');
      expect(room.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'ai']);
      expect(room.seats[1].persona).toBe('lia');
      expect(room.seats[3].persona).toBe('otavio');
      const sent = ana.sent.map((x) => JSON.parse(x.data) as { t: string });
      const start = sent.findIndex((m) => m.t === 'start');
      expect(sent.slice(0, start).some((m) => JSON.stringify(m) === '{"t":"plan","seat":3,"ai":"otavio"}')).toBe(true);
    });

    await test.step('the match ends: Ana plays again or changes the table, Beto waits for her', async () => {
      const t0 = Date.now();
      const results = await Promise.all(players.map((p) => playLoop(p, { policy: STEADY, timeoutMs: 360_000 })));
      console.log(`room ${code}: match 1 ended in ${since(t0)}, moves ${results.map((r) => r.moves).join('/')}`);
      for (const r of results) expect(r.ended).toBe(true);
      for (const p of players) await expect(p.page.getByTestId('match-result')).toBeVisible();
      await expect(beto.page.getByTestId('rematch-button')).toHaveCount(0);
      await expect(beto.page.getByTestId('change-table')).toHaveCount(0);
      await expect(beto.page.getByTestId('wait-owner')).toHaveText('Esperando quem criou a sala começar.');
      await expect(ana.page.getByTestId('rematch-button')).toBeVisible();
      await expect(ana.page.getByTestId('change-table')).toHaveText('Mudar a mesa');
      await expect(ana.page.getByTestId('wait-owner')).toHaveCount(0);
      await ana.shot('m15-room-end-owner-desktop');
      await beto.shot('m15-room-end-friend-phone');
    });

    await test.step('"Mudar a mesa" holds "Jogar de novo" and takes both back to the lobby, focus on its title', async () => {
      const before = ana.sent.length;
      await ana.page.getByTestId('change-table').click();
      // While it waits, "Jogar de novo" sends nothing (the button may already be gone).
      await ana.page.getByTestId('rematch-button').click({ timeout: 1_000 }).catch(() => {});
      for (const p of players) {
        await expect(p.page.getByTestId('room-code')).toHaveText(code, { timeout: 15_000 });
        await expect(p.page.locator('main.lobby h1')).toBeFocused();
        await expect(p.page.getByTestId('match-result')).toHaveCount(0);
      }
      const after = ana.sent.slice(before).map((x) => (JSON.parse(x.data) as { t: string }).t);
      expect(after.filter((t) => t === 'lobby')).toHaveLength(1);
      expect(after).not.toContain('rematch');
      await sleep(500);
      for (const p of players) await expect(p.page.getByTestId('notice')).toHaveCount(0);
      await expect(beto.page.getByTestId('wait-owner')).toHaveText('A partida acabou. Quem criou a sala está mudando a mesa.');
      await expect(beto.page.getByTestId('start-button')).toHaveCount(0);
      // The finished match is gone from both pages; the reserved characters are back on their seats.
      expect(ana.lastRoom()!.room.status).toBe('lobby');
      expect(ana.lastRoom()!.room.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'ai']);
      expect(beto.seat).toBe(2);
      // The post match lobby keeps the teams: Ana and Beto together in Nós on both pages.
      await expectTeams(ana.page, [0, 2], [1, 3]);
      await expectTeams(beto.page, [0, 2], [1, 3]);
      await beto.shot('m15-room-friend-back-phone');
      await ana.shot('m15-room-owner-back-desktop');
    });

    await test.step('Ana frees seat 3 and Caio joins by code: he lands on it', async () => {
      await ana.page.getByTestId('arrange-3').selectOption('open');
      await expectSeat(ana.page, 3, { kind: 'empty' });
      await expect(ana.page.getByTestId('seat-3')).toContainText('se ficar vazia, joga o Otávio');
      caio = await Player.create(browser, 'Caio', DESKTOP);
      players.push(caio);
      await joinByCode(caio, code);
      expect(caio.seat).toBe(3);
      await expectSeat(ana.page, 3, { kind: 'human', connected: true });
      // Caio sits on seat 4: his Nós is seats 2 and 4, where he is with Lia; on Ana's page he is in Eles.
      await expectTeams(caio.page, [1, 3], [0, 2]);
      await expect(ana.page.locator('[data-side="them"] [data-testid="seat-3"]')).toHaveAttribute('data-kind', 'human');
      // A late friend in a lobby between matches reads the same line as Beto.
      await expect(caio.page.getByTestId('wait-owner')).toHaveText('A partida acabou. Quem criou a sala está mudando a mesa.');
    });

    await test.step('Ana starts: the new table plays, with no stale result anywhere', async () => {
      await ana.page.getByTestId('start-button').click();
      for (const p of players) await expectTable(p);
      const room = ana.lastRoom()!.room;
      expect(room.matchNo).toBe(2);
      expect(room.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'human']);
      expect(room.seats[1].persona).toBe('lia');
      expect(players.map((p) => p.seat)).toEqual([0, 2, 3]);
      for (const p of players) {
        await expect(p.page.getByTestId('match-result')).toHaveCount(0);
        expect(await p.page.evaluate(() => document.activeElement?.id ?? '')).not.toBe('result-title');
        await expect.poll(() => p.lastGame()?.matchNo, { message: `${p.name} gets match 2` }).toBe(2);
        const first = p.gameMsgs().find((g) => g.matchNo === 2)!;
        expect(first.obs.score).toEqual([0, 0]);
      }
      const total = () => players.reduce((n, x) => n + x.moves, 0);
      const moves = total();
      await Promise.all(players.map((p) => playLoop(p, { policy: QUICK, stop: () => total() >= moves + 6, timeoutMs: 60_000 })));
      for (const p of players) await expect(p.page.getByTestId('match-result')).toHaveCount(0);
    });

    await test.step('every page only ever had its own hand, in each match at the seat it had then', async () => {
      const audit = auditRoom(players);
      expect(audit.problems).toEqual([]);
      console.log(`room ${code}: ${audit.hands} hands checked, ${audit.sharedHands} on all three devices`);
    });
  } finally {
    await Promise.all(players.map((p) => p.close()));
  }
});
