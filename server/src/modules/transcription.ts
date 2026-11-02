// Optional speech-to-text for Audio Line segments. H3Mise ships no ASR model:
// use an explicit OpenAI-compatible endpoint or a local `whisper` CLI. Never
// pretend silence detection is transcription.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  provider: 'openai_compatible' | 'local_whisper';
  language?: string;
  segments: TranscriptSegment[];
}

function normalizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const start = Number(row.start ?? row.startSeconds ?? 0);
    const end = Number(row.end ?? row.endSeconds ?? start);
    const text = String(row.text ?? row.content ?? '').trim();
    return { start: Number.isFinite(start) ? Math.max(0, start) : 0, end: Number.isFinite(end) ? Math.max(start, end) : start, text };
  }).filter((segment) => segment.text && segment.end >= segment.start);
}

export async function transcribeAudio(filePath: string, options: { language?: string } = {}): Promise<TranscriptionResult> {
  const baseUrl = process.env.ASR_BASE_URL?.trim();
  const apiKey = process.env.ASR_API_KEY?.trim();
  const model = process.env.ASR_MODEL?.trim();
  if (baseUrl && model) {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), basename(filePath));
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (options.language) form.append('language', options.language);
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    const data = await response.json().catch(() => null) as { segments?: unknown; text?: string; language?: string; error?: { message?: string } } | null;
    if (!response.ok) throw new Error(`ASR request failed: ${data?.error?.message ?? `HTTP ${response.status}`}`);
    const segments = normalizeSegments(data?.segments);
    if (!segments.length && data?.text?.trim()) segments.push({ start: 0, end: 0, text: data.text.trim() });
    if (!segments.length) throw new Error('ASR returned no transcript segments');
    return { provider: 'openai_compatible', language: data?.language, segments };
  }

  const bin = process.env.H3MISE_WHISPER_BIN?.trim() || 'whisper';
  const dir = await mkdtemp(join(tmpdir(), 'h3mise-asr-'));
  try {
    await execFileAsync(bin, [
      filePath,
      '--output_format', 'json',
      '--output_dir', dir,
      '--model', process.env.H3MISE_WHISPER_MODEL?.trim() || 'small',
      ...(options.language ? ['--language', options.language] : []),
    ], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.json'));
    if (!files.length) throw new Error('whisper produced no JSON output');
    const parsed = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as { segments?: unknown; text?: string; language?: string };
    const segments = normalizeSegments(parsed.segments);
    if (!segments.length && parsed.text?.trim()) segments.push({ start: 0, end: 0, text: parsed.text.trim() });
    if (!segments.length) throw new Error('whisper returned no transcript segments');
    return { provider: 'local_whisper', language: parsed.language, segments };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No ASR configured. Set ASR_BASE_URL/ASR_MODEL or install the `whisper` CLI (or set H3MISE_WHISPER_BIN).');
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
