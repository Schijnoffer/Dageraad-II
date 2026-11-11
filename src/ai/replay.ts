import { isWolfRole, teamOf } from '../engine/roles.js';
import type { Choice, PrivateInfo, RoleId } from '../engine/types.js';
import { describeInfo, roleName } from './rules.js';
import type { GameLog, LogEvent, SeatKnowledge } from './types.js';

type Ev<T extends LogEvent['t']> = Extract<LogEvent, { t: T }>;

function find<T extends LogEvent['t']>(log: GameLog, t: T): Ev<T> | undefined {
  return log.events.find((e): e is Ev<T> => e.t === t);
}
function all<T extends LogEvent['t']>(log: GameLog, t: T): Ev<T>[] {
  return log.events.filter((e): e is Ev<T> => e.t === t);
}

function choiceText(names: readonly string[], choice: Choice): string {
  switch (choice.kind) {
    case 'none': return 'niets';
    case 'seat': return names[choice.seat] ?? `stoel ${choice.seat}`;
    case 'seats': return choice.seats.map((s) => names[s] ?? `stoel ${s}`).join(' en ');
    case 'center': return `middenkaart ${choice.centerIndices.join(' en ')}`;
    case 'dorpsgek': return choice.direction === 'none' ? 'niet doorschuiven'
      : `doorschuiven naar ${choice.direction === 'left' ? 'links' : 'rechts'}`;
    case 'heks-policy': return 'heks-regel';
    case 'bool': return choice.value ? 'ja' : 'nee';
  }
}

const TEAM_NL: Record<string, string> = { village: 'dorp', wolf: 'wolven', solo: 'Looier' };

function quote(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

export interface CostSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unknownCost: boolean;
  byAgent: Record<string, { calls: number; costUsd: number }>;
}

export function costSummary(log: GameLog): CostSummary {
  const out: CostSummary = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unknownCost: false, byAgent: {} };
  for (const call of all(log, 'call')) {
    out.calls++;
    out.inputTokens += call.inputTokens;
    out.outputTokens += call.outputTokens;
    if (call.costUsd === null) out.unknownCost = true;
    out.costUsd += call.costUsd ?? 0;
    const agent = (out.byAgent[call.agent] ??= { calls: 0, costUsd: 0 });
    agent.calls++;
    agent.costUsd += call.costUsd ?? 0;
  }
  return out;
}

