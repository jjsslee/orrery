import type { ResourceType } from '@orrery/shared';
import { TYPE_META } from '../model/types';

export function TypeIcon({ type, size = 16, className }: { type: ResourceType; size?: number; className?: string }) {
  const Icon = TYPE_META[type].icon;
  return <Icon size={size} strokeWidth={1.75} className={className} aria-hidden />;
}
