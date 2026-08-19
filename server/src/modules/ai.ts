// Optional AI layer — PRD §22, §39-40. v0.1 ships one adapter:
// OpenAI-compatible (works with OpenAI / DeepSeek / MiniMax / Ollama).
// AI NEVER owns program facts (selected take, render status, paths, …).
// All actions return suggestions the user applies explicitly.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

export interface DirectorInput {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  json?: boolean;
  temperature?: number;
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

  private async chat(input: DirectorInput): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.7,
        ...(input.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI returned no content');
    return content;
  }

  async complete(input: DirectorInput): Promise<string> {
    return this.chat(input);
  }

  async structured<T>(input: DirectorInput): Promise<T> {
    const text = await this.chat({ ...input, json: true });
    try {
      return JSON.parse(text) as T;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as T;
      throw new Error('AI did not return valid JSON');
    }
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

  async complete(messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>): Promise<string> {
    if (!this.model) throw new Error('AI not configured');
    return this.model.complete({ messages });
  }
}
