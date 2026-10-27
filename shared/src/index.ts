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
  | 'codebuild-project'
  | 'scheduler'
  | 'opensearch-collection'
  | 'transit-gateway'
  | 'cloudmap-namespace'
  | 'cloudmap-service'
  | 'waf-acl'
  | 'acm-certificate';

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
  status?: 'complete' | 'empty' | 'partial' | 'error';
  /** Original CloudWatch result status; preserved even when Messages is absent. */
  awsStatus?: string;
  /** AWS/SDK exception name, for authorization/expiry versus retryable failures. */
  errorCode?: string;
  messages?: string[];
  period?: number;
  startTime?: string;
  endTime?: string;
  fetchedAt?: string;
  lastDataAt?: string;
  region?: string;
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
  baseStatus?: Status;
  baseStatusLabel?: string;
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

/** Facts are collected from AWS responses, never inferred from graph edges or UI labels. */
export type CleanupRule = 'detached-ebs' | 'empty-target-group' | 'stopped-ec2' | 'disabled-cloudfront';
export type CleanupFact = { resourceId: string } & (
  | { ruleId: 'detached-ebs'; state?: string; attachments: number; sizeGiB?: number; multiAttach?: boolean }
  | { ruleId: 'empty-target-group'; registeredTargets: number; loadBalancers: number }
  | { ruleId: 'stopped-ec2'; state?: string }
  | { ruleId: 'disabled-cloudfront'; enabled?: boolean }
);
export interface CleanupCoverage {
  ruleId: CleanupRule;
  api: string;
  resourceId?: string;
  state: 'complete' | 'error' | 'not-collected';
  attemptedAt: string;
  succeededAt?: string;
  errorCode?: string;
}
export interface CleanupDiscovery { facts: CleanupFact[]; coverage: CleanupCoverage[] }
export interface CleanupFinding {
  id: string;
  resourceId: string;
  ruleId: CleanupRule;
  reviewClass: 'connections' | 'inactive';
  fact: CleanupFact;
  observedAt: string;
}
export interface CleanupSnapshot {
  schemaVersion: 1;
  scope: { source: string; account: string; region: string };
  observedAt: string;
  findings: CleanupFinding[];
  coverage: CleanupCoverage[];
}

export interface ResourceGraph {
  cleanup?: CleanupSnapshot;
  account: string;
  region: string;
  /** Credential source descriptor, e.g. profile:my-dev */
  source: string;
  collectedAt: string;
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  reports: CollectorReport[];
  statusObservation?: ObservationState;
  alarmObservation?: ObservationState;
}

export interface MetricsBundle {
  /** Actual server credential scope; detect same-profile account changes before merging. */
  scope?: MonitoringScope;
  region: string;
  collectedAt: string;
  /** node id → series list */
  series: Record<string, MetricSeries[]>;
  /** node id → 0..1 traffic intensity */
  traffic: Record<string, number>;
}

/** Result of a status-only pass (free Describe/List calls, no CloudWatch metrics). */
export interface ObservationState {
  errorCode?: string;
  attemptedAt: string;
  succeededAt?: string;
  error?: string;
}

