import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Search, RotateCw, Clock3 } from 'lucide-react';
import type { CleanupFinding, CleanupHistory, ResourceGraph } from '@orrery/shared';
import { useStore } from '../model/store';
import { api } from '../api/client';
import { CLEANUP_RULES, cleanupConsoleUrl, cleanupScopeKey, durationLabel, historyMatches, validCleanup, latestHistory, VERDICT_LABEL } from '../model/cleanup';
import { TypeIcon } from '../components/TypeIcon';
const date=(value:string)=>new Date(value).toLocaleString('ko-KR');

export function Cleanup(){
 const graph=useStore(s=>s.graph),generation=useStore(s=>s.connectionGeneration);
 if(!graph)return null;
 return <CleanupWorkspace key={`${cleanupScopeKey(graph)}:${graph.collectedAt}:${generation}`} graph={graph} generation={generation}/>;
}
export function CleanupWorkspace({graph,generation}:{graph:ResourceGraph;generation:number}){
 const snapshot=validCleanup(graph);
 const [query,setQuery]=useState(''),[rule,setRule]=useState(''),[filter,setFilter]=useState('all'),[limit,setLimit]=useState(60);
 const [histories,setHistories]=useState<Record<string,CleanupHistory>>({}),[errors,setErrors]=useState<Record<string,string>>({});
 const [selected,setSelected]=useState<string>();
 const detailPanel=useRef<HTMLDivElement>(null);
 const [busy,setBusy]=useState(''),[progress,setProgress]=useState('');
 const abort=useRef<AbortController|undefined>(undefined);
 const loading=useStore(s=>s.loading.active);
 useEffect(()=>()=>abort.current?.abort(),[]);
 const nodes=useMemo(()=>new Map(graph.nodes.map(n=>[n.id,n])),[graph]);
 const findings=snapshot?.findings??[];
 const counts={review:0,recent:0,insufficient:0,pending:0};
 for(const finding of findings)counts[histories[finding.id]?.verdict??'pending']++;
 const filtered=findings.filter(f=>{
  const node=nodes.get(f.resourceId);if(!node)return false;
  const status=histories[f.id]?.verdict??'pending';
  return (!rule||f.ruleId===rule)&&(filter==='all'||status===filter)&&(!query||`${node.name} ${node.nativeId}`.toLowerCase().includes(query.toLowerCase()));
 });
 const selectedFinding=filtered.find(f=>f.id===selected)??filtered[0];
 const unavailable=snapshot?.coverage.filter(c=>c.state!=='complete')??[];
 const current=()=>{const s=useStore.getState();return s.view==='cleanup'&&s.connectionGeneration===generation&&!!s.graph&&s.graph.collectedAt===graph.collectedAt&&cleanupScopeKey(s.graph)===cleanupScopeKey(graph)};
 const analyze=async(items:CleanupFinding[])=>{
  if(abort.current||!current()||loading)return;
  const controller=new AbortController();abort.current=controller;
  const {profile,region}=useStore.getState();
  try{
   for(const [i,finding] of items.slice(0,20).entries()){
    if(controller.signal.aborted||!current())break;
    setBusy(finding.id);setProgress(`${i+1} / ${Math.min(items.length,20)}개 분석 중`);
    setErrors(previous=>{const next={...previous};delete next[finding.id];return next});
    try{
     const result=await api.cleanupHistory(profile,region,finding.id,graph.collectedAt,controller.signal);
     if(controller.signal.aborted||!current())break;
     if(!historyMatches(graph,finding.id,result))throw new Error('계정 또는 구성 시각이 다른 결과입니다. 구성을 다시 수집하세요.');
     setHistories(previous=>({...previous,[finding.id]:result}));
    }catch(error){if(controller.signal.aborted||!current())break;setErrors(previous=>({...previous,[finding.id]:(error as Error).message}));}
   }
  }finally{if(abort.current===controller){abort.current=undefined;setBusy('');setProgress('')}}
 };
 const stop=()=>abort.current?.abort();
 const refresh=()=>{stop();void useStore.getState().load(true)};
 return <section className="cleanup-workspace" aria-label="정리 후보 점검">
  <header className="cleanup-heading"><div><h1>정리 후보</h1><p>현재 상태와 최근 30일의 관리 이력을 함께 확인합니다.</p><small>{graph.account} / {graph.region} · 구성 확인 {date(graph.collectedAt)}</small></div><button className="cleanup-button" onClick={refresh} disabled={loading}><RotateCw size={14}/>구성 다시 수집</button></header>
  {!snapshot?<div className="cleanup-notice" role="status">점검 근거가 없거나 현재 계정과 일치하지 않습니다. 구성을 다시 수집하세요.</div>:<>
   <div className="cleanup-counts"><span><strong>{counts.review}</strong>정리 검토 후보</span><span><strong>{counts.pending}</strong>이력 분석 전</span><span><strong>{counts.insufficient}</strong>근거 부족</span><span><strong>{counts.recent}</strong>최근 활동·변경</span></div>
   <div className="cleanup-toolbar"><label className="cleanup-search"><Search size={15}/><input aria-label="점검 자원 검색" placeholder="자원 이름·ID 검색" value={query} onChange={e=>{setQuery(e.target.value);setLimit(60)}}/></label><select aria-label="점검 유형" value={rule} onChange={e=>{setRule(e.target.value);setLimit(60)}}><option value="">전체 유형</option>{Object.entries(CLEANUP_RULES).map(([key,value])=><option key={key} value={key}>{value.label}</option>)}</select><select aria-label="판정 결과" value={filter} onChange={e=>{setFilter(e.target.value);setLimit(60)}}><option value="all">전체 점검 자원</option><option value="pending">이력 분석 전</option>{Object.entries(VERDICT_LABEL).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select><button className="cleanup-button" disabled={!!busy||loading||!filtered.length} onClick={()=>void analyze(filtered)}>목록 이력 조회·30일 분석 ({Math.min(20,filtered.length)}개)</button>{busy&&<button className="cleanup-button" onClick={stop}>분석 중단</button>}</div>
   <p className="cleanup-analysis-note">버튼을 누를 때만 CloudTrail 관리 이벤트를 조회합니다. 판정은 최근 30일, 시작 시점 탐색은 최대 90일입니다. 자원당 최대 10페이지·500건, 목록은 한 번에 최대 20개입니다. 애플리케이션 로그·CloudWatch 사용량 지표는 조회하지 않습니다. 성공한 분석은 5분간 재사용하며 화면을 벗어나면 진행 중인 목록 분석을 멈춥니다.</p>
   <div className="cleanup-progress" role="status">{progress||`${filtered.length}개 점검 자원 · 현재 상태만으로 후보를 확정하지 않습니다.`}</div>
   <div className="cleanup-split">
    <div className="cleanup-list" aria-label="점검 자원 목록">
     <div className="cleanup-list-head" aria-hidden="true"><span>자원 · 현재 상태</span><span>상태 경과</span><span>30일 판정</span></div>
     <div className="cleanup-list-rows">{filtered.slice(0,limit).map(finding=>{
      const node=nodes.get(finding.resourceId)!;const history=histories[finding.id];
      return <button className={`cleanup-row ${selectedFinding?.id===finding.id?'selected':''}`} key={finding.id} aria-pressed={selectedFinding?.id===finding.id} aria-controls="cleanup-detail" onClick={()=>{setSelected(finding.id);if(window.innerWidth<900)requestAnimationFrame(()=>detailPanel.current?.scrollIntoView({block:'start'}))}}>
       <span className="cleanup-row-resource"><span className={`cleanup-icon cat-${node.category}`}><TypeIcon type={node.type} size={18}/></span><span><strong>{node.name}</strong><small>{CLEANUP_RULES[finding.ruleId].label} · {node.nativeId}</small><small>{CLEANUP_RULES[finding.ruleId].condition}</small></span></span>
       <span className="cleanup-row-duration">{durationLabel(history)}{history?.duration.since&&<small>변경 기록 기준 추정</small>}</span>
       <span className={`cleanup-verdict ${history?.verdict??'pending'}`}>{busy===finding.id?'분석 중…':errors[finding.id]?'분석 실패':history?VERDICT_LABEL[history.verdict]:'이력 분석 전'}</span>
      </button>;
     })}</div>
     {filtered.length>limit&&<button className="cleanup-button cleanup-more" onClick={()=>setLimit(v=>v+60)}>60개 더 보기</button>}
     {!filtered.length&&<p className="cleanup-list-empty">선택한 조건의 점검 자원이 없습니다.</p>}
    </div>
    <div className="cleanup-detail-panel" id="cleanup-detail" ref={detailPanel}>{(selectedFinding?[selectedFinding]:[]).map(finding=>{
    const node=nodes.get(finding.resourceId)!;const history=histories[finding.id];const spec=CLEANUP_RULES[finding.ruleId];const url=cleanupConsoleUrl(node);
    const related=graph.edges.flatMap(e=>e.source===node.id?[nodes.get(e.target)]:e.target===node.id?[nodes.get(e.source)]:[]).filter((n):n is NonNullable<typeof n>=>!!n);
    return <article className="cleanup-card" key={finding.id} aria-label={`${node.name} 점검`}>
     <header><div className={`cleanup-icon cat-${node.category}`}><TypeIcon type={node.type} size={22}/></div><div><h2>{node.name}</h2><small>{node.nativeId}</small></div><span className={`cleanup-verdict ${history?.verdict??'pending'}`}>{history?VERDICT_LABEL[history.verdict]:'이력 분석 전'}</span></header>
     <div className="cleanup-condition"><strong>{spec.label}</strong><span>{spec.condition}</span></div>
     <div className="cleanup-duration"><Clock3 size={18}/><div><strong>{durationLabel(history)}</strong><span>{history?.duration.since?`상태 변경 요청 기록 후 경과 (추정) · ${date(history.duration.since)}`:'현재 상태가 시작된 시점을 아직 확인하지 못했습니다.'}</span></div></div>
     {finding.fact.ruleId==='detached-ebs'&&finding.fact.sizeGiB!==undefined&&<p className="cleanup-resource-note">보관 용량 {finding.fact.sizeGiB} GiB</p>}
     {finding.fact.ruleId==='empty-target-group'&&<p className="cleanup-resource-note">등록 대상 0개 · 로드 밸런서 연결 {finding.fact.loadBalancers}개</p>}
     <section className="cleanup-tags" aria-label="자원 태그"><h3>태그</h3>{Object.keys(node.tags??{}).length?<dl>{Object.entries(node.tags??{}).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value||'—'}</dd></div>)}</dl>:<p>수집된 태그 정보가 없습니다. 태그가 없거나 조회하지 못한 경우입니다.</p>}</section>
     <CleanupHistoryPanel history={history}/>
     <p className="cleanup-limitation">{spec.limitation}</p>
     <details className="cleanup-facts"><summary>수집된 구성·관련 자원</summary><dl>{Object.entries(node.props).filter(([k,v])=>!k.startsWith('_')&&v!==null).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl><p>수집 시각 {date(finding.observedAt)} · 연결선은 현재 수집된 범위이며 전체 의존성을 보장하지 않습니다.</p>{[...new Map(related.map(n=>[n.id,n])).values()].map(n=><button className="cleanup-link" key={n.id} onClick={()=>useStore.getState().locate(n.id)}>{n.name}</button>)}</details>
     {errors[finding.id]&&<p role="alert" className="cleanup-error">{errors[finding.id]}</p>}
     <footer><button className="cleanup-button primary" disabled={!!busy||loading} onClick={()=>void analyze([finding])}>{busy===finding.id?'분석 중…':history?'이력 다시 확인':'이력 조회·30일 분석'}</button><button className="cleanup-button" onClick={()=>useStore.getState().locate(node.id)}>지도에서 보기</button>{url&&<a className="cleanup-button" href={url} target="_blank" rel="noreferrer">AWS 콘솔<ExternalLink size={12}/></a>}</footer><small className="cleanup-console-note">AWS 콘솔 로그인 계정은 앱 프로필과 다를 수 있습니다.</small>
    </article>;
   })}{!selectedFinding&&<div className="cleanup-notice">목록에서 자원을 선택하면 이력과 판단 근거를 표시합니다.</div>}</div>
   </div>
   {!filtered.length&&<div className="cleanup-notice">{findings.length?'선택한 검색·필터에 해당하는 자원이 없습니다.':unavailable.length?'확인 가능한 범위에서 점검 자원이 없습니다. 아래 조회 실패를 확인하세요.':'네 가지 현재 상태 조건에 해당하는 자원이 없습니다. 전체 AWS 자원의 미사용 점검 완료를 뜻하지 않습니다.'}</div>}
   {unavailable.length>0&&<details className="cleanup-coverage" open><summary>구성 점검 불가 {unavailable.length}개 조회 범위</summary>{unavailable.map((c,i)=><p key={i}>{CLEANUP_RULES[c.ruleId].label} · {nodes.get(c.resourceId??'')?.name??c.resourceId??'목록 전체'} · {c.api} · {c.state==='not-collected'?'미수집':c.errorCode??'조회 실패'}</p>)}</details>}
  </>}
 </section>;
}

