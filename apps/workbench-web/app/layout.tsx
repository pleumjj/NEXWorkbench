import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@nex/ui/styles.css';
import { WorkbenchShell } from '../shell/WorkbenchShell';

// Bundled with the app (SIL OFL): no font request ever leaves the machine, so the UI works fully offline.
const sans = localFont({ src: './fonts/SchibstedGrotesk-latin.woff2', weight: '400 900', variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: 'NEX Workbench',
  description: 'Local tools. Local data. Local control.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <body><WorkbenchShell>{children}</WorkbenchShell></body>
    </html>
  );
}
