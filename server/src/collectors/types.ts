import type { AlarmInfo, CleanupDiscovery, ResourceEdge, ResourceNode, RelationCoverage } from '@orrery/shared';
import type { ClientFactory } from '../aws/clients.ts';

export interface CollectorOutput {
  collector?: string;
  coverage?: RelationCoverage[];
  cleanup?: CleanupDiscovery;
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  /** CloudWatch alarms; the assembler attaches them to nodes by dimension */
  alarms?: AlarmInfo[];
}

export interface CollectorContext {
  region: string;
  account: string;
  clients: ClientFactory;
  /** Concurrency limiter shared by all collectors (per-resource fan-out calls) */
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  log: (message: string) => void;
  observe?: (coverage: Omit<RelationCoverage, "collector">) => void;
}

export interface Collector {
  /** Short stable name shown in progress UI, e.g. "ec2" */
  name: string;
  /** Human label, e.g. "EC2 인스턴스" */
  label: string;
  run(ctx: CollectorContext): Promise<CollectorOutput>;
}
