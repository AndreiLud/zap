// The settings of a room with friends (CLIENT-SPEC 10.2 item 5): players, time per move and the
// house rules. Who sits where is set up in the room itself (M15), not here. Testids and the
// option keys are the ones the old room form had.

import type { RuleOptions, Variant } from '../../../engine/src/config.ts';
import type { TurnSeconds } from '../../../shared/protocol.ts';
import { t, type Key } from '../i18n.ts';

export type TurnChoice = '15' | '30' | '60' | 'none';

export interface RoomForm {
  players: 2 | 4;
  turn: TurnChoice;
  bestOf3: boolean;
  raiseAnyTime: boolean;
  faceDownFirst: boolean;
  allTieToMao: boolean;
  ironNormal: boolean;
  ladder8: boolean;
  signals: RuleOptions['signals'];
}

export const DEFAULT_ROOM: RoomForm = {
  players: 4,
  turn: '30',
  bestOf3: false,
  raiseAnyTime: false,
  faceDownFirst: false,
  allTieToMao: false,
  ironNormal: false,
  ladder8: false,
  signals: 'p25',
};

/** The house rules that differ from the defaults, for the room request. */
export function roomOptions(f: RoomForm, variant: Variant): Partial<RuleOptions> {
  const options: Partial<RuleOptions> = {};
  if (f.bestOf3) options.bestOf = 3;
  if (f.raiseAnyTime) options.raiseAnyTime = true;
  if (f.faceDownFirst) options.faceDownFirstRound = true;
  if (f.allTieToMao) options.allTieToMao = true;
  if (f.ironNormal) options.ironHand = 'normal';
  if (f.players === 4 && f.signals !== 'p25') options.signals = f.signals;
  if (variant === 'mineiro' && f.ladder8) options.ladder = 'mineiro8';
  return options;
}

export function turnSecondsOf(f: RoomForm): TurnSeconds {
  return f.turn === 'none' ? null : (Number(f.turn) as 15 | 30 | 60);
}

type Flag = 'bestOf3' | 'raiseAnyTime' | 'faceDownFirst' | 'allTieToMao' | 'ironNormal' | 'ladder8';

export function RoomSettings(props: { form: RoomForm; variant: Variant; onChange(f: RoomForm): void }) {
  const { form, variant } = props;
  const set = (patch: Partial<RoomForm>) => props.onChange({ ...form, ...patch });
  const check = (flag: Flag, label: Key, testid: string) => (
    <label class="check-field">
      <input type="checkbox" data-testid={testid} checked={form[flag]} onChange={(e) => set({ [flag]: e.currentTarget.checked })} />
      <span>{t(label)}</span>
    </label>
  );
  return (
    <div class="room-settings">
      <div class="room-settings__row">
        <label class="field" for="room-players">
          <span>{t('play.room.players')}</span>
          <select id="room-players" data-testid="room-players" value={String(form.players)} onChange={(e) => set({ players: e.currentTarget.value === '2' ? 2 : 4 })}>
            <option value="4">{t('mode.4')}</option>
            <option value="2">{t('mode.2')}</option>
          </select>
        </label>
        <label class="field" for="room-turn">
          <span>{t('play.room.turn')}</span>
          <select
            id="room-turn"
            data-testid="room-turn"
            value={form.turn}
            aria-describedby={form.turn === 'none' ? 'room-turn-hint' : undefined}
            onChange={(e) => set({ turn: e.currentTarget.value as TurnChoice })}
          >
            <option value="15">{t('turn.option', { n: 15 })}</option>
            <option value="30">{t('turn.option', { n: 30 })}</option>
            <option value="60">{t('turn.option', { n: 60 })}</option>
            <option value="none">{t('turn.none')}</option>
          </select>
        </label>
      </div>
      {form.turn === 'none' ? (
        <p class="play__note" id="room-turn-hint">
          {t('turn.noneHint')}
        </p>
      ) : null}
      <details class="house-rules">
        <summary>
          <span>{t('play.room.house')}</span>
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </summary>
        <div class="house-rules__list">
          {check('bestOf3', 'house.bestOf3', 'room-best-of-3')}
          {check('raiseAnyTime', 'house.raiseAnyTime', 'room-raise-any-time')}
          {check('faceDownFirst', 'house.faceDownFirst', 'room-face-down-first')}
          {check('allTieToMao', 'house.allTieToMao', 'room-all-tie-to-mao')}
          {check('ironNormal', 'house.ironNormal', 'room-iron-normal')}
          {variant === 'mineiro' ? check('ladder8', 'house.ladder8', 'room-ladder-8') : null}
          {form.players === 4 ? (
            <label class="field" for="room-signals">
              <span>{t('house.signals')}</span>
              <select id="room-signals" data-testid="room-signals" value={form.signals} onChange={(e) => set({ signals: e.currentTarget.value as RuleOptions['signals'] })}>
                <option value="p25">{t('house.signals.p25')}</option>
                <option value="secret">{t('house.signals.secret')}</option>
                <option value="all">{t('house.signals.all')}</option>
              </select>
            </label>
          ) : null}
        </div>
      </details>
    </div>
  );
}
