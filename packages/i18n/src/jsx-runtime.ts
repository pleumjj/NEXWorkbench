/**
 * JSX runtime with UI translation (jsxImportSource for the web app). In English it is React's runtime unchanged.
 * In Thai, string children and a few text attributes of host elements go through `translate()`.
 * Skipped: translate="no", .mono / .path elements, <code>, <kbd>, <pre>, <script>, <style> — user data and commands.
 */
import * as R from 'react/jsx-runtime';
import { getLanguage, translate } from './index';

export type { JSX } from 'react/jsx-runtime';
export const Fragment = R.Fragment;
const SKIP_TAGS = new Set(['code', 'kbd', 'pre', 'script', 'style', 'samp']);
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'] as const;

const tr = (c: unknown): unknown => (typeof c === 'string' ? translate(c) : Array.isArray(c) ? c.map(tr) : c);

export function localize(type: unknown, props: any): any {
  if (getLanguage() === 'en' || !props) return props;
  // Components (e.g. next/link, compiled outside this runtime): translate plain string children only.
  if (typeof type !== 'string') {
    if (type === R.Fragment || props.translate === 'no' || props.children === undefined) return props;
    const c = typeof props.children === 'string' || Array.isArray(props.children) ? tr(props.children) : props.children;
    return c === props.children ? props : { ...props, children: c };
  }
  if (SKIP_TAGS.has(type) || props.translate === 'no' || (typeof props.className === 'string' && /(^|\s)(mono|path|no-tr)(\s|$)/.test(props.className))) return props;
  let out = props;
  const set = (k: string, v: unknown) => { if (out === props) out = { ...props }; out[k] = v; };
  if (props.children !== undefined) { const c = tr(props.children); if (c !== props.children) set('children', c); }
  for (const a of ATTRS) if (typeof props[a] === 'string') { const v = translate(props[a]); if (v !== props[a]) set(a, v); }
  return out;
}

export function jsx(type: any, props: any, key?: any) { return R.jsx(type, localize(type, props), key); }
export function jsxs(type: any, props: any, key?: any) { return R.jsxs(type, localize(type, props), key); }
