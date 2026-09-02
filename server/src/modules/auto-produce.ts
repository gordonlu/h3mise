import type {
  AutoProducePlan, AutoProducePlanShot, AutoProduceProviderOption, AutoProduceRun,
  AutoProduceSettings, AutoProduceShot, AutoProduceStatus, H3Mode, StoryBeat,
} from '@h3mise/shared';
import { AUTO_PRODUCE_TERMINAL } from '@h3mise/shared';
import type { ProjectContext, ProjectStore } from '../project-store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { EventBus } from '../events.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { RenderQueue } from './render.js';
import { nextId } from '../db/ids.js';
import { j, jget } from '../db/sqlite.js';
import { getStory, listBeats, updateStory } from './story.js';
import { getShot, listShots, resolveDependentsAfterSelection, updateShot } from './shots.js';
import { applyBeatProposal, materializeMissingBeatShots } from './story-pipeline.js';
import { compilePrompt } from './prompt.js';
import { intentFromInput, renderIntentHash, runBasicPreflightIntent } from './preflight.js';
import { listTakes, selectTake } from './takes.js';
import { addMissingSelectedTakes, exportTimeline, getTimeline, removeClip } from './timeline.js';
import { runFilmCheck } from './film-check.js';

interface RunRow {
  id: string; status: string; settings_json: string; shots_json: string; current_step: string;
  export_rel_path: string | null; export_duration_seconds: number | null; error: string | null;
  started_at: string; updated_at: string; finished_at: string | null;
}

const ACTIVE_JOB = new Set(['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING']);
const SUCCESS_JOB = new Set(['LOCAL_READY', 'SUCCEEDED']);
const WAIT_MS = 500;
const MAX_WAIT_MS = 60 * 60 * 1000;

function fromRow(row: RunRow): AutoProduceRun {
  const shots = jget<AutoProduceShot[]>(row.shots_json, []);
  return {
    id: row.id,
    status: row.status as AutoProduceStatus,
    settings: jget<AutoProduceSettings>(row.settings_json, { providerId: 'mock', aspectRatio: '16:9', megapixels: 0.6, skipCompleted: true }),
    shots,
    totalShots: shots.length,
    doneShots: shots.filter((shot) => shot.state === 'done' || shot.state === 'skipped').length,
    failedShots: shots.filter((shot) => shot.state === 'failed').length,
    currentStep: row.current_step,
    exportRelPath: row.export_rel_path,
    exportUrl: row.export_rel_path ? `/api/file/${encodeURIComponent(row.export_rel_path)}` : null,
    exportDurationSeconds: row.export_duration_seconds,
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function storySegments(body: string, desired?: number): string[] {
  const raw = body.replace(/\r/g, '').split(/(?:\n\s*\n)|(?<=[。！？!?；;])\s*/u).map((part) => part.trim()).filter(Boolean);
  if (!raw.length) return [];
  const whole = raw.join('');
  const count = Math.max(1, Math.min(12, whole.length, desired ?? raw.length));
  if (raw.length === count) return raw;
  if (raw.length < count) {
    return Array.from({ length: count }, (_, index) => whole.slice(Math.floor(index * whole.length / count), Math.floor((index + 1) * whole.length / count)).trim()).filter(Boolean);
  }
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * raw.length / count);
    const end = Math.max(start + 1, Math.floor((i + 1) * raw.length / count));
    result.push(raw.slice(start, end).join(''));
  }
  return result;
}

function beatDuration(text: string, index: number, planned: number, count: number): number {
  const base = planned > 0 ? planned / count : 5;
  // Persist a small deterministic variation instead of assigning every beat
  // the same duration. Bounds match the story timing contract.
  const rhythm = [0, 1, -1, 2, -0.5][index % 5]!;
  const density = Math.min(2, Math.max(-1, (text.length - 35) / 35));
  return Math.round(Math.min(15, Math.max(2, base + rhythm + density)) * 10) / 10;
}

