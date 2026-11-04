import { ENGLISH } from './translations/en';

export type Language = 'ko' | 'en';
export const isLanguage = (value: unknown): value is Language => value === 'ko' || value === 'en';
export const detectLanguage = (value: string | undefined): Language => value?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
export const intlLocale = (language: Language): string => language === 'ko' ? 'ko-KR' : 'en-US';

export function normalizeMessage(message: string): string { return message.trim().replace(/\s+/g, ' '); }
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(ENGLISH).filter(([key]) => /\{\d+\}/.test(key)).sort(([a], [b]) => b.length - a.length).map(([key, english]) => ({
  // A time/count placeholder must be numeric: "최장 대기 시간" must never match "{0}시간".
  expression: new RegExp('^' + key.split(/(\{\d+\})/).map((part, index, parts) => /^\{\d+\}$/.test(part)
    ? /^(개|건|회|분|시간|일|페이지)/.test(parts[index + 1] ?? '') ? '([+-]?\\d+(?:[.,]\\d+)*)' : '([\\s\\S]*?)'
    : escapePattern(part)).join('') + '$'), english,
}));

/** Source-language keys keep protocol/property identifiers unchanged; only presentation calls translate. */
export function translate(language: Language, source: string | TemplateStringsArray, ...values: unknown[]): string {
  const key = typeof source === 'string' ? source : source.reduce((result, part, i) => result + (i ? `{${i - 1}}` : '') + part, '');
  const interpolate = (text: string, args: unknown[]) => text.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
  if (language === 'ko') return interpolate(key, values);
  const normalized = normalizeMessage(key);
  let english = Object.hasOwn(ENGLISH, normalized) ? ENGLISH[normalized] : undefined;
  let args = values;
  if (english === undefined && /[가-힣]/.test(normalized)) {
    for (const pattern of patterns) {
      const match = normalized.match(pattern.expression);
      if (match) { english = pattern.english; args = match.slice(1); break; }
    }
  }
  if (english === undefined) {
    if (normalized.includes(' · ') && /[가-힣]/.test(normalized)) return normalized.split(' · ').map((part) => translate(language, part)).join(' · ');
    return interpolate(key, values);
  }
  const leading = key.match(/^[ \t]+/)?.[0] ?? '', trailing = key.match(/[ \t]+$/)?.[0] ?? '';
  return leading + interpolate(english, args) + trailing;
}

export const createTranslator = (language: () => Language) => (source: string | TemplateStringsArray, ...values: unknown[]): string => translate(language(), source, ...values);
