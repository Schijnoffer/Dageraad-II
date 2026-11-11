import type { Choice, DecisionRequest } from '../engine/types.js';
import { extractJson, toChoice } from './choices.js';
import { costUsd, type LlmClient } from './llm.js';
import {
  GENERAL_RULES, knowledgeText, requestText, rolesInPlayText, seatLabel, seatingText,
} from './rules.js';
import type {
  AiAgent, PublicMessage, SeatKnowledge, SpeakContext, Turn, Usage, VoteDecision,
} from './types.js';

export interface LlmAgentOptions {
  /** Answers when the model's reply is unusable twice. Usually the scripted player. */
  fallback: AiAgent;
  /** Public word limit per message (Clocktower Bench uses 150; a table talks shorter). */
  maxWords?: number;
  /** Optional persona so a table of identical models does not sound identical. */
  persona?: string;
}

/**
 * One seat played by an LLM.
 *
 * Memory like a person's (the Clocktower Bench rule): each call is built from
 * what this seat knows, the public chat, and this seat's OWN earlier private
 * thoughts. No shared channel between seats, no notes about anyone else.
 */
export function llmAgent(client: LlmClient, opts: LlmAgentOptions): AiAgent {
  const maxWords = opts.maxWords ?? 80;
  const thoughts: string[] = [];

  function system(k: SeatKnowledge): string {
    return [
      'Je speelt mee als speler in een sociaal deductiespel aan een tafel met vrienden (mensen en AI\'s door elkaar).',
      'Speel om te winnen voor je eigen team. Je mag liegen, bluffen, beschuldigen en van mening veranderen; anderen kunnen dat ook.',
      'Praat in het Nederlands, kort en natuurlijk, zoals aan een echte tafel. Geen opmaak, geen emoji.',
      'Je antwoordt ALTIJD met precies één JSON-object. Het veld "thinking" is je privé-redenering: niemand aan tafel ziet die, alleen de replay achteraf.',
      opts.persona ? `Jouw speelstijl: ${opts.persona}` : '',
      '',
      'SPELREGELS',
      ...GENERAL_RULES.map((r) => `- ${r}`),
      '',
      'KAARTEN IN HET SPEL',
      rolesInPlayText(k.cards),
      '',
      'TAFEL',
      seatingText(k),
    ].filter((line) => line !== null).join('\n');
  }

  function memory(): string {
    if (thoughts.length === 0) return '';
    return `\nJe eigen eerdere privé-gedachten:\n${thoughts.slice(-6).map((t) => `- ${t}`).join('\n')}\n`;
  }

  function chatText(k: SeatKnowledge, chat: readonly PublicMessage[]): string {
    if (chat.length === 0) return '(nog niemand heeft iets gezegd)';
    return chat.map((m) => `${m.seat === null ? m.name : seatLabel(k, m.seat)}: ${m.text}`).join('\n');
  }

  async function ask(
    k: SeatKnowledge, user: string, maxTokens: number,
  ): Promise<{ json: Record<string, unknown> | null; usage: Usage }> {
    const sys = system(k);
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let json: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !json; attempt++) {
      try {
        const reply = await client.complete({
          system: sys,
          user: attempt === 0 ? user : `${user}\n\nLET OP: je vorige antwoord was geen geldig JSON-object. Antwoord alleen met JSON.`,
          maxTokens,
        });
        inputTokens += reply.inputTokens;
        outputTokens += reply.outputTokens;
        json = extractJson(reply.text);
      } catch (err) {
        if (attempt === 1) {
          return { json: null, usage: usage(started, inputTokens, outputTokens, String(err)) };
        }
      }
    }
    return { json, usage: usage(started, inputTokens, outputTokens) };
  }

  function usage(started: number, inputTokens: number, outputTokens: number, _error?: string): Usage {
    return {
      inputTokens, outputTokens, ms: Date.now() - started,
      costUsd: costUsd(client.model, inputTokens, outputTokens),
    };
  }

  function remember(thinking: unknown): string {
    const text = typeof thinking === 'string' ? thinking.trim() : '';
    if (text) thoughts.push(text.length > 400 ? `${text.slice(0, 400)}…` : text);
    return text;
  }

  return {
    label: client.label,

    async night(k: SeatKnowledge, request: DecisionRequest): Promise<Turn<Choice>> {
      const user = [
        'HET IS NACHT. Alleen jij ziet dit.',
        knowledgeText(k),
        memory(),
        requestText(k, request),
      ].join('\n');
      const { json, usage } = await ask(k, user, 2_000);
      const choice = json ? toChoice(json, request, k.names.length) : null;
      if (!choice) {
        const fb = await opts.fallback.night(k, request);
        return { ...fb, usage, fallback: true, reasoning: `[fallback] ${fb.reasoning}` };
      }
      return { value: choice, reasoning: remember(json?.thinking), usage };
    },

    async speak(k: SeatKnowledge, ctx: SpeakContext): Promise<Turn<string | null>> {
      const user = [
        `HET IS DAG — discussieronde ${ctx.round} van ${ctx.rounds}.`,
        knowledgeText(k),
        memory(),
        'Wat er tot nu toe openlijk gezegd is:',
        chatText(k, ctx.chat),
        '',
        ctx.mustTellTruth
          ? 'LET OP: de Rechter koos jou. Wat je nu zegt (je eerste uitspraak) MOET waar zijn. Je mag wel vaag blijven.'
          : '',
        `Wil je iets zeggen? Maximaal ${maxWords} woorden. Je mag ook zwijgen met "say": "".`,
        'Antwoord-JSON: {"thinking": "...", "say": "..."}',
      ].join('\n');
      const { json, usage } = await ask(k, user, 2_000);
      if (!json || typeof json.say !== 'string') {
        const fb = await opts.fallback.speak(k, ctx);
        return { ...fb, usage, fallback: true, reasoning: `[fallback] ${fb.reasoning}` };
      }
      const words = json.say.trim().split(/\s+/).filter(Boolean);
      const said = words.length === 0 ? null : words.slice(0, Math.round(maxWords * 1.5)).join(' ');
      return { value: said, reasoning: remember(json.thinking), usage };
    },

    async vote(k: SeatKnowledge, chat: readonly PublicMessage[]): Promise<Turn<VoteDecision>> {
      const others = k.names.map((_, s) => s).filter((s) => s !== k.seat);
      const user = [
        'DE STEMMING IS GEOPEND. Iedereen stemt tegelijk en geheim.',
        knowledgeText(k),
        memory(),
        'De hele discussie:',
        chatText(k, chat),
        '',
        'Geef eerst voor elke andere stoel je inschatting (0 tot 1) dat die speler bij dageraad een WOLF-kaart heeft. Die inschatting is privé en telt niet mee in het spel.',
        k.dealtRole === 'bodyguard'
          ? 'Als je bij dageraad nog de Bodyguard bent, beschermt je "vote" die speler in plaats van op hem te stemmen.'
          : '',
        `Stem dan op één andere stoel: ${others.join(', ')}.`,
        'Antwoord-JSON: {"thinking": "...", "beliefs": {"<stoel>": 0.0}, "vote": <stoelnummer>}',
      ].join('\n');
      const { json, usage } = await ask(k, user, 2_000);
      const target = Number(json?.vote);
      if (!json || !others.includes(target)) {
        const fb = await opts.fallback.vote(k, chat);
        return { ...fb, usage, fallback: true, reasoning: `[fallback] ${fb.reasoning}` };
      }
      const beliefs: Record<number, number> = {};
      if (json.beliefs && typeof json.beliefs === 'object') {
        for (const [seat, p] of Object.entries(json.beliefs as Record<string, unknown>)) {
          const n = Number(p);
          if (others.includes(Number(seat)) && Number.isFinite(n)) beliefs[Number(seat)] = Math.max(0, Math.min(1, n));
        }
      }
      return { value: { target, beliefs }, reasoning: remember(json.thinking), usage };
    },
  };
}
