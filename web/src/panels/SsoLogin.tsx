import { uiText, useLanguage } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { SsoLoginStatus } from '@orrery/shared';
import { api } from '../api/client';
import { useStore } from '../model/store';
import { SsoLoginFlow } from '../model/sso-login';

export function SsoLogin() {
  useLanguage();
  const profile = useStore((s) => s.profile);
  const method = useStore((s) => s.profiles.find((p) => p.name === s.profile)?.method);
  const generation = useStore((s) => s.connectionGeneration);
  const connectionError = useStore((s) => s.loading.error ?? s.statusError);
  const [required, setRequired] = useState(false);
  const [status, setStatus] = useState<SsoLoginStatus>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const flow = useRef(new SsoLoginFlow());
  const selection = useRef(0);

  useEffect(() => {
    selection.current++;
    flow.current.cancel();
    setStatus(undefined); setError(undefined); setStarting(false); setRequired(false);
    return () => { selection.current++; flow.current.cancel(); };
  }, [profile, method, generation]);

  useEffect(() => {
    if (method !== 'sso') return;
    const request = new AbortController();
    const selected = selection.current;
    void api.identity(profile, useStore.getState().region, request.signal).then(() => {
      if (!request.signal.aborted && selected === selection.current) setRequired(false);
    }).catch((err: Error & { status?: number }) => {
      if (!request.signal.aborted && selected === selection.current && err.status === 401) setRequired(true);
    });
    return () => request.abort();
  }, [profile, method, generation, connectionError]);

  if (method !== 'sso') return null;
  const pending = starting || status?.state === 'pending';
  const message = error ?? status?.message;
  const start = () => {
    if (pending) return;
    const selected = selection.current;
    const current = () => selected === selection.current && useStore.getState().profile === profile && useStore.getState().connectionGeneration === generation;
    if (!current()) return;
    setStarting(true); setError(undefined); setStatus(undefined); setRequired(true);
    void flow.current.start(profile, (value) => { if (current()) { setStarting(false); setStatus(value); } }, async () => {
      if (!current()) return;
      setRequired(false);
      await useStore.getState().reconnect();
    }, (message) => { if (current()) { setStarting(false); setError(message); } });
  };
  return <div className="sso-login">
    <button type="button" className="link-btn" onClick={start} disabled={pending}>{pending ? uiText('SSO 인증 중…') : uiText('SSO 로그인')}</button>
    {(required || message || pending) && <section className="sso-login-card" aria-label={uiText("SSO 로그인")} aria-live="polite">
      <strong>{profile} · {pending ? uiText('브라우저에서 로그인해 주세요') : uiText('SSO 인증 확인이 필요합니다')}</strong>
      <p>{message ?? (pending ? uiText('회사 계정 인증을 완료하면 자동으로 다시 연결합니다.') : uiText('로그인하면 기본 브라우저가 열립니다. 완료 후 자동으로 자원을 불러옵니다.'))}</p>
      <div className="sso-login-actions">
        {pending ? <button type="button" className="btn" onClick={() => { flow.current.cancel(); setStarting(false); setStatus(undefined); }}>{uiText("취소")}</button>
          : <><button type="button" className="btn" onClick={start}>{uiText("브라우저에서 로그인")}</button><button type="button" className="link-btn" onClick={() => { setRequired(false); setError(undefined); setStatus(undefined); }}>{uiText("닫기")}</button></>}
      </div>
    </section>}
  </div>;
}
