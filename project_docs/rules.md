# Rules used by Zap

Zap plays two Brazilian variants of truco: paulista and mineiro. Both run on the same rules engine (`engine/`), with the variant and the room options as configuration. Truco has many house rules. The defaults below were chosen from tournament regulations and popular online rooms; common alternatives are room options.

## Sources

| Key | Source |
| --- | --- |
| UFFS | Regulamento de truco paulista, Universidade Federal da Fronteira Sul, 2024. https://site-antigo-2025.uffs.edu.br/pastas-ocultas/bd/pro-reitoria-de-assuntos-estudantis/arquivos/regulamento-truco-paulista/@@download/file |
| BANC | Regulamento do torneio de truco, Sindicato dos Bancários de São Paulo, 2017. https://spbancarios.com.br/sites/default/files/anexos/regulamento2017_1.pdf |
| ASFO | Regulamento de truco, ASFO, Unesp ICT, 2019. https://www.ict.unesp.br/Home/sobreoict/fundacoeseassociacoes/asfo/regulamento-de-truco-2019.pdf |
| MJP | MegaJogos, truco paulista rules. https://www.megajogos.com.br/truco-online/regras |
| MJM | MegaJogos, truco mineiro rules. https://www.megajogos.com.br/truco-mineiro-online/regras |
| WIKI | Wikipédia (pt), Truco. https://pt.wikipedia.org/wiki/Truco |
| PAGAT | Pagat, Truco (Brazil). https://pagat.com/put/truco_br.html |

## Defaults and room options

| Rule | Paulista | Mineiro | Room option |
| --- | --- | --- | --- |
| Deck and direction | 40 cards (no 8, 9 or 10); play goes counterclockwise; the "mão" sits to the right of the dealer and plays first | same | clockwise seating (display only) |
| Manilhas | the rank after the vira (after 3 comes 4); by suit: clubs, hearts, spades, diamonds | fixed, no vira: 4 of clubs, 7 of hearts, ace of spades, 7 of diamonds | |
| Hand value and raises | 1; truco 3, then 6, 9, 12 | 2; truco 4, then 6, 10, 12 | mineiro 2, 4, 8, 10, 12 (WIKI) |
| Running from a bet | the team that raised scores the value before the raise | same | |
| Asking and answering | on your own turn; teams alternate; no skipping steps; the first answer from the other team counts | same | raise at any moment (ASFO) |
| Match | one game to 12 points | same | best of three games |
| Mão de onze / de dez | team at 11 sees the partner's cards, then plays for 3 or runs (other team +1); no truco | team at 10: plays for 4 or runs (other team +2) | all three rounds tied gives the hand to the other team (BANC, WIKI); not seeing the partner's cards (WIKI, mineiro) |
| Mão de ferro | both at 11: cards face down to everyone, including their owner; no truco; the winner takes the game | both at 10: same | play a regular hand (BANC) |
| Face-down card | worth nothing; not allowed in the first round | same | allowed in the first round, except for the player who opens the hand |
| Ties | first round tied: the second decides; second or third tied: the winner of the first takes it; first and second tied: the third decides; all three tied: nobody scores. After a tied round, the player who opened it leads again (UFFS) | same | all three tied: the team of the "mão" takes the hand |
| Time | 30 s per move; when it runs out the AI plays that move for you, and that move is left out of the human data | same | 15 s, 60 s, or no limit (rooms with humans only) |
| Signals (2 against 2) | "I have" zap, copas, espadilha, pica-fumo, a three, or nothing; one per player per hand; each opponent catches it with a 25% chance; it may be a lie | same | secret, 25%, or everyone sees |

Quick play opens in paulista.

## Exact semantics implemented by the engine

These are the rules the tests check. Seats are numbered in play order: seat `s + 1` plays after seat `s`. Teams are `seat % 2` (seats 0 and 2 against 1 and 3 in 2 against 2; seat 0 against seat 1 in 1 against 1).

### Cards

* Card id is `rank * 4 + suit`. Ranks, weakest first: 4, 5, 6, 7, Q, J, K, A, 2, 3. Suits in manilha order, weakest first: diamonds, spades, hearts, clubs.
* Plain cards of the same rank tie whatever the suit.
* Paulista: the vira is turned after dealing; the four cards of the next rank are the manilhas and beat every plain card; among manilhas, clubs (zap) beats hearts (copas) beats spades (espadilha) beats diamonds (pica-fumo).
* Mineiro: no vira. The manilhas are always 4 of clubs (zap), 7 of hearts (copas), ace of spades (espadilha) and 7 of diamonds (pica-fumo), in that order. The other fours, sevens and aces are plain cards.
* A card played face down has strength below every real card. Two face-down cards tie with each other.

### Dealing and turns

* Each hand: shuffle with the hand seed, the seat after the dealer (the "mão") opens the first round, and the deal passes to the next seat for the next hand.
* A round ends when every seat has played one card. The strongest card wins the round. If the strongest strength is shared by both teams, the round is tied. If it is shared only by partners, their team wins and the first of them to play it is the round winner.
* The round winner opens the next round. After a tied round, the player who opened the tied round opens the next one.

