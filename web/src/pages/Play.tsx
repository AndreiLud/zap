// The Play page (/jogar, /en/play; CLIENT-SPEC 10.2, prototype azulejo-v2/jogar.html): the title
// and the page's tile strip, then the table chooser right above the one primary button, whose label
// and note always say what starts. Solo modes start at once ("Play now"); "With friends" creates a
// room and offers the join form and a picture of a room. Below: the "So far" strip (milestone 7),
// the learning loop teaser and the source code.
//
// The choice lives in component state, so the PT/EN switch keeps it. Only the mode and the variant are
// saved in this browser (play/state.ts): the line up starts from the defaults at every visit (owner
// decision, M15), with the random switches before the pickers they hide. The address can preset it
// (?modo=, ?variante=, ?contra=).

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
import { CharacterPicker, ModePicker, VariantPicker, namesOf } from '../play/Pickers.tsx';
import { RandomSwitches, type RandomFlags } from '../play/RandomSwitches.tsx';
import { DEFAULT_ROOM, RoomSettings, type RoomForm } from '../play/RoomSettings.tsx';
import {
  STORE_KEY,
  initialChoice,
  isComplete,
  lineupOf,
  lineupSize,
  partnerOf,
  pick,
  requestOf,
  roomRequestOf,
  savedHasLineup,
  serialize,
  summaryOf,
  takenByOpponents,
  takenByPartner,
  withLineup,
  type PlayChoice,
  type PlayMode,
} from '../play/state.ts';
import { Lobby } from '../room-chunks.tsx';
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

/** On idle, start loading the table's and the lobby's code, so either opens fast after the button. */
function usePrefetchRoom(): void {
  useEffect(() => {
    const load = () => {
      void import('../table/Table.tsx').catch(() => {});
      void Lobby.preload().catch(() => {});
    };
    const w = window as Window & { requestIdleCallback?(cb: () => void, o?: { timeout: number }): number; cancelIdleCallback?(id: number): void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(load, { timeout: 2000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(load, 2000);
    return () => clearTimeout(id);
  }, []);
}

export function PlayPage({ s }: { s: AppState }) {
  const title = usePageFocus('play');
  const [saved] = useState(readSaved);
  const [choice, setChoice] = useState<PlayChoice>(() => initialChoice(saved, location.search));
  const [room, setRoom] = useState<RoomForm>(DEFAULT_ROOM);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [partnerOpen, setPartnerOpen] = useState(false);
  const [said, setSaid] = useState('');
  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  const live = useLiveCounters();
  const last = lastRoom();
  const strip = useMemo(() => panelModules(24, 1957, STRIP_PALETTE), []);
  usePrefetchRoom();
  useEffect(() => () => void (sayTimer.current && clearTimeout(sayTimer.current)), []);
  // A value stored before M15 still holds a line up: rewrite it at once without one.
  useEffect(() => {
    if (savedHasLineup(saved)) save(choice);
  }, []);

  /** Every change is saved (mode and variant only); the partner never clashes with the opponents. */
  const update = (c: PlayChoice) => {
    const next = { ...c, parceiro: partnerOf(c) };
    setChoice(next);
    save(next);
  };

  /** A polite announcement; cleared first, so the same sentence is read again. */
  const say = (msg: string) => {
    setSaid('');
    if (sayTimer.current) clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(msg), 30);
  };

  const inRoom = choice.modo === 'sala';
  const lineup = lineupOf(choice);
  const size = lineupSize(lineup);
  const list = choice.contra[lineup];
  const partner = partnerOf(choice);
  const complete = isComplete(choice);
  const blocked = !complete || s.busy;

  const onPick = (id: PersonaId, checked: boolean) => {
    const r = pick(list, id, checked, size);
    update(withLineup(choice, lineup, r.list));
    const names = (ids: PersonaId[]) => namesOf(ids);
    if (r.kind === 'swap') say(t('play.opp.swap', { out: PERSONA_NAMES[r.out], in: PERSONA_NAMES[r.in], list: names(r.list) }));
    else if (r.kind === 'missing') say(r.list.length ? `${t('play.opp.now', { list: names(r.list) })} ${t('play.opp.missing')}` : t('play.opp.missing'));
    else say(t('play.opp.now', { list: names(r.list) }));
  };

  const onPartner = (id: PersonaId, checked: boolean) => {
    if (!checked) return;
    const next = { ...choice, parceiro: id };
    update(next);
    // The partner kept, which is the one clicked unless the opponents picked by hand have it.
    say(t('play.partner.now', { name: PERSONA_NAMES[partnerOf(next)] }));
  };

  const onSwitches = (v: RandomFlags) => update({ ...choice, sorteio: { ...choice.sorteio, [lineup]: v.opponents, parceiro: v.partner } });

  const launch = () => {
    if (s.busy) return;
    if (!complete) {
      // An incomplete line up opens the picker on the first free choice instead of starting.
      setPickerOpen(true);
      say(t('play.opp.missing'));
      requestAnimationFrame(() => picker.current?.querySelector<HTMLInputElement>('input[name="play-opponents"]:not(:checked):not(:disabled)')?.focus());
      return;
    }
    if (inRoom) void createRoom(roomRequestOf(choice, room));
    else void playSolo(requestOf(choice));
  };

  // Quick play: the switches first, then the pickers they hide (a picker that appears follows the focus).
  const lineupPart = (
    <>
      <RandomSwitches
        players={size === 1 ? 2 : 4}
        values={{ opponents: choice.sorteio[lineup], partner: choice.sorteio.parceiro }}
        onChange={onSwitches}
        legend="play.random.legend"
        testid="random"
      />
      {choice.sorteio[lineup] ? null : (
        <div ref={picker}>
          <CharacterPicker
            name="play-opponents"
            testid="opponent"
            toggle="opponents-toggle"
            list={list}
            size={size}
            label={size === 1 ? 'play.opp.one' : 'play.opp'}
            legend={size === 1 ? 'play.opp.legend1' : 'play.opp.legend2'}
            taken={takenByPartner(choice)}
            reason="play.taken.partner"
            open={pickerOpen}
            onOpen={setPickerOpen}
            onPick={onPick}
          />
        </div>
      )}
      {size === 2 && !choice.sorteio.parceiro ? (
        <CharacterPicker
          name="play-partner"
          testid="partner"
          toggle="partner-toggle"
          list={[partner]}
          size={1}
          label="play.partner"
          legend="play.partner.legend"
          taken={takenByOpponents(choice)}
          reason="play.taken.opp"
          open={partnerOpen}
          onOpen={setPartnerOpen}
          onPick={onPartner}
        />
      ) : null}
    </>
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
          {inRoom ? <RoomSettings form={room} variant={choice.variante} onChange={setRoom} /> : lineupPart}

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
              {summaryOf(choice, room.players, t)}
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
