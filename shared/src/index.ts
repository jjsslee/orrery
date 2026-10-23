/**
 * Orrery shared graph model.
 * The server builds a ResourceGraph from read-only AWS API calls;
 * the web client renders it. Everything here is serialisable JSON.
 */

export type Category =
  | 'compute'
  | 'network'
  | 'database'
  | 'storage'
  | 'security'
  | 'integration';

export const CATEGORY_LABEL: Record<Category, string> = {
  compute: '컴퓨트',
  network: '네트워크',
  database: '데이터베이스',
  storage: '스토리지',
  security: '보안·자격',
  integration: '통합·이벤트',
};

/** Every resource type the collectors can emit. Keep in sync with web/src/model/types.ts */
export type ResourceType =
  // network
  | 'region'
  | 'vpc'
  | 'subnet'
  | 'internet-gateway'
  | 'nat-gateway'
  | 'vpc-endpoint'
  | 'load-balancer'
  | 'target-group'
  | 'cloudfront'
  | 'api-gateway'
  | 'appsync-api'
  | 'route53-zone'
  // compute
  | 'ec2-instance'
  | 'autoscaling-group'
  | 'lambda'
  | 'ecs-cluster'
  | 'ecs-service'
  | 'eks-cluster'
  // database
  | 'rds-instance'
  | 'rds-cluster'
  | 'dynamodb-table'
  | 'elasticache'
  // storage
  | 's3-bucket'
  | 'efs'
  | 'ebs-volume'
  | 'ecr-repository'
  // security
  | 'security-group'
  | 'iam-role'
  | 'kms-key'
  | 'secret'
  | 'cognito-user-pool'
  // integration
  | 'sqs-queue'
  | 'sns-topic'
  | 'eventbridge-rule'
  | 'step-function'
  | 'codebuild-project';

export type Status = 'healthy' | 'warning' | 'critical' | 'inactive' | 'unknown';

export interface MetricPoint {
  /** epoch millis */
  t: number;
  v: number;
}

export interface MetricSeries {
  /** CloudWatch metric name, e.g. RequestCount */
  name: string;
  /** Human label, e.g. 요청 수 */
  label: string;
  unit: string;
  /** Aggregation used, e.g. Sum / Average */
  stat: string;
  points: MetricPoint[];
  /** Latest non-null value, convenience for the UI */
  latest: number | null;
}

export interface ResourceNode {
  /** Stable id: ARN when available, else `${type}:${nativeId}` */
  id: string;
  type: ResourceType;
  category: Category;
  name: string;
  /** Native identifier (i-0123, vpc-abc, bucket name...) */
  nativeId: string;
  arn?: string;
  region: string;
  /** Containment parent (vpc → subnet → instance). Omit for top level. */
  parentId?: string;
  status: Status;
  /** Short human status, e.g. running / available / 2/3 healthy */
  statusLabel?: string;
  /** Availability zone for placement hints */
  az?: string;
  /** Free-form, display-oriented properties (already formatted strings/numbers) */
  props: Record<string, string | number | boolean | null>;
  tags?: Record<string, string>;
  /** 0..1 relative throughput derived from metrics; drives motion intensity */
  traffic?: number;
  /** Alarms in ALARM state attached to this node */
  alarms?: string[];
  /**
   * Free-text identifiers this node references (env var values, image URIs,
   * KMS key ids, policy ARNs...). The assembler resolves them into edges.
   */
  refs?: string[];
}

export interface AlarmInfo {
  name: string;
  state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  namespace?: string;
  metric?: string;
  dimensions: Record<string, string>;
}

export type EdgeKind =
  | 'attached' // ENI/volume style attachments, instance → SG, LB → subnet
  | 'routes' // IGW/NAT routing, subnet → NAT
  | 'targets' // LB → target (through a target group)
  | 'invokes' // event source → lambda, rule → target
  | 'publishes' // sns → subscription endpoint
  | 'reads' // compute → data store (derived from env vars / policies)
  | 'origin' // cloudfront → origin
  | 'resolves' // route53 record → alias target
  | 'mounts' // efs → subnet mount target
  | 'allows' // SG rule: source resource may reach target resource
  | 'assumes' // compute → IAM role
  | 'encrypts' // KMS key → resource
  | 'member'; // ASG → instance, cluster → service

export interface ResourceEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  /** 0..1 relative traffic along this edge (particles speed/density) */
  traffic?: number;
  status?: Status;
  props?: Record<string, string | number | boolean | null>;
}

export interface CollectorReport {
  collector: string;
  ok: boolean;
  durationMs: number;
  nodes: number;
  edges: number;
  error?: string;
}

export interface ResourceGraph {
  account: string;
  region: string;
  /** Credential source descriptor, e.g. profile:my-dev */
  source: string;
  collectedAt: string;
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  reports: CollectorReport[];
}

export interface MetricsBundle {
  region: string;
  collectedAt: string;
  /** node id → series list */
  series: Record<string, MetricSeries[]>;
  /** node id → 0..1 traffic intensity */
  traffic: Record<string, number>;
}

/** Result of a status-only pass (free Describe/List calls, no CloudWatch metrics). */
export interface StatusBundle {
  collectedAt: string;
  /** How many nodes the pass re-read */
  checked: number;
  /** Node id → fresh status fields (all re-read nodes, not only changed ones) */
  nodes: Record<string, { status: Status; statusLabel?: string; alarms?: string[]; props?: Record<string, string | number | boolean | null> }>;
  /** Edge id → fresh status (edges whose status is tracked, e.g. target health) */
  edges: Record<string, Status>;
  /** Wall time of the pass */
  durationMs: number;
  /** Per-collector timing of the pass (diagnostics) */
  reports: CollectorReport[];
}

/** Credential source abstraction — only `profile` is implemented today. */
export type CredentialSourceSpec =
  | { kind: 'profile'; profile: string }
  | { kind: 'assume-role'; roleArn: string; baseProfile?: string; externalId?: string }
  | { kind: 'environment' };

export interface ProfileInfo {
  name: string;
  region?: string;
  /** static | sso | assume-role | process | unknown */
  method: string;
  isDefault: boolean;
}

/** SSE progress event emitted while collecting */
export type CollectEvent =
  | { type: 'ping' }
  | { type: 'start'; collectors: string[]; account: string; region: string }
  | { type: 'collector'; report: CollectorReport }
  | { type: 'done'; graph: ResourceGraph }
  | { type: 'error'; message: string; status?: number };

export const STATUS_LABEL: Record<Status, string> = {
  healthy: '정상',
  warning: '주의',
  critical: '위험',
  inactive: '중지',
  unknown: '알 수 없음',
};
