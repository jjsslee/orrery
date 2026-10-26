import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Pause, Play, RotateCcw, SkipForward, UserRound } from 'lucide-react';
import type { ResourceGraph } from '@orrery/shared';
import { useStore } from '../model/store';
import { buildJourney, END_USER, entryForUrl, ENTRY_TYPES, frontendCandidates, graphScope, resourceHosts, routeKey, type JourneyPlan, type JourneyStep } from '../model/request-journey';
import { TypeIcon } from '../components/TypeIcon';
import { TYPE_META } from '../model/types';
import '../styles/journey.css';

const SEGMENT_MS = 1300;
interface Point { x: number; y: number }
function positions(plan: JourneyPlan): Map<string, Point> {
  const result = new Map<string, Point>([[END_USER, { x: 30, y: 170 }]]);
  const phases = new Set(plan.steps.map((s) => s.phase));
  let depth = 0;
  for (const step of plan.steps.filter((s) => s.kind === 'request')) {
    depth = step.from === END_USER ? 1 : depth + 1;
    if (!result.has(step.to)) result.set(step.to, { x: 30 + depth * 280, y: phases.size > 1 ? step.phase === 'document' ? 45 : 280 : 170 });
  }
  let i = 0;
  for (const node of plan.nodes) if (!result.has(node.id)) { result.set(node.id, { x: 30 + (i % 4) * 280, y: 460 + Math.floor(i / 4) * 130 }); i++; }
  return result;
}
function geometry(from: Point, to: Point, kind: JourneyStep['kind'], fraction = 0) {
  const right = to.x > from.x, sx = from.x + (right ? 210 : 0), ex = to.x + (right ? 0 : 210);
  const sy = from.y + (kind === 'request' ? 26 : 57), ey = to.y + (kind === 'request' ? 26 : 57), cx = (sx + ex) / 2;
  const t = fraction, u = 1 - t;
  return { path: `M${sx},${sy} C${cx},${sy} ${cx},${ey} ${ex},${ey}`, x: u*u*u*sx + 3*u*u*t*cx + 3*u*t*t*cx + t*t*t*ex, y: u*u*u*sy + 3*u*u*t*sy + 3*u*t*t*ey + t*t*t*ey };
}

export function RequestJourney() {
  const graph = useStore((s) => s.graph);
  const generation = useStore((s) => s.connectionGeneration);
  const selectedId = useStore((s) => s.selectedId);
  if (!graph) return null;
  // Unmount all playback/options on every scope or topology snapshot change.
  return <JourneyWorkspace key={`${graphScope(graph)}:${generation}:${graph.collectedAt}`} graph={graph} initialId={selectedId} />;
}

