// The random switches of quick play (M15 spec 5.2, 5.4): "Adversários" ("Adversário" in 1 against
// 1) and, in 2 against 2, "Time" for your partner. On, that side is drawn again at every match; off,
// it is the one chosen by hand (Play page) or the one just played (end screen). The Play page puts
// them before the pickers they hide, so a picker that appears follows the focus; the end screen
// puts them right below "Jogar de novo". Real switches (a checkbox with role="switch", as
// KeysSwitch), styled by the entry's .switch rules; toggling never moves the focus.

import { t, type Key } from '../i18n.ts';

export interface RandomFlags {
  opponents: boolean;
  partner: boolean;
}

export function RandomSwitches(props: {
  players: 2 | 4;
  values: RandomFlags;
  onChange(v: RandomFlags): void;
  legend: Key;
  /** random on the Play page, rematch-random on the end screen: testids <prefix>-opponents and <prefix>-partner. */
  testid: string;
  disabled?: boolean;
}) {
  const { values, disabled } = props;
  const row = (label: Key, key: keyof RandomFlags) => (
    <label class="switch">
      <span>
        <b>{t(label)}</b>
      </span>
      <input
        type="checkbox"
        role="switch"
        data-testid={`${props.testid}-${key}`}
        checked={values[key]}
        disabled={disabled}
        onChange={(e) => props.onChange({ ...values, [key]: e.currentTarget.checked })}
      />
    </label>
  );
  return (
    <fieldset class="draw">
      <legend>{t(props.legend)}</legend>
      {row(props.players === 2 ? 'play.opp.one' : 'play.opp', 'opponents')}
      {props.players === 4 ? row('play.random.team', 'partner') : null}
    </fieldset>
  );
}
