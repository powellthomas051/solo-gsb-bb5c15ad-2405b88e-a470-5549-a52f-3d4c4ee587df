import type { Chapter } from '../types';
import { MIN_CHAPTER_DURATION } from './chapterOps';
import { clamp, formatTime, uid } from './time';

/**
 * Chapter file import (JSON exported by this tool, or standard WebVTT).
 *
 * Parsing is lenient: every cue / array item becomes an entry, with NaN
 * times when its timecodes cannot be parsed. `buildImportPlan` then
 * classifies each entry against the current audio duration and the existing
 * chapters (ok / invalid / out-of-range / overlap) for the preview dialog.
 * `mergeImportedChapters` applies the ok entries atomically: fresh unique
 * ids, sorted by start, verified non-overlapping — any invariant violation
 * aborts the whole merge (null) so a failed import never partially writes.
 */

/** A chapter as parsed from an external file; times may be NaN. */
export interface ParsedChapter {
  title: string;
  start: number;
  end: number;
}

export type ImportFormat = 'json' | 'vtt';

export type ImportStatus = 'ok' | 'invalid' | 'out-of-range' | 'overlap';

export interface ImportEntry extends ParsedChapter {
  /** 1-based position of the entry in the source file. */
  index: number;
  status: ImportStatus;
  /** Human-readable detail shown in the preview list. */
  reason: string;
}

export interface ImportPlan {
  format: ImportFormat;
  entries: ImportEntry[];
}

/** Tolerance (s) for rounding overshoot at the file edges; clamped on apply. */
const EDGE_EPS = 0.002;
const OVERLAP_EPS = 1e-9;

/** Parse a WebVTT timestamp: HH:MM:SS.mmm or MM:SS.mmm (comma tolerated). */
export function parseVttTime(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (minutes > 59 || seconds > 59) return null;
  const ms = Number(m[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/** Parse standard WebVTT: cue identifier, NOTE/STYLE/REGION blocks and cue
 *  settings are skipped; multi-line cue text is joined into one title. */
export function parseWebVtt(text: string): ParsedChapter[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  if (!lines[0]?.trimStart().startsWith('WEBVTT')) {
    throw new Error('不是有效的 WebVTT 文件（缺少 WEBVTT 文件头）。');
  }
  // blank-line-separated blocks after the header line
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);

  const chapters: ParsedChapter[] = [];
  for (const block of blocks) {
    if (/^(NOTE|STYLE|REGION)\b/.test(block[0].trim())) continue;
    // the timing line holds the arrow; lines before it are cue identifiers
    const timingIdx = block.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;
    const timing = block[timingIdx];
    const arrow = timing.indexOf('-->');
    const start = parseVttTime(timing.slice(0, arrow));
    // anything after the end timecode is cue settings (align, position, …)
    const endToken = timing.slice(arrow + 3).trim().split(/\s+/)[0] ?? '';
    const end = parseVttTime(endToken);
    chapters.push({
      title: block
        .slice(timingIdx + 1)
        .join(' ')
        .trim(),
      start: start ?? NaN,
      end: end ?? NaN,
    });
  }
  return chapters;
}

/** Parse the tool's JSON export (`{ version, chapters: [...] }`; a bare
 *  chapter array is also accepted). Items with non-numeric times are kept
 *  as NaN entries so the preview can flag them individually. */
export function parseJsonChapters(text: string): ParsedChapter[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败：文件不是有效的 JSON。');
  }
  const list: unknown = Array.isArray(data)
    ? data
    : (data as { chapters?: unknown } | null)?.chapters;
  if (!Array.isArray(list)) {
    throw new Error('JSON 中缺少 chapters 数组，请选择本工具导出的章节文件。');
  }
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  return list.map((item) => {
    const c = item as { title?: unknown; start?: unknown; end?: unknown } | null;
    return {
      title: typeof c?.title === 'string' ? c.title.trim() : '',
      start: num(c?.start),
      end: num(c?.end),
    };
  });
}

/** Detect the format and parse a chapter file. Throws when the file is
 *  neither WebVTT nor JSON, or contains no entries at all. */
export function parseChapterFile(text: string): {
  format: ImportFormat;
  chapters: ParsedChapter[];
} {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('WEBVTT')) {
    const chapters = parseWebVtt(text);
    if (chapters.length === 0) throw new Error('WebVTT 文件中没有可识别的章节（cue）。');
    return { format: 'vtt', chapters };
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    const chapters = parseJsonChapters(text);
    if (chapters.length === 0) throw new Error('JSON 文件中没有章节条目。');
    return { format: 'json', chapters };
  }
  throw new Error('无法识别的文件格式：请选择本工具导出的 JSON 或标准 WebVTT 文件。');
}

