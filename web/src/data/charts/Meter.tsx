// A threshold meter (DATA-SPEC F24, F25 empty, F26 empty): a lock or a check, the part's name, its
// state in words, and a bar that fills with value / needed. A count that is not public (null, under
// the privacy minimum) draws no fill and says so in words; the bar carries the same words as its
// accessible name. Plain HTML, used inside a plain figure or any block of a page.

export interface MeterProps {
  /** The part's name ("Ranking contra o Zap"). */
  label: string;
  /** The count so far, or null when it is under the public minimum. */
  value: number | null;
  needed: number;
  /** The part is on. */
  on: boolean;
  /** "ligado" / "esperando", from the page's keys. */
  state: string;
  /** The count in words ("12 de 20 pessoas"). */
  text: string;
  /** Said instead of the count when value is null ("menos de 20 pessoas"). */
  nullText?: string;
}

function LockIcon({ on }: { on: boolean }) {
  return on ? (
    <svg class="meter__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="8.5" class="meter__icon-ring" />
      <path d="M6 10.5l2.6 2.6L14 7.6" class="meter__icon-mark" />
    </svg>
  ) : (
    <svg class="meter__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" class="meter__icon-mark" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" class="meter__icon-mark" />
    </svg>
  );
}

export function Meter(p: MeterProps) {
  const share = p.value === null || p.needed <= 0 ? 0 : Math.max(0, Math.min(1, p.value / p.needed));
  const words = p.value === null ? (p.nullText ?? p.text) : p.text;
  return (
    <div class={`meter${p.on ? ' meter--on' : ''}`}>
      <LockIcon on={p.on} />
      <div class="meter__body">
        <p class="meter__head">
          <span class="meter__label">{p.label}</span>
          <span class="meter__state">{p.state}</span>
        </p>
        <div
          class="meter__track"
          role={p.value === null ? 'img' : 'meter'}
          aria-label={`${p.label}: ${words}`}
          aria-valuemin={p.value === null ? undefined : 0}
          aria-valuemax={p.value === null ? undefined : p.needed}
          aria-valuenow={p.value === null ? undefined : Math.min(p.value, p.needed)}
          aria-valuetext={p.value === null ? undefined : words}
        >
          {share > 0 ? <span class="meter__fill" style={{ width: `${(share * 100).toFixed(1)}%` }} /> : null}
        </div>
        <p class="meter__text">{words}</p>
      </div>
    </div>
  );
}
