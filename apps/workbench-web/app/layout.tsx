import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@nex/ui/styles.css';
import { WorkbenchShell } from '../shell/WorkbenchShell';

// Bundled with the app (SIL OFL): no font request ever leaves the machine, so the UI works fully offline.
const sans = localFont({ src: './fonts/SchibstedGrotesk-latin.woff2', weight: '400 900', variable: '--font-sans', display: 'swap' });
// Thai glyphs only (IBM Plex Sans Thai, SIL OFL — see fonts/IBMPlexSansThai-OFL.txt); Latin text keeps Schibsted Grotesk.
const thai = localFont({
  src: [
    { path: './fonts/IBMPlexSansThai-thai-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexSansThai-thai-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexSansThai-thai-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/IBMPlexSansThai-thai-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-thai', display: 'swap', preload: false,
});

export const metadata: Metadata = {
  title: 'NEX Workbench',
  description: 'Local tools. Local data. Local control.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${thai.variable}`} suppressHydrationWarning>
      <body><WorkbenchShell>{children}</WorkbenchShell></body>
    </html>
  );
}
