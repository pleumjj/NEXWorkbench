import { Suspense } from 'react';
import { DevnexApp } from '../../modules/devnex/DevnexApp';
export const metadata = { title: 'DevNEX · NEX Workbench' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <Suspense><DevnexApp />{children}</Suspense>;
}
