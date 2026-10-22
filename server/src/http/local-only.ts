/**
 * Orrery shows one person's AWS account on their own machine. Binding to
 * 127.0.0.1 keeps other machines out, but not other pages open in the same
 * browser, which can reach loopback too:
 * - DNS rebinding: attacker.example re-resolves to 127.0.0.1 and becomes
 *   "same origin"; its Host header still says attacker.example.
 * - Cross-site requests (fetch, <img>, forms, links): browsers label them with
 *   Sec-Fetch-Site, so other sites cannot even trigger a collection. Only the
 *   API is guarded this way; the page itself may be opened from a link.
 * The API sends no CORS headers, so no other origin can read a response.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Returns why the request is refused, or undefined when it may proceed. */
export function rejectNonLocal(url: string, headers: { host?: string; 'sec-fetch-site'?: string | string[] }): string | undefined {
  const host = (headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTS.has(host)) return `로컬 주소로만 접속할 수 있습니다 (Host: ${headers.host ?? '없음'})`;
  if (!url.startsWith('/api/')) return undefined;
  // Absent for non-browser clients (curl); 'none' is a URL typed into the address bar.
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return `다른 사이트에서 보낸 요청은 받지 않습니다 (${site})`;
  return undefined;
}
