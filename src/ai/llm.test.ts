import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../engine/types.js';
import { TWO_ROUND_CONFIG } from '../engine/presets.js';
import { agentFromSpec } from './agents.js';
import { extractJson, toChoice } from './choices.js';
import { clientFromSpec, costUsd, type FetchLike } from './llm.js';
import { simulateGame } from './simulate.js';
import type { SeatKnowledge } from './types.js';

function fakeFetch(reply: (body: Record<string, unknown>, url: string) => unknown) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, headers: init.headers, body });
    return { ok: true, status: 200, text: async () => JSON.stringify(reply(body, url)) };
  };
  return { fetchImpl, calls };
}

const openAiReply = (content: string) => ({
  choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 100 },
});
const anthropicReply = (text: string) => ({
  content: [{ type: 'text', text }], usage: { input_tokens: 2000, output_tokens: 200 },
});

const k: SeatKnowledge = {
  seat: 1, names: ['Rieks', 'AI Bram', 'Milan', 'AI Noor'], dealtRole: 'mystiekewolf',
  privateInfo: [], publicView: null, cards: ['mystiekewolf', 'heks', 'medium', 'dorpeling', 'dorpeling', 'dorpeling', 'leerlingziener'],
  config: TWO_ROUND_CONFIG, hasAlphaWolfCard: false,
};
const viewRequest: DecisionRequest = {
  seat: 1, actingAs: 'mystiekewolf', step: 40, key: 'mystic-view',
  prompt: { kind: 'seat', exclude: [1], optional: false }, dependsOnReveal: false,
};

describe('provider selection', () => {
  it('auto prefers Anthropic, then OpenAI, then the scripted mock', () => {
    expect(clientFromSpec('auto', { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })?.label).toBe('anthropic:claude-haiku-5-5');
    expect(clientFromSpec('auto', { OPENAI_API_KEY: 'o' })?.label).toBe('openai:gpt-6-luna');
    expect(clientFromSpec('auto', {})).toBeNull();
    expect(clientFromSpec('mock', { OPENAI_API_KEY: 'o' })).toBeNull();
  });

  it('refuses a provider whose key is missing, by name', () => {
    expect(() => clientFromSpec('openai:gpt-6.1-sol', {})).toThrow(/OPENAI_API_KEY/);
    expect(() => clientFromSpec('compat:some/model', { AI_API_KEY: 'x' })).toThrow(/AI_BASE_URL/);
  });

  it('prices known models and refuses to guess unknown ones', () => {
    expect(costUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(costUsd('who-knows', 1, 1)).toBeNull();
  });
});

describe('request shapes', () => {
  it('OpenAI: bearer key, JSON mode, system + user', async () => {
    const { fetchImpl, calls } = fakeFetch(() => openAiReply('{"thinking":"kijk bij Rieks","seat":0}'));
    const agent = agentFromSpec('openai:gpt-6-luna', 1, { OPENAI_API_KEY: 'sk-test' }, fetchImpl);
    const turn = await agent.night(k, viewRequest);

    expect(turn.value).toEqual({ kind: 'seat', seat: 0 });
    expect(turn.reasoning).toBe('kijk bij Rieks');
    expect(turn.usage?.costUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    const messages = calls[0]!.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toContain('Mystieke Wolf');
  });

  it('Anthropic: x-api-key, version header, text blocks joined', async () => {
    const { fetchImpl, calls } = fakeFetch(() => anthropicReply('Prima.\n```json\n{"thinking":"bluf","say":"Ik ben de Heks."}\n```'));
    const agent = agentFromSpec('anthropic', 2, { ANTHROPIC_API_KEY: 'sk-ant' }, fetchImpl);
    const turn = await agent.speak(k, { round: 1, rounds: 2, chat: [], mustTellTruth: false });

    expect(turn.value).toBe('Ik ben de Heks.');
    expect(turn.reasoning).toBe('bluf');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.body.model).toBe('claude-haiku-5-5');
  });

  it('never puts the API key in a prompt', async () => {
    const { fetchImpl, calls } = fakeFetch(() => openAiReply('{"thinking":"x","seat":2}'));
    await agentFromSpec('openai', 3, { OPENAI_API_KEY: 'sk-secret-123' }, fetchImpl).night(k, viewRequest);
    expect(JSON.stringify(calls[0]!.body)).not.toContain('sk-secret-123');
  });
});

describe('bad answers', () => {
  it('retries once on non-JSON, then falls back to the scripted player', async () => {
    const { fetchImpl, calls } = fakeFetch(() => openAiReply('Ik denk dat ik bij Milan kijk.'));
    const turn = await agentFromSpec('openai', 4, { OPENAI_API_KEY: 'k' }, fetchImpl).night(k, viewRequest);
    expect(calls).toHaveLength(2);
    expect(turn.fallback).toBe(true);
    expect(turn.value.kind).toBe('seat');
  });

  it('treats an illegal target (own seat) as unusable', async () => {
    const { fetchImpl } = fakeFetch(() => openAiReply('{"thinking":"","seat":1}'));
    const turn = await agentFromSpec('openai', 5, { OPENAI_API_KEY: 'k' }, fetchImpl).night(k, viewRequest);
    expect(turn.fallback).toBe(true);
    expect(turn.value).not.toEqual({ kind: 'seat', seat: 1 });
  });

  it('survives HTTP errors with the fallback rather than stalling the table', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    const turn = await agentFromSpec('anthropic', 6, { ANTHROPIC_API_KEY: 'k' }, fetchImpl)
      .vote(k, [{ seat: 0, name: 'Rieks', text: 'AI Bram is een wolf', round: 1 }]);
    expect(turn.fallback).toBe(true);
    expect(turn.value.target).not.toBe(1);
  });
});

