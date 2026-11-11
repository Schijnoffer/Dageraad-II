/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Choice, DecisionRequest } from '../../engine/types.js';
import { TWO_ROUND_CONFIG } from '../../engine/presets.js';
import { agentFromSpec } from '../agents.js';
import { describeInfo, requestText, roleName } from '../rules.js';
import { renderReplay, toJsonl } from '../replay.js';
import { simulateGame, type HumanPlayer } from '../simulate.js';
import type { SeatKnowledge } from '../types.js';

/**
 * You at a table of AIs, in the terminal, offline (no Firebase):
 *
 *   npm run ai:play -- --ais 5 --name Rieks --ai mock
 *   ANTHROPIC_API_KEY=… npm run ai:play -- --ais 6 --name Rieks --ai anthropic
 *
 * Same room, referee and rules as the app; your seat acts through its own
 * device exactly like a phone would.
 */

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), 'true');
    else { out.set(a.slice(2), next); i++; }
  }
  return out;
}

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const next = await lines.next();
  if (next.done) throw new Error('invoer gestopt');
  return String(next.value).trim();
}

function parseChoice(input: string, request: DecisionRequest, seatCount: number): Choice | null {
  const p = request.prompt;
  const nums = (input.match(/\d+/g) ?? []).map(Number);
  const center = /^[cm]/i.test(input);
  switch (p.kind) {
    case 'seat':
      if (input === '' && p.optional) return { kind: 'none' };
      return nums[0] !== undefined && nums[0] < seatCount && !p.exclude.includes(nums[0]) ? { kind: 'seat', seat: nums[0] } : null;
    case 'seat-or-center':
      if (center) return nums.length === p.centerCount && nums.every((n) => n <= 2) ? { kind: 'center', centerIndices: nums } : null;
      return nums[0] !== undefined && nums[0] < seatCount && !p.exclude.includes(nums[0]) ? { kind: 'seat', seat: nums[0] } : null;
    case 'two-seats':
      return nums.length === 2 && nums[0] !== nums[1] && nums.every((n) => n < seatCount && !p.exclude.includes(n))
        ? { kind: 'seats', seats: nums } : null;
    case 'center':
      return nums.length === p.count && nums.every((n) => n <= 2) ? { kind: 'center', centerIndices: nums } : null;
    case 'dorpsgek': {
      const d = input.toLowerCase();
      if (d.startsWith('l')) return { kind: 'dorpsgek', direction: 'left' };
      if (d.startsWith('r')) return { kind: 'dorpsgek', direction: 'right' };
      if (d.startsWith('n')) return { kind: 'dorpsgek', direction: 'none' };
      return null;
    }
    case 'confirm':
      return { kind: 'bool', value: !/^n/i.test(input) };
  }
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const ais = Number(a.get('ais') ?? 5);
  const name = a.get('name') ?? 'Jij';
  const seed = Number(a.get('seed') ?? Date.now() % 100_000);
  const rounds = Number(a.get('rounds') ?? 3);
  const spec = a.get('ai') ?? 'auto';

  const human: HumanPlayer = {
    name,
    async night({ seat, names, dealtRole, privateInfo, request }) {
      const k: SeatKnowledge = {
        seat, names: [...names], dealtRole: dealtRole ?? 'dorpeling', privateInfo: [...privateInfo],
        publicView: null, cards: [], config: TWO_ROUND_CONFIG, hasAlphaWolfCard: false,
      };
      console.log(`\n--- NACHT (alleen voor jou) --- Je kaart: ${dealtRole ? roleName(dealtRole) : '?'}`);
      for (const info of privateInfo) console.log(`  · ${describeInfo(k, info)}`);
      console.log(names.map((n, s) => `  stoel ${s}: ${n}`).join('\n'));
      console.log(requestText(k, request).split('\n').filter((l) => !l.startsWith('Antwoord-JSON')).join('\n'));
      console.log('  (stoel: "3" · twee stoelen: "1 4" · midden: "m0" of "m0 2" · Dorpsgek: l/r/n)');
      for (;;) {
        const choice = parseChoice(await ask('> '), request, names.length);
        if (choice) return choice;
        console.log('  Ongeldige keuze, probeer opnieuw.');
      }
    },
    async speak(_seat, ctx) {
      if (ctx.mustTellTruth) console.log('  (De Rechter koos jou: je eerste uitspraak moet waar zijn.)');
      return (await ask(`\n[ronde ${ctx.round}/${ctx.rounds}] ${name} (Enter = zwijgen): `)) || null;
    },
    async vote({ seat, names, privateInfo }) {
      const k = { seat, names: [...names] } as SeatKnowledge;
      console.log('\n--- STEMMING --- wat jij weet:');
      for (const info of privateInfo) console.log(`  · ${describeInfo(k, info)}`);
      console.log(names.map((n, s) => (s === seat ? null : `  stoel ${s}: ${n}`)).filter(Boolean).join('\n'));
      for (;;) {
        const n = Number(await ask('Stem op stoel: '));
        if (Number.isInteger(n) && n >= 0 && n < names.length && n !== seat) return n;
      }
    },
  };

  console.log(`Dageraad · jij (${name}) + ${ais} AI's (${spec}) · seed ${seed}`);
  const { log, run } = await simulateGame({
    ais, seed, rounds, humans: [human],
    agentFor: (i) => agentFromSpec(spec, seed * 97 + i, process.env),
    onPublic: (m) => { if (m.name !== name) console.log(`  ${m.name}: ${m.text}`); },
  });
  const names = log.events.find((e) => e.t === 'setup');
  console.log(`\n=== UITSLAG: ${run.outcome} · winnaars: ${run.results.winningTeams.join(', ') || 'niemand'} ===`);
  if (names?.t === 'setup') {
    for (const s of names.seats) {
      console.log(`  ${s.name}: ${roleName(run.results.originalRoles?.[s.seat] ?? 'dorpeling')} → ${roleName(run.finalRoles[s.seat]!)} · stem op ${names.seats[run.results.finalVotes[s.seat] ?? -1]?.name ?? '—'}`);
    }
  }
  const dir = join('ai-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-play-seed${seed}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'transcript.md'), renderReplay(log, `Dageraad — ${name} tegen de AI's (seed ${seed})`));
  writeFileSync(join(dir, 'events.jsonl'), toJsonl(log));
  console.log(`\nReplay (met privé-redenering van de AI's): ${dir}/transcript.md`);
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
