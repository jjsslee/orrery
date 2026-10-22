/**
 * CloudWatch metrics for nodes in a graph. Implemented in ./cloudwatch.ts;
 * this façade keeps the HTTP layer independent of the metric catalogue.
 */
import type { MetricsBundle, ResourceGraph } from '@orrery/shared';
import type { ClientFactory } from '../aws/clients.ts';
import { collectMetrics } from './cloudwatch.ts';

export async function metricsForGraph(graph: ResourceGraph, clients: ClientFactory): Promise<MetricsBundle> {
  return collectMetrics(graph, clients);
}
