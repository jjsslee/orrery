import type { ResourceType } from '@orrery/shared';
import { TYPE_META } from '../model/types';

export function TypeIcon({ type, size = 16, className }: { type: ResourceType; size?: number; className?: string }) {
  const Icon = TYPE_META[type].icon;
  return <Icon size={size} strokeWidth={1.75} className={className} aria-hidden />;
}

/** The type icon on its category tint: the same identity the map nodes and tables carry. */
export function TypeBadge({ type, size = 'm' }: { type: ResourceType; size?: 's' | 'm' }) {
  return <span className={`type-badge type-badge-${size} cat-${TYPE_META[type].category}`}><TypeIcon type={type} size={size === 's' ? 13 : 15} /></span>;
}
