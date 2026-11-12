import { Suspense } from 'react';
import { FilenexApp } from '../../modules/filenex/FilenexApp';
export const metadata = { title: 'FileNEX · NEX Workbench' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <Suspense><FilenexApp />{children}</Suspense>;
}
