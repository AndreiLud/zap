// The Play page (/jogar, /en/play; CLIENT-SPEC 10.2, prototype azulejo-v2/jogar.html): the title
// and the page's tile strip, then the table chooser right above the one primary button, whose label
// and note always say what starts. Solo modes start at once ("Play now"); "With friends" creates a
// room and offers the join form and a picture of a room. Below: the "So far" strip (milestone 7),
// the learning loop teaser and the source code.
//
// The choice lives in component state, so the PT/EN switch keeps it; it is saved in this browser on
// every change (play/state.ts) and the address can preset it (?modo=, ?variante=, ?contra=).

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PersonaId } from '../../../ai/src/personas.ts';
import type { Variant } from '../../../engine/src/config.ts';
import { createRoom, lastRoom, navigate, playSolo, urlFor } from '../actions.ts';
import { Link } from '../components/common.tsx';
import { Icon } from '../components/icons.tsx';
import { Module, TILE, panelModules } from '../deck/tiles.tsx';
import { PERSONA_NAMES } from '../game-text.ts';
import { t } from '../i18n.ts';
import { useLiveCounters } from '../live.ts';
import { usePageFocus } from '../page-focus.ts';
import { errorText } from '../play/errors.ts';
import { LessonTeaser, LiveStrip, OpenSource, RoomSample } from '../play/Extras.tsx';
import { JoinByCode } from '../play/JoinByCode.tsx';
import { ModePicker, OpponentPicker, VariantPicker, namesOf } from '../play/Pickers.tsx';
import { DEFAULT_ROOM, RoomSettings, roomOptions, turnSecondsOf, type RoomForm } from '../play/RoomSettings.tsx';
import {
  STORE_KEY,
  initialChoice,
  isComplete,
  lineupOf,
  lineupSize,
  matchOf,
  opponentsOf,
  partnerFor,
  pick,
  serialize,
  withLineup,
  type PlayChoice,
  type PlayMode,
} from '../play/state.ts';
import type { AppState } from '../store.ts';
import '../styles/play.css';

const STRIP_PALETTE = [
  [TILE.cobalt, TILE.cal],
  [TILE.ochre, TILE.cobalt],
  [TILE.cal, TILE.terra],
  [TILE.terra, TILE.cal],
  [TILE.cobalt, TILE.ochre],
  ['#FBF8F2', TILE.cobalt],
] as const;

