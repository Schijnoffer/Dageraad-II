/**
 * Pluggable LLM providers over plain `fetch` — no SDK dependencies, so the
 * same code runs in Node and (later, if wanted) in the table device's browser.
 *
 * Keys come from the environment of whoever runs the AI table. Nothing here
 * stores, logs or commits a key.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  readonly label: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmReply>;
}

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * USD per million tokens [input, output], list prices checked 2026-11-11 on
 * developers.openai.com/api/docs/pricing and platform.claude.com/docs/en/about-claude/pricing.
 * Unknown models report cost as null rather than a guess.
 */
export const PRICES: Record<string, [number, number]> = {
  'gpt-6-luna': [0.10, 0.50],
  'gpt-5.6-luna': [0.20, 1.20],
  'gpt-6.1-terra': [1.00, 5.00],
  'gpt-6.1-sol': [2.00, 10.00],
  'gpt-6-astra': [10.00, 50.00],
  'gpt-5-mini': [0.25, 2.00],
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-opus-5-5': [4.00, 20.00],
  'claude-fable-5-2': [8.00, 40.00],
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

export class LlmError extends Error {}

async function postJson(
  fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new LlmError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export function openAiClient(opts: {
  apiKey: string; model: string; baseUrl?: string; label?: string; fetchImpl?: FetchLike; timeoutMs?: number;
}): LlmClient {
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const label = opts.label ?? `openai:${opts.model}`;
  return {
    label,
    model: opts.model,
    async complete(req) {
      const json = await postJson(fetchImpl, `${base}/chat/completions`, {
        authorization: `Bearer ${opts.apiKey}`,
      }, {
        model: opts.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: req.maxTokens,
      }, opts.timeoutMs ?? 120_000);
      const choices = json.choices as { message?: { content?: string } }[] | undefined;
      const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        text: choices?.[0]?.message?.content ?? '',
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      };
    },
  };
}

export function anthropicClient(opts: {
  apiKey: string; model: string; fetchImpl?: FetchLike; timeoutMs?: number;
}): LlmClient {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  return {
    label: `anthropic:${opts.model}`,
    model: opts.model,
    async complete(req) {
      const json = await postJson(fetchImpl, 'https://api.anthropic.com/v1/messages', {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      }, {
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }, opts.timeoutMs ?? 120_000);
      const content = json.content as { type: string; text?: string }[] | undefined;
      const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        text: (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      };
    },
  };
}

export const DEFAULT_MODELS = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
} as const;

/**
 * Parse a provider spec: `mock`, `openai[:model]`, `anthropic[:model]`,
 * `compat:model` (any OpenAI-compatible endpoint via AI_BASE_URL), or `auto`
 * (Anthropic if its key is set, else OpenAI, else mock).
 *
 * Returns null for `mock`, meaning "use the scripted player".
 */
export function clientFromSpec(
  spec: string,
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
): LlmClient | null {
  const [provider, ...rest] = spec.trim().split(':');
  const model = rest.join(':') || undefined;
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new LlmError(`${name} is not set (needed for "${spec}")`);
    return value;
  };
  switch (provider) {
    case 'mock':
      return null;
    case 'auto':
      if (env.ANTHROPIC_API_KEY) return clientFromSpec(`anthropic${model ? `:${model}` : ''}`, env, fetchImpl);
      if (env.OPENAI_API_KEY) return clientFromSpec(`openai${model ? `:${model}` : ''}`, env, fetchImpl);
      return null;
    case 'openai':
      return openAiClient({
        apiKey: need('OPENAI_API_KEY'), model: model ?? DEFAULT_MODELS.openai,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case 'anthropic':
      return anthropicClient({
        apiKey: need('ANTHROPIC_API_KEY'), model: model ?? DEFAULT_MODELS.anthropic,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case 'compat':
      if (!model) throw new LlmError('compat needs a model, e.g. compat:google/gemini-x');
      return openAiClient({
        apiKey: need('AI_API_KEY'), model, baseUrl: need('AI_BASE_URL'), label: `compat:${model}`,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    default:
      throw new LlmError(`unknown AI provider "${provider}" (use mock, auto, openai, anthropic or compat)`);
  }
}
