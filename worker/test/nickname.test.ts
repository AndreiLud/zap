// Nickname filter: shape, length and the short list of offensive words.

import { describe, expect, it } from 'vitest';
import { cleanNickname } from '../src/nickname.ts';

describe('nicknames', () => {
  it('accepts letters of any language, digits and single spaces, 2 to 20 characters', () => {
    for (const ok of ['Zé', 'Ana', 'José da Silva', 'Ñandú 77', 'Çağrı', 'Łucja', '王小明', 'Мария', 'Øystein 2', 'ab', 'A'.repeat(20)]) {
      expect(cleanNickname(ok), ok).toBe(ok.normalize('NFC'));
    }
    // Spaces at the ends go away and runs of spaces become one.
    expect(cleanNickname('  Ana   Maria ')).toBe('Ana Maria');
    // Decomposed accents are stored composed.
    expect(cleanNickname('Jose\u0301')).toBe('José');
  });

  it('refuses other characters, sizes and types', () => {
    for (const bad of ['a', '', '   ', 'A'.repeat(21), 'ana_maria', 'ana.maria', 'ana-maria', 'x<script>', '\u{1F642}\u{1F642}', 'Ana\tMaria', 'Ana\nMaria', '@ana', "o'neil", 'a\u0301\u0301\u0301\u0301']) {
      expect(cleanNickname(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [null, undefined, 12, {}, ['Ana'], 'x'.repeat(500)]) expect(cleanNickname(bad)).toBeNull();
  });

  it('refuses offensive words regardless of case, accents, stretched letters, digits or spacing', () => {
    for (const bad of ['puta', 'PUTA', 'Pütá', 'puuuuta', 'p u t a', 'Put4', 'Viado', 'seu cu', 'Porra', 'caralho', 'Caralhooo', 'filho da puta', 'f0da', 'fuck you', 'FUCKER', 'sh1t', 'b1tch', 'Arrombado', 'nigger', 'Hitler 88']) {
      expect(cleanNickname(bad), bad).toBeNull();
    }
  });

  it('does not refuse ordinary words that contain a short offensive word', () => {
    for (const ok of ['Computador', 'Enviado', 'Disputa', 'Picafumo', 'Cunha', 'Scunthorpe', 'Cucaracha', 'Sexta Feira', 'Pau Brasil', 'Rolando', 'Niger', 'Cocada', 'Dickens']) {
      expect(cleanNickname(ok), ok).toBe(ok);
    }
  });

  it('refuses names that look like the default name of a seat', () => {
    for (const bad of ['Jogador 3', 'jogador3', 'Player 2', 'JOGADOR']) expect(cleanNickname(bad), bad).toBeNull();
    expect(cleanNickname('Jogadora Ana')).toBe('Jogadora Ana');
  });
});
