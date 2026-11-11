import type { Choice, DecisionRequest, NightState, SeatIndex } from './types.js';

/**
 * Automated players.
 *
 * Built for test mode (§16): every seat except yours decides at random so you
 * can walk a whole night alone. The interface is deliberately wider than random
 * needs to be — `chooseVote` gets the resolved state, `choose` gets the full
 * request — so a smarter bot can be dropped in later without touching the
 * referee. Milan's eventual "fill an empty seat in a real game" idea needs
 * exactly that seam, and it is free to leave open now.
 *
 * Deterministic from a seed, so a bug found in test mode can be reproduced
 * rather than chased.
 */

export interface Bot {
  /** May be async: an LLM player answers after a network round-trip. */
  choose(request: DecisionRequest, state: NightState): Choice | Promise<Choice>;
  chooseVote(seat: SeatIndex, state: NightState): { target: SeatIndex | null; abstain: boolean };
}

/** xorshift32, same generator as the deal — small, fast, reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export interface SyncBot extends Bot {
  choose(request: DecisionRequest, state: NightState): Choice;
}

export function randomBot(seed: number): SyncBot {
  const next = rng(seed);
  const pick = <T>(items: T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(next() * items.length)];

  return {
    choose(request, state) {
      const seats: SeatIndex[] = [];
      for (let s = 0; s < state.seatCount; s++) seats.push(s);

      switch (request.prompt.kind) {
        case 'seat': {
          const excluded = new Set(request.prompt.exclude);
          const allowed = seats.filter((s) => !excluded.has(s) && s !== request.seat);
          // An optional action is declined some of the time, so test games
          // exercise the "nobody acted" paths rather than only the happy ones.
          const seat = pick(allowed);
          return seat === undefined ? { kind: 'none' } : { kind: 'seat', seat };
        }
        case 'seat-or-center': {
          if (next() < 0.5) {
            const excluded = new Set(request.prompt.exclude);
            const seat = pick(seats.filter((s) => !excluded.has(s) && s !== request.seat));
            return seat === undefined ? { kind: 'none' } : { kind: 'seat', seat };
          }
          const all = Array.from({ length: state.centerCount }, (_, i) => i);
          const chosen: number[] = [];
          while (chosen.length < request.prompt.centerCount && chosen.length < all.length) {
            const center = pick(all.filter((i) => !chosen.includes(i)));
            if (center === undefined) break;
            chosen.push(center);
          }
          return { kind: 'center', centerIndices: chosen };
        }
        case 'two-seats': {
          const excluded = new Set(request.prompt.exclude);
          const allowed = seats.filter((s) => !excluded.has(s) && s !== request.seat);
          if (allowed.length < 2) return { kind: 'none' };
          const a = pick(allowed)!;
          const b = pick(allowed.filter((s) => s !== a))!;
          return { kind: 'seats', seats: [a, b] };
        }
        case 'center': {
          const all = Array.from({ length: state.centerCount }, (_, i) => i);
          const chosen: number[] = [];
          while (chosen.length < request.prompt.count && chosen.length < all.length) {
            const c = pick(all.filter((i) => !chosen.includes(i)));
            if (c === undefined) break;
            chosen.push(c);
          }
          return { kind: 'center', centerIndices: chosen };
        }
        case 'dorpsgek': {
          const direction = pick(['left', 'right', 'none'] as const)!;
          const choice: Choice = { kind: 'dorpsgek', direction };
          if (request.prompt.variant === 'designate' && direction !== 'none') {
            const seat = pick(seats.filter((s) => s !== request.seat));
            if (seat !== undefined) choice.designatedSeat = seat;
          }
          return choice;
        }
        case 'confirm':
          return { kind: 'bool', value: next() < 0.5 };
      }
    },

    chooseVote(seat, state) {
      const others: SeatIndex[] = [];
      for (let s = 0; s < state.seatCount; s++) if (s !== seat) others.push(s);
      // Abstains occasionally, so the majority-abstain path gets exercised too.
      if (next() < 0.12) return { target: null, abstain: true };
      const target = pick(others);
      return { target: target ?? null, abstain: false };
    },
  };
}