/** Omniscient replay: every card, every public word, and every seat's private reasoning. */
export function renderReplay(log: GameLog, title = 'Dageraad — AI-spel'): string {
  const setup = find(log, 'setup');
  const deal = find(log, 'deal');
  const result = find(log, 'result');
  if (!setup || !deal) return `# ${title}\n\n(onvolledig log)\n`;
  const names = setup.seats.map((s) => s.name);
  const k: Pick<SeatKnowledge, 'names'> = { names };
  const out: string[] = [];

  out.push(`# ${title}`, '');
  out.push(`Gestart: ${log.startedAt} · seed ${setup.seed} · modus ${setup.config.mode} · ${names.length} spelers`, '');
  out.push('> Deze replay is **alwetend**: hij toont alle kaarten en de privé-redenering van elke AI. Aan tafel zag niemand dat.', '');

  out.push('## Spelers', '');
  out.push('| Stoel | Naam | Speler | Gedeeld | Bij dageraad | Gewonnen |');
  out.push('|---|---|---|---|---|---|');
  for (const seat of setup.seats) {
    const dealt = deal.dealt[seat.seat]!;
    const final = result?.finalRoles[seat.seat];
    out.push(`| ${seat.seat} | ${seat.name} | ${seat.kind === 'ai' ? `AI (${seat.agent})` : 'mens'} | ${roleName(dealt)} | ${final ? `${roleName(final)} (${TEAM_NL[teamOf(final)]})` : '?'} | ${result ? (result.seatWon[seat.seat] ? 'ja' : 'nee') : '?'} |`);
  }
  out.push('');
  out.push(`Midden bij de deal: ${deal.center.map((r, i) => `${i}: ${roleName(r)}`).join(', ')}${deal.alphaWolfCard ? ` · Alfawolf-kaart: ${roleName(deal.alphaWolfCard)}` : ''}`, '');

  out.push('## Nacht', '');
  for (const night of all(log, 'night')) {
    out.push(`- **${names[night.seat]}** als ${roleName(night.actingAs)} → ${choiceText(names, night.choice)}${night.fallback ? ' *(fallback)*' : ''}`);
    if (night.reasoning) out.push(`  - *privé:* ${night.reasoning.replace(/\n+/g, ' ')}`);
  }
  out.push('');
  out.push('### Wat elke speler privé te zien kreeg', '');
  for (const priv of all(log, 'private')) {
    const items = priv.info.map((i: PrivateInfo) => describeInfo({ ...emptyKnowledge(), names }, i));
    out.push(`- **${names[priv.seat]}**: ${items.join(' ') || '—'}`);
  }
  const view = find(log, 'public-view')?.view;
  if (view) {
    const revealed = Object.entries(view.revealed);
    if (revealed.length > 0) {
      out.push('', `Open op tafel: ${revealed.map(([slot, role]) => `${Number(slot) < names.length ? names[Number(slot)] : `midden ${Number(slot) - names.length}`} = ${roleName(role as RoleId)}`).join('; ')}`);
    }
  }
  out.push('');

  out.push('## Dag — discussie', '');
  let round = -1;
  for (const say of all(log, 'say')) {
    if (say.round !== round) {
      round = say.round;
      out.push(round === 0 ? '### Tussendoor (mensen)' : `### Ronde ${round}`, '');
    }
    const who = say.name;
    out.push(say.text ? `**${who}:** ${say.text}` : `*${who} zwijgt.*`);
    if (say.reasoning) out.push('', quote(`*privé (${who}):* ${say.reasoning.replace(/\n+/g, ' ')}`));
    out.push('');
  }

  out.push('## Stemming', '');
  for (const vote of all(log, 'vote')) {
    const target = vote.target === null ? '—' : names[vote.target];
    out.push(`- **${names[vote.seat]}** stemt op **${target}**${vote.fallback ? ' *(fallback)*' : ''}`);
    if (vote.beliefs && Object.keys(vote.beliefs).length > 0) {
      const top = Object.entries(vote.beliefs).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([seat, p]) => `${names[Number(seat)]} ${Math.round(p * 100)}%`).join(', ');
      out.push(`  - *wolfkans volgens ${names[vote.seat]}:* ${top}`);
    }
    if (vote.reasoning) out.push(`  - *privé:* ${vote.reasoning.replace(/\n+/g, ' ')}`);
  }
  if (result) {
    const humanVotes = setup.seats.filter((s) => s.kind === 'human');
    for (const h of humanVotes) {
      const target = result.finalVotes[h.seat];
      out.push(`- **${h.name}** (mens) stemt op **${target === null || target === undefined ? '—' : names[target]}**`);
    }
  }
  out.push('');

  if (result) {
    out.push('## Uitslag', '');
    const eliminated = result.eliminated.map((s) => `${names[s]} (${roleName(result.finalRoles[s]!)})`);
    out.push(`- Uitkomst: **${result.outcome}**`);
    out.push(`- Opgehangen: ${eliminated.length > 0 ? eliminated.join(', ') : 'niemand'}`);
    out.push(`- Winnaars: **${result.winningTeams.map((t) => TEAM_NL[t] ?? t).join(', ') || 'niemand'}**`);
    out.push(`- Stemmen: ${Object.entries(result.tally).filter(([, n]) => n > 0).map(([s, n]) => `${names[Number(s)]} ${n}`).join(', ') || 'geen'}`);
    const wolves = Object.entries(result.finalRoles).filter(([, r]) => isWolfRole(r)).map(([s]) => names[Number(s)]);
    out.push(`- Wolven bij dageraad: ${wolves.join(', ') || 'geen (alle wolven in het midden)'}`);
    out.push(`- Midden bij dageraad: ${result.centerAtDawn.map((r) => roleName(r)).join(', ')}`);
    out.push('');
  }

  const cost = costSummary(log);
  out.push('## Kosten', '');
  if (cost.calls === 0) out.push('Geen API-calls (gescripte/mock AI).');
  else {
    out.push(`${cost.calls} calls · ${cost.inputTokens} input- en ${cost.outputTokens} output-tokens · ca. $${cost.costUsd.toFixed(4)}${cost.unknownCost ? ' (+ onbekende prijs voor sommige modellen)' : ''}`);
    for (const [agent, c] of Object.entries(cost.byAgent)) out.push(`- ${agent}: ${c.calls} calls, $${c.costUsd.toFixed(4)}`);
  }
  out.push('');
  return out.join('\n');
}

function emptyKnowledge(): SeatKnowledge {
  return {
    seat: 0, names: [], dealtRole: 'dorpeling', privateInfo: [], publicView: null,
    cards: [], config: { mode: 'tworound', heksVariant: 'flat', dorpsgekVariant: 'standard', heksMaySwapSelf: true, precommitRoles: [] },
    hasAlphaWolfCard: false,
  };
}

/** Line-per-event JSON, like Clocktower Bench's events.jsonl. */
export function toJsonl(log: GameLog): string {
  return log.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** One row per AI seat for model comparisons across many games. */
export function seatOutcomes(log: GameLog): { agent: string; team: string; won: boolean; votedWolf: boolean | null }[] {
  const setup = find(log, 'setup');
  const result = find(log, 'result');
  if (!setup || !result) return [];
  return setup.seats.filter((s) => s.kind === 'ai').map((s) => {
    const final = result.finalRoles[s.seat]!;
    const target = result.finalVotes[s.seat];
    return {
      agent: s.agent ?? '?',
      team: teamOf(final),
      won: result.seatWon[s.seat] ?? false,
      votedWolf: target === null || target === undefined ? null : isWolfRole(result.finalRoles[target]!),
    };
  });
}
