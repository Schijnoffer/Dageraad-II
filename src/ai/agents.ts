import { teamOf } from '../engine/roles.js';
import { clientFromSpec, type FetchLike } from './llm.js';
import { llmAgent } from './llmagent.js';
import { scriptedAgent } from './scripted.js';
import type { AiAgent, SeatKnowledge } from './types.js';

const PERSONAS = [
  'rustig en analytisch, telt claims na',
  'spontaan en een beetje brutaal',
  'voorzichtig, stelt vragen voordat je iemand beschuldigt',
  'zelfverzekerd, neemt graag de leiding',
  'droog en kort van stof',
  'wantrouwig, gelooft niets zonder bewijs',
];

/** Build one AI player from a provider spec (see `clientFromSpec`). */
export function agentFromSpec(
  spec: string, seed: number, env: Record<string, string | undefined>, fetchImpl?: FetchLike,
): AiAgent {
  const fallback = scriptedAgent(seed);
  const client = clientFromSpec(spec, env, fetchImpl);
  if (!client) return fallback;
  return llmAgent(client, { fallback, persona: PERSONAS[Math.abs(seed) % PERSONAS.length]! });
}

/**
 * One model plays every village seat and another every wolf seat — the
 * Clocktower Bench setup, so a game measures one model's detection against
 * the other's deception. The team is fixed by the DEALT card at the first
 * call; a card that moves at night does not move the seat to the other model.
 */
export function teamRouter(village: AiAgent, wolves: AiAgent): AiAgent {
  let chosen: AiAgent | null = null;
  const pick = (k: SeatKnowledge) => (chosen ??= teamOf(k.dealtRole) === 'wolf' ? wolves : village);
  return {
    get label() { return chosen?.label ?? `${village.label}|${wolves.label}`; },
    night: (k, r) => pick(k).night(k, r),
    speak: (k, c) => pick(k).speak(k, c),
    vote: (k, c) => pick(k).vote(k, c),
  };
}
