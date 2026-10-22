import type { Category, ResourceType, Status } from '@orrery/shared';
import {
  Archive, ArrowLeftRight, Boxes, Braces, CalendarClock, Container, Database, DatabaseZap, FileKey, FolderTree, Globe, Grid2x2,
  Hammer, Hexagon, Inbox, KeyRound, Layers, ListTree, Lock, Map as MapIcon, Megaphone, MemoryStick, Network, Orbit, Package, Plug,
  Rss, Server, Shield, Signpost, Table2, Target, Users, Waypoints, Zap, type LucideIcon,
} from 'lucide-react';

export interface TypeMeta {
  label: string;
  /** Short label for dense chips */
  short: string;
  category: Category;
  icon: LucideIcon;
  /** Renders as a containment plate on the canvas */
  plate?: boolean;
  /** Not drawn on the topology unless its overlay is switched on */
  overlay?: 'security' | 'iam' | 'encryption' | 'targetGroups';
  /** The prop shown under the name on the canvas */
  keyProp?: string;
}

export const TYPE_META: Record<ResourceType, TypeMeta> = {
  region: { label: '리전', short: '리전', category: 'network', icon: MapIcon, plate: true },
  vpc: { label: 'VPC', short: 'VPC', category: 'network', icon: Network, plate: true, keyProp: 'CIDR' },
  subnet: { label: '서브넷', short: '서브넷', category: 'network', icon: Grid2x2, plate: true, keyProp: 'CIDR' },
  'internet-gateway': { label: '인터넷 게이트웨이', short: 'IGW', category: 'network', icon: Globe },
  'nat-gateway': { label: 'NAT 게이트웨이', short: 'NAT', category: 'network', icon: ArrowLeftRight, keyProp: '퍼블릭 IP' },
  'vpc-endpoint': { label: 'VPC 엔드포인트', short: '엔드포인트', category: 'network', icon: Plug, keyProp: '유형' },
  'load-balancer': { label: '로드 밸런서', short: 'LB', category: 'network', icon: Waypoints, keyProp: '유형' },
  'target-group': { label: '타깃 그룹', short: 'TG', category: 'network', icon: Target, overlay: 'targetGroups', keyProp: '프로토콜/포트' },
  cloudfront: { label: 'CloudFront', short: 'CloudFront', category: 'network', icon: Orbit, keyProp: '도메인' },
  'api-gateway': { label: 'API Gateway', short: 'API', category: 'network', icon: Braces, keyProp: '유형' },
  'appsync-api': { label: 'AppSync API', short: 'AppSync', category: 'network', icon: Rss, keyProp: '유형' },
  'route53-zone': { label: 'Route 53 호스팅 영역', short: 'Route 53', category: 'network', icon: Signpost, keyProp: '도메인' },
  'ec2-instance': { label: 'EC2 인스턴스', short: 'EC2', category: 'compute', icon: Server, keyProp: '인스턴스 유형' },
  'autoscaling-group': { label: '오토스케일링 그룹', short: 'ASG', category: 'compute', icon: Layers, keyProp: '현재 인스턴스' },
  lambda: { label: 'Lambda 함수', short: 'Lambda', category: 'compute', icon: Zap, keyProp: '런타임' },
  'ecs-cluster': { label: 'ECS 클러스터', short: 'ECS', category: 'compute', icon: Boxes, keyProp: '서비스' },
  'ecs-service': { label: 'ECS 서비스', short: '서비스', category: 'compute', icon: Container, keyProp: '희망/실행 작업' },
  'eks-cluster': { label: 'EKS 클러스터', short: 'EKS', category: 'compute', icon: Hexagon, keyProp: '버전' },
  'rds-instance': { label: 'RDS 인스턴스', short: 'RDS', category: 'database', icon: Database, keyProp: '엔진' },
  'rds-cluster': { label: 'RDS 클러스터', short: 'Aurora', category: 'database', icon: DatabaseZap, keyProp: '엔진' },
  'dynamodb-table': { label: 'DynamoDB 테이블', short: 'DynamoDB', category: 'database', icon: Table2, keyProp: '항목 수' },
  elasticache: { label: 'ElastiCache', short: 'ElastiCache', category: 'database', icon: MemoryStick, keyProp: '엔진' },
  's3-bucket': { label: 'S3 버킷', short: 'S3', category: 'storage', icon: Archive, keyProp: '생성일' },
  efs: { label: 'EFS 파일 시스템', short: 'EFS', category: 'storage', icon: FolderTree, keyProp: '크기' },
  'ecr-repository': { label: 'ECR 리포지터리', short: 'ECR', category: 'storage', icon: Package, keyProp: '생성일' },
  'security-group': { label: '보안 그룹', short: 'SG', category: 'security', icon: Shield, overlay: 'security', keyProp: '인바운드 규칙 수' },
  'iam-role': { label: 'IAM 역할', short: 'IAM', category: 'security', icon: KeyRound, overlay: 'iam', keyProp: '마지막 사용' },
  'kms-key': { label: 'KMS 키', short: 'KMS', category: 'security', icon: Lock, overlay: 'encryption', keyProp: '관리 주체' },
  secret: { label: 'Secrets Manager', short: 'Secret', category: 'security', icon: FileKey, keyProp: '마지막 변경' },
  'cognito-user-pool': { label: 'Cognito 사용자 풀', short: 'Cognito', category: 'security', icon: Users, keyProp: '사용자 수' },
  'sqs-queue': { label: 'SQS 대기열', short: 'SQS', category: 'integration', icon: Inbox, keyProp: '대기 메시지' },
  'sns-topic': { label: 'SNS 토픽', short: 'SNS', category: 'integration', icon: Megaphone, keyProp: '구독' },
  'eventbridge-rule': { label: 'EventBridge 규칙', short: '규칙', category: 'integration', icon: CalendarClock, keyProp: '타깃 수' },
  'step-function': { label: 'Step Functions', short: 'SFN', category: 'integration', icon: ListTree, keyProp: '유형' },
  'codebuild-project': { label: 'CodeBuild 프로젝트', short: 'CodeBuild', category: 'integration', icon: Hammer, keyProp: '소스 유형' },
};

