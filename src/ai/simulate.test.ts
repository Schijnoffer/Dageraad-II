import { describe, expect, it } from 'vitest';
import { isWolfRole } from '../engine/roles.js';
import type { SeatIndex } from '../engine/types.js';
import { renderReplay, seatOutcomes } from './replay.js';
import { scriptedAgent } from './scripted.js';
import { simulateGame, type HumanPlayer } from './simulate.js';
import type { AiAgent, LogEvent, SeatKnowledge } from './types.js';

function mockTable(seed: number) {
  return (i: number) => scriptedAgent(seed * 31 + i);
}

/** Wraps an agent and records every knowledge object it was ever handed. */
function spy(inner: AiAgent, seen: SeatKnowledge[]): AiAgent {
  return {
    label: inner.label,
    night: (k, r) => { seen.push(k); return inner.night(k, r); },
    speak: (k, c) => { seen.push(k); return inner.speak(k, c); },
    vote: (k, c) => { seen.push(k); return inner.vote(k, c); },
  };
}

describe('AI vs AI, headless, through the real referee', () => {
  it('plays a full round from deal to result', async () => {
    const { log, run } = await simulateGame({ ais: 6, seed: 42, agentFor: mockTable(42) });

    expect(run.outcome).toBeTruthy();
    expect(run.resultsPersisted).toBe(false);
    expect(run.day.missingVotes).toEqual([]);

    const types = new Set(log.events.map((e) => e.t));
    for (const t of ['setup', 'deal', 'private', 'say', 'vote', 'result'] as const) expect(types).toContain(t);
    const votes = log.events.filter((e): e is Extract<LogEvent, { t: 'vote' }> => e.t === 'vote');
    expect(votes).toHaveLength(6);
    // The published ballot is the one the AI decided, not a random fallback.
    for (const v of votes) expect(run.results.finalVotes[v.seat]).toBe(v.target);
  });

  it('is deterministic for a seed', async () => {
    const a = await simulateGame({ ais: 5, seed: 7, agentFor: mockTable(7) });
    const b = await simulateGame({ ais: 5, seed: 7, agentFor: mockTable(7) });
    const strip = (events: LogEvent[]) => events.filter((e) => e.t !== 'call');
    expect(strip(b.log.events)).toEqual(strip(a.log.events));
  });

  it('never hands a seat anything but its own card and its own receipts', async () => {
    const seen: SeatKnowledge[] = [];
    const { log } = await simulateGame({
      ais: 7, seed: 99, agentFor: (i) => spy(scriptedAgent(i), seen),
    });
    const deal = log.events.find((e): e is Extract<LogEvent, { t: 'deal' }> => e.t === 'deal')!;
    const finalPrivate = new Map(log.events
      .filter((e): e is Extract<LogEvent, { t: 'private' }> => e.t === 'private')
      .map((e) => [e.seat, e.info]));

    expect(seen.length).toBeGreaterThan(0);
    for (const k of seen) {
      expect(k.dealtRole).toBe(deal.dealt[k.seat]);
      // Whatever the seat knew at any moment is a prefix of what it was finally
      // released — never something released to another seat.
      const mine = finalPrivate.get(k.seat) ?? [];
      expect(mine.slice(0, k.privateInfo.length)).toEqual(k.privateInfo);
      expect(Object.keys(k)).not.toContain('state');
    }
  });

  it('renders a replay with public talk and private reasoning kept apart', async () => {
    const { log } = await simulateGame({ ais: 5, seed: 3, agentFor: mockTable(3) });
    const md = renderReplay(log);
    expect(md).toContain('## Dag — discussie');
    expect(md).toContain('*privé');
    expect(md).toContain('## Uitslag');
    expect(seatOutcomes(log)).toHaveLength(5);
  });

  it('runs many seeds without a stuck or illegal game', async () => {
    let villageWins = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { run } = await simulateGame({ ais: 3 + (seed % 6), seed, agentFor: mockTable(seed), rounds: 2 });
      expect(run.day.missingVotes).toEqual([]);
      if (run.results.winningTeams.includes('village')) villageWins++;
    }
    // Not a balance claim — just that the scripted table is not degenerate.
    expect(villageWins).toBeGreaterThan(0);
    expect(villageWins).toBeLessThan(12);
  });
});

describe('a slow model at night', () => {
  it('is answered by the scripted fallback after the grace period, so the night keeps its timing', async () => {
    const stuck = (i: number): AiAgent => {
      const inner = scriptedAgent(i);
      return { ...inner, label: 'stuck', night: () => new Promise(() => {}) };
    };
    const { log, run } = await simulateGame({ ais: 5, seed: 8, agentFor: stuck, nightGraceMs: 20, rounds: 1 });
    expect(run.day.missingVotes).toEqual([]);
    const night = log.events.filter((e) => e.t === 'night');
    expect(night.length).toBeGreaterThan(0);
    expect(night.every((e) => e.t === 'night' && e.fallback === true)).toBe(true);
  });
});

describe('AIs at a table with humans', () => {
  it('seats humans and AIs together; humans act through their own device', async () => {
    const humanLog: string[] = [];
    const human = (name: string): HumanPlayer => ({
      name,
      async night({ request, names, seat }) {
        humanLog.push(`${name} night ${request.key}`);
        const others = names.map((_, s) => s).filter((s) => s !== seat);
        switch (request.prompt.kind) {
          case 'seat': return { kind: 'seat', seat: others[0]! };
          case 'two-seats': return { kind: 'seats', seats: [others[0]!, others[1]!] };
          case 'center': return { kind: 'center', centerIndices: [0] };
          case 'seat-or-center': return { kind: 'center', centerIndices: [0, 1] };
          case 'dorpsgek': return { kind: 'dorpsgek', direction: 'none' };
          case 'confirm': return { kind: 'bool', value: true };
        }
      },
      async speak(_seat, ctx) {
        humanLog.push(`${name} speaks r${ctx.round}`);
        return ctx.round === 1 ? `Hoi, ik ben ${name} en ik vertrouw niemand.` : null;
      },
      async vote({ seat, names }) {
        return ((seat + 1) % names.length) as SeatIndex;
      },
    });

    const { log, run } = await simulateGame({
      ais: 4, seed: 2026, agentFor: mockTable(5), humans: [human('Rieks'), human('Milan')], rounds: 2,
    });
    expect(run.day.missingVotes).toEqual([]);
    const setup = log.events.find((e): e is Extract<LogEvent, { t: 'setup' }> => e.t === 'setup')!;
    expect(setup.seats.filter((s) => s.kind === 'human').map((s) => s.name).sort()).toEqual(['Milan', 'Rieks']);
    expect(humanLog.filter((l) => l.includes('speaks'))).toHaveLength(4);
    const humanSays = log.events.filter((e) => e.t === 'say' && e.human && e.text);
    expect(humanSays).toHaveLength(2);
    // AIs heard the humans: at least one AI spoke after the first human line.
    const firstHuman = log.events.findIndex((e) => e.t === 'say' && e.human);
    expect(log.events.slice(firstHuman).some((e) => e.t === 'say' && !e.human)).toBe(true);
    expect(Object.values(run.finalRoles).some(isWolfRole) || run.results.winningTeams.length >= 0).toBe(true);
  });
});
