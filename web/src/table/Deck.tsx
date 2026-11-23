// The deck resting on the line medallion (CLIENT-SPEC 11.3): two packets of card backs, their
// thickness drawn as card edges (motion.ts thins it card by card during the deal). It is shuffled
// once when it lands on the table (not with reduced motion).

import { seatName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { BackView } from './cards.tsx';
import type { Model } from './model.ts';
import { deckShadow } from './motion.ts';

export function Deck({ m, ended, shuffle }: { m: Model | null; ended: boolean; shuffle: boolean }) {
  let label: string;
  if (!m) label = t('board.deck.aria.opening');
  else if (ended) label = t('board.deck.aria.end');
  else if (m.v.dealer === m.you) label = t('board.deck.aria.you');
  else label = t('board.deck.aria', { dealer: seatName(m.names, m.v.dealer) });
  return (
    <div class={`deck${shuffle ? ' deck--shuffle' : ''}`} data-testid="deck" role="img" aria-label={label}>
      <div class="deck__packet" data-m="a" style={{ boxShadow: deckShadow(40, false) }}>
        <BackView />
      </div>
      <div class="deck__packet deck__packet--top" data-m="b" style={{ boxShadow: deckShadow(40, true) }}>
        <BackView />
      </div>
    </div>
  );
}
