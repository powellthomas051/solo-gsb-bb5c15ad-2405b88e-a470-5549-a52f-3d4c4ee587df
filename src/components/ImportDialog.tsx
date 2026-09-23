import type { ImportPlan, ImportStatus } from '../utils/importChapters';
import { countByStatus } from '../utils/importChapters';
import { formatTime } from '../utils/time';

interface ImportDialogProps {
  fileName: string;
  plan: ImportPlan;
  onApply: () => void;
  onCancel: () => void;
}

const STATUS_LABEL: Record<ImportStatus, string> = {
  ok: '新增',
  'out-of-range': '时间越界',
  overlap: '重叠',
  invalid: '无效',
};

export function ImportDialog({ fileName, plan, onApply, onCancel }: ImportDialogProps) {
  const counts = countByStatus(plan.entries);
  const problems: string[] = [];
  if (counts['out-of-range'] > 0) problems.push(`时间越界 ${counts['out-of-range']}`);
  if (counts.overlap > 0) problems.push(`与现有章节重叠 ${counts.overlap}`);
  if (counts.invalid > 0) problems.push(`无效 ${counts.invalid}`);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="import-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>导入章节预览</h2>
        <p className="import-summary">
          {fileName}（{plan.format === 'json' ? 'JSON' : 'WebVTT'}）：共 {plan.entries.length} 条，
          可导入 <b>{counts.ok}</b> 条{problems.length > 0 && `（${problems.join('，')}，将被跳过）`}
        </p>
        <div className="import-list">
          {plan.entries.map((e) => (
            <div key={e.index} className={`import-item import-${e.status}`}>
              <span className="import-index">{e.index}</span>
              <div className="import-main">
                <span className="import-title">{e.title || '（未命名，导入时自动命名）'}</span>
                <span className="import-reason">{e.reason}</span>
              </div>
              <span className="import-time">
                {Number.isFinite(e.start) && Number.isFinite(e.end)
                  ? `${formatTime(e.start)} → ${formatTime(e.end)}`
                  : '— : — : —'}
              </span>
              <span className={`import-status import-status-${e.status}`}>
                {STATUS_LABEL[e.status]}
              </span>
            </div>
          ))}
        </div>
        <div className="import-actions">
          <button onClick={onCancel}>全部取消</button>
          <button className="primary" disabled={counts.ok === 0} onClick={onApply}>
            仅导入有效条目（{counts.ok}）
          </button>
        </div>
      </div>
    </div>
  );
}
