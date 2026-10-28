const KEY = 'orrery-api-token';

/** Fragment never reaches the HTTP server; erase it before rendering or making requests. */
export function acceptAuthFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>, storage: Pick<Storage, 'setItem'>): void {
  const token = new URLSearchParams(location.hash.slice(1)).get('orrery-token');
  if (token === null) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (/^[a-f0-9]{64}$/.test(token)) storage.setItem(KEY, token);
}

export function authHeaders(): Record<string, string> {
  const token = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}
