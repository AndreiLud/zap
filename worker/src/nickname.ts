// Nicknames: 2 to 20 characters, letters of any language, digits and single spaces, minus a short
// list of offensive words in Portuguese and English. The check ignores case, accents, stretched
// letters ("puuuta") and the usual digit-for-letter swaps. Anything refused gets the same answer,
// with no detail, so the list cannot be probed word by word.

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;

/** Offensive anywhere inside the name (long or rare enough not to hit ordinary words). */
const ANYWHERE = [
  'caralho', 'buceta', 'boceta', 'arrombad', 'punheta', 'piroca', 'xoxota', 'xereca', 'vagabund', 'vadia', 'pedofil', 'estupr',
  'filhodaputa', 'filhadaputa', 'fdp', 'vsf', 'vtnc', 'pqp', 'kct', 'cuzao', 'fodase', 'foderse', 'baitola', 'boiola',
  'traveco', 'sapatao', 'crioulo', 'nazista', 'hitler',
  'fuck', 'motherf', 'shit', 'bitch', 'asshole', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'rapist', 'wanker', 'retard', 'tranny',
  'porn', 'pussy', 'penis', 'vagina',
];

/** Offensive as a whole word (with plural and gender endings): too short to search inside other words. */
const WORDS = [
  'puta', 'puto', 'viado', 'veado', 'bicha', 'porra', 'merda', 'bosta', 'cu', 'foda', 'foder', 'fode', 'rola', 'corno', 'otario',
  'babaca', 'escroto', 'cacete', 'mongol', 'nazi', 'cunt', 'dick', 'cock', 'fag', 'rape', 'spic', 'chink', 'twat', 'cum', 'sexo',
];

const ENDINGS = ['', 's', 'a', 'o', 'as', 'os', 'es', 'ao', 'oes', 'ona', 'inho', 'inha', 'zinho', 'zinha', 'zao'];

/** "Jogador 3" or "Player 3" would look like the default name of another seat. */
const DEFAULT_NAME = /^(?:jogador|player|jugador) ?\d*$/;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' };

/** Lower case, without accents. */
function plain(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Each letter may be stretched: "puta" also matches "puuuuta". */
const stretchable = (w: string) => [...plain(w)].map((c) => `${c}+`).join('');

const ANYWHERE_RE = new RegExp(ANYWHERE.map(stretchable).join('|'));
const WORD_RE = new RegExp(`^(?:${WORDS.map(stretchable).join('|')})(?:${ENDINGS.join('|')})$`);

function offensive(name: string): boolean {
  const p = plain(name);
  if (DEFAULT_NAME.test(p)) return true;
  const read = p.replace(/[0-9]/g, (d) => LEET[d] ?? d);
  const joined = read.replace(/ /g, '');
  if (ANYWHERE_RE.test(joined)) return true;
  // As one word, or spelled out with spaces ("p u t a").
  return WORD_RE.test(joined) || read.split(' ').some((t) => WORD_RE.test(t));
}

const SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?: [\p{L}\p{M}\p{N}]+)*$/u;

/**
 * The nickname to store, or null when it is refused. Spaces at the ends are dropped and runs of
 * spaces become one; every other rule is strict.
 */
export function cleanNickname(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const s = raw.normalize('NFC').replace(/ +/g, ' ').trim();
  const len = [...s].length;
  if (len < NICKNAME_MIN || len > NICKNAME_MAX) return null;
  if (!SHAPE.test(s)) return null;
  // One letter dressed in a pile of marks is not a name.
  if (/\p{M}{3,}/u.test(s)) return null;
  if (offensive(s)) return null;
  return s;
}
