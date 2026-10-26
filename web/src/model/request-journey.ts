import type { RequestRoute, ResourceGraph, ResourceNode } from '@orrery/shared';

export const END_USER = '@end-user';
export const ENTRY_TYPES = new Set(['cloudfront', 'api-gateway', 'appsync-api', 'load-balancer']);
export interface JourneyOptions { entryId: string; path: string; method: string; apiId?: string; apiRoute?: string; cacheHit: boolean }
export interface JourneyStep { from: string; to: string; kind: 'request' | 'response'; phase: 'document' | 'api'; title: string }
export interface JourneyPlan { steps: JourneyStep[]; nodes: ResourceNode[]; contextEdges: Array<{ source: string; target: string }>; notes: string[]; unresolved: string[]; omitted: number; phaseComplete: boolean }
export const routeKey = (route: RequestRoute) => `${route.method} ${route.path}`;

export function graphScope(graph: ResourceGraph): string { return JSON.stringify([graph.source, graph.account, graph.region]); }
export function frontendCandidates(graph: ResourceGraph, entryId: string) {
  const data = graph.frontendRelations;
  if (!data || JSON.stringify([data.scope.source, data.scope.account, data.scope.region]) !== graphScope(graph)) return [];
  const ids = new Set(data.relations.filter((r) => r.hostingResourceId === entryId).map((r) => r.targetId));
  return graph.nodes.filter((n) => ids.has(n.id) && n.type === 'api-gateway');
}

export function resourceHosts(node: ResourceNode): string[] {
  if (node.requestRouting?.kind === 'cloudfront') return node.requestRouting.hosts.map((h) => h.toLowerCase());
  const values = ['엔드포인트', '도메인', 'DNS', '_hosts'].flatMap((key) => typeof node.props[key] === 'string' ? String(node.props[key]).split(',') : []);
  return values.flatMap((v) => { try { return [new URL(v.includes('://') ? v.trim() : `https://${v.trim()}`).hostname]; } catch { return []; } });
}

export function entryForUrl(graph: ResourceGraph, text: string): { node?: ResourceNode; path?: string; error?: string } {
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { error: '인증 정보가 없는 HTTP(S) 주소를 입력하세요.' };
    const found = graph.nodes.filter((n) => ENTRY_TYPES.has(n.type) && resourceHosts(n).includes(url.hostname));
    if (found.length !== 1) return { error: found.length ? '같은 주소의 자원이 여러 개입니다. 시작 자원을 선택하세요.' : '현재 계정·리전에서 이 주소를 확인하지 못했습니다. 자원을 선택하거나 다시 수집하세요.' };
    return { node: found[0], path: url.pathname }; // Query/fragment tokens are never retained.
  } catch { return { error: 'https://로 시작하는 주소를 입력하세요.' }; }
}

function wildcard(pattern: string, path: string): boolean {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(path);
}
function apiMatch(pattern: string, path: string): boolean {
  const parts = pattern.split('/'); const target = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (/^\{[^}]+\+\}$/.test(parts[i])) return target.slice(i).join('/').length > 0;
    if (target[i] === undefined || (/^\{[^}]+\}$/.test(parts[i]) ? !target[i] : target[i] !== parts[i])) return false;
  }
  return parts.length === target.length;
}
export function matchApiRoute(routes: RequestRoute[], path: string, method: string): RequestRoute | undefined {
  const found = routes.filter((r) => (r.method === method || r.method === 'ANY') && (r.path === '$default' || apiMatch(r.path, path)));
  const score = (r: RequestRoute) => r.path === '$default' ? -1000 : r.path.split('/').reduce((s, p) => s + (p.includes('+') ? 0 : p.startsWith('{') ? 1 : 10), 0) + (r.method === method ? 0.1 : 0);
  found.sort((a, b) => score(b) - score(a));
  return found.length > 1 && score(found[0]) === score(found[1]) ? undefined : found[0];
}

