import { uiText, useLanguage } from '../i18n';
import type { Status } from '@orrery/shared';
import { STATUS_LABEL } from '@orrery/shared';

export function StatusDot({ status, label, showLabel = false, size = 8 }: { status: Status; label?: string; showLabel?: boolean; size?: number }) {
  useLanguage();
  const text = uiText(label ?? STATUS_LABEL[status]);
  return (
    <span className={`status st-${status}`} title={text} aria-label={uiText`상태: ${text}`}>
      <span className="status-dot" style={{ width: size, height: size }} />
      {showLabel && <span className="status-label">{text}</span>}
    </span>
  );
}