/**
 * Classify parsed chapters for the import preview. Entries stay in file
 * order. An entry is `ok` only when it is intrinsically valid, lies within
 * [0, duration] and overlaps neither an existing chapter nor an already
 * accepted entry of the same import.
 */
export function buildImportPlan(
  parsed: ParsedChapter[],
  existing: Chapter[],
  duration: number,
): ImportEntry[] {
  const existingSorted = [...existing].sort((a, b) => a.start - b.start);

  const entries: ImportEntry[] = parsed.map((p, i) => {
    const base = { index: i + 1, title: p.title, start: p.start, end: p.end };
    if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) {
      return { ...base, status: 'invalid' as const, reason: '时间缺失或无法解析' };
    }
    if (p.end - p.start < MIN_CHAPTER_DURATION) {
      return {
        ...base,
        status: 'invalid' as const,
        reason: `起止颠倒或时长短于 ${MIN_CHAPTER_DURATION}s`,
      };
    }
    if (p.start < -EDGE_EPS) {
      return { ...base, status: 'out-of-range' as const, reason: '起点早于音频开头' };
    }
    if (p.end > duration + EDGE_EPS) {
      return {
        ...base,
        status: 'out-of-range' as const,
        reason: `终点超出音频时长（${formatTime(duration)}）`,
      };
    }
    return { ...base, status: 'ok' as const, reason: '可导入' };
  });

  // overlap pass: intrinsically valid entries, in time order
  const accepted: { start: number; end: number }[] = [];
  const candidates = entries
    .filter((e) => e.status === 'ok')
    .sort((a, b) => a.start - b.start || a.index - b.index);
  for (const e of candidates) {
    const hit = existingSorted.find(
      (c) => e.start < c.end - OVERLAP_EPS && e.end > c.start + OVERLAP_EPS,
    );
    if (hit) {
      e.status = 'overlap';
      e.reason = `与现有章节「${hit.title}」重叠`;
      continue;
    }
    if (accepted.some((a) => e.start < a.end - OVERLAP_EPS && e.end > a.start + OVERLAP_EPS)) {
      e.status = 'overlap';
      e.reason = '与本次导入的其他条目重叠';
      continue;
    }
    accepted.push({ start: e.start, end: e.end });
  }
  return entries;
}

export function countByStatus(entries: ImportEntry[]): Record<ImportStatus, number> {
  const counts: Record<ImportStatus, number> = { ok: 0, invalid: 0, 'out-of-range': 0, overlap: 0 };
  for (const e of entries) counts[e.status]++;
  return counts;
}

/**
 * Merge the `ok` entries into the existing chapters as one new list: ids are
 * rebuilt, the result is sorted by start, edge overshoot within tolerance is
 * clamped. Returns null — nothing to write — when there are no ok entries or
 * the merged list would violate the invariants (unique ids, within bounds,
 * minimum duration, no overlap), so a failed apply never partially writes.
 */
export function mergeImportedChapters(
  existing: Chapter[],
  entries: ImportEntry[],
  duration: number,
  makeId: () => string = uid,
): Chapter[] | null {
  const ok = entries.filter((e) => e.status === 'ok');
  if (ok.length === 0) return null;
  const next = [...existing];
  for (const e of ok) {
    next.push({
      id: makeId(),
      title: e.title.trim() || `章节 ${next.length + 1}`,
      start: clamp(e.start, 0, duration),
      end: clamp(e.end, 0, duration),
    });
  }
  next.sort((a, b) => a.start - b.start);
  const ids = new Set<string>();
  let prevEnd = 0;
  for (const c of next) {
    if (ids.has(c.id)) return null;
    ids.add(c.id);
    if (!(c.start >= -OVERLAP_EPS && c.end <= duration + OVERLAP_EPS)) return null;
    if (c.end - c.start < MIN_CHAPTER_DURATION - OVERLAP_EPS) return null;
    if (c.start < prevEnd - OVERLAP_EPS) return null;
    prevEnd = Math.max(prevEnd, c.end);
  }
  return next;
}