export const CATEGORY_ORDER: Category[] = ['network', 'compute', 'database', 'storage', 'integration', 'security'];

export const CATEGORY_VAR: Record<Category, string> = {
  compute: 'var(--cat-compute)',
  network: 'var(--cat-network)',
  database: 'var(--cat-database)',
  storage: 'var(--cat-storage)',
  security: 'var(--cat-security)',
  integration: 'var(--cat-integration)',
};

export const STATUS_VAR: Record<Status, string> = {
  healthy: 'var(--status-healthy)',
  warning: 'var(--status-warning)',
  critical: 'var(--status-critical)',
  inactive: 'var(--status-inactive)',
  unknown: 'var(--status-unknown)',
};

export const STATUS_ORDER: Status[] = ['critical', 'warning', 'healthy', 'inactive', 'unknown'];

/** Types listed in the rail, grouped by category in display order */
export const TYPES_BY_CATEGORY: Record<Category, ResourceType[]> = CATEGORY_ORDER.reduce((acc, c) => {
  acc[c] = (Object.keys(TYPE_META) as ResourceType[]).filter((t) => TYPE_META[t].category === c && t !== 'region');
  return acc;
}, {} as Record<Category, ResourceType[]>);

export const EDGE_KIND_LABEL: Record<string, string> = {
  attached: '연결',
  routes: '라우팅',
  targets: '트래픽 전달',
  invokes: '호출',
  publishes: '발행',
  reads: '접근',
  origin: '오리진',
  resolves: 'DNS',
  mounts: '마운트',
  allows: '허용',
  assumes: '역할',
  encrypts: '암호화',
  member: '구성원',
};

/** Edge kinds that carry runtime traffic and therefore animate */
export const LIVE_EDGE_KINDS = new Set(['targets', 'invokes', 'publishes', 'reads', 'origin', 'resolves', 'routes', 'mounts']);
