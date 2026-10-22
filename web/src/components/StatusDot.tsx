import type { Status } from '@orrery/shared';
import { STATUS_LABEL } from '@orrery/shared';

export function StatusDot({ status, label, showLabel = false, size = 8 }: { status: Status; label?: string; showLabel?: boolean; size?: number }) {
  const text = label ?? STATUS_LABEL[status];
  return (
    <span className={`status st-${status}`} title={text} aria-label={`상태: ${text}`}>
      <span className="status-dot" style={{ width: size, height: size }} />
      {showLabel && <span className="status-label">{text}</span>}
    </span>
  );
}
