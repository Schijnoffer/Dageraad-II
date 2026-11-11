/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFromSpec, teamRouter } from '../agents.js';
import { costSummary, renderReplay, seatOutcomes, toJsonl } from '../replay.js';
import { simulateGame } from '../simulate.js';
import type { AiAgent } from '../types.js';

/**
 * AI vs AI, headless.
 *
 *   npm run ai:sim -- --players 6 --ai mock
 *   npm run ai:sim -- --players 7 --ai anthropic:claude-haiku-5-5
 *   npm run ai:sim -- --village openai:gpt-6-luna --wolves anthropic:claude-haiku-5-5 --games 4 --swap
 *
 * Writes transcript.md, events.jsonl and result.json per game under --out.
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

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  if (a.has('help')) {
    console.log('Opties: --players N (3-12) --seed S --games G --rounds R --ai SPEC[,SPEC…] | --village SPEC --wolves SPEC [--swap] --out DIR --quiet');
    console.log('SPEC: mock | auto | openai[:model] | anthropic[:model] | compat:model (AI_BASE_URL + AI_API_KEY)');
    return;
  }
  const players = Number(a.get('players') ?? 6);
  const firstSeed = Number(a.get('seed') ?? Date.now() % 100_000);
  const games = Number(a.get('games') ?? 1);
  const rounds = Number(a.get('rounds') ?? 3);
  const outDir = a.get('out') ?? 'ai-runs';
  const quiet = a.has('quiet');
  const env = process.env;

  const village = a.get('village');
  const wolves = a.get('wolves');
  const specs = (a.get('ai') ?? 'auto').split(',').map((s) => s.trim()).filter(Boolean);

  type Pairing = { label: string; seed: number; build: (i: number, seed: number) => AiAgent };
  const plan: Pairing[] = [];
  for (let g = 0; g < games; g++) {
    const seed = firstSeed + g;
    if (village && wolves) {
      plan.push({
        label: `dorp=${village} wolven=${wolves}`, seed,
        build: (i, s) => teamRouter(agentFromSpec(village, s * 97 + i, env), agentFromSpec(wolves, s * 89 + i, env)),
      });
      if (a.has('swap')) {
        plan.push({
          label: `dorp=${wolves} wolven=${village}`, seed,
          build: (i, s) => teamRouter(agentFromSpec(wolves, s * 97 + i, env), agentFromSpec(village, s * 89 + i, env)),
        });
      }
    } else {
      plan.push({
        label: specs.join(','), seed,
        build: (i, s) => agentFromSpec(specs[i % specs.length]!, s * 97 + i, env),
      });
    }
  }

  const tally = new Map<string, { seats: number; wins: number; village: number; villageWins: number; wolf: number; wolfWins: number }>();
  let totalCost = 0;
  for (const game of plan) {
    console.log(`\n=== Spel seed ${game.seed} · ${players} AI's · ${game.label} ===`);
    const { log, run } = await simulateGame({
      ais: players, seed: game.seed, rounds,
      agentFor: (i) => game.build(i, game.seed),
      onPublic: quiet ? undefined : (m) => console.log(`  ${m.name}: ${m.text}`),
    });
    const dir = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${game.seed}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transcript.md'), renderReplay(log, `Dageraad — AI-spel (seed ${game.seed})`));
    writeFileSync(join(dir, 'events.jsonl'), toJsonl(log));
    writeFileSync(join(dir, 'result.json'), JSON.stringify(run.results, null, 2));
    const cost = costSummary(log);
    totalCost += cost.costUsd;
    console.log(`→ ${run.outcome}; winnaars: ${run.results.winningTeams.join(', ') || 'niemand'} · ${cost.calls} calls · $${cost.costUsd.toFixed(4)} · ${dir}/transcript.md`);
    for (const row of seatOutcomes(log)) {
      const t = tally.get(row.agent) ?? { seats: 0, wins: 0, village: 0, villageWins: 0, wolf: 0, wolfWins: 0 };
      t.seats++; if (row.won) t.wins++;
      if (row.team === 'village') { t.village++; if (row.won) t.villageWins++; }
      if (row.team === 'wolf') { t.wolf++; if (row.won) t.wolfWins++; }
      tally.set(row.agent, t);
    }
  }
  if (plan.length > 1 || tally.size > 1) {
    console.log('\nPer model (eindkaart bepaalt het team):');
    for (const [agent, t] of tally) {
      console.log(`  ${agent}: ${t.wins}/${t.seats} gewonnen · als dorp ${t.villageWins}/${t.village} · als wolf ${t.wolfWins}/${t.wolf}`);
    }
  }
  console.log(`\nTotaal geschatte kosten: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
