// The switch for the single key shortcuts (1, 2, 3, T, A, C, E at the table and R for the rules).
// WCAG 2.1.4 asks for a way to turn single character shortcuts off: this switch, in the menu sheet,
// in the side panel next to the keys line and in the quick rules, all on the same saved preference
// (store.keysOn, 'zap-keys' in this browser).

import { setKeysOn } from '../actions.ts';
import { t } from '../i18n.ts';
import { useStoreSelect } from '../store.ts';

export function KeysSwitch({ testid, class: cls }: { testid: string; class?: string }) {
  const on = useStoreSelect((s) => s.keysOn);
  useStoreSelect((s) => s.lang);
  return (
    <label class={`switch${cls ? ` ${cls}` : ''}`}>
      <span>
        <b>{t('shell.keys')}</b>
        <small>{t('shell.keys.hint')}</small>
      </span>
      <input type="checkbox" role="switch" data-testid={testid} checked={on} onChange={(e) => setKeysOn(e.currentTarget.checked)} />
    </label>
  );
}