export interface StatusBundle {
  scope?: MonitoringScope;
  statusObservation?: ObservationState;
  alarmObservation?: ObservationState;
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

/** Monitoring settings and results are isolated from topology collection. */
export interface MonitoringScope { source: string; account: string; region: string }
export type MonitoringResourceType = 'lambda' | 'sqs-queue' | 'load-balancer' | 'ecs-service' | 'ec2-instance' | 'rds-instance';
export interface MonitoringResource {
  metricsSupported?: boolean;
  alarmMappingSupported?: boolean;
  alarmScopeWarning?: string;
  metricsUnsupportedReason?: string;
  key: string;
  nodeId: string;
  type: ResourceType;
  nativeId: string;
  name: string;
  region: string;
  arn?: string;
  tags?: Record<string, string>;
  tagsStatus: 'complete' | 'unavailable';
  props: Record<string, string | number | boolean | null>;
}
export interface MonitoringResourceIndex {
  scope: MonitoringScope;
  resources: MonitoringResource[];
  types: MonitoringResourceType[];
  complete: boolean;
  observation: ObservationState;
}
export interface AlarmMetric { namespace?: string; metric?: string; dimensions: Record<string, string>; stat?: string; period?: number }
export interface AlarmRecord {
  name: string;
  arn?: string;
  region: string;
  type: 'metric' | 'composite';
  state: AlarmInfo['state'];
  reason?: string;
  stateUpdatedAt?: string;
  description?: string;
  threshold?: number;
  comparisonOperator?: string;
  evaluationPeriods?: number;
  datapointsToAlarm?: number;
  treatMissingData?: string;
  metrics: AlarmMetric[];
  rule?: string;
  expressions?: string[];
  childAlarmNames?: string[];
  resourceKeys: string[];
  mapping: 'matched' | 'unresolved';
}
export interface MonitoringAlarmSnapshot {
  scope: MonitoringScope;
  alarms: AlarmRecord[];
  complete: boolean;
  observation: ObservationState;
}
export interface AlarmHistoryItem { timestamp?: string; type?: string; summary?: string; data?: string }
export interface AlarmHistorySnapshot {
  scope: MonitoringScope;
  items: AlarmHistoryItem[];
  nextToken?: string;
  observation: ObservationState;
}

/** Resources observed together in monitoring. The web tray and the metric API both enforce it; at most 4 queries per resource keeps a full set well inside the 100-query request cap. */
export const MAX_OBSERVED_RESOURCES = 8;

export interface MonitoringMetricRequest {
  resourceKeys: string[];
  range: { startTime: string; endTime: string };
  metricIds?: string[];
  /** Optional coarser resolution; server/service minimums still apply. */
  period?: number;
  refresh?: boolean;
}
export interface MonitoringMetricSeries extends MetricSeries { id: string }
export interface MonitoringMetricsSnapshot {
  scope: MonitoringScope;
  /** Requested display window; each series carries its effective aligned AWS query window. */
  range: { startTime: string; endTime: string };
  collectedAt: string;
  series: Record<string, MonitoringMetricSeries[]>;
  queryCount: number;
  /** SDK commands, excluding SDK retry attempts (up to 8 attempts per command). */
  requestCount: number;
  maxRequests: number;
}

export interface SavedResourceGroup { id: string; name: string; tagFilters: Array<{ key: string; value?: string }>; resourceKeys: string[] }

export type MonitoringRelatedReason =
  | { kind: 'edge'; direction: 'outgoing' | 'incoming'; edgeKind: EdgeKind; label?: string; evidence: 'unknown' }
  | { kind: 'tag'; key: string; value: string };
export interface MonitoringRelatedCandidate { resource: MonitoringResource; reasons: MonitoringRelatedReason[] }
export interface MonitoringGraphState {
  state: 'not-requested' | 'loading' | 'complete' | 'partial' | 'error';
  stale?: boolean;
  observation?: ObservationState;
}
export interface MonitoringRelatedSnapshot {
  error?: string;
  scope: MonitoringScope;
  resourceKey: string;
  connected: MonitoringRelatedCandidate[];
  sameTags: MonitoringRelatedCandidate[];
  graph: MonitoringGraphState;
  tagCoverage: { types: MonitoringResourceType[]; incompleteTypes: MonitoringResourceType[] };
}
export interface MonitoringResourceResolution {
  scope: MonitoringScope;
  resources: MonitoringResource[];
  unresolvedKeys: string[];
  graph: MonitoringGraphState;
}

export interface CleanupHistoryEvent {
  id: string;
  time: string;
  name: string;
  effect: 'idle' | 'active' | 'change' | 'metadata';
  actor?: { type: string; label: string };
}
export interface CleanupHistory {
  scope: CleanupSnapshot['scope'];
  findingId: string;
  graphCollectedAt: string;
  analyzedAt: string;
  start: string;
  end: string;
  lookbackStart: string;
  region: string;
  coverage: 'complete' | 'partial' | 'error';
  pages: number;
  events: CleanupHistoryEvent[];
  duration: { since?: string; seconds?: number; basis: 'event' | 'unknown' };
  verdict: 'review' | 'recent' | 'insufficient';
  messages: string[];
}

/** Only progress metadata is exposed; SSO tokens stay in the AWS CLI cache. */
export interface SsoLoginStatus {
  id: string;
  profile: string;
  state: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  message?: string;
}
