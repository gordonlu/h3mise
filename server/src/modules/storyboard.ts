import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Storyboard,
  StoryboardJob,
  StoryboardPanel,
  StoryboardPanelCount,
} from '@h3mise/shared';
import { recommendedStoryboardPanelCount } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { nextId } from '../db/ids.js';
import { j, jget } from '../db/sqlite.js';
import { getStory, listBeats } from './story.js';
import { getMedia, listEntities } from './assets.js';
import { importUpload } from './media.js';
import { directorStylePromptDirective } from './director-styles.js';

const RH_BASE = 'https://www.runninghub.cn';
const ACTIVE_JOB_STATUSES = "'SUBMITTING','QUEUED','RUNNING'";

interface StoryboardRow {
  id: string;
  series_id: string;
  page_number: number;
  source_start_index: number;
  source_end_index: number;
  source_segment_count: number;
  panel_count: number;
  status: string;
  source_duration_seconds: number;
  sheet_asset_id: string | null;
  prompt: string;
  created_at: string;
  updated_at: string;
}

interface PanelRow {
  id: string;
  storyboard_id: string;
  ord: number;
  description: string;
  asset_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  storyboard_id: string;
  panel_id: string | null;
  kind: string;
  provider_task_id: string | null;
  status: string;
  cost_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function panelFromRow(row: PanelRow): StoryboardPanel {
  return {
    id: row.id,
    storyboardId: row.storyboard_id,
    order: row.ord,
    description: row.description,
    assetId: row.asset_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobFromRow(row: JobRow): StoryboardJob {
  return {
    id: row.id,
    storyboardId: row.storyboard_id,
    panelId: row.panel_id,
    kind: row.kind as StoryboardJob['kind'],
    providerTaskId: row.provider_task_id,
    status: row.status as StoryboardJob['status'],
    cost: jget<Record<string, unknown> | null>(row.cost_json, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromRow(p: ProjectContext, row: StoryboardRow): Storyboard {
  const panels = p.db.all<PanelRow>('SELECT * FROM storyboard_panels WHERE storyboard_id = ? ORDER BY ord', [row.id]).map(panelFromRow);
  const latestJob = p.db.get<JobRow>('SELECT * FROM storyboard_jobs WHERE storyboard_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [row.id]);
  return {
    id: row.id,
    seriesId: row.series_id || row.id,
    pageNumber: row.page_number || 1,
    totalPages: p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboards WHERE series_id = ?', [row.series_id || row.id])?.n ?? 1,
    sourceStartIndex: row.source_start_index,
    sourceEndIndex: row.source_end_index,
    sourceSegmentCount: row.source_segment_count,
    panelCount: row.panel_count as StoryboardPanelCount,
    status: row.status as Storyboard['status'],
    sourceDurationSeconds: row.source_duration_seconds,
    sheetAssetId: row.sheet_asset_id,
    prompt: row.prompt,
    panels,
    activeJob: latestJob ? jobFromRow(latestJob) : null,
    sheetAsset: row.sheet_asset_id ? getMedia(p, row.sheet_asset_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireStoryboardRow(p: ProjectContext, id: string): StoryboardRow {
  const row = p.db.get<StoryboardRow>('SELECT * FROM storyboards WHERE id = ?', [id]);
  if (!row) throw new Error('storyboard not found');
  return row;
}

export function storyDurationSeconds(p: ProjectContext): number {
  const story = getStory(p);
  if (story.plannedDurationSeconds > 0) return story.plannedDurationSeconds;
  const beatDuration = listBeats(p).reduce((sum, beat) => sum + beat.durationSeconds, 0);
  return beatDuration > 0 ? beatDuration : p.config.default_duration_seconds;
}

export function getCurrentStoryboard(p: ProjectContext): Storyboard | null {
  const latest = p.db.get<StoryboardRow>('SELECT * FROM storyboards ORDER BY created_at DESC, id DESC LIMIT 1');
  if (!latest) return null;
  const row = p.db.get<StoryboardRow>('SELECT * FROM storyboards WHERE series_id = ? ORDER BY page_number LIMIT 1', [latest.series_id || latest.id]) ?? latest;
  return row ? fromRow(p, row) : null;
}

export function listStoryboardPages(p: ProjectContext): Storyboard[] {
  const latest = p.db.get<StoryboardRow>('SELECT * FROM storyboards ORDER BY created_at DESC, id DESC LIMIT 1');
  if (!latest) return [];
  return p.db.all<StoryboardRow>('SELECT * FROM storyboards WHERE series_id = ? ORDER BY page_number', [latest.series_id || latest.id]).map((row) => fromRow(p, row));
}

function splitSourceText(p: ProjectContext): string[] {
  const story = getStory(p);
  const beats = listBeats(p);
  const beatText = beats.map((beat) => [beat.title, beat.summary, beat.stateChange].filter(Boolean).join('：')).filter(Boolean);
  if (beatText.length) return beatText;
  return [story.synopsis, story.body]
    .filter(Boolean)
    .flatMap((text) => text.split(/(?<=[。！？.!?])|\n+/u))
    .map((text) => text.trim())
    .filter(Boolean);
}

function panelDescriptions(source: string[], count: StoryboardPanelCount): string[] {
  if (!source.length) return Array.from({ length: count }, (_, i) => `镜头 ${i + 1}：补充这一格的画面内容`);
  return Array.from({ length: count }, (_, i) => source[i] ?? `补充镜头：围绕第 ${Math.min(i, source.length - 1) + 1} 段增加一个不同景别或反应画面。`);
}

export function prepareStoryboard(p: ProjectContext, requestedCount?: number): Storyboard {
  const active = p.db.get<{ id: string }>(`SELECT id FROM storyboard_jobs WHERE status IN (${ACTIVE_JOB_STATUSES}) LIMIT 1`);
  if (active) throw new Error('当前有 Storyboard 生图任务正在进行，请等待任务完成后再重新规划');
  const duration = storyDurationSeconds(p);
  const source = splitSourceText(p);
  const sourceCount = Math.max(1, source.length);
  const recommended = recommendedStoryboardPanelCount(sourceCount);
  const count = requestedCount === undefined ? recommended : requestedCount;
  if (count !== 3 && count !== 6 && count !== 9) throw new Error('panelCount must be 3, 6, or 9');
  const seriesId = nextId(p.db, 'storyboard-series');
  const now = new Date().toISOString();
  const totalPages = Math.max(1, Math.ceil(sourceCount / count));
  let firstId = '';
  p.db.tx(() => {
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const id = nextId(p.db, 'storyboard');
      if (!firstId) firstId = id;
      const start = pageIndex * count;
      const end = Math.min(sourceCount, start + count);
      const pageSource = source.slice(start, end);
      const pageCount = pageIndex === totalPages - 1 ? recommendedStoryboardPanelCount(Math.max(1, pageSource.length)) : count;
      const descriptions = panelDescriptions(pageSource, pageCount);
      p.db.run(
        'INSERT INTO storyboards (id, panel_count, status, source_duration_seconds, sheet_asset_id, prompt, created_at, updated_at, series_id, page_number, source_start_index, source_end_index, source_segment_count) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, pageCount, 'draft', duration, '', now, now, seriesId, pageIndex + 1, start, end, sourceCount],
      );
      descriptions.forEach((description, index) => {
        p.db.run(
          'INSERT INTO storyboard_panels (id, storyboard_id, ord, description, asset_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)',
          [nextId(p.db, 'storyboard-panel'), id, index + 1, description, now, now],
        );
      });
    }
  });
  return fromRow(p, requireStoryboardRow(p, firstId));
}

export function updatePanel(p: ProjectContext, panelId: string, description: unknown): Storyboard {
  if (typeof description !== 'string' || !description.trim()) throw new Error('panel description is required');
  const row = p.db.get<PanelRow>('SELECT * FROM storyboard_panels WHERE id = ?', [panelId]);
  if (!row) throw new Error('storyboard panel not found');
  const now = new Date().toISOString();
  p.db.run('UPDATE storyboard_panels SET description = ?, updated_at = ? WHERE id = ?', [description.trim(), now, panelId]);
  p.db.run("UPDATE storyboards SET status = CASE WHEN status = 'approved' THEN 'ready' ELSE status END, updated_at = ? WHERE id = ?", [now, row.storyboard_id]);
  return fromRow(p, requireStoryboardRow(p, row.storyboard_id));
}

export function approveStoryboard(p: ProjectContext, id: string): Storyboard {
  const row = requireStoryboardRow(p, id);
  const seriesId = row.series_id || row.id;
  const missing = p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboard_panels sp JOIN storyboards s ON s.id = sp.storyboard_id WHERE s.series_id = ? AND sp.asset_id IS NULL', [seriesId])?.n ?? row.panel_count;
  if (missing > 0) throw new Error('请先生成全部 Storyboard 页面和分格再批准');
  p.db.run("UPDATE storyboards SET status = 'approved', updated_at = ? WHERE series_id = ?", [new Date().toISOString(), seriesId]);
  return fromRow(p, requireStoryboardRow(p, id));
}

function visualAliases(p: ProjectContext): string {
  return listEntities(p).map((entity, index) => {
    const alias = String.fromCharCode(65 + index);
    const traits = Object.entries(entity.traits).map(([key, value]) => `${key}: ${value}`).join(', ');
    const creatureRule = entity.kind === 'creature' ? ' This is a creature: do not invent clothing or a hairstyle.' : '';
    return `${alias} = ${entity.kind}; ${entity.description || entity.name}${traits ? `; ${traits}` : ''}.${creatureRule}`;
  }).join('\n');
}

export function buildStoryboardPrompt(p: ProjectContext, storyboard: Storyboard, onlyPanel?: StoryboardPanel): string {
  const rows = storyboard.panelCount / 3;
  const panels = onlyPanel ? [onlyPanel] : storyboard.panels;
  const numbered = panels.map((panel) => `${panel.order}. ${panel.description}`).join('\n');
  const layout = onlyPanel
    ? 'Create one storyboard panel inside the single black frame.'
    : `Create exactly ${storyboard.panelCount} storyboard panels in a fixed 3-column by ${rows}-row grid.`;
  const directorStyle = directorStylePromptDirective(p);
  return [
    'Professional cinematic storyboard concept art, clear readable staging, consistent identities and environments.',
    directorStyle && `Project director style: ${directorStyle}`,
    layout,
    'Use the supplied layout image only as geometry. Keep straight solid black outer borders and black separators. Never add extra panels, captions, labels, numbers, logos, or text.',
    'Each panel is one distinct chronological moment. Do not merge adjacent moments. Preserve screen direction and continuity.',
    visualAliases(p),
    'Chronological panels:',
    numbered,
  ].filter(Boolean).join('\n');
}

async function runningHubJson(key: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${RH_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const jsonBody = await response.json().catch(() => null);
  if (!response.ok || !jsonBody || typeof jsonBody !== 'object') throw new Error(`RunningHub HTTP ${response.status}`);
  return jsonBody as Record<string, unknown>;
}

async function uploadLayout(key: string, path: string): Promise<string> {
  const data = await readFile(path);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: 'image/png' }), 'storyboard-layout.png');
  const response = await fetch(`${RH_BASE}/openapi/v2/media/upload/binary`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180_000),
  });
  const result = await response.json().catch(() => null) as { code?: number; msg?: string; data?: { fileName?: string } } | null;
  if (!response.ok || result?.code !== 0 || !result.data?.fileName) throw new Error(`Storyboard 布局图上传失败：${result?.msg ?? `HTTP ${response.status}`}`);
  return result.data.fileName;
}

function requireProvider(providers: ProviderRegistry) {
  const key = providers.getEffectiveApiKey();
  const profile = providers.getStoryboardProfile();
  if (!key) throw new Error('请先在设置中配置 RunningHub API Key');
  if (!profile.enabled) throw new Error('Storyboard 生图 Provider 未启用');
  if (profile.verification.status !== 'nodes_detected' && profile.verification.status !== 'verified') {
    throw new Error('请先在设置中检测 Storyboard AI App 节点映射');
  }
  for (const slot of Object.values(profile.inputs)) if (!slot.nodeId) throw new Error('Storyboard Provider 节点映射不完整');
  return { key, profile };
}

async function submitJob(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  providers: ProviderRegistry,
  storyboardId: string,
  panelId?: string,
): Promise<Storyboard> {
  const storyboard = fromRow(p, requireStoryboardRow(p, storyboardId));
  const panel = panelId ? storyboard.panels.find((item) => item.id === panelId) : undefined;
  if (panelId && !panel) throw new Error('storyboard panel not found');
  const active = p.db.get<{ id: string }>(`SELECT id FROM storyboard_jobs WHERE storyboard_id = ? AND status IN (${ACTIVE_JOB_STATUSES}) LIMIT 1`, [storyboardId]);
  if (active) throw new Error('这个 Storyboard 已有生图任务正在进行');
  const { key, profile } = requireProvider(providers);
  const jobId = nextId(p.db, 'storyboard-job');
  const now = new Date().toISOString();
  const prompt = buildStoryboardPrompt(p, storyboard, panel);
  const cacheDir = join(p.root, 'cache', 'storyboards');
  await mkdir(cacheDir, { recursive: true });
  const layoutPath = join(cacheDir, `${jobId}-layout.png`);
  if (panel) await ffmpeg.storyboardPanelTemplate(layoutPath);
  else await ffmpeg.storyboardGridTemplate(layoutPath, storyboard.panelCount);
  p.db.run(
    'INSERT INTO storyboard_jobs (id, storyboard_id, panel_id, kind, provider_task_id, status, request_json, response_json, cost_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?)',
    [jobId, storyboardId, panelId ?? null, panel ? 'panel' : 'sheet', 'SUBMITTING', j({ panelCount: panel ? 1 : storyboard.panelCount, prompt }), now, now],
  );
  p.db.run("UPDATE storyboards SET status = 'generating', prompt = ?, updated_at = ? WHERE id = ?", [prompt, now, storyboardId]);
  try {
    const layoutRef = await uploadLayout(key, layoutPath);
    const nodeInfoList = [
      { nodeId: profile.inputs.prompt.nodeId, fieldName: profile.inputs.prompt.fieldName, fieldValue: prompt },
      { nodeId: profile.inputs.size.nodeId, fieldName: profile.inputs.size.fieldName, fieldValue: panel ? profile.sizeValues[3] : profile.sizeValues[storyboard.panelCount] },
      { nodeId: profile.inputs.layoutImage.nodeId, fieldName: profile.inputs.layoutImage.fieldName, fieldValue: layoutRef },
    ];
    const result = await runningHubJson(key, `/openapi/v2/run/ai-app/${profile.appId}`, { nodeInfoList });
    const taskId = typeof result.taskId === 'string' || typeof result.taskId === 'number' ? String(result.taskId) : '';
    if (!taskId || (result.errorCode && String(result.errorCode))) throw new Error(`Storyboard 提交失败：${String(result.errorMessage ?? result.errorCode ?? '未返回 taskId')}`);
    p.db.run("UPDATE storyboard_jobs SET provider_task_id = ?, status = 'QUEUED', response_json = ?, updated_at = ? WHERE id = ?", [taskId, j(result), new Date().toISOString(), jobId]);
    providers.confirmStoryboardVerified();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.db.run("UPDATE storyboard_jobs SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?", [message, new Date().toISOString(), jobId]);
    p.db.run("UPDATE storyboards SET status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), storyboardId]);
    throw error;
  }
  return fromRow(p, requireStoryboardRow(p, storyboardId));
}

export function submitSheetGeneration(p: ProjectContext, ffmpeg: Ffmpeg, providers: ProviderRegistry, storyboardId: string): Promise<Storyboard> {
  return submitJob(p, ffmpeg, providers, storyboardId);
}

export function submitPanelRegeneration(p: ProjectContext, ffmpeg: Ffmpeg, providers: ProviderRegistry, storyboardId: string, panelId: string): Promise<Storyboard> {
  return submitJob(p, ffmpeg, providers, storyboardId, panelId);
}

async function downloadImage(url: string): Promise<{ data: Buffer; mimeType: string; extension: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Storyboard 图片下载失败：HTTP ${response.status}`);
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const extension = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  return { data: Buffer.from(await response.arrayBuffer()), mimeType, extension };
}

async function applySheetResult(p: ProjectContext, ffmpeg: Ffmpeg, storyboard: Storyboard, data: Buffer, mimeType: string, extension: string): Promise<void> {
  const sheet = await importUpload(p, ffmpeg, { fileName: `storyboard-${storyboard.id}.${extension}`, mimeType, data, source: 'render_download', label: `Storyboard ${storyboard.panelCount} 宫格` });
  const cacheDir = join(p.root, 'cache', 'storyboards', `${storyboard.id}-${Date.now()}`);
  await mkdir(cacheDir, { recursive: true });
  const outputs = storyboard.panels.map((panel) => join(cacheDir, `panel-${panel.order}.png`));
  await ffmpeg.splitStoryboardGrid(p.resolveProjectPath(sheet.fileName), outputs, storyboard.panelCount);
  for (let index = 0; index < storyboard.panels.length; index++) {
    const panel = storyboard.panels[index]!;
    const asset = await importUpload(p, ffmpeg, { fileName: `storyboard-${storyboard.id}-panel-${panel.order}.png`, mimeType: 'image/png', data: await readFile(outputs[index]!), source: 'other', label: `Storyboard 格 ${panel.order}` });
    const version = panel.version + 1;
    p.db.run('INSERT INTO storyboard_panel_versions (id, panel_id, version, asset_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [nextId(p.db, 'storyboard-panel-version'), panel.id, version, asset.id, 'sheet', new Date().toISOString()]);
    p.db.run('UPDATE storyboard_panels SET asset_id = ?, version = ?, updated_at = ? WHERE id = ?', [asset.id, version, new Date().toISOString(), panel.id]);
  }
  p.db.run("UPDATE storyboards SET sheet_asset_id = ?, status = 'ready', updated_at = ? WHERE id = ?", [sheet.id, new Date().toISOString(), storyboard.id]);
}

async function applyPanelResult(p: ProjectContext, ffmpeg: Ffmpeg, storyboard: Storyboard, panelId: string, data: Buffer, mimeType: string, extension: string): Promise<void> {
  const panel = storyboard.panels.find((item) => item.id === panelId);
  if (!panel) throw new Error('storyboard panel not found');
  const asset = await importUpload(p, ffmpeg, { fileName: `storyboard-${storyboard.id}-panel-${panel.order}-v${panel.version + 1}.${extension}`, mimeType, data, source: 'render_download', label: `Storyboard 格 ${panel.order} v${panel.version + 1}` });
  const version = panel.version + 1;
  const now = new Date().toISOString();
  p.db.run('INSERT INTO storyboard_panel_versions (id, panel_id, version, asset_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [nextId(p.db, 'storyboard-panel-version'), panel.id, version, asset.id, 'panel', now]);
  p.db.run('UPDATE storyboard_panels SET asset_id = ?, version = ?, updated_at = ? WHERE id = ?', [asset.id, version, now, panel.id]);
  const current = fromRow(p, requireStoryboardRow(p, storyboard.id));
  if (current.panels.every((item) => item.assetId)) {
    const paths = current.panels.map((item) => p.resolveProjectPath(getMedia(p, item.assetId!).fileName));
    const cacheDir = join(p.root, 'cache', 'storyboards');
    await mkdir(cacheDir, { recursive: true });
    const composedPath = join(cacheDir, `${storyboard.id}-composed-${Date.now()}.png`);
    await ffmpeg.composeStoryboardGrid(paths, composedPath, storyboard.panelCount);
    const composed = await importUpload(p, ffmpeg, { fileName: `storyboard-${storyboard.id}-composed.png`, mimeType: 'image/png', data: await readFile(composedPath), source: 'other', label: `Storyboard ${storyboard.panelCount} 宫格（重组）` });
    p.db.run("UPDATE storyboards SET sheet_asset_id = ?, status = 'ready', updated_at = ? WHERE id = ?", [composed.id, new Date().toISOString(), storyboard.id]);
  } else {
    p.db.run("UPDATE storyboards SET status = 'ready', updated_at = ? WHERE id = ?", [new Date().toISOString(), storyboard.id]);
  }
}

export async function reconcileStoryboard(p: ProjectContext, ffmpeg: Ffmpeg, providers: ProviderRegistry, storyboardId?: string): Promise<Storyboard | null> {
  const current = storyboardId ? fromRow(p, requireStoryboardRow(p, storyboardId)) : getCurrentStoryboard(p);
  if (!current) return null;
  const jobRow = p.db.get<JobRow>(`SELECT * FROM storyboard_jobs WHERE storyboard_id = ? AND status IN (${ACTIVE_JOB_STATUSES}) ORDER BY created_at LIMIT 1`, [current.id]);
  if (!jobRow || !jobRow.provider_task_id || jobRow.status === 'SUBMITTING') return current;
  const key = providers.getEffectiveApiKey();
  if (!key) return current;
  let result: Record<string, unknown>;
  try {
    result = await runningHubJson(key, '/openapi/v2/query', { taskId: jobRow.provider_task_id });
  } catch {
    return current;
  }
  const status = String(result.status ?? '').toUpperCase();
  if (status === 'QUEUED' || status === 'RUNNING') {
    p.db.run('UPDATE storyboard_jobs SET status = ?, response_json = ?, updated_at = ? WHERE id = ?', [status, j(result), new Date().toISOString(), jobRow.id]);
    return fromRow(p, requireStoryboardRow(p, current.id));
  }
  if (status !== 'SUCCESS') {
    const error = String(result.errorMessage ?? result.failedReason ?? result.errorCode ?? 'Storyboard 任务失败');
    p.db.run("UPDATE storyboard_jobs SET status = 'FAILED', response_json = ?, error = ?, updated_at = ? WHERE id = ?", [j(result), error, new Date().toISOString(), jobRow.id]);
    p.db.run("UPDATE storyboards SET status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), current.id]);
    return fromRow(p, requireStoryboardRow(p, current.id));
  }
  try {
    const results = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : [];
    const url = results.map((item) => item.url).find((value): value is string => typeof value === 'string' && Boolean(value));
    if (!url) throw new Error('Storyboard 任务成功但没有返回图片');
    const downloaded = await downloadImage(url);
    if (jobRow.kind === 'panel' && jobRow.panel_id) await applyPanelResult(p, ffmpeg, current, jobRow.panel_id, downloaded.data, downloaded.mimeType, downloaded.extension);
    else await applySheetResult(p, ffmpeg, current, downloaded.data, downloaded.mimeType, downloaded.extension);
    p.db.run("UPDATE storyboard_jobs SET status = 'SUCCESS', response_json = ?, cost_json = ?, updated_at = ? WHERE id = ?", [j(result), j(result.usage ?? null), new Date().toISOString(), jobRow.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.db.run("UPDATE storyboard_jobs SET status = 'FAILED', response_json = ?, error = ?, updated_at = ? WHERE id = ?", [j(result), message, new Date().toISOString(), jobRow.id]);
    p.db.run("UPDATE storyboards SET status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), current.id]);
  }
  return fromRow(p, requireStoryboardRow(p, current.id));
}
