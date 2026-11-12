import { Suspense } from 'react';
import { MemnexApp } from '../../modules/memnex/MemnexApp';
export const metadata = { title: 'MemNEX · NEX Workbench' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <Suspense><MemnexApp />{children}</Suspense>;
}
