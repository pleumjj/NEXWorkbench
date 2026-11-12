'use client';
import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

/** Light / Dark / System, remembered per browser (try/catch: storage may be unavailable). */
export function useTheme(storageKey: string) {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    try { const saved = localStorage.getItem(storageKey); if (saved === 'light' || saved === 'dark') setTheme(saved); } catch {}
  }, [storageKey]);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(storageKey, theme); } catch {}
  }, [theme, storageKey]);
  return [theme, setTheme] as const;
}

/** A clock that ticks every second, for "updated Ns ago". */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/** Auto-dismissing toast state. */
export function useToast<T extends { tone: 'ok' | 'error'; text: string }>(durationFor: (t: T) => number = () => 5000) {
  const [toast, setToast] = useState<T | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), durationFor(toast));
    return () => clearTimeout(t);
  }, [toast]); // eslint-disable-line react-hooks/exhaustive-deps
  return [toast, setToast] as const;
}