export function buildJourney(graph: ResourceGraph, options: JourneyOptions): JourneyPlan {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const root = byId.get(options.entryId);
  const plan: JourneyPlan = { steps: [], nodes: [], contextEdges: [], notes: ['설정에 따른 가정 재생입니다. 실제 요청·인증·응답 상태·지연 시간을 측정하지 않습니다.'], unresolved: [], omitted: 0, phaseComplete: false };
  if (!root || !ENTRY_TYPES.has(root.type)) { plan.unresolved.push('시작 자원을 선택하세요.'); return plan; }
  const important = new Set([root.id]);
  const walk = (entry: ResourceNode, initialPath: string, method: string, phase: JourneyStep['phase'], chosenRoute?: string) => {
    const chain = [END_USER]; let node = entry, path = initialPath; const visited = new Set<string>(); let complete = false;
    for (let depth = 0; depth < 10; depth++) {
      if (visited.has(node.id)) { plan.unresolved.push('라우팅 순환이 있어 이 구간에서 멈췄습니다.'); break; }
      visited.add(node.id); important.add(node.id);
      plan.steps.push({ from: chain[chain.length - 1], to: node.id, kind: 'request', phase, title: `${node.name}에 ${phase === 'document' ? '시작 URL' : 'API'} 요청 전달` });
      chain.push(node.id);
      if (node.type === 's3-bucket' || node.type === 'lambda') {
        plan.notes.push(node.type === 'lambda' ? 'Lambda 내부 코드·DB·큐 실행은 미확인입니다. 반환 구간은 동기 응답을 가정합니다.' : 'S3 객체 존재·접근 권한·화면 파일 내용은 미확인입니다. 파일 반환을 가정합니다.');
        complete = true; break;
      }
      const routing = node.requestRouting;
      if (routing?.kind === 'cloudfront') {
        if (!routing.enabled) { plan.unresolved.push(`${node.name}: 비활성 배포입니다.`); break; }
        const behavior = routing.behaviors.find((b) => wildcard(b.pattern.startsWith('/') ? b.pattern : '/' + b.pattern, path));
        if (!behavior || !behavior.methods.includes(method)) { plan.unresolved.push(`${node.name}: 일치하는 경로 또는 허용 method가 없습니다.`); break; }
        if (behavior.dynamic) { plan.unresolved.push(`${node.name}: Edge 함수가 요청·응답을 바꿀 수 있어 이후 경로는 미확인입니다.`); break; }
        if (!routing.deployed) plan.notes.push('CloudFront 설정이 배포 중입니다. 현재 모든 edge에 반영됐다고 보장하지 않습니다.');
        if (options.cacheHit && (method === 'GET' || method === 'HEAD') && phase === 'document') { plan.notes.push('캐시 적중을 가정하여 오리진 요청을 생략합니다.'); complete = true; break; }
        const origin = routing.origins.find((o) => o.id === behavior.originId);
        if (!origin) { plan.unresolved.push('오리진 그룹 또는 미수집 오리진의 전달 대상을 확인할 수 없습니다.'); break; }
        const matches = graph.nodes.filter((n) => n.id !== node.id && (resourceHosts(n).includes(origin.host.toLowerCase()) || (n.type === 's3-bucket' && (['s3', `s3.${n.region}`, `s3-${n.region}`, `s3-website.${n.region}`, `s3-website-${n.region}`].some((service) => origin.host === `${n.nativeId}.${service}.amazonaws.com${n.arn?.startsWith('arn:aws-cn:') ? '.cn' : ''}`)))));
        if (matches.length !== 1) { plan.unresolved.push(`${node.name}: 오리진 대상이 미수집이거나 여러 개입니다.`); break; }
        path = origin.path + path; node = matches[0]; continue;
      }
      if (routing?.kind === 'api') {
        plan.notes.push(routing.deployment === 'editable-config' ? 'REST API 편집 설정으로 경로를 계산합니다. 배포 stage와 다를 수 있습니다.' : 'API의 현재 라우트 설정입니다. 배포 여부는 미확인입니다.');
        if (routing.protocol === 'websocket') { plan.unresolved.push('WebSocket 연결·메시지 라우트는 HTTP 왕복 재생에서 해석하지 않습니다.'); break; }
        if (!routing.complete) { plan.unresolved.push('API 라우트 수집이 부분 결과입니다. 다시 수집하거나 권한을 확인하세요.'); break; }
        let route: RequestRoute | undefined;
        if (chosenRoute && node.id === entry.id) route = routing.routes.find((r) => routeKey(r) === chosenRoute);
        else {
          const stage = path.split('/')[1];
          if (routing.stages.includes(stage)) path = path.slice(stage.length + 1) || '/';
          route = matchApiRoute(routing.routes, path, method);
        }
        if (!route) { plan.unresolved.push(`${node.name}: 일치하는 API 경로가 없습니다. method·경로를 확인하세요.`); break; }
        if (route.async) { plan.unresolved.push('비동기 또는 호출 방식 변경이 설정되어 동기 응답을 재생하지 않습니다.'); break; }
        const arn = route.targetArn;
        const parts = arn?.split(':');
        const lambda = parts && parts[3] === graph.region && parts[4] === graph.account ? graph.nodes.find((n) => n.type === 'lambda' && n.arn === parts.slice(0, 7).join(':')) : undefined;
        if (!lambda) { plan.unresolved.push('통합 대상이 Lambda가 아니거나, 다른 계정·리전 또는 미수집 대상입니다.'); break; }
        if (parts && parts.length > 7) plan.notes.push(`Lambda qualifier ${parts.slice(7).join(':')}: 실제 version 선택은 미확인입니다.`);
        node = lambda; continue;
      }
      if (node.type === 'appsync-api') plan.unresolved.push('AppSync는 query·mutation과 resolver별 경로가 필요합니다. 연결된 데이터 소스는 표시하지만 이후 호출·응답은 미확인입니다.');
      else if (node.type === 'load-balancer') plan.unresolved.push('로드 밸런서의 listener 규칙·target 선택은 미확인입니다. 연결된 자원만 표시합니다.');
      else plan.unresolved.push(`${node.name}: 경로 정보가 없습니다. 다시 수집하거나 지원 범위를 확인하세요.`);
      break;
    }
    if (complete) for (let i = chain.length - 1; i > 0; i--) plan.steps.push({ from: chain[i], to: chain[i - 1], phase, kind: 'response', title: chain[i - 1] === END_USER ? `${phase === 'document' ? '시작 URL' : 'API'} 응답이 사용자에게 돌아옴 (가정)` : `${byId.get(chain[i - 1])?.name ?? ''}로 응답 반환 (가정)` });
    return complete;
  };
  const document = root.type === 'cloudfront';
  plan.phaseComplete = walk(root, options.path.startsWith('/') ? options.path : '/', options.method, document ? 'document' : 'api', document ? undefined : options.apiRoute);
  const api = options.apiId ? frontendCandidates(graph, root.id).find((n) => n.id === options.apiId) : undefined;
  if (api) {
    important.add(api.id);
    if (document && plan.phaseComplete) { plan.notes.push('선택된 FE–API 연결 후보를 사용한다고 가정합니다. 실제 FE 호출은 미관측입니다.'); plan.phaseComplete = walk(api, '/', 'GET', 'api', options.apiRoute); }
  }
  // Context is never traversed as a request path. AppSync and every existing resource type remain visible.
  const candidates = frontendCandidates(graph, root.id); candidates.forEach((n) => important.add(n.id));
  const context = new Set(important);
  for (const seed of [...important]) for (const e of graph.edges) {
    if (e.source === seed && byId.has(e.target)) context.add(e.target);
    if (e.target === seed && byId.has(e.source)) context.add(e.source);
  }
  const all = [...context]; const kept = new Set([...important, ...all.filter((id) => !important.has(id)).slice(0, Math.max(0, 60 - important.size))]);
  plan.omitted = all.length - kept.size;
  plan.nodes = [...kept].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  plan.contextEdges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target)).map((e) => ({ source: e.source, target: e.target }));
  for (const candidate of candidates) plan.contextEdges.push({ source: root.id, target: candidate.id });
  plan.notes = [...new Set(plan.notes)]; plan.unresolved = [...new Set(plan.unresolved)];
  return plan;
}