describe('choice parsing', () => {
  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('blah {"a": {"b": "}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(extractJson('no json')).toBeNull();
  });

  it('validates every prompt kind', () => {
    const base = { seat: 0, actingAs: 'ziener' as const, step: 1, key: 'seer', dependsOnReveal: false };
    expect(toChoice({ center: [0, 2] }, { ...base, prompt: { kind: 'seat-or-center', exclude: [0], centerCount: 2 } }, 4))
      .toEqual({ kind: 'center', centerIndices: [0, 2] });
    expect(toChoice({ center: [0, 0] }, { ...base, prompt: { kind: 'seat-or-center', exclude: [0], centerCount: 2 } }, 4)).toBeNull();
    expect(toChoice({ seats: [1, 3] }, { ...base, prompt: { kind: 'two-seats', exclude: [0] } }, 4))
      .toEqual({ kind: 'seats', seats: [1, 3] });
    expect(toChoice({ seats: [0, 3] }, { ...base, prompt: { kind: 'two-seats', exclude: [0] } }, 4)).toBeNull();
    expect(toChoice({ direction: 'left' }, { ...base, prompt: { kind: 'dorpsgek', variant: 'standard' } }, 4))
      .toEqual({ kind: 'dorpsgek', direction: 'left' });
    expect(toChoice({ center: 5 }, { ...base, prompt: { kind: 'center', count: 1 } }, 4)).toBeNull();
  });
});

describe('a whole game on a fake LLM', () => {
  it('plays to a result with every call logged and priced', async () => {
    let n = 0;
    const { fetchImpl } = fakeFetch((body) => {
      n++;
      const user = String((body.messages as { content: string }[])[1]!.content);
      if (user.includes('STEMMING')) return openAiReply('{"thinking":"gok","beliefs":{"0":0.5},"vote":0}');
      if (user.includes('HET IS DAG')) return openAiReply(`{"thinking":"praat","say":"Bericht ${n}."}`);
      return openAiReply('{"thinking":"nacht"}');
    });
    const { log, run } = await simulateGame({
      ais: 5, seed: 12, rounds: 1,
      agentFor: (i) => agentFromSpec('openai:gpt-6-luna', i, { OPENAI_API_KEY: 'k' }, fetchImpl),
    });
    expect(run.day.missingVotes).toEqual([]);
    const calls = log.events.filter((e) => e.t === 'call');
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls.every((c) => c.t === 'call' && c.costUsd !== null)).toBe(true);
    // Votes for seat 0 come from the model, except seat 0 itself, which must fall back.
    const votes = log.events.filter((e) => e.t === 'vote');
    for (const v of votes) if (v.t === 'vote' && v.seat !== 0) expect(v.target).toBe(0);
  });
});
