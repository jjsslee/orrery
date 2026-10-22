/**
 * Collectors other than the VPC fabric register here.
 * Keep this list alphabetical; each entry is a `Collector` from ./types.ts.
 */
import type { Collector } from './types.ts';
import { alarmsCollector } from './alarms.ts';
import { codebuildCollector } from './codebuild.ts';
import { dynamodbCollector } from './dynamodb.ts';
import { ec2Collector } from './ec2.ts';
import { ecrCollector } from './ecr.ts';
import { ecsCollector } from './ecs.ts';
import { edgeCollector } from './edge.ts';
import { efsCollector } from './efs.ts';
import { eksCollector } from './eks.ts';
import { elasticacheCollector } from './elasticache.ts';
import { elbCollector } from './elb.ts';
import { lambdaCollector } from './lambda.ts';
import { messagingCollector } from './messaging.ts';
import { rdsCollector } from './rds.ts';
import { s3Collector } from './s3.ts';
import { securityCollector } from './security.ts';

export const extraCollectors: Collector[] = [
  alarmsCollector,
  codebuildCollector,
  dynamodbCollector,
  ec2Collector,
  ecrCollector,
  ecsCollector,
  edgeCollector,
  efsCollector,
  eksCollector,
  elasticacheCollector,
  elbCollector,
  lambdaCollector,
  messagingCollector,
  rdsCollector,
  s3Collector,
  securityCollector,
];
