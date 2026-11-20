// Mock provider — offline development & acceptance testing. Renders a
// synthetic clip locally via ffmpeg so the entire Take pipeline (submit →
// poll → download → take) can be exercised with zero network and zero cost.
// Task records persist to disk so the queue-recovery path is fully testable:
// after a restart the mock resumes polling by providerTaskId, like RunningHub.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { H3Mode, MediaAsset, ProviderCapabilities } from '@h3mise/shared';
import type { Ffmpeg } from '../ffmpeg.js';
import type { RenderJobHandle, RenderRequestInput, RenderResult, RenderStatus, UploadedAsset, VideoProvider } from './types.js';
import { ProviderError } from './types.js';

const CAPS: ProviderCapabilities = {
  supportedModes: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va', 'faceswap'],
  minDuration: 1,
  maxDuration: 15,
  supportedAspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
  supportedResolutions: ['720p', '1080p'],
  maxImageRefs: 9,
  maxVideoRefs: 1,
  maxAudioRefs: 3,
  maxTotalRefs: 12,
  audioSupported: true,
};

interface MockTask {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED';
  startAt: number; // epoch ms when the task begins rendering
  duration: number;
  label: string;
  aspectRatio: string;
  cleanPlate?: boolean;
}

export class MockProvider implements VideoProvider {
  readonly id = 'mock';
  readonly name = 'Mock (offline)';
  readonly configured = true;
  private readonly tasksDir: string;

  constructor(
    private readonly ffmpeg: Ffmpeg,
    workDir: string,
  ) {
    this.tasksDir = join(workDir, 'mock-tasks');
  }

  private taskPath(id: string): string {
    return join(this.tasksDir, `${id}.json`);
  }

  private async readTask(id: string): Promise<MockTask | null> {
    try {
      return JSON.parse(await readFile(this.taskPath(id), 'utf8')) as MockTask;
    } catch {
      return null;
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return CAPS;
  }

  async uploadAsset(_asset: MediaAsset, _localPath: string): Promise<UploadedAsset> {
    return { providerRef: `mock://${_asset.id}` };
  }

  async submit(request: RenderRequestInput): Promise<RenderJobHandle> {
    const id = `mock-${Math.random().toString(36).slice(2, 10)}`;
    const duration = Math.min(15, Math.max(1, request.durationSeconds));
    await mkdir(this.tasksDir, { recursive: true });
    const task: MockTask = {
      id,
      status: 'QUEUED',
      startAt: Date.now() + 1200,
      duration,
      label: `Mock ${request.mode.toUpperCase()} · ${request.prompt.slice(0, 40)}`,
      aspectRatio: request.aspectRatio,
      cleanPlate: request.prompt.includes('surveillance_clean_plate'),
    };
    await writeFile(this.taskPath(id), JSON.stringify(task), 'utf8');
    return { providerTaskId: id };
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    const task = await this.readTask(handle.providerTaskId);
    if (!task) return { status: 'FAILED', error: 'unknown mock task (state lost)' };
    if (Date.now() < task.startAt) return { status: 'QUEUED' };
    const elapsed = Date.now() - task.startAt;
    if (elapsed < task.duration * 1000) return { status: 'RUNNING' };
    return { status: 'SUCCEEDED', resultUrl: `mock://result/${handle.providerTaskId}` };
  }

  async result(handle: RenderJobHandle): Promise<RenderResult> {
    const task = await this.readTask(handle.providerTaskId);
    if (!task) throw new ProviderError('unknown mock task', 'download');
    const st = await this.status(handle);
    if (st.status !== 'SUCCEEDED') throw new ProviderError('mock task not finished', 'download', st);
    const outPath = join(this.tasksDir, '..', `${handle.providerTaskId}.mp4`);
    try {
      const sizes: Record<string, string> = { '16:9': '1280x720', '9:16': '720x1280', '4:3': '960x720', '3:4': '720x960', '1:1': '720x720' };
      await this.ffmpeg.syntheticVideo(outPath, task.duration, task.cleanPlate ? '' : task.label, sizes[task.aspectRatio] ?? '1280x720');
    } catch (e) {
      throw new ProviderError('mock render failed: ' + (e instanceof Error ? e.message : e), 'download');
    }
    return { url: `mock://${outPath}`, cost: { credits: 0, unit: 'mock' } };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    await rm(this.taskPath(handle.providerTaskId), { force: true });
  }
}
