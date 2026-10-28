import { ECSClient, DescribeServicesCommand, type Service } from '@aws-sdk/client-ecs';
/** Recover readable services without treating a sibling's denial as an empty list. */
export async function readEcsServices(client: ECSClient, cluster: string, arns: string[], report: (message: string) => void, limit: <T>(fn: () => Promise<T>) => Promise<T> = fn => fn()): Promise<Service[]> {
  let found: Service[] = [];
  try { found = (await limit(() => client.send(new DescribeServicesCommand({ cluster, services: arns, include: ['TAGS'] })))).services ?? []; } catch { /* retry unresolved identities independently */ }
  for (const arn of arns.filter(a => !found.some(s => s.serviceArn === a))) {
    try {
      const response = await limit(() => client.send(new DescribeServicesCommand({ cluster, services: [arn], include: ['TAGS'] })));
      if (response.services?.length) found.push(...response.services);
      else report(`${arn}: ${response.failures?.map(f => f.reason).join(', ') || '상세 응답 없음'}`);
    } catch (error) { report(`${arn}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`); }
  }
  return found;
}
