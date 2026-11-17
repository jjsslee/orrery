import { useEffect, useState } from 'react';
import { Check, Circle, ExternalLink, GitCommitHorizontal, LoaderCircle, Pause, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { PipelineDetail, PipelineHistory, PipelinePage } from '@orrery/shared';
import { actionTone, latestActions, pipelinePool, pipelineRunning, readPipelineSelection, savePipelineSelection, selectionKey, stageTone, type PipelineTone } from '../model/pipelines';
import { api } from '../api/client';
import { useStore } from '../model/store';
import { locale, useLanguage } from '../i18n';
import './pipelines.css';

type Translate = (ko: string, en: string) => string;
type Snapshot = { history?: PipelineHistory; detail?: PipelineDetail; error?: string; checkedAt?: string };
const statusText = (tone: PipelineTone, t: Translate) => ({ success: t('성공', 'Succeeded'), running: t('진행 중', 'Running'), failed: t('실패', 'Failed'), waiting: t('승인 대기', 'Awaiting approval'), idle: t('기타·기록 없음', 'Other / no record') })[tone];
function StatusIcon({ tone }: { tone: PipelineTone }) {
  const Icon = { success: Check, running: LoaderCircle, failed: X, waiting: Pause, idle: Circle }[tone];
  return <Icon size={16} aria-hidden className={tone === 'running' ? 'pipeline-spin' : undefined} />;
}
const date = (value?: string) => value ? new Date(value).toLocaleString(locale()) : '—';
function duration(start?: string, end?: string) {
  if (!start || !end) return '—';
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function rowTone(snapshot?: Snapshot): PipelineTone {
  if (snapshot?.error) return 'idle';
  if (snapshot?.detail && latestActions(snapshot.detail.actions).some(a => a.category === 'Approval' && pipelineRunning(a.status))) return 'waiting';
  return actionTone(snapshot?.history?.executions[0]?.status);
}
function Flow({ detail, t }: { detail: PipelineDetail; t: Translate }) {
  return <div className="pipeline-flow" aria-label={t('단계별 상태', 'Stage status')}>{detail.stages.map(stage => {
    const actions = latestActions(detail.actions.filter(a => a.stage === stage));
    const tone = stageTone(actions, detail.stageActions?.[stage]?.length);
    const start = actions.map(a => a.startedAt).filter((v): v is string => !!v).sort()[0];
    const end = actions.some(a => pipelineRunning(a.status)) ? detail.checkedAt : actions.map(a => a.updatedAt).filter((v): v is string => !!v).sort().at(-1);
    return <div className={`pipeline-node tone-${tone}`} key={stage}><strong><StatusIcon tone={tone} /><span>{stage}</span></strong><small>{statusText(tone, t)}{actions.length > 0 && <> · {duration(start, end)}</>}</small></div>;
  })}</div>;
}
export function Pipelines() {
  const profile = useStore(s => s.profile), region = useStore(s => s.region), identity = useStore(s => s.identity);
  const generation = useStore(s => s.connectionGeneration), setup = useStore(s => s.setup), error = useStore(s => s.loading.error);
  const lang = useLanguage();
  if (setup !== 'done' || !region) return <div className="empty">{lang === 'ko' ? '프로필과 리전을 선택하세요.' : 'Select a profile and region.'}</div>;
  if (!identity) return <div className="empty" role="status">{error || (lang === 'ko' ? '계정 확인 중…' : 'Verifying account…')}</div>;
  return <Workspace key={`${profile}:${identity.account}:${region}:${generation}`} profile={profile} region={region} account={identity.account} />;
}
export function Workspace({ profile, region, account }: { profile: string; region: string; account: string }) {
  const lang = useLanguage(), t: Translate = (ko, en) => lang === 'ko' ? ko : en;
  const storageKey = selectionKey(profile, account, region);
  const [names, setNames] = useState<string[]>(() => { try { return readPipelineSelection(localStorage, storageKey); } catch { return []; } });
  const [saveError, setSaveError] = useState(false), [picker, setPicker] = useState(!names.length);
  const [selected, setSelected] = useState(names[0] ?? ''), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({}), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [page, setPage] = useState<PipelinePage>({ names: [] }), [listToken, setListToken] = useState<string>(), [listRevision, setListRevision] = useState(0);
  const [listError, setListError] = useState(''), [listBusy, setListBusy] = useState(false), [pickerQuery, setPickerQuery] = useState('');
  const changeNames = (next: string[]) => {
    setNames(next); setSelected(s => next.includes(s) ? s : next[0] ?? '');
    try { setSaveError(!savePipelineSelection(localStorage, storageKey, next)); } catch { setSaveError(true); }
  };
  useEffect(() => {
    if (!picker) return;
    const controller = new AbortController(); setListBusy(true); setListError('');
    api.pipelines(profile, region, listToken, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(p => ({ ...value, names: listToken ? [...new Set([...p.names, ...value.names])] : value.names }));
    }).catch(e => { if (!controller.signal.aborted) setListError(e.message); }).finally(() => { if (!controller.signal.aborted) setListBusy(false); });
    return () => controller.abort();
  }, [profile, region, picker, listToken, listRevision]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let running = false;
    const refresh = async () => {
      if (running || controller.signal.aborted || document.visibilityState === 'hidden') return;
      running = true; setBusy(true); let active = false;
      await pipelinePool(names, controller.signal, async name => {
        let history: PipelineHistory | undefined;
        try {
          history = await api.pipelineHistory(profile, region, name, undefined, controller.signal);
          const latest = history.executions[0];
          const detail = latest ? await api.pipelineDetail(profile, region, name, latest.id, controller.signal) : undefined;
          active ||= history.executions.some(e => pipelineRunning(e.status));
          if (!controller.signal.aborted) setSnapshots(previous => ({ ...previous, [name]: { history, detail, checkedAt: new Date().toISOString() } }));
        } catch (error) {
          if (!controller.signal.aborted) setSnapshots(previous => ({ ...previous, [name]: { ...previous[name], ...(history ? { history, detail: undefined } : {}), error: (error as Error).message } }));
        }
      });
      running = false;
      if (!controller.signal.aborted) { setBusy(false); if (names.length) timer = setTimeout(() => { void refresh(); }, active ? 15000 : 60000); }
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === 'visible') void refresh(); };
    void refresh(); document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [profile, region, names, revision]);
  const active = names.some(name => snapshots[name]?.history?.executions.some(e => pipelineRunning(e.status)));
  const visibleNames = names.filter(name => name.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || rowTone(snapshots[name]) === filter));
  const selectedSnapshot = snapshots[selected];
  return <section className="pipelines">
    <header className="pipeline-header"><div><h1>{t('배포 모니터링', 'Deployment monitoring')} <span className="pipeline-readonly">{t('조회 전용', 'Read only')}</span></h1><p>{t('여러 파이프라인의 진행 상황을 한눈에 확인하세요.', 'Follow your pipelines at a glance.')} <span>{profile} / {region}</span></p></div><div className="pipeline-controls"><span className="pipeline-live"><i />{active ? t('15초 자동 갱신', 'Refresh every 15s') : t('60초 자동 갱신', 'Refresh every 60s')}</span><button className="btn" disabled={busy} onClick={() => setRevision(v => v + 1)}><RefreshCw size={15} className={busy ? 'pipeline-spin' : ''} />{t('새로고침', 'Refresh')}</button></div></header>
    <div className="pipeline-summary" aria-label={t('상태 필터', 'Status filters')}>{(['all', 'running', 'failed', 'waiting', 'success', 'idle'] as const).map(tone => <button key={tone} className={tone === 'all' ? '' : `tone-${tone}`} aria-pressed={filter === tone} onClick={() => setFilter(tone)}>{tone !== 'all' && <StatusIcon tone={tone} />}{tone === 'all' ? t('전체', 'All') : statusText(tone, t)}<b>{tone === 'all' ? names.length : names.filter(name => rowTone(snapshots[name]) === tone).length}</b></button>)}</div>
    {saveError && <p className="pipeline-error" role="alert">{t('목록을 저장하지 못했습니다. 이 화면에서만 선택이 유지됩니다.', 'Could not save your selection. It is kept for this session only.')}</p>}
    <div className="pipeline-layout"><section className="pipeline-board"><div className="pipeline-toolbar"><label className="pipeline-search"><Search size={16} /><input aria-label={t('파이프라인 검색', 'Search pipelines')} placeholder={t('파이프라인 검색', 'Search pipelines')} value={query} onChange={e => setQuery(e.target.value)} /></label><span>{names.length}{t('개 선택', ' selected')}</span><button className="btn" aria-expanded={picker} onClick={() => setPicker(v => !v)}><Plus size={16} />{t('파이프라인 추가', 'Add pipelines')}</button></div>
    {picker && <section className="pipeline-picker" aria-label={t('파이프라인 선택', 'Select pipelines')}><div className="pipeline-controls"><strong>{t('볼 파이프라인을 선택하세요', 'Choose pipelines to monitor')}</strong><button className="btn" onClick={() => setPicker(false)}>{t('완료', 'Done')}</button></div><input aria-label={t('추가할 파이프라인 검색', 'Search available pipelines')} placeholder={t('이름으로 검색', 'Search by name')} value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} />
      <div className="pipeline-options">{[...new Set([...names, ...page.names])].filter(name => name.toLowerCase().includes(pickerQuery.toLowerCase())).map(name => <label key={name}><input type="checkbox" checked={names.includes(name)} onChange={e => changeNames(e.target.checked ? [...names, name] : names.filter(n => n !== name))} /><span>{name}</span></label>)}</div>
      {listError && <p role="alert" className="pipeline-error">{listError}</p>}{listBusy && <p role="status">{t('목록 조회 중…', 'Loading pipelines…')}</p>}{!listBusy && !listError && !page.names.length && <p>{t('이 리전에 파이프라인이 없습니다.', 'No pipelines in this region.')}</p>}
      <div className="pipeline-controls"><button className="btn" disabled={listBusy} onClick={() => { setListToken(undefined); setListRevision(v => v + 1); }}>{t('목록 새로고침', 'Refresh list')}</button>{page.nextToken && <button className="btn" disabled={listBusy} onClick={() => setListToken(page.nextToken)}>{t('목록 더 보기', 'More pipelines')}</button>}</div></section>}
    {!names.length && <div className="pipeline-empty"><GitCommitHorizontal size={32} /><h2>{t('함께 볼 파이프라인을 추가하세요', 'Add pipelines to your board')}</h2><p>{t('선택한 목록은 이 브라우저에 자동 저장됩니다.', 'Your selection is saved automatically in this browser.')}</p></div>}
    {!!names.length && !visibleNames.length && <p className="pipeline-empty">{t('조건에 맞는 파이프라인이 없습니다.', 'No pipelines match these filters.')}</p>}
    <div className="pipeline-rows">{visibleNames.map(name => {
      const snapshot = snapshots[name], latest = snapshot?.history?.executions[0], tone = rowTone(snapshot);
      return <div key={name} className={`pipeline-row ${selected === name ? 'is-selected' : ''} tone-${tone}`}><button className="pipeline-row-select" aria-pressed={selected === name} onClick={() => setSelected(name)}><span className="pipeline-name">{name}</span><span className="pipeline-row-meta"><StatusIcon tone={tone} />{snapshot?.error ? t('조회 오류', 'Read error') : latest?.status ?? (snapshot ? t('실행 기록 없음', 'No executions') : t('조회 대기', 'Pending'))}</span><small>{date(latest?.startedAt)}</small></button><div className="pipeline-row-flow">{snapshot?.error && <p className="pipeline-error" role="status">{snapshot.error}<small>{t('이전 결과일 수 있습니다.', 'Results may be stale.')}</small></p>}{snapshot?.detail && <Flow detail={snapshot.detail} t={t} />}{!snapshot && <span className="pipeline-muted">{t('조회 대기…', 'Waiting…')}</span>}</div><button className="pipeline-remove" aria-label={`${name} ${t('목록에서 제거', 'Remove from board')}`} title={t('목록에서 제거', 'Remove from board')} onClick={() => changeNames(names.filter(n => n !== name))}><X size={15} /></button></div>;
    })}</div><footer className="pipeline-legend">{(['success', 'running', 'failed', 'waiting', 'idle'] as const).map(tone => <span key={tone} className={`tone-${tone}`}><StatusIcon tone={tone} />{statusText(tone, t)}</span>)}</footer></section>
    <aside className="pipeline-inspector">{selected ? <Inspector key={selected} {...{ profile, region, name: selected, snapshot: selectedSnapshot, t }} /> : <div className="pipeline-empty">{t('파이프라인을 선택하면 실행 상세가 표시됩니다.', 'Select a pipeline to inspect its execution.')}</div>}</aside></div>
    <p className="pipeline-footnote">{t('선택 목록 자동 저장 · 프로필·계정·리전별 구분 · 화면이 보일 때만 갱신', 'Selection saved by profile, account and region · Refreshes while visible')}</p>
  </section>;
}

