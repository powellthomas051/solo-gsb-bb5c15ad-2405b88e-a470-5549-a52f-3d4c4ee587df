import {
  parseChapterFile,
  parseVttTime,
  buildImportPlan,
  mergeImportedChapters,
  countByStatus,
  type ImportEntry,
  type ParsedChapter,
} from '../src/utils/importChapters';
import { toJSON, toWebVTT } from '../src/utils/export';
import type { Chapter } from '../src/types';

const D = 100; // audio duration
const mk = (id: string, start: number, end: number): Chapter => ({ id, title: id, start, end });
const pc = (title: string, start: number, end: number): ParsedChapter => ({ title, start, end });

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${msg}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${msg}${a === e ? '' : `: expected ${e}, got ${a}`}`);
}
function throws(fn: () => unknown, msg: string) {
  try {
    fn();
    check(false, `${msg}: expected throw`);
  } catch {
    check(true, msg);
  }
}

// --- timestamp parsing ---
eq(parseVttTime('00:01:23.456'), 83.456, 'vtt time HH:MM:SS.mmm');
eq(parseVttTime('01:23.456'), 83.456, 'vtt time MM:SS.mmm');
eq(parseVttTime('1:02:03.5'), 3723.5, 'vtt time short fields');
eq(parseVttTime('00:00:10,250'), 10.25, 'vtt time comma tolerated');
eq(parseVttTime('abc'), null, 'vtt time garbage null');
eq(parseVttTime('00:61:00.000'), null, 'vtt time minutes > 59 null');
eq(parseVttTime('00:00:61.000'), null, 'vtt time seconds > 59 null');

// --- WebVTT round-trip through the tool's own exporter ---
{
  const chapters = [mk('开场', 0, 5.25), mk('正文', 10, 20.5), mk('结尾', 90, 100)];
  const parsed = parseChapterFile(toWebVTT(chapters));
  eq(parsed.format, 'vtt', 'round-trip detected as vtt');
  eq(
    parsed.chapters.map((c) => [c.title, c.start, c.end]),
    chapters.map((c) => [c.title, c.start, c.end]),
    'vtt round-trip preserves titles and times',
  );
}

// --- WebVTT: identifiers, NOTE/STYLE blocks, cue settings, multi-line text ---
{
  const vtt = [
    'WEBVTT - podcast chapters',
    '',
    'NOTE this is a comment',
    'spanning two lines',
    '',
    'STYLE',
    '::cue { color: #fff }',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:05.000 align:start position:0%',
    'First',
    '',
    '00:00:10.000 --> 00:00:20.000',
    'Second part one',
    'part two',
    '',
  ].join('\n');
  const parsed = parseChapterFile(vtt);
  eq(parsed.chapters.length, 2, 'vtt skips NOTE/STYLE blocks');
  eq(parsed.chapters[0], { title: 'First', start: 1, end: 5 }, 'vtt identifier + settings parsed');
  eq(
    parsed.chapters[1],
    { title: 'Second part one part two', start: 10, end: 20 },
    'vtt multi-line title joined',
  );
}

// --- JSON round-trip through the tool's own exporter ---
{
  const chapters = [mk('A', 0, 5), mk('B', 10.125, 20.375)];
  const parsed = parseChapterFile(toJSON(chapters));
  eq(parsed.format, 'json', 'round-trip detected as json');
  eq(
    parsed.chapters.map((c) => [c.title, c.start, c.end]),
    chapters.map((c) => [c.title, c.start, c.end]),
    'json round-trip preserves titles and times',
  );
}

// --- JSON: bare array accepted; imported ids are ignored ---
{
  const parsed = parseChapterFile('[{"id":"ext-1","title":"X","start":1,"end":2}]');
  eq(parsed.chapters, [{ title: 'X', start: 1, end: 2 }], 'bare array accepted, id dropped');
}

// --- malformed files throw (nothing to preview) ---
throws(() => parseChapterFile('hello world'), 'plain text rejected');
throws(() => parseChapterFile('{"foo":1}'), 'json without chapters rejected');
throws(() => parseChapterFile('{not json'), 'broken json rejected');
throws(() => parseChapterFile('{"chapters":[]}'), 'empty chapters rejected');
throws(() => parseChapterFile('WEBVTT\n\nNOTE only a comment\n'), 'vtt without cues rejected');

// --- classification: ok / overlap / out-of-range / invalid ---
{
  const existing = [mk('existing', 10, 20)];
  const plan = buildImportPlan(
    [
      pc('new-ok', 0, 5), // ok
      pc('hits-existing', 15, 25), // overlap with existing
      pc('beyond-end', 95, 105), // out of range
      pc('before-zero', -5, 5), // out of range
      pc('backwards', 30, 25), // invalid: end < start
      pc('tiny', 50, 50.1), // invalid: shorter than MIN_CHAPTER_DURATION
      pc('no-times', NaN, 5), // invalid: unparseable
      pc('ok-2', 40, 50), // ok
      pc('hits-import', 41, 49), // overlap with imported ok-2
      pc('touching', 5, 10), // ok: abutting is not overlap
    ],
    existing,
    D,
  );
  eq(
    plan.map((e) => e.status),
    [
      'ok',
      'overlap',
      'out-of-range',
      'out-of-range',
      'invalid',
      'invalid',
      'invalid',
      'ok',
      'overlap',
      'ok',
    ],
    'entries classified individually',
  );
  eq(plan[1].reason, '与现有章节「existing」重叠', 'overlap reason names the existing chapter');
  eq(countByStatus(plan), { ok: 3, invalid: 3, 'out-of-range': 2, overlap: 2 }, 'status counts');
  eq(
    plan.map((e) => e.index),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'entries keep file order',
  );
}

// --- rounding overshoot at the file edge is tolerated and clamped on apply ---
{
  const plan = buildImportPlan([pc('edge', 90, 100.0015)], [], D);
  eq(plan[0].status, 'ok', 'tiny overshoot tolerated');
  const merged = mergeImportedChapters([], plan, D)!;
  eq(merged[0].end, 100, 'overshoot clamped to duration on apply');
}

// --- merge: ids rebuilt, sorted by start, existing untouched ---
{
  let n = 0;
  const makeId = () => `new-${++n}`;
  const existing = [mk('keep-1', 10, 20)];
  const plan = buildImportPlan([pc('b', 30, 40), pc('a', 0, 5), pc('', 50, 60)], existing, D);
  const merged = mergeImportedChapters(existing, plan, D, makeId)!;
  eq(
    merged.map((c) => [c.id, c.title, c.start, c.end]),
    [
      ['new-2', 'a', 0, 5],
      ['keep-1', 'keep-1', 10, 20],
      ['new-1', 'b', 30, 40],
      ['new-3', '章节 4', 50, 60],
    ],
    'merged: sorted, fresh ids, existing preserved, empty title named',
  );
  check(new Set(merged.map((c) => c.id)).size === merged.length, 'merged ids unique');
}

// --- merge failure is atomic: conflicting entries -> null, nothing to write ---
{
  const existing = [mk('x', 10, 20)];
  const forged: ImportEntry[] = [
    { index: 1, title: 'forged', start: 15, end: 25, status: 'ok', reason: '' },
  ];
  eq(mergeImportedChapters(existing, forged, D), null, 'conflicting ok entry aborts merge');
  eq(mergeImportedChapters(existing, [], D), null, 'no ok entries -> null');
  const invalidOnly = buildImportPlan([pc('bad', 200, 300)], existing, D);
  eq(mergeImportedChapters(existing, invalidOnly, D), null, 'all-invalid plan -> null');
}

// --- full pipeline: export -> edit externally -> import preview -> apply ---
{
  const existing = [mk('现有', 10, 20)];
  const vtt = toWebVTT([mk('第一章', 0, 5), mk('第二章', 30, 40)]);
  const parsed = parseChapterFile(vtt);
  const plan = buildImportPlan(parsed.chapters, existing, D);
  const merged = mergeImportedChapters(existing, plan, D)!;
  eq(
    merged.map((c) => [c.title, c.start, c.end]),
    [
      ['第一章', 0, 5],
      ['现有', 10, 20],
      ['第二章', 30, 40],
    ],
    'pipeline: vtt import merges around existing chapters',
  );
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
