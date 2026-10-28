/** Explicit resource-read operations used by collectors, monitoring and identity checks.
 * Additions require review; SDK credential providers/SSO authentication are separate. */
export const READ_ONLY_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  ACMClient: new Set([
    'DescribeCertificateCommand',
    'ListCertificatesCommand',
    'ListTagsForCertificateCommand',
  ]),
  APIGatewayClient: new Set([
    'GetIntegrationCommand',
    'GetResourcesCommand',
    'GetRestApisCommand',
    'GetStagesCommand',
  ]),
  ApiGatewayV2Client: new Set([
    'GetApisCommand',
    'GetIntegrationsCommand',
    'GetStagesCommand',
  ]),
  AppSyncClient: new Set([
    'GetApiCommand',
    'ListApisCommand',
    'ListChannelNamespacesCommand',
    'ListDataSourcesCommand',
    'ListGraphqlApisCommand',
  ]),
  AutoScalingClient: new Set([
    'DescribeAutoScalingGroupsCommand',
  ]),
  CloudFrontClient: new Set([
    'ListDistributionsCommand',
    'ListTagsForResourceCommand',
  ]),
  CloudTrailClient: new Set([
    'LookupEventsCommand',
  ]),
  CloudWatchClient: new Set([
    'DescribeAlarmHistoryCommand',
    'DescribeAlarmsCommand',
    'GetMetricDataCommand',
  ]),
  CodeBuildClient: new Set([
    'BatchGetProjectsCommand',
    'ListProjectsCommand',
  ]),
  CognitoIdentityProviderClient: new Set([
    'DescribeUserPoolCommand',
    'ListUserPoolsCommand',
  ]),
  DynamoDBClient: new Set([
    'DescribeTableCommand',
    'ListTablesCommand',
    'ListTagsOfResourceCommand',
  ]),
  EC2Client: new Set([
    'DescribeInstanceStatusCommand',
    'DescribeInstancesCommand',
    'DescribeInternetGatewaysCommand',
    'DescribeNatGatewaysCommand',
    'DescribeRegionsCommand',
    'DescribeRouteTablesCommand',
    'DescribeSecurityGroupsCommand',
    'DescribeSubnetsCommand',
    'DescribeTransitGatewayAttachmentsCommand',
    'DescribeTransitGatewaysCommand',
    'DescribeVolumesCommand',
    'DescribeVpcEndpointsCommand',
    'DescribeVpcsCommand',
  ]),
  ECRClient: new Set([
    'DescribeRepositoriesCommand',
    'ListTagsForResourceCommand',
  ]),
  ECSClient: new Set([
    'DescribeClustersCommand',
    'DescribeServicesCommand',
    'DescribeTaskDefinitionCommand',
    'ListClustersCommand',
    'ListServicesCommand',
  ]),
  EFSClient: new Set([
    'DescribeFileSystemsCommand',
    'DescribeMountTargetSecurityGroupsCommand',
    'DescribeMountTargetsCommand',
  ]),
  EKSClient: new Set([
    'DescribeClusterCommand',
    'DescribeNodegroupCommand',
    'ListClustersCommand',
    'ListNodegroupsCommand',
  ]),
  ElastiCacheClient: new Set([
    'DescribeCacheClustersCommand',
    'DescribeCacheSubnetGroupsCommand',
    'DescribeReplicationGroupsCommand',
    'ListTagsForResourceCommand',
  ]),
  ElasticLoadBalancingV2Client: new Set([
    'DescribeListenersCommand',
    'DescribeLoadBalancersCommand',
    'DescribeTagsCommand',
    'DescribeTargetGroupsCommand',
    'DescribeTargetHealthCommand',
  ]),
  EventBridgeClient: new Set([
    'ListEventBusesCommand',
    'ListRulesCommand',
    'ListTagsForResourceCommand',
    'ListTargetsByRuleCommand',
  ]),
  IAMClient: new Set([
    'ListRoleTagsCommand',
    'ListRolesCommand',
  ]),
  KMSClient: new Set([
    'DescribeKeyCommand',
    'ListAliasesCommand',
    'ListKeysCommand',
    'ListResourceTagsCommand',
  ]),
  LambdaClient: new Set([
    'ListEventSourceMappingsCommand',
    'ListFunctionsCommand',
    'ListTagsCommand',
  ]),
  OpenSearchServerlessClient: new Set([
    'BatchGetCollectionCommand',
    'ListCollectionsCommand',
    'ListTagsForResourceCommand',
  ]),
  RDSClient: new Set([
    'DescribeDBClustersCommand',
    'DescribeDBInstancesCommand',
    'ListTagsForResourceCommand',
  ]),
  Route53Client: new Set([
    'ListHostedZonesCommand',
    'ListResourceRecordSetsCommand',
    'ListTagsForResourcesCommand',
  ]),
  S3Client: new Set([
    'GetBucketLocationCommand',
    'GetBucketTaggingCommand',
    'GetBucketVersioningCommand',
    'GetPublicAccessBlockCommand',
    'ListBucketsCommand',
  ]),
  SFNClient: new Set([
    'DescribeStateMachineCommand',
    'ListStateMachinesCommand',
    'ListTagsForResourceCommand',
  ]),
  SNSClient: new Set([
    'GetTopicAttributesCommand',
    'ListSubscriptionsByTopicCommand',
    'ListTagsForResourceCommand',
    'ListTopicsCommand',
  ]),
  SQSClient: new Set([
    'GetQueueAttributesCommand',
    'ListQueueTagsCommand',
    'ListQueuesCommand',
  ]),
  STSClient: new Set([
    'GetCallerIdentityCommand',
  ]),
  SchedulerClient: new Set([
    'GetScheduleCommand',
    'ListSchedulesCommand',
  ]),
  SecretsManagerClient: new Set([
    'ListSecretsCommand',
  ]),
  ServiceDiscoveryClient: new Set([
    'GetNamespaceCommand',
    'GetServiceCommand',
    'ListNamespacesCommand',
    'ListServicesCommand',
    'ListTagsForResourceCommand',
  ]),
  WAFV2Client: new Set([
    'GetWebACLCommand',
    'ListResourcesForWebACLCommand',
    'ListTagsForResourceCommand',
    'ListWebACLsCommand',
  ]),
};