function readSaved(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function save(c: PlayChoice): void {
  try {
    localStorage.setItem(STORE_KEY, serialize(c));
  } catch {
    // Storage blocked: the choice lasts while the page is open.
  }
}

/** On idle, start loading the table's code, so the table opens fast after "Play now". */
function usePrefetchTable(): void {
  useEffect(() => {
    const load = () => void import('../table/Table.tsx').catch(() => {});
    const w = window as Window & { requestIdleCallback?(cb: () => void, o?: { timeout: number }): number; cancelIdleCallback?(id: number): void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(load, { timeout: 2000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(load, 2000);
    return () => clearTimeout(id);
  }, []);
}

/** The note under the button: what this choice starts. */
function summaryOf(c: PlayChoice, room: RoomForm): string {
  const v = t(`play.v.${c.variante}`);
  if (c.modo === 'sala') return t('play.sum.sala', { v, m: t(`mode.${room.players}`) });
  const ops = opponentsOf(c, room.players);
  if (!isComplete(c, room.players)) return t('play.opp.missing');
  if (c.modo === 'solo') return t('play.sum.solo', { v, a: t(`play.who.${ops[0]}`) });
  return t('play.sum.dupla', { v, p: t(`play.who.${partnerFor(ops)}`), a: t(`play.who.${ops[0]}`), b: t(`play.who.${ops[1]}`) });
}

export function PlayPage({ s }: { s: AppState }) {
  const title = usePageFocus('play');
  const [choice, setChoice] = useState<PlayChoice>(() => initialChoice(readSaved(), location.search));
  const [room, setRoom] = useState<RoomForm>(DEFAULT_ROOM);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [said, setSaid] = useState('');
  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  const live = useLiveCounters();
  const last = lastRoom();
  const strip = useMemo(() => panelModules(24, 1957, STRIP_PALETTE), []);
  usePrefetchTable();
  useEffect(() => () => void (sayTimer.current && clearTimeout(sayTimer.current)), []);

  const update = (c: PlayChoice) => {
    setChoice(c);
    save(c);
  };

  /** A polite announcement; cleared first, so the same sentence is read again. */
  const say = (msg: string) => {
    setSaid('');
    if (sayTimer.current) clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(msg), 30);
  };

  const inRoom = choice.modo === 'sala';
  const lineup = lineupOf(choice, room.players);
  const size = lineupSize(lineup);
  const list = choice.contra[lineup];
  const complete = isComplete(choice, room.players);
  const blocked = !complete || s.busy;

  const onPick = (id: PersonaId, checked: boolean) => {
    const r = pick(list, id, checked, size);
    update(withLineup(choice, lineup, r.list));
    const names = (ids: PersonaId[]) => namesOf(ids);
    if (r.kind === 'swap') say(t('play.opp.swap', { out: PERSONA_NAMES[r.out], in: PERSONA_NAMES[r.in], list: names(r.list) }));
    else if (r.kind === 'missing') say(r.list.length ? `${t('play.opp.now', { list: names(r.list) })} ${t('play.opp.missing')}` : t('play.opp.missing'));
    else say(t('play.opp.now', { list: names(r.list) }));
  };

  const launch = () => {
    if (s.busy) return;
    if (!complete) {
      // An incomplete line up opens the picker on the first free choice instead of starting.
      setPickerOpen(true);
      say(t('play.opp.missing'));
      requestAnimationFrame(() => picker.current?.querySelector<HTMLInputElement>('input[name="play-opponents"]:not(:checked)')?.focus());
      return;
    }
    const m = matchOf(choice, room.players);
    if (inRoom) void createRoom({ ...m, turnSeconds: turnSecondsOf(room), options: roomOptions(room, choice.variante) });
    else void playSolo(m);
  };

  const opponents = (
    <div ref={picker}>
      <OpponentPicker
        list={list}
        size={size}
        label={inRoom ? 'play.room.ai' : size === 1 ? 'play.opp.one' : 'play.opp'}
        open={pickerOpen}
        onOpen={setPickerOpen}
        onPick={onPick}
      />
    </div>
  );

  return (
    <main id="main" class="play">
      <div class="play__entry">
        <header class="play__hero">
          <h1 id="play-title" ref={title} tabIndex={-1}>
            {t('play.choose.h')}
          </h1>
          <p class="play__lead">{t('play.lead')}</p>
          <div class="play__strip" aria-hidden="true">
            {strip.map((m, i) => (
              <Module key={i} m={m} />
            ))}
          </div>
        </header>

        <section class="play__chooser" aria-labelledby="play-title">
          <ModePicker value={choice.modo} labelledBy="play-title" onChange={(m: PlayMode) => update({ ...choice, modo: m })} />
          <VariantPicker value={choice.variante} onChange={(v: Variant) => update({ ...choice, variante: v })} />
          {inRoom ? <RoomSettings form={room} variant={choice.variante} onChange={setRoom} ai={opponents} /> : opponents}

          <div class="launch">
            <button
              type="button"
              class={`btn btn--primary btn--big launch__button${complete ? '' : ' is-missing'}`}
              data-testid={inRoom ? 'create-room-submit' : 'play-now'}
              aria-describedby="play-summary"
              aria-disabled={blocked ? 'true' : undefined}
              onClick={launch}
            >
              <Icon name="play" />
              <span>{t(inRoom ? 'play.room.create' : 'play.play')}</span>
            </button>
            <p class="launch__note" id="play-summary" data-testid="play-summary">
              {summaryOf(choice, room)}
            </p>
            {s.homeError ? (
              <p class="error" role="alert" data-testid="home-error">
                {errorText(s.homeError, s.homeLimit)}
              </p>
            ) : null}
            {s.busy ? (
              <p class="launch__note" role="status">
                {t('play.busy')}
              </p>
            ) : null}
          </div>

          {inRoom ? (
            <div class="play__room">
              <p class="play__or" aria-hidden="true">
                <span>{t('play.room.or')}</span>
              </p>
              <JoinByCode />
              <RoomSample variant={choice.variante} />
            </div>
          ) : null}

          <ul class="play__links">
            <li>
              <Link to={{ name: 'guided' }} testid="guided-link">
                <span class="play__links-q">{t('play.guided.q')}</span> <b>{t('play.guided')}</b>
              </Link>
            </li>
            <li>
              <Link to={{ name: 'rules' }} testid="rules-link">
                <b>{t('play.rules')}</b>
              </Link>
            </li>
            {last ? (
              <li>
                <a
                  href={urlFor({ name: 'room', code: last })}
                  data-testid="back-to-room"
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    navigate({ name: 'room', code: last });
                  }}
                >
                  <b>{t('play.backToRoom', { code: last })}</b>
                </a>
              </li>
            ) : null}
          </ul>
          <p class="sr-only" aria-live="polite">
            {said}
          </p>
        </section>
      </div>

      {live ? <LiveStrip live={live} lang={s.lang} /> : null}
      <LessonTeaser />
      <OpenSource />
    </main>
  );
}