export function JourneyWorkspace({ graph, initialId }: { graph: ResourceGraph; initialId?: string }) {
  const entries = graph.nodes.filter((n) => ENTRY_TYPES.has(n.type));
  const [entryId, setEntryId] = useState(entries.find((n) => n.id === initialId)?.id ?? entries[0]?.id ?? '');
  const [path, setPath] = useState('/');
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [apiId, setApiId] = useState('');
  const [selectedRoute, setSelectedRoute] = useState('');
  const [cacheHit, setCacheHit] = useState(false);
  const [time, setTime] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [detail, setDetail] = useState<string>();
  const [reducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const entry = entries.find((n) => n.id === entryId);
  const candidates = useMemo(() => frontendCandidates(graph, entryId), [graph, entryId]);
  const target = graph.nodes.find((n) => n.id === apiId) ?? entry;
  const routes = target?.requestRouting?.kind === 'api' ? target.requestRouting.routes : [];
  const plan = useMemo(() => buildJourney(graph, { entryId, path, method, apiId, apiRoute: selectedRoute || undefined, cacheHit }), [graph, entryId, path, method, apiId, selectedRoute, cacheHit]);
  const layout = useMemo(() => positions(plan), [plan]);
  const duration = plan.steps.length * SEGMENT_MS;
  const bounded = Math.min(time, duration);
  const done = duration > 0 && bounded >= duration;
  const index = done ? plan.steps.length - 1 : Math.floor(bounded / SEGMENT_MS);
  const step = plan.steps[index];
  const fraction = done ? 1 : (bounded % SEGMENT_MS) / SEGMENT_MS;
  const last = useRef<number | undefined>(undefined);
  const reset = () => { setRunning(false); setTime(0); last.current = undefined; };
  useEffect(() => { reset(); setDetail(undefined); }, [plan]);
  useEffect(() => {
    if (!running) return;
    let frame: number;
    const tick = (now: number) => { const dt = last.current === undefined ? 0 : now - last.current; last.current = now; setTime((v) => Math.min(duration, v + dt * speed)); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    const hide = () => { if (document.hidden) setRunning(false); };
    document.addEventListener('visibilitychange', hide);
    return () => { cancelAnimationFrame(frame); last.current = undefined; document.removeEventListener('visibilitychange', hide); };
  }, [running, duration, speed]);
  useEffect(() => { if (done) setRunning(false); }, [done]);
  const play = () => {
    if (!duration) return;
    if (reducedMotion) { setTime((v) => v >= duration ? 0 : Math.min(duration, (Math.floor(v / SEGMENT_MS) + 1) * SEGMENT_MS)); return; }
    if (done) setTime(0);
    setRunning((v) => !v);
  };
  const changeEntry = (id: string) => { reset(); setEntryId(id); setPath('/'); setApiId(''); setSelectedRoute(''); setCacheHit(false); setUrl(''); setUrlError(''); };
  const applyUrl = () => {
    const resolved = entryForUrl(graph, url);
    setUrl(''); // Do not retain query tokens even in the input after parsing.
    if (!resolved.node) { setUrlError(resolved.error ?? '주소 미확인'); return; }
    changeEntry(resolved.node.id); setPath(resolved.path ?? '/');
  };
  const nodeDetail = graph.nodes.find((n) => n.id === detail);
  const width = Math.max(1080, ...[...layout.values()].map((p) => p.x + 250));
  const height = Math.max(410, ...[...layout.values()].map((p) => p.y + 110));
  const activeGeometry = step && layout.has(step.from) && layout.has(step.to) ? geometry(layout.get(step.from)!, layout.get(step.to)!, step.kind, fraction) : undefined;
  const lines = [...new Map(plan.steps.map((s) => [`${s.from}|${s.to}|${s.kind}`, s])).values()];
  const fileReceived = plan.steps.slice(0, done ? plan.steps.length : index).some((s) => s.to === END_USER && s.phase === 'document');

  return <section className="request-journey" aria-label="사용자 요청 흐름">
    <header className="journey-heading"><div><h1>사용자 요청 흐름</h1><p>End user를 눌러 설정상 요청·응답 경로를 재생합니다. 실제 트래픽·응답 시간은 아닙니다.</p></div><button className="journey-button" onClick={() => useStore.getState().setView('topology')}><ArrowLeft size={14}/> 토폴로지로</button></header>
    <div className="journey-options">
      <label>시작 자원<select value={entryId} onChange={(e) => changeEntry(e.target.value)}><option value="">자원 선택</option>{entries.map((n) => <option key={n.id} value={n.id}>{n.name} · {TYPE_META[n.type].short}</option>)}</select></label>
      <form onSubmit={(e) => { e.preventDefault(); applyUrl(); }}><label>URL로 찾기<input aria-label="URL로 찾기" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={entry ? `https://${resourceHosts(entry)[0] ?? '서비스 주소'}` : 'https://서비스 주소'} autoComplete="off" /></label><button className="journey-button" type="submit">찾기</button></form>
      <label>Method<select value={method} onChange={(e) => setMethod(e.target.value)}>{['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map((m) => <option key={m}>{m}</option>)}</select></label>
      <label>경로<input aria-label="요청 경로" value={path} onChange={(e) => { setPath(e.target.value.split(/[?#]/)[0]); setSelectedRoute(''); }} /></label>
      {entry?.type === 'cloudfront' && <label>시작 URL 응답<select value={cacheHit ? 'hit' : 'miss'} onChange={(e) => setCacheHit(e.target.value === 'hit')}><option value="miss">오리진 요청 가정</option><option value="hit">캐시 적중 가정</option></select></label>}
      {entry?.type === 'cloudfront' && <label>후속 API 호출 후보<select value={apiId} onChange={(e) => { setApiId(e.target.value); setSelectedRoute(''); }}><option value="">{candidates.length ? 'API 선택 (호출 가정)' : '자동 확인된 후보 없음'}</option>{candidates.map((n) => <option value={n.id} key={n.id}>{n.name}</option>)}</select></label>}
      {routes.length > 0 && <label>API 라우트 시나리오<select value={selectedRoute} onChange={(e) => setSelectedRoute(e.target.value)}><option value="">입력 method·경로로 해석</option>{routes.map((r,i) => <option key={`${routeKey(r)}:${i}`} value={routeKey(r)}>{routeKey(r)}</option>)}</select></label>}
    </div>
    {urlError && <p className="journey-alert" role="alert">{urlError}</p>}
    {!entries.length ? <div className="journey-empty">현재 수집 결과에 CloudFront·API Gateway·AppSync·로드 밸런서가 없습니다. 프로필·리전을 확인하고 다시 수집하세요.</div> : <>
    <div className="journey-scene" tabIndex={0} aria-label="요청 흐름 지도 · 넘치는 영역은 스크롤 가능">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width, height }} role="group" aria-label="자원을 따라 흐르는 요청과 응답">
        <defs><marker id="journey-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10" fill="var(--ink-3)"/></marker></defs>
        {plan.contextEdges.map((e,i) => layout.has(e.source) && layout.has(e.target) ? <path key={`context:${i}`} className="journey-context-edge" d={geometry(layout.get(e.source)!, layout.get(e.target)!, 'request').path}><title>관련 자원 · 실행 경로 미확인</title></path> : null)}
        {lines.map((s) => <path key={`${s.from}|${s.to}|${s.kind}`} className={`journey-edge ${s.kind} ${step?.from === s.from && step?.to === s.to && !done ? 'active' : ''}`} d={geometry(layout.get(s.from)!, layout.get(s.to)!, s.kind).path} markerEnd="url(#journey-arrow)"/>)}
        <foreignObject x={30} y={170} width={210} height={86}><button className="journey-user" aria-label="End user 요청 재생" onClick={() => { last.current = undefined; setTime(0); if (reducedMotion) setTime(SEGMENT_MS); else setRunning(true); }} disabled={!duration}><UserRound size={25}/><span><strong>End user</strong><small>{done ? plan.phaseComplete ? '응답 귀환 경로 확인' : '응답 구간 미확인' : '브라우저 · 클릭하여 재생'}</small></span></button></foreignObject>
        {plan.nodes.map((n) => {const p=layout.get(n.id)!; const inPath=plan.steps.some((s)=>s.to===n.id); return <foreignObject key={n.id} x={p.x} y={p.y} width={210} height={86}><button onClick={() => setDetail(n.id)} className={`journey-resource cat-${n.category} ${step?.to === n.id && !done ? 'active' : ''} ${inPath ? '' : 'context'}`} title={`${n.name} · ${TYPE_META[n.type].label}`}><TypeIcon type={n.type} size={20}/><span><strong>{n.name}</strong><small>{TYPE_META[n.type].short}{inPath ? '' : ' · 관련 자원'}</small></span></button></foreignObject>})}
        {activeGeometry && (running || bounded > 0) && !done && <circle className={`journey-packet ${step.kind}`} cx={activeGeometry.x} cy={activeGeometry.y} r={7}/>}
      </svg>
    </div>
    <div className="journey-progress"><div style={{ width: `${duration ? bounded / duration * 100 : 0}%` }}/></div>
    <div className="journey-status" aria-live="polite"><div><small>{duration ? `${Math.min(index+1, plan.steps.length)} / ${plan.steps.length} 구간` : '경로 준비'}</small><h2>{done ? plan.phaseComplete ? '응답이 사용자에게 돌아오는 경로입니다 (가정)' : '확인 가능한 구간까지 재생했습니다' : bounded || running ? step?.title : 'End user를 클릭하세요'}</h2></div><p>{done ? plan.phaseComplete ? '실제 HTTP 상태·본문은 조회하지 않았습니다.' : '이후 실행과 응답은 미확인입니다.' : fileReceived ? '시작 URL 응답 경로 확인 · 후속 API 재생 중' : '설정에 따른 경로이며 실제 요청을 보내지 않습니다.'}</p></div>
    <div className="journey-controls"><button className="journey-button primary" onClick={play} disabled={!duration}>{running ? <Pause size={14}/> : <Play size={14}/>} {reducedMotion ? '구간 이동' : running ? '일시정지' : done ? '다시 재생' : '재생'}</button><button className="journey-button" onClick={() => { setRunning(false); setTime(Math.min(duration, (Math.floor(bounded / SEGMENT_MS) + 1) * SEGMENT_MS)); }} disabled={!duration}><SkipForward size={14}/>다음 구간</button><button className="journey-button" onClick={reset}><RotateCcw size={14}/>처음으로</button><label>속도<select value={speed} onChange={(e)=>setSpeed(Number(e.target.value))}>{[0.5,1,2].map((s)=><option key={s} value={s}>{s}×</option>)}</select></label><input type="range" aria-label="재생 위치" min={0} max={duration || 1} value={bounded} onChange={(e)=>{setRunning(false);setTime(Number(e.target.value))}} disabled={!duration}/></div>
    <div className="journey-legend"><span><i className="request"/>요청</span><span><i className="response"/>응답</span><span>회색 점선: 관련 자원 · 이 요청의 실행은 미확인</span>{plan.omitted > 0 && <span>주변 자원 {plan.omitted}개는 토폴로지에서 확인</span>}</div>
    {plan.unresolved.length > 0 && <div className="journey-alert" role="status">{plan.unresolved.map((message)=><p key={message}>{message}</p>)}</div>}
    {nodeDetail && <div className="journey-detail"><strong>{nodeDetail.name} · {TYPE_META[nodeDetail.type].label}</strong><p>이 자원을 포함한 전체 관계는 토폴로지에서 확인할 수 있습니다.</p><button className="journey-button" onClick={()=>useStore.getState().locate(nodeDetail.id)}>토폴로지에서 보기</button><button className="journey-button" onClick={()=>setDetail(undefined)}>닫기</button></div>}
    <details className="journey-evidence"><summary>분석 근거와 한계</summary>{plan.notes.map((note)=><p key={note}>{note}</p>)}<p>수집: {graph.collectedAt} · 계정/리전: {graph.account} / {graph.region}</p>{apiId && <p>FE–API 후보는 수집한 CORS 허용 origin과 CloudFront 도메인 일치를 사용했습니다. 실제 FE 호출을 관측한 것은 아닙니다.</p>}<p>AppSync 데이터 소스와 DB·큐 등은 관련 자원으로 표시합니다. resolver·애플리케이션 코드·trace가 없는 구간에는 요청 점을 이동시키지 않습니다.</p></details>
    </>}
  </section>;
}
