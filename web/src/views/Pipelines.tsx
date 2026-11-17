import { pipelineRunning, stageStatuses } from '../model/pipelines';
import { useEffect, useState } from 'react';
import type { PipelineDetail, PipelineHistory, PipelinePage } from '@orrery/shared';
import { api } from '../api/client';
import { useStore } from '../model/store';
import { locale, useLanguage } from '../i18n';
import './pipelines.css';

export function Pipelines() {
  const { profile, region, connectionGeneration, setup } = useStore();
  const lang = useLanguage();
  if (setup !== 'done' || !region) return <div className="empty">{lang === 'ko' ? '프로필과 리전을 선택하세요.' : 'Select a profile and region.'}</div>;
  return <Workspace key={`${profile}:${region}:${connectionGeneration}`} profile={profile} region={region} />;
}
function Workspace({ profile, region }: { profile: string; region: string }) {
  const lang = useLanguage(), t = (ko: string, en: string) => lang === 'ko' ? ko : en;
  const [page, setPage] = useState<PipelinePage>({ names: [] }), [name, setName] = useState('');
  const [listError, setListError] = useState(''), [listBusy, setListBusy] = useState(false), [listToken, setListToken] = useState<string>();
  const [listRevision, setListRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setListBusy(true); setListError('');
    api.pipelines(profile, region, listToken, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(p => ({ ...value, names: listToken ? [...new Set([...p.names, ...value.names])] : value.names }));
    }).catch(e => { if (!controller.signal.aborted) setListError(e.message); }).finally(() => { if (!controller.signal.aborted) setListBusy(false); });
    return () => controller.abort();
  }, [profile, region, listToken, listRevision]);
  return <section className="pipelines"><header><h1>CodePipeline</h1><p>{t('배포 현황 · 조회 전용', 'Deployment status · Read only')} · {profile} / {region}</p></header>
    <div className="pipeline-controls"><label>{t('파이프라인', 'Pipeline')} <select value={name} onChange={e => setName(e.target.value)}><option value="">{t('선택하세요', 'Select a pipeline')}</option>{page.names.map(n => <option key={n}>{n}</option>)}</select></label>
    <button disabled={listBusy} onClick={() => { setListToken(undefined); setListRevision(v => v + 1); }}>{t('목록 새로고침', 'Refresh list')}</button>
    {page.nextToken && <button disabled={listBusy} onClick={() => setListToken(page.nextToken)}>{t('목록 더 보기', 'More pipelines')}</button>}</div>
    {listBusy && <p role="status">{t('조회 중…', 'Loading…')}</p>}{listError && <p role="alert">{listError}</p>}
    {!listBusy && !listError && !page.names.length && <p>{t('이 리전에 파이프라인이 없습니다.', 'No pipelines in this region.')}</p>}
    {name && <ExecutionPanel key={name} {...{ profile, region, name }} />}
  </section>;
}
function ExecutionPanel({ profile, region, name }: { profile: string; region: string; name: string }) {
  const lang = useLanguage(), t = (ko: string, en: string) => lang === 'ko' ? ko : en;
  const [history, setHistory] = useState<PipelineHistory>({ executions: [] }), [selected, setSelected] = useState('');
  const [token, setToken] = useState<string>(), [revision, setRevision] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detail, setDetail] = useState<PipelineDetail>(), [detailError, setDetailError] = useState('');
  const active = history.executions.some(e => pipelineRunning(e.status)) || pipelineRunning(detail?.status);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    api.pipelineHistory(profile, region, name, token, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setHistory(previous => ({ ...value, executions: token ? [...new Map([...previous.executions, ...value.executions].map(e => [e.id, e])).values()] : value.executions }));
      setSelected(s => s || value.executions[0]?.id || '');
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [profile, region, name, token, revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); setDetailError(''); setDetailBusy(true);
    api.pipelineDetail(profile, region, name, selected, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(e => { if (!controller.signal.aborted) setDetailError(e.message); }).finally(() => { if (!controller.signal.aborted) setDetailBusy(false); });
    return () => controller.abort();
  }, [profile, region, name, selected, revision]);
  useEffect(() => {
    if (!active || busy || detailBusy || error || detailError) return;
    const timer = window.setTimeout(() => { if (document.visibilityState === 'visible') { setToken(undefined); setRevision(v => v + 1); } }, 15000);
    const visible = () => { if (document.visibilityState === 'visible') { setToken(undefined); setRevision(v => v + 1); } };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [active, busy, detailBusy, error, detailError, revision]);
  const date = (value?: string) => value ? new Date(value).toLocaleString(locale()) : '—';
  return <><div className="pipeline-controls"><h2>{name}</h2><button disabled={busy || detailBusy} onClick={() => { setToken(undefined); setRevision(v => v + 1); }}>{t('새로고침', 'Refresh')}</button></div>
    <p>{t('진행 중이면 15초마다 자동 갱신 · 조회 오류 시 수동 재시도', 'Refreshes every 15 seconds while running · Retry manually after errors')}</p>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">{t('조회 중…', 'Loading…')}</p>}
    <div className="pipeline-columns"><section><h3>{t('실행 이력', 'Execution history')}</h3>{!busy && !error && !history.executions.length && <p>{t('실행 이력이 없습니다.', 'No executions.')}</p>}
    {history.executions.map(e => <button className="pipeline-execution" aria-pressed={selected === e.id} key={e.id} onClick={() => { if (selected !== e.id) { setDetail(undefined); setSelected(e.id); } }}><strong>{e.status}</strong><time>{date(e.startedAt)}</time><code>{e.id}</code></button>)}
    {history.nextToken && <button disabled={busy} onClick={() => setToken(history.nextToken)}>{t('이력 더 보기', 'More history')}</button>}</section>
    <section><h3>{t('선택한 실행의 단계별 상태', 'Stages for selected execution')}</h3><code>{selected}</code>
    {detailError && <p role="alert">{detailError} · {t('이전 조회 결과일 수 있습니다.', 'Displayed data may be stale.')}</p>}
    {selected && !detail && !detailError && <p role="status">{t('조회 중…', 'Loading…')}</p>}
    {detail && <><p>{detail.status} · {t('확인 시각', 'Checked at')}: {date(detail.checkedAt)}</p>{detail.stages.map(stage => <article className="pipeline-stage" key={stage}><h4>{stage} · {stageStatuses(detail.actions.filter(a => a.stage === stage)) || t('실행 기록 없음', 'No action execution recorded')}</h4>
      {!detail.actions.some(a => a.stage === stage) && <p>{t('실행 기록 없음', 'No action execution recorded')}</p>}
      {detail.actions.filter(a => a.stage === stage).map((a, i) => <div key={a.id ?? i}><strong>{a.name} · {a.status}</strong><p>{date(a.startedAt)} — {date(a.updatedAt)}</p>{a.error && <pre role="note">{a.error}</pre>}{a.status === 'Failed' && !a.error && <p>{t('AWS가 실패 원인을 반환하지 않았습니다.', 'AWS did not return a failure reason.')}</p>}</div>)}
    </article>)}</>}
    </section></div></>;
}