export function CleanupHistoryPanel({history}:{history?:CleanupHistory}){
 if(!history)return <section className="cleanup-history"><h3>마지막 활동 및 관리 이력</h3><p>이력을 조회하면 최근 90일 범위의 마지막 기록과 최근 30일 판정을 표시합니다.</p></section>;
 const latest=latestHistory(history);
 const missing=history.coverage==='complete'?'최근 90일 내 해당 이력 확인 안 됨':'조회가 완료되지 않아 확인 불가';
 const actor=(event:CleanupHistory['events'][number])=>event.actor?`${event.actor.type} · ${event.actor.label}`:'실행 주체 확인 불가';
 return <section className="cleanup-history"><h3>{history.coverage==='complete'?'마지막 활동 및 관리 변경':'조회된 범위의 최신 기록'}</h3>
 <p>최대 90일의 성공한 관리 변경 기록입니다. 실제 트래픽·사용량이나 자원 전체 수명 이력이 아닙니다.</p>
 {history.coverage!=='complete'&&<p role="status">{history.coverage==='error'?'이력 조회 실패':'일부 이력만 조회됨'} · 전체 범위의 마지막 기록을 확정할 수 없습니다.</p>}
 <dl className="cleanup-latest">{([['마지막 관리 변경',latest.management],['마지막 사용 관련 변경',latest.activity],['현재 상태로 변경한 기록',latest.state]] as const).map(([label,event])=><div key={label}><dt>{label}</dt><dd>{event?<><strong>{event.name}</strong><time>{date(event.time)}</time><span>{actor(event)}</span></>:label==='현재 상태로 변경한 기록'?'현재 상태의 시작 시점을 확인할 수 없습니다.':missing}</dd></div>)}</dl>
 <p>최근 30일 판정: {VERDICT_LABEL[history.verdict]} · 조회된 변경 기록 {latest.events.filter(e=>e.time>=history.start).length}개</p>
 <details><summary>조회 근거·기간 보기</summary><p>30일 판정: {date(history.start)} ~ {date(history.end)}</p><p>이력 조회: {date(history.lookbackStart)} ~ {date(history.end)} · {history.region} · {history.pages}페이지</p>{history.messages.map(message=><p key={message}>{message}</p>)}</details>
 <details><summary>조회된 전체 이력 ({latest.events.length}개) · 최신순</summary>{!latest.events.length?<p>{missing}</p>:<ul>{latest.events.map(event=><li key={event.id}><div><strong>{event.name}</strong><span className="cleanup-event-actor">{actor(event)}</span></div><time>{date(event.time)}</time></li>)}</ul>}</details>
 </section>;
}
