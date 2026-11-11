import { describe, expect, it } from 'vitest';
import { claimSuspicion } from './scripted.js';
import { physicalCards } from './table.js';
import type { RoleId } from '../engine/types.js';
import type { PublicMessage } from './types.js';

const names = ['AI Eva', 'AI Fleur', 'AI Joris', 'AI Tijn', 'AI Noor'];
const say = (seat: number, text: string): PublicMessage => ({ seat, name: names[seat]!, text, round: 1 });

describe('the cards the AIs count with', () => {
  it('include the Dorpeling that fills the deck when the Alfawolf card is set aside', () => {
    const roles: RoleId[] = ['alphawolf', 'droomwolf', 'heks', 'dorpeling', 'dorpeling'];
    expect(physicalCards(roles).filter((r) => r === 'dorpeling')).toHaveLength(3);
    expect(physicalCards(['weerwolf', 'dorpeling'])).toEqual(['weerwolf', 'dorpeling']);
  });
});

describe('claimSuspicion', () => {
  const cards: RoleId[] = ['weerwolf', 'medium', 'leerlingziener', 'dorpeling', 'dorpeling', 'heks', 'dorpsgek', 'dorpeling'];

  it('lets honest claims stand', () => {
    const chat = [
      say(0, 'Ik ben Dorpeling.'),
      say(1, 'Ik ben Dorpeling.'),
      say(3, 'Ik ben Leerlingziener. Middenkaart 1 was Dorpeling.'),
    ];
    expect(claimSuspicion(names, cards, chat)).toEqual([0, 0, 0, 0, 0]);
  });

  it('flags a role claim that a centre-card report has already used up', () => {
    const chat = [
      say(3, 'Ik ben Leerlingziener. Middenkaart 1 was Medium.'),
      say(4, 'Ik ben het Medium. Ik keek bij iemand.'),
    ];
    const score = claimSuspicion(names, cards, chat);
    expect(score[4]).toBeGreaterThan(score[3]!);
    expect(score[3]).toBeGreaterThan(0);
    expect(score[0]).toBe(0);
  });

  it('flags a role that is not in the game', () => {
    const score = claimSuspicion(names, cards, [say(2, 'Ik ben de Ziener.')]);
    expect(score[2]).toBeGreaterThan(0);
  });
});