export class AutoProduceService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly getStore: () => ProjectStore,
    private readonly registry: ProviderRegistry,
    private readonly queue: RenderQueue,
    private readonly ffmpeg: Ffmpeg,
    private readonly bus: EventBus,
  ) {}

  listRuns(p: ProjectContext): AutoProduceRun[] {
    return p.db.all<RunRow>('SELECT * FROM auto_produce_runs ORDER BY started_at DESC').map(fromRow);
  }

  getRun(p: ProjectContext, id: string): AutoProduceRun | null {
    const row = p.db.get<RunRow>('SELECT * FROM auto_produce_runs WHERE id = ?', [id]);
    return row ? fromRow(row) : null;
  }

  getActiveRun(p: ProjectContext): AutoProduceRun | null {
    const row = p.db.get<RunRow>("SELECT * FROM auto_produce_runs WHERE status NOT IN ('succeeded','failed','cancelled') ORDER BY started_at DESC LIMIT 1");
    return row ? fromRow(row) : null;
  }

  async buildPlan(p: ProjectContext): Promise<AutoProducePlan> {
    const story = getStory(p);
    const beats = listBeats(p);
    const shots = listShots(p);
    const segments = beats.length ? [] : storySegments(story.body, shots.length || undefined);
    const previewShots = shots.map((shot) => this.planShot(p, shot));
    const statuses = await this.registry.statuses();
    const providers: AutoProduceProviderOption[] = statuses.map((status) => {
      const isMock = status.id === 'mock';
      const verified = status.verification.status === 'verified';
      // Node detection gives Preflight a real capability/mapping snapshot. It
      // is not the same as verification, but after the user explicitly accepts
      // the paid batch it is safe to submit the first task. The render queue
      // only promotes the profile to verified after that submission returns a
      // provider task id; a failed first task stops one-click at the real stage.
      const detectedReady = status.configured && status.verification.status === 'nodes_detected';
      return {
        id: status.id as AutoProduceProviderOption['id'], name: status.name, kind: status.kind,
        configured: status.configured, usable: isMock || verified || detectedReady,
        requiresConfirmation: !isMock,
        note: isMock
          ? '离线免费，适合完整验收'
          : verified
            ? '已通过真实提交验证，开始后可能产生真实费用'
            : detectedReady
              ? '节点已检测，尚未真实验证；开始后首个任务将验证映射并可能产生费用'
              : status.verification.status === 'failed'
                ? `检测失败：${status.verification.note || '请到设置中重新检测'}`
                : '尚未完成节点检测，不能用于一键制作',
      };
    });
    const blockers: string[] = [];
    if (!shots.length && !story.body.trim()) blockers.push('故事正文和镜头都为空，请先写故事或建立镜头。');
    const missingRefs = previewShots.filter((shot) => shot.willRender && !shot.refReady);
    if (missingRefs.length) blockers.push(`${missingRefs.length}个镜头缺少所选生成模式需要的参考素材；不会自动降级为t2va。`);
    const candidateShots = previewShots.filter((shot) => shot.hasCandidateTake);
    if (candidateShots.length) blockers.push(`${candidateShots.length}个镜头已有候选Take，请先选择或拒绝，避免重复付费生成。`);
    const activeShots = previewShots.filter((shot) => shot.hasActiveJob);
    if (activeShots.length) blockers.push(`${activeShots.length}个镜头已有生成任务，请等待并对账现有任务。`);
    const createBeats = beats.length ? 0 : segments.length;
    const uncoveredBeats = beats.filter((beat) => !shots.some((shot) => shot.storyBeatId === beat.id));
    const createShots = createBeats || uncoveredBeats.length;
    const newShotDuration = beats.length
      ? uncoveredBeats.reduce((sum, beat) => sum + beat.durationSeconds, 0)
      : segments.reduce((sum, text, i) => sum + beatDuration(text, i, story.plannedDurationSeconds, segments.length), 0);
    return {
      settings: { providerId: 'mock', aspectRatio: p.config.default_aspect_ratio || '16:9', megapixels: 0.6, skipCompleted: true },
      providers, shots: previewShots,
      renderCount: previewShots.filter((shot) => shot.willRender).length + createShots,
      skipCount: previewShots.filter((shot) => !shot.willRender).length,
      estimatedDurationSeconds: shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) + newShotDuration,
      storyPreparation: {
        willCreateBeats: createBeats, willCreateShots: createShots, uncoveredBeatIds: uncoveredBeats.map((beat) => beat.id),
        note: createBeats
          ? `开始时会把故事拆成${createBeats}个正式Beat并建立${createShots}个关联Shot`
          : createShots
            ? `开始时会为${createShots}个尚未覆盖的Beat补齐关联Shot`
            : null,
      },
      blockers,
    };
  }

  start(p: ProjectContext, settings: AutoProduceSettings): AutoProduceRun {
    if (this.getActiveRun(p)) throw new Error('已有一键制作正在运行');
    if (settings.providerId !== 'mock' && settings.confirmRealProvider !== true) throw new Error('真实生成服务可能产生费用，请在本次开始前明确确认');
    const provider = this.registry.get(settings.providerId);
    if (!provider) throw new Error('生成服务不存在');
    if (settings.providerId !== 'mock' && !provider.configured) throw new Error('生成服务尚未配置或节点未检测，不能开始一键制作');
    if (![0.6, 0.8, 1, 1.2].includes(settings.megapixels)) throw new Error('megapixels必须是0.6、0.8、1.0或1.2');
    const before = listShots(p).map((shot) => this.planShot(p, shot));
    if (before.some((shot) => shot.hasCandidateTake)) throw new Error('已有候选Take，请先选择或拒绝，避免重复付费生成');
    if (before.some((shot) => shot.hasActiveJob)) throw new Error('已有生成任务，请等待并对账现有任务');
    if (before.some((shot) => shot.willRender && !shot.refReady)) throw new Error('现有镜头缺少所选模式需要的参考素材');
    this.prepareProject(p);
    const shots = listShots(p);
    if (!shots.length) throw new Error('没有可制作的镜头');
    const now = new Date().toISOString();
    const id = nextId(p.db, 'autorun');
    const runShots: AutoProduceShot[] = shots.map((shot) => {
      const selected = listTakes(p, shot.id).find((take) => take.status === 'selected');
      return {
        shotId: shot.id, storyBeatId: shot.storyBeatId, order: shot.order, title: shot.title,
        // A selected Take is valuable user work. Beginner mode never spends
        // money replacing it; rerenders remain an explicit professional action.
        durationSeconds: shot.durationSeconds, state: selected ? 'skipped' : 'pending',
        renderJobId: null, takeId: selected?.id ?? null, error: null, attempts: 0,
      };
    });
    const storedSettings = { ...settings, confirmRealProvider: false };
    p.db.run(
      `INSERT INTO auto_produce_runs (id,status,settings_json,shots_json,current_step,started_at,updated_at)
       VALUES (?,'preparing',?,?,?, ?, ?)`,
      [id, j(storedSettings), j(runShots), '正在准备Prompt和生成检查…', now, now],
    );
    this.emit(id, 'preparing');
    void this.drive(p.meta.id, id).catch((error) => console.error('[auto-produce]', error));
    return this.getRun(p, id)!;
  }

  async cancel(projectId: string, runId: string): Promise<AutoProduceRun | null> {
    const p = await this.queue.backgroundContext(projectId);
    if (!p) return null;
    const run = this.getRun(p, runId);
    if (!run || AUTO_PRODUCE_TERMINAL.includes(run.status)) return run;
    this.patch(p, runId, { status: 'cancelled', currentStep: '已取消；已经提交的真实任务不会被重复提交', finishedAt: new Date().toISOString() });
    this.emit(runId, 'cancelled');
    return this.getRun(p, runId);
  }

  async resumeAll(): Promise<void> {
    for (const meta of await this.getStore().list()) {
      const p = await this.getStore().openDetached(meta.id).catch(() => null);
      if (!p) continue;
      try {
        const active = this.getActiveRun(p);
        if (active) void this.drive(meta.id, active.id).catch((error) => console.error('[auto-produce resume]', error));
      } finally { p.close(); }
    }
  }

  private planShot(p: ProjectContext, shot: ReturnType<typeof listShots>[number]): AutoProducePlanShot {
    const takes = listTakes(p, shot.id);
    const selected = takes.some((take) => take.status === 'selected');
    const candidate = !selected && takes.some((take) => take.status === 'candidate');
    const active = Boolean(p.db.get<{ id: string }>(
      `SELECT id FROM render_jobs WHERE shot_id = ? AND status IN (${[...ACTIVE_JOB].map(() => '?').join(',')}) LIMIT 1`,
      [shot.id, ...ACTIVE_JOB],
    ));
    const mode = shot.h3Mode ?? 't2va';
    const bindings = p.db.all<{ type: string; roles_json: string }>('SELECT type, roles_json FROM reference_bindings WHERE shot_id = ?', [shot.id]);
    const refReady = mode === 't2va' || bindings.some((binding) => {
      const roles = jget<string[]>(binding.roles_json, []);
      if (mode === 'ref2va') return binding.type === 'image' || binding.type === 'audio';
      if (mode === 'i2va') return roles.includes('first_frame');
      if (mode === 'l2va') return roles.includes('last_frame');
      return roles.includes('first_frame') || roles.includes('last_frame');
    });
    return { shotId: shot.id, storyBeatId: shot.storyBeatId, order: shot.order, title: shot.title, durationSeconds: shot.durationSeconds, mode, hasSelectedTake: selected, hasCandidateTake: candidate, hasActiveJob: active, willRender: !selected && !candidate && !active, refReady };
  }

  /** Materialize the beginner story plan into the same editable Beat/Shot
   * tables used by the professional flow. Safe to call repeatedly. */
  prepareProject(p: ProjectContext): void {
    let beats = listBeats(p);
    if (!beats.length) {
      const story = getStory(p);
      const segments = storySegments(story.body, listShots(p).length || undefined);
      if (segments.length) {
        const result = applyBeatProposal(p, segments.map((text, index) => ({
            title: text.replace(/\s+/g, ' ').slice(0, 24) || `段落${index + 1}`,
            summary: text, category: index === 0 ? 'setup' : index === segments.length - 1 ? 'resolution' : index === segments.length - 2 ? 'climax' : 'rising_action',
            durationSeconds: beatDuration(text, index, story.plannedDurationSeconds, segments.length),
          })), { mode: 'replace', createMissingShots: true });
        beats = result.beats;
        if (!story.plannedDurationSeconds) updateStory(p, { plannedDurationSeconds: beats.reduce((sum, beat) => sum + beat.durationSeconds, 0) });
      }
    }
    if (beats.length) materializeMissingBeatShots(p);
  }

  private patch(p: ProjectContext, runId: string, values: Partial<AutoProduceRun> & { shots?: AutoProduceShot[] }): void {
    const map: Record<string, string> = { status: 'status', currentStep: 'current_step', exportRelPath: 'export_rel_path', exportDurationSeconds: 'export_duration_seconds', error: 'error', finishedAt: 'finished_at', shots: 'shots_json' };
    const cols: string[] = []; const args: unknown[] = [];
    for (const [key, value] of Object.entries(values)) {
      const col = map[key]; if (!col || value === undefined) continue;
      cols.push(`${col} = ?`); args.push(key === 'shots' ? j(value) : value);
    }
    if (!cols.length) return;
    args.push(new Date().toISOString(), runId);
    p.db.run(`UPDATE auto_produce_runs SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, args);
  }

  private emit(runId: string, status: AutoProduceStatus): void {
    this.bus.emit({ type: 'auto.updated', runId, status });
    this.bus.emit({ type: 'project.updated' });
  }

  private async drive(projectId: string, runId: string): Promise<void> {
    if (this.inFlight.has(runId)) return;
    this.inFlight.add(runId);
    try {
      const p = await this.queue.backgroundContext(projectId);
      if (!p) return;
      let run = this.getRun(p, runId);
      if (!run || AUTO_PRODUCE_TERMINAL.includes(run.status)) return;

      this.patch(p, runId, { status: 'rendering', currentStep: '正在生成镜头；已完成的结果会保留' });
      this.emit(runId, 'rendering');
      // Dependency-aware waves: independent shots fill the configured
      // concurrency slots together; previous-Take shots wait until their
      // upstream Take is selected and its tail-frame binding is resolved.
      for (;;) {
        run = this.getRun(p, runId)!;
        if (run.status === 'cancelled') return;
        if (run.shots.some((shot) => shot.state === 'rendering' && shot.renderJobId)) {
          await this.waitForAll(p, runId);
          continue;
        }
        const pending = run.shots.filter((shot) => shot.state === 'pending' || (shot.state === 'rendering' && !shot.renderJobId));
        if (!pending.length) break;
        const ready = pending.filter((item) => {
          const shot = getShot(p, item.shotId);
          if (!shot.dependsOnShotId) return true;
          return listTakes(p, shot.dependsOnShotId).some((take) => take.status === 'selected');
        });
        if (!ready.length) {
          for (const item of pending) this.updateShotState(p, runId, item.shotId, { state: 'failed', error: '等待的上游镜头没有选定Take' });
          break;
        }
        for (const current of ready) {
          const existing = p.db.get<{ id: string }>(
            `SELECT id FROM render_jobs WHERE shot_id = ? AND provider = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
            [current.shotId, run.settings.providerId, run.startedAt],
          );
          if (existing) this.updateShotState(p, runId, current.shotId, { state: 'rendering', renderJobId: existing.id, attempts: Math.max(1, current.attempts) });
          else await this.submitShot(p, runId, current);
        }
        await this.waitForAll(p, runId);
      }
      run = this.getRun(p, runId)!;
      if (run.status === 'cancelled') return;
      if (run.failedShots) {
        this.patch(p, runId, { status: 'failed', currentStep: `${run.failedShots}个镜头失败，可修复后再次开始；成功镜头不会重做`, error: '部分镜头未完成', finishedAt: new Date().toISOString() });
        this.emit(runId, 'failed'); return;
      }

      this.patch(p, runId, { status: 'assembling', currentStep: '正在把选定Take加入原有时间线…' });
      this.emit(runId, 'assembling');
      for (const clip of getTimeline(p).clips) {
        const selected = listTakes(p, clip.shotId).find((take) => take.status === 'selected');
        if (!selected || selected.id !== clip.takeId) removeClip(p, clip.id);
      }
      addMissingSelectedTakes(p);
      this.patch(p, runId, { status: 'checking', currentStep: '正在做导出前成片检查…' });
      this.emit(runId, 'checking');
      const check = await runFilmCheck(p);
      if (!check.canExport) {
        this.patch(p, runId, { status: 'failed', currentStep: '成片检查未通过', error: check.errors.map((issue) => issue.message).join('；'), finishedAt: new Date().toISOString() });
        this.emit(runId, 'failed'); return;
      }
      this.patch(p, runId, { status: 'exporting', currentStep: '正在导出完整视频…' });
      this.emit(runId, 'exporting');
      const result = await exportTimeline(p, this.ffmpeg, getStory(p).title);
      this.patch(p, runId, { status: 'succeeded', currentStep: '制作完成，可以预览或进入专业工作台继续编辑', exportRelPath: result.relPath, exportDurationSeconds: result.durationSeconds, finishedAt: new Date().toISOString(), error: null });
      this.emit(runId, 'succeeded');
    } catch (error) {
      const p = await this.queue.backgroundContext(projectId);
      if (p) {
        this.patch(p, runId, { status: 'failed', currentStep: '制作中断', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
        this.emit(runId, 'failed');
      }
    } finally { this.inFlight.delete(runId); }
  }

  private async submitShot(p: ProjectContext, runId: string, item: AutoProduceShot): Promise<void> {
    try {
      const run = this.getRun(p, runId)!;
      const shot = getShot(p, item.shotId);
      const mode: H3Mode = shot.h3Mode ?? 't2va';
      if (shot.aspectRatio !== run.settings.aspectRatio) updateShot(p, shot.id, { aspectRatio: run.settings.aspectRatio });
      const prompt = compilePrompt(p, shot.id, mode, shot.durationSeconds);
      const intent = await intentFromInput(p, this.registry, { shotId: shot.id, promptVersionId: prompt.id, providerId: run.settings.providerId, mode, aspectRatio: run.settings.aspectRatio, megapixels: run.settings.megapixels });
      const preflight = await runBasicPreflightIntent(p, this.registry, intent);
      if (preflight.blocked) {
        const reasons = preflight.basic.flatMap((section) => section.checks).filter((check) => check.severity === 'error').map((check) => check.message);
        throw new Error(reasons.join('；') || '生成检查未通过');
      }
      const rh = this.registry.getProfile(); const comfy = this.registry.getComfyUiProfile();
      const profileRef = run.settings.providerId === 'comfyui'
        ? { appId: `comfyui:${comfy.clientId}`, checkedAt: comfy.verification.checkedAt }
        : { appId: rh?.appId ?? run.settings.providerId, checkedAt: rh?.verification.checkedAt ?? null };
      const job = await this.queue.submitDetached({
        projectId: p.meta.id, shotId: shot.id, promptVersionId: prompt.id, provider: run.settings.providerId,
        request: { provider: run.settings.providerId, aiAppId: run.settings.providerId === 'runninghub' ? rh?.appId ?? '' : 'comfyui-local', mode: intent.mode, promptVersionId: prompt.id, durationSeconds: intent.durationSeconds, aspectRatio: intent.aspectRatio, resolution: intent.resolution, megapixels: intent.megapixels, references: intent.references, providerParams: intent.providerParams },
        intentHash: renderIntentHash(intent, profileRef),
      });
      // queue.submitDetached persists before returning. Checkpoint immediately;
      // recovery also reconciles the row by shot/provider/start time.
      this.updateShotState(p, runId, shot.id, { state: 'rendering', renderJobId: job.id, attempts: item.attempts + 1, error: null });
    } catch (error) {
      this.updateShotState(p, runId, item.shotId, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private updateShotState(p: ProjectContext, runId: string, shotId: string, patch: Partial<AutoProduceShot>): void {
    const run = this.getRun(p, runId); if (!run) return;
    this.patch(p, runId, { shots: run.shots.map((shot) => shot.shotId === shotId ? { ...shot, ...patch } : shot) });
  }

  private async waitForAll(p: ProjectContext, runId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      const run = this.getRun(p, runId); if (!run || run.status === 'cancelled') return;
      let pending = 0;
      const shots = run.shots.map((shot) => {
        if (shot.state !== 'rendering' || !shot.renderJobId) return shot;
        const job = p.db.get<{ status: string; take_id: string | null; error: string | null }>('SELECT status,take_id,error FROM render_jobs WHERE id = ?', [shot.renderJobId]);
        if (!job) return { ...shot, state: 'failed' as const, error: '渲染任务记录丢失' };
        if (ACTIVE_JOB.has(job.status)) { pending++; return shot; }
        if (!SUCCESS_JOB.has(job.status)) return { ...shot, state: 'failed' as const, error: job.error ?? `任务状态${job.status}` };
        const manual = listTakes(p, shot.shotId).find((take) => take.status === 'selected');
        if (manual) return { ...shot, state: 'done' as const, takeId: manual.id, error: null };
        const result = job.take_id ? listTakes(p, shot.shotId).find((take) => take.id === job.take_id) : undefined;
        if (!result) return { ...shot, state: 'failed' as const, error: '生成完成但没有Take' };
        selectTake(p, result.id, this.bus);
        resolveDependentsAfterSelection(p, shot.shotId);
        return { ...shot, state: 'done' as const, takeId: result.id, error: null };
      });
      this.patch(p, runId, { shots, currentStep: `正在生成镜头，已完成${shots.filter((shot) => shot.state === 'done' || shot.state === 'skipped').length}/${shots.length}` });
      if (!pending) return;
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
    const run = this.getRun(p, runId);
    if (run) this.patch(p, runId, { shots: run.shots.map((shot) => shot.state === 'rendering' ? { ...shot, state: 'failed', error: '等待超时，未自动重试' } : shot) });
  }
}
