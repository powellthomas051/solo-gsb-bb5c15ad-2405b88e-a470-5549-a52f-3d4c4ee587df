import { useMemo, useState } from 'react';
import type { ChapterLoudness } from '../audio/loudness';
import type { Chapter, SortKey } from '../types';
import { formatTime } from '../utils/time';

interface ChapterListProps {
  chapters: Chapter[];
  selectedId: string | null;
  loudness?: Map<string, ChapterLoudness> | null;
  lockedIds?: ReadonlySet<string>;
  chainEnabled?: boolean;
  onSelect: (id: string) => void;
  onPreview: (c: Chapter) => void;
  onPreviewIssue: (c: Chapter) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
  onToggleLock: (id: string) => void;
}

const STATUS_LABEL: Record<ChapterLoudness['status'], string> = {
  ok: '正常',
  quiet: '过轻',
  loud: '过响',
  unknown: '过短',
};

function statusText(q: ChapterLoudness): string {
  const mean = q.meanDbfs === null ? '-∞' : q.meanDbfs.toFixed(1);
  return `${STATUS_LABEL[q.status]}：均值 ${mean} dBFS，动态范围 ${q.rangeDb.toFixed(1)} dB${
    q.allSilent ? '（全静音）' : ''
  }（点击从首个异常处预览）`;
}

export function ChapterList(props: ChapterListProps) {
  const {
    chapters,
    selectedId,
    loudness,
    lockedIds,
    chainEnabled,
    onSelect,
    onPreview,
    onPreviewIssue,
    onRename,
    onRemove,
    onToggleLock,
  } = props;
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('start');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? chapters.filter((c) => c.title.toLowerCase().includes(q))
      : [...chapters];
    filtered.sort((a, b) => {
      switch (sortKey) {
        case 'title':
          return a.title.localeCompare(b.title, 'zh-Hans-CN');
        case 'duration':
          return b.end - b.start - (a.end - a.start);
        default:
          return a.start - b.start;
      }
    });
    return filtered;
  }, [chapters, query, sortKey]);

  return (
    <div className="chapter-list">
      <div className="chapter-list-toolbar">
        <input
          type="search"
          placeholder="搜索章节标题…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="search-input"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="sort-select"
          title="排序方式"
        >
          <option value="start">按开始时间</option>
          <option value="title">按标题</option>
          <option value="duration">按时长</option>
        </select>
      </div>
      <div className="chapter-list-body">
        {visible.length === 0 && (
          <div className="empty-hint">
            {chapters.length === 0 ? '还没有章节。在波形上拖拽即可创建。' : '没有匹配的章节。'}
          </div>
        )}
        {visible.map((c) => {
          const q = loudness?.get(c.id);
          const locked = lockedIds?.has(c.id) ?? false;
          return (
            <div
              key={c.id}
              className={`chapter-item${c.id === selectedId ? ' selected' : ''}${
                locked ? ' locked' : ''
              }`}
              onClick={() => onSelect(c.id)}
            >
              <input
                className="chapter-title"
                value={c.title}
                onChange={(e) => onRename(c.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="章节标题"
              />
              <div className="chapter-meta">
                <span>
                  {formatTime(c.start)} → {formatTime(c.end)}（{(c.end - c.start).toFixed(1)}s）
                </span>
                {locked && (
                  <span
                    className="lock-badge"
                    title={
                      chainEnabled
                        ? '连锁移动的固定止点：已锁定，不可移动/缩放；位移传递到此停止'
                        : '已锁定：任何模式下都不可移动/缩放（仅当前会话有效）'
                    }
                  >
                    🔒 已锁定
                  </span>
                )}
                {q && (
                  <span
                    className={`loudness-pill loudness-${q.status}`}
                    title={statusText(q)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreviewIssue(c);
                    }}
                  >
                    {STATUS_LABEL[q.status]}
                    {q.meanDbfs !== null && ` ${q.meanDbfs.toFixed(0)}dB`}
                    {q.allSilent && ' · 静音'}
                  </span>
                )}
              </div>
              <div className="chapter-actions">
                <button
                  title={locked ? '解锁该章节' : '锁定该章节（连锁移动的固定止点，仅当前会话有效，L 键）'}
                  className={locked ? 'lock-btn is-locked' : 'lock-btn'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLock(c.id);
                  }}
                >
                  {locked ? '🔒' : '🔓'}
                </button>
                <button
                  title="预览该章节"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPreview(c);
                  }}
                >
                  ▶
                </button>
                <button
                  title="删除该章节"
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(c.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
