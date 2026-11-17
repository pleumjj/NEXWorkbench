import * as D from 'react/jsx-dev-runtime';
import { localize } from './jsx-runtime';

export type { JSX } from 'react/jsx-dev-runtime';
export const Fragment = D.Fragment;
export function jsxDEV(type: any, props: any, key: any, isStatic: boolean, source?: any, self?: any) {
  return (D as any).jsxDEV(type, localize(type, props), key, isStatic, source, self);
}
