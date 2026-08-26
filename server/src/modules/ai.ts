// Optional AI layer — PRD §22, §39-40. v0.1 ships one adapter:
// OpenAI-compatible (works with OpenAI / DeepSeek / MiniMax / Ollama).
// AI NEVER owns program facts (selected take, render status, paths, …).
// All actions return suggestions the user applies explicitly.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

export type DirectorContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface DirectorMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | DirectorContentPart[];
}

export interface DirectorInput {
  system?: string;
  messages: DirectorMessage[];
  json?: boolean;
  temperature?: number;
  /** Request-level transport feedback; intentionally not serialized to the provider. */
  onVisionStatus?: (status: VisionStatus) => void;
}

export interface VisionStatus {
  mode: 'multimodal' | 'text_fallback' | 'text_only';
  imageCount: number;
}

export interface DirectorModel {
  complete(input: DirectorInput): Promise<string>;
  structured<T>(input: DirectorInput): Promise<T>;
}

export class OpenAICompatModel implements DirectorModel {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private async chatOnce(input: DirectorInput): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: input.system
          ? [{ role: 'system' as const, content: input.system }, ...input.messages]
          : input.messages,
        temperature: input.temperature ?? 0.7,
        ...(input.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      // Reasoning models (deepseek-v4 etc.) routinely think for 1–2 minutes
      // on director-plan sized inputs — 90s aborted healthy requests.
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI returned no content');
    return content;
  }

  private async chat(input: DirectorInput): Promise<string> {
    const imageCount = this.imageCount(input);
    try {
      const content = await this.chatOnce(input);
      input.onVisionStatus?.({ mode: imageCount > 0 ? 'multimodal' : 'text_only', imageCount });
      return content;
    } catch (first) {
      // OpenAI-compatible endpoints differ widely in multimodal support. If
      // an endpoint/model rejects image blocks (or the vision request times
      // out), retry transparently with the exact same text and no images.
      // This keeps existing text-only providers fully usable.
      if (this.hasImages(input)) {
        console.warn(`[ai] multimodal request failed; falling back to text: ${first instanceof Error ? first.message : first}`);
        const textInput = this.withoutImages(input);
        try {
          const content = await this.chatOnce(textInput);
          input.onVisionStatus?.({ mode: 'text_fallback', imageCount });
          return content;
        } catch (fallbackError) {
          if (!this.retryable(fallbackError)) throw fallbackError;
          try {
            const content = await this.chatOnce(textInput);
            input.onVisionStatus?.({ mode: 'text_fallback', imageCount });
            return content;
          } catch (second) {
            throw new Error(`${second instanceof Error ? second.message : second} (multimodal failed; text fallback retried once)`);
          }
        }
      }
      // Transient failures (timeout / 5xx / network) get one retry — normal
      // requests finish in seconds, so this only masks hiccups.
      if (!this.retryable(first)) throw first;
      try {
        return await this.chatOnce(input);
      } catch (second) {
        throw new Error(`${second instanceof Error ? second.message : second} (retried once)`);
      }
    }
  }

  private retryable(error: unknown): boolean {
    return error instanceof Error && /aborted due to timeout|AI HTTP 5\d\d|fetch failed/i.test(error.message);
  }

  private hasImages(input: DirectorInput): boolean {
    return this.imageCount(input) > 0;
  }

  private imageCount(input: DirectorInput): number {
    return input.messages.reduce((count, message) => count + (Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'image_url').length
      : 0), 0);
  }

  private withoutImages(input: DirectorInput): DirectorInput {
    return {
      ...input,
      messages: input.messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
          : message.content,
      })),
    };
  }

  async complete(input: DirectorInput): Promise<string> {
    return this.chat(input);
  }

  async structured<T>(input: DirectorInput): Promise<T> {
    const text = await this.chat({ ...input, json: true });
    const parsed = this.extractJson<T>(text);
    if (parsed.ok) return parsed.value;
    // The model ignored the JSON instruction — retry once with a blunt order.
    const retry = await this.chat({
      ...input,
      json: true,
      messages: [
        ...input.messages,
        { role: 'assistant', content: text.slice(0, 2000) },
        {
          role: 'user',
          content:
            'Your previous reply contained NO valid JSON. Respond with ONLY a single valid JSON value (array or object). No prose. No markdown. No code fences. No explanations. Begin directly with [ or { and end with ] or }.',
        },
      ],
    });
    const retried = this.extractJson<T>(retry);
    if (retried.ok) return retried.value;
    throw new Error(`AI did not return valid JSON (after retry): ${retry.slice(0, 120)}`);
  }

  private extractJson<T>(text: string): { ok: true; value: T } | { ok: false } {
    const candidates = [text];
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) candidates.push(fence[1]);
    for (const cand of candidates) {
      try {
        return { ok: true, value: JSON.parse(cand) as T };
      } catch {
        /* keep trying */
      }
    }
    for (const cand of candidates) {
      const obj = cand.match(/\{[\s\S]*\}/);
      if (obj) {
        try {
          return { ok: true, value: JSON.parse(obj[0]) as T };
        } catch {
          /* keep trying */
        }
      }
      const arr = cand.match(/\[[\s\S]*\]/);
      if (arr) {
        try {
          return { ok: true, value: JSON.parse(arr[0]) as T };
        } catch {
          /* keep trying */
        }
      }
    }
    return { ok: false };
  }
}

export interface AIServiceStatus {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
}

export class AIService {
  model: DirectorModel | null = null;
  status: AIServiceStatus;
  readonly skillsDir: string | null;

  constructor(
    private readonly cfg: { baseUrl: string | null; apiKey: string | null; model: string | null },
    skillsDir: string | null,
  ) {
    this.skillsDir = skillsDir;
    this.status = { configured: Boolean(cfg.baseUrl && cfg.apiKey && cfg.model), baseUrl: cfg.baseUrl, model: cfg.model };
    if (this.status.configured) {
      this.model = new OpenAICompatModel(cfg.baseUrl!, cfg.apiKey!, cfg.model!);
    }
  }

  /** Load local Director Skills (PRD §23). Falls back to bundled starter skills. */
  async loadSkills(): Promise<Array<{ id: string; title: string; content: string }>> {
    const bundled = [
      { id: 'h3-micro-cinematic-director', title: 'H3 Micro Cinematic Director', file: 'h3-micro-cinematic-director.md' },
      { id: 'h3-shot-pattern-library', title: 'H3 Shot Pattern Library', file: 'h3-shot-pattern-library.md' },
      { id: 'h3-performance-director', title: 'H3 Performance Director', file: 'h3-performance-director.md' },
    ];
    const dir = this.skillsDir;
    const out: Array<{ id: string; title: string; content: string }> = [];
    for (const b of bundled) {
      let content: string | null = null;
      if (dir) {
        try {
          const f = join(dir, b.file);
          await readFile(f, 'utf8').then((c) => (content = c));
        } catch {
          /* fall through to bundled */
        }
      }
      if (!content) {
        content = await readFile(join(SERVER_DIR, 'skills', b.file), 'utf8').catch(() => null);
      }
      out.push({ id: b.id, title: b.title, content: content ?? `(skill file ${b.file} not found)` });
    }
    return out;
  }

  async complete(messages: DirectorMessage[]): Promise<string> {
    if (!this.model) throw new Error('AI not configured');
    return this.model.complete({ messages });
  }
}
