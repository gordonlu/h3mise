import type { CctvOverlayConfig, ShotContinuitySegment } from '@h3mise/shared';
import { existsSync } from 'node:fs';

const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simsun.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
];

export function cctvFontFile(): string | undefined {
  return CJK_FONT_CANDIDATES.find((path) => existsSync(path));
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/[\r\n]+/g, ' ');
}

function clockParts(startTime: string, offsetSeconds: number, fps: number): { date: string; timecode: string } {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(startTime);
  const base = parsed
    ? Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]), Number(parsed[4]), Number(parsed[5]), Number(parsed[6] ?? 0))
    : Date.UTC(2026, 0, 1);
  const date = new Date(base + Math.max(0, offsetSeconds) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const frame = Math.floor((Math.max(0, offsetSeconds) % 1) * fps);
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    timecode: `${pad(date.getUTCHours())}\\:${pad(date.getUTCMinutes())}\\:${pad(date.getUTCSeconds())}\\:${pad(frame)}`,
  };
}

function fontOption(fontFile?: string): string {
  return fontFile ? `fontfile='${escapeText(fontFile)}':` : '';
}

function drawText(text: string, x: string, y: string, size: number, fontFile?: string): string {
  return `drawtext=${fontOption(fontFile)}text='${escapeText(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=lightgreen:box=1:boxcolor=black@0.45:boxborderw=5`;
}

export function cctvVideoFilters(
  overlay: CctvOverlayConfig,
  segment: ShotContinuitySegment,
  options: { trimInSeconds: number; width: number; height: number; fps?: number | null; preview?: boolean; segmentOffsetSeconds?: number; fontFile?: string; availableFilters?: Set<string> },
): string[] {
  const filters: string[] = [];
  const has = (name: string) => !options.availableFilters || options.availableFilters.has(name);
  const width = Math.max(2, Math.round(options.width));
  const height = Math.max(2, Math.round(options.height));
  if (overlay.enabled && overlay.lowResolution) {
    const lowWidth = Math.max(2, Math.round(width / 3 / 2) * 2);
    const lowHeight = Math.max(2, Math.round(height / 3 / 2) * 2);
    filters.push(`scale=${lowWidth}:${lowHeight}:flags=neighbor`, `scale=${width}:${height}:flags=neighbor`);
  }
  if (overlay.enabled && overlay.blurUpscale && has('gblur')) {
    const lowWidth = Math.max(2, Math.round(width * 0.75 / 2) * 2);
    const lowHeight = Math.max(2, Math.round(height * 0.75 / 2) * 2);
    filters.push(`scale=${lowWidth}:${lowHeight}:flags=bilinear`, 'gblur=sigma=1.2', `scale=${width}:${height}:flags=bilinear`);
  }
  if (overlay.enabled && overlay.dotMatrix && has('drawgrid')) {
    filters.push('drawgrid=width=4:height=4:thickness=1:color=lightgreen@0.12');
  }
  if (overlay.enabled && has('drawtext')) {
    const fps = options.fps && options.fps > 0 ? Number(options.fps.toFixed(3)) : 24;
    const clock = clockParts(overlay.startTime, (options.segmentOffsetSeconds ?? segment.timeJumpSeconds) + options.trimInSeconds, fps);
    const fontSize = Math.max(12, Math.round(height * 0.028));
    const title = `${overlay.cameraLabel || 'CAM 04'} · ${overlay.location || 'UNKNOWN'}`;
    filters.push(drawText(title, '12', '12', fontSize, options.fontFile));
    if (overlay.showRec) filters.push(drawText('● REC', 'w-tw-12', '12', fontSize, options.fontFile));
    filters.push(drawText(clock.date, '12', 'h-th-12', fontSize, options.fontFile));
    filters.push(`drawtext=${fontOption(options.fontFile)}timecode='${clock.timecode}':rate=${fps}:x=w-tw-12:y=h-th-12:fontsize=${fontSize}:fontcolor=lightgreen:box=1:boxcolor=black@0.45:boxborderw=5`);
  }
  const frameSkip = options.preview ? 1 : segment.kind === 'surveillance_skip' ? Math.max(1, Math.floor(segment.frameSkip)) : 1;
  if (frameSkip > 1) {
    filters.push(`select='not(mod(n,${frameSkip}))'`, `setpts=N*${frameSkip}/FRAME_RATE/TB`);
  }
  return filters;
}
