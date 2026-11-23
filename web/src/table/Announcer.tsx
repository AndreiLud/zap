// The screen reader's view of the table (CLIENT-SPEC 13): one polite log region, screen reader only,
// with the last six sentences. Each game event and phrase of the feed becomes a sentence
// (describeEvent, describePhrase); the turn, the clock and the table add theirs through say().

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { describeEvent, describePhrase, type Names } from '../game-text.ts';
import { store, useStoreSelect, type FeedItem } from '../store.ts';
import { clearAnnouncements, say, useAnnouncements } from './announce.ts';

export function feedSentence(item: FeedItem, n: Names): string {
  const names = { ...n, you: item.you, players: item.kind === 'event' ? item.players : n.players };
  return item.kind === 'event' ? describeEvent(item.e, names) : describePhrase(item.seat, item.key, names);
}

/** The last feed item read aloud, kept while the page lives, so a table that mounts again repeats nothing. */
let lastRead = 0;

/**
 * Where reading starts when the table mounts: the first deal of a visit arrives with the table
 * itself, so the items of the hand on screen that were never read are read; older ones are not.
 */
function startOfMount(feed: readonly FeedItem[]): number {
  let from = feed.length ? feed[feed.length - 1].id : 0;
  for (let i = feed.length - 1; i >= 0; i--) {
    const it = feed[i];
    if (it.kind === 'event' && it.e.t === 'deal') {
      from = i > 0 ? feed[i - 1].id : it.id - 1;
      break;
    }
  }
  return Math.max(lastRead, from);
}

export function Announcer({ names }: { names: Names }) {
  const feed = useStoreSelect((s) => s.feed);
  const lines = useAnnouncements();
  const seen = useRef<number | null>(null);
  const namesRef = useRef(names);
  namesRef.current = names;
  // A layout effect, so what was just played is said before the turn and the clock of the same
  // render (their passive effects run after this one).
  useLayoutEffect(() => {
    seen.current ??= startOfMount(store.get().feed);
    for (const item of feed) {
      if (item.id <= seen.current) continue;
      seen.current = item.id;
      lastRead = Math.max(lastRead, item.id);
      say(feedSentence(item, namesRef.current));
    }
  }, [feed]);
  useEffect(() => () => clearAnnouncements(), []);
  return (
    <div class="sr-only" role="log" aria-live="polite" aria-relevant="additions" data-testid="announcer">
      {lines.map((l) => (
        <p key={l.id}>{l.text}</p>
      ))}
    </div>
  );
}
