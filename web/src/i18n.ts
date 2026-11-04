import { useSyncExternalStore } from 'react';
import { createTranslator, detectLanguage, intlLocale, isLanguage, type Language } from '@orrery/shared';

export const LANGUAGE_KEY = 'orrery.language';
const listeners = new Set<() => void>();
function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'ko';
  try { const saved = window.localStorage.getItem(LANGUAGE_KEY); if (isLanguage(saved)) return saved; } catch { /* Storage may be unavailable. */ }
  return detectLanguage(window.navigator.language);
}
let language = initialLanguage();
export const getLanguage = (): Language => language;
export const locale = (): string => intlLocale(language);
export const uiText = createTranslator(getLanguage);

export function setLanguage(value: Language): void {
  if (!isLanguage(value)) return;
  language = value;
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  try { if (typeof window !== 'undefined') window.localStorage.setItem(LANGUAGE_KEY, value); } catch { /* Keep the current session usable. */ }
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useLanguage = (): Language => useSyncExternalStore(subscribe, getLanguage, getLanguage);
if (typeof document !== 'undefined') document.documentElement.lang = language;
