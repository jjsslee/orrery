export function fmtNumber(v: number | null | undefined, unit?: string): string {
  if (v == null || Number.isNaN(v)) return '–';
  const u = (unit ?? '').toLowerCase();
  if (u === 'bytes' || u === 'byte') return fmtBytes(v);
  if (u === 'percent' || u === '%') return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
  if (u === 'seconds' || u === 's') return v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(0)} ms`;
  if (u === 'milliseconds' || u === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`;
  return compact(v);
}

export function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  if (Number.isInteger(v)) return String(v);
  return abs >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function fmtRelative(iso: string | number | undefined): string {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}일 전`;
  return new Date(t).toLocaleDateString('ko-KR');
}

export function fmtDateTime(iso: string | number | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Shows prop values; ISO dates become relative, booleans become 예/아니오 */
export function fmtProp(v: string | number | boolean | null): string {
  if (v === null || v === undefined || v === '') return '–';
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  if (typeof v === 'number') return v.toLocaleString('ko-KR');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const age = Date.now() - Date.parse(v);
    const withYear = age > 300 * 86_400_000;
    const d = new Date(v).toLocaleString('ko-KR', { year: withYear ? 'numeric' : undefined, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return age < 30 * 86_400_000 ? `${d} (${fmtRelative(v)})` : d;
  }
  return v;
}

export function maskAccount(id?: string): string {
  if (!id) return '';
  return id.replace(/^(\d{4})\d{4}(\d{4})$/, '$1····$2');
}
