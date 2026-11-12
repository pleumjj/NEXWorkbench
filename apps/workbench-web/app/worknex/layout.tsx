import { Suspense } from 'react';
import { WorknexApp } from '../../modules/worknex/WorknexApp';
export const metadata = { title: 'WorkNEX · NEX Workbench' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <Suspense><WorknexApp />{children}</Suspense>;
}
