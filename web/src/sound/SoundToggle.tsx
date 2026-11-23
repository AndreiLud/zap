// The sound and vibration switch for the desktop header (from 64em), where the menu sheet and its
// sound-switch do not exist. Same state and memory as the sheet switch: store.soundOn, saved as
// 'zap-sound' in this browser by actions.setSoundOn. Icon only, with the accessible name
// "Sound and vibration" and aria-pressed; switched off, the sound waves give way to a slash.

import '../styles/sound.css';
import { setSoundOn } from '../actions.ts';
import { Icon } from '../components/icons.tsx';
import { t } from '../i18n.ts';

export function SoundToggle({ on }: { on: boolean }) {
  return (
    <button
      type="button"
      class="sound-toggle"
      data-testid="sound-toggle"
      aria-pressed={on}
      aria-label={t('shell.sound')}
      title={t('shell.sound')}
      onClick={() => setSoundOn(!on)}
    >
      <Icon name="sound" />
    </button>
  );
}
