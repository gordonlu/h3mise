export interface ByteRange {
  start: number;
  end: number;
}

/** Parse one RFC byte range. Multiple ranges are intentionally unsupported. */
export function parseByteRange(header: string, total: number): ByteRange | 'unsatisfiable' | null {
  if (total <= 0) return 'unsatisfiable';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= total || requestedEnd < start) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(requestedEnd, total - 1) };
}