function Inspector({ profile, region, name, snapshot, t }: { profile: string; region: string; name: string; snapshot?: Snapshot; t: Translate }) {
  const [execution, setExecution] = useState(''), [past, setPast] = useState<PipelineDetail>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [older, setOlder] = useState<PipelineHistory>({ executions: [] }), [historyError, setHistoryError] = useState(''), [token, setToken] = useState<string>(), [historyBusy, setHistoryBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const latestId = snapshot?.history?.executions[0]?.id;
  const detail = execution ? past : snapshot?.detail;
  const recent = snapshot?.history?.executions ?? [];
  const history = [...recent, ...older.executions.filter(e => !recent.some(r => r.id === e.id))];
  useEffect(() => {
    if (!execution) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let running = false;
    const refresh = async () => {
      if (controller.signal.aborted || running || document.visibilityState === 'hidden') return;
      running = true;
      setBusy(true); setError('');
      try {
        const value = await api.pipelineDetail(profile, region, name, execution, controller.signal);
        if (!controller.signal.aborted) { setPast(value); if (pipelineRunning(value.status)) timer = setTimeout(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000); }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { running = false; if (!controller.signal.aborted) setBusy(false); }
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === 'visible') void refresh(); };
    void refresh(); document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [profile, region, name, execution, retry]);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController(); setHistoryBusy(true); setHistoryError('');
    api.pipelineHistory(profile, region, name, token, controller.signal).then(value => { if (!controller.signal.aborted) setOlder(previous => ({ ...value, executions: [...new Map([...previous.executions, ...value.executions].map(e => [e.id, e])).values()] })); }).catch(e => { if (!controller.signal.aborted) setHistoryError(e.message); }).finally(() => { if (!controller.signal.aborted) setHistoryBusy(false); });
    return () => controller.abort();
  }, [profile, region, name, token, retry]);
  const tone = detail ? actionTone(detail.status) : 'idle';
  const domain = region.startsWith('cn-') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';
  return <><header><h2>{name}</h2><span className={`pipeline-badge tone-${tone}`}><StatusIcon tone={tone} />{detail?.status ?? '—'}</span></header><code className="pipeline-execution-id">{execution || latestId || '—'}</code>
    {execution && <button className="btn" onClick={() => { setExecution(''); setPast(undefined); setError(''); }}>{t('최신 실행 보기', 'Follow latest execution')}</button>}
    {(error || snapshot?.error) && <p role="alert" className="pipeline-error">{error || snapshot?.error}</p>}{error && <button className="btn" onClick={() => setRetry(v => v + 1)}>{t('다시 시도', 'Retry')}</button>}
    {busy && <p role="status">{t('상세 조회 중…', 'Loading details…')}</p>}
    {detail && <><Flow detail={detail} t={t} /><h3>{t('액션 상세 · 실패 원인', 'Actions and failure reasons')}</h3><div className="pipeline-action-list">{detail.actions.map((a, i) => <article key={a.id ?? i} className={`pipeline-action tone-${actionTone(a.status, a.category === 'Approval')}`}><strong><StatusIcon tone={actionTone(a.status, a.category === 'Approval')} />{a.stage} / {a.name}</strong><small>{a.status} · {date(a.startedAt)} · {duration(a.startedAt, a.updatedAt)}</small>{a.error && <pre>{a.error}</pre>}{a.status === 'Failed' && !a.error && <p>{t('AWS가 실패 원인을 반환하지 않았습니다.', 'AWS did not return a failure reason.')}</p>}</article>)}</div><p className="pipeline-muted">{t('확인 시각', 'Checked at')}: {date(detail.checkedAt)}</p></>}
    <a className="pipeline-console" href={`https://${domain}/codesuite/codepipeline/pipelines/${encodeURIComponent(name)}/view?region=${encodeURIComponent(region)}`} target="_blank" rel="noreferrer">{t('AWS Console에서 보기', 'View in AWS Console')}<ExternalLink size={14} /></a>
    <h3>{t('최근 실행', 'Recent executions')}</h3><div className="pipeline-timeline">{history.map(e => <button key={e.id} className={`tone-${actionTone(e.status)}`} aria-pressed={(execution || latestId) === e.id} onClick={() => { const next = e.id === latestId ? '' : e.id; if (next !== execution) { setPast(undefined); setError(''); setExecution(next); } }}><StatusIcon tone={actionTone(e.status)} /><span><strong>{e.status}</strong><time>{date(e.startedAt)}</time><code>{e.id.slice(0, 8)}</code></span><small>{duration(e.startedAt, e.updatedAt)}</small></button>)}</div>
    {!history.length && snapshot?.history && <p>{t('실행 이력이 없습니다.', 'No executions.')}</p>}{historyError && <p role="alert" className="pipeline-error">{historyError}</p>}
    {(older.executions.length ? older.nextToken : snapshot?.history?.nextToken) && <button className="btn" disabled={historyBusy} onClick={() => { setToken(older.executions.length ? older.nextToken : snapshot?.history?.nextToken); setRetry(v => v + 1); }}>{historyBusy ? t('조회 중…', 'Loading…') : t('이력 더 보기', 'More history')}</button>}
  </>;
}