### Who wins the hand

With round results r1, r2, r3 (team or tie):

* r1 tied: r2 decides; if r2 is also tied, r3 decides.
* r1 won by a team: if r2 is won by the same team or tied, that team takes the hand after two rounds. If r2 is won by the other team, r3 decides, and a tied r3 gives the hand to the winner of r1.
* All three tied: nobody scores. Options change this: in a mão de onze or de dez with `onzeTieToOpponents`, the team not on the threshold takes the hand value; otherwise, with `allTieToMao`, the team of the "mão" takes it.

### Bets

* Ladder by step: paulista 1, 3, 6, 9, 12; mineiro 2, 4, 6, 10, 12; mineiro with `ladder: 'mineiro8'` 2, 4, 8, 10, 12. Step 0 is the starting value.
* In a normal hand, the player whose turn it is may raise to the next step before playing a card, if the step is below 4 and the last accepted raise did not come from their own team. With `raiseAnyTime`, any player of an eligible team may raise at any moment of the play, also out of turn.
* While a raise waits for an answer, nobody plays cards. Either player of the other team may answer, and the first answer counts. The raiser's partner cannot answer.
* Answers: accept (the hand is now worth the new step), run (the raising team scores the value before the raise and the hand ends), or raise again (accepts the pending step and proposes the next one; allowed only while that next step is at most 4). After a raise again, the original team answers, and either of its players may do so, including the one who first raised.
* Teams alternate: after a team's raise is accepted, only the other team may raise next.
* With `raiseAnyTime`, a player who has already played all their cards may still raise while the hand goes on.
* A raise again is announced as one raise event; the step it accepts is the one below the step it proposes.

### Mão de onze, mão de dez and mão de ferro

* Threshold: 11 in paulista, 10 in mineiro.
* Exactly one team on the threshold: before any card is played, that team decides to play (the hand is worth 3 in paulista, 4 in mineiro) or to run (the other team scores 1 in paulista, 2 in mineiro). Either player of that team may decide; the first decision counts. In 2 against 2, with `onzeSeesPartner` (the default), the players of that team see each other's remaining cards during the whole hand. Nobody can raise in this hand.
* Both teams on the threshold: with `ironHand: 'blind'` (default), it is a mão de ferro: nobody sees their own cards (a card is revealed when played), nobody raises, no face-down plays and no signals; the hand is worth the starting value, so the winner reaches 12. With `ironHand: 'normal'`, it is a regular hand.

### Face-down cards

* Not allowed in the first round. With `faceDownFirstRound`, allowed in the first round for everyone except the player who opens the hand. Always allowed in the second and third rounds of normal hands and of a mão de onze. Never in a mão de ferro.
* A face-down card's identity is never shown to the other players. Its owner still sees it. One exception follows from the mão de onze rule: when partners see each other's cards, the partner knows which card was covered, because it leaves the hand they can see.
* Cards that were never played and face-down cards are not revealed at the end of the hand during the match. They are kept with the hand record for audit, replays after the match and the data.

### Signals (2 against 2)

* Six signals: zap, copas, espadilha, pica-fumo, three, nothing. Each means "I have this card". zap, copas, espadilha and pica-fumo are the manilhas of clubs, hearts, spades and diamonds (in mineiro, the four fixed manilhas). Three means a three that is not a manilha. Nothing means no manilha and no three.
* Each player may send one signal per hand, at any moment of the play phase before playing their first card of the hand, also out of turn, but not while a bet or a mão de onze decision is pending, and never in a mão de ferro.
* The partner always sees it. Each opponent sees it with a 25% chance (`signals: 'p25'`), never (`'secret'`) or always (`'all'`). The draw uses the hand's random stream right after the shuffle: one uniform draw from 0 to 3 for the opponent after the signaler, then one for the opponent before, and the opponent sees the signal on a 0. It is part of the deterministic replay. The signaler is not told who caught it, except when everyone sees signals.
* A signal can be a lie. The engine records whether it was true, but never shows that during the match.

### Match

* A game ends when a team reaches 12 or more points. With `bestOf: 3`, the score resets to 0 to 0 after each game and the match ends when a team wins two games.
* With `bestOf: 3`, the deal keeps rotating across games: the next game starts with the next dealer in the rotation.
* "On the threshold" means a score of at least 11 (paulista) or 10 (mineiro); higher scores below 12 cannot happen in play.
* A match may start from a given dealer, score and games (used for analysis and tests); the engine rejects values that play cannot produce: a dealer outside the table, a score of 12 or more, negative values, or games that already decide the match.
* The configuration is copied when the match is created, so changing the caller's object later has no effect.
* Every action is logged as `seat * 16 + action`. Replaying the log from the same configuration, seed and initial state rebuilds the same match.
* Randomness: the match seed (256 bits) comes from a cryptographic generator on the server. The first dealer and each hand's seed are derived from it with ChaCha20, and each hand is shuffled from its own seed. Hand seeds are stored with the hand for audit and replay, and are shown only after the match ends: during the match a seed would reveal face-down cards and whether signals were true.
