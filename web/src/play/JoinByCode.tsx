// "Join with a code" (CLIENT-SPEC 10.2 item 7): uppercases as the person types, drops 0, O, 1, I
// and L (and anything that is not a letter or a digit) and says why, then opens the room.

import { useRef, useState } from 'preact/hooks';
import { joinByCode } from '../actions.ts';
import { t, type Key } from '../i18n.ts';
import { CODE_LENGTH, cleanCodeInput } from './state.ts';

export function JoinByCode() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const { code: clean, dropped } = cleanCodeInput(el.value);
    if (el.value !== clean) {
      const pos = Math.min(clean.length, el.selectionStart ?? clean.length);
      el.value = clean;
      el.setSelectionRange(pos, pos);
    }
    setCode(clean);
    // A dropped character keeps its explanation until the code is complete or the field is empty.
    if (dropped) setError(t(dropped === 'chars' ? 'play.room.err.chars' : 'play.room.err.other'));
    else if (clean.length === CODE_LENGTH || clean.length === 0) setError(null);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (code.length === CODE_LENGTH && joinByCode(code)) {
      setError(null);
      return;
    }
    const missing = CODE_LENGTH - code.length;
    const key: Key = code.length === 0 ? 'play.room.err.empty' : missing === 1 ? 'play.room.err.short1' : 'play.room.err.short';
    setError(t(key, { n: missing }));
    input.current?.focus();
  };

  return (
    <form class="code-form" onSubmit={submit} noValidate>
      <label class="code-form__label" for="join-code">
        {t('play.room.code')}
      </label>
      <p class="play__note" id="join-hint">
        {t('play.room.code.hint')}
      </p>
      <div class="code-form__row">
        <input
          ref={input}
          id="join-code"
          data-testid="join-code-input"
          type="text"
          inputMode="text"
          value={code}
          onInput={onInput}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          placeholder="·····"
          aria-describedby="join-hint join-error"
          aria-invalid={error ? 'true' : undefined}
        />
        <button type="submit" class="btn btn--outline code-form__submit" data-testid="join-submit">
          {t('play.room.enter')}
        </button>
      </div>
      <p class="code-form__error" id="join-error" data-testid="join-error" aria-live="polite">
        {error ?? ''}
      </p>
    </form>
  );
}
