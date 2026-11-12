/**
 * Plain-language explanations for processes people don't recognise (Explain first, act second).
 * Local and static: no lookups leave the machine. Keys are lower-case process names.
 */
const EXACT: Record<string, string> = {
  // ── macOS system
  kernel_task: 'The macOS kernel. Also throttles the CPU when the Mac runs hot.',
  launchd: 'Starts and supervises every other process on the Mac.',
  windowserver: 'Draws everything on screen. Usage rises with displays, windows and animations.',
  loginwindow: 'Your login session. Quitting it logs you out.',
  dock: 'The Dock, Launchpad and Mission Control.',
  finder: 'The Finder.',
  systemuiserver: 'Menu bar items such as clock, Wi-Fi and volume.',
  controlcenter: 'Control Center and menu bar status icons.',
  mds: 'Spotlight’s index server. Busy after updates or when many files change.',
  mds_stores: 'Spotlight indexing your files. Temporary; settles once indexing finishes.',
  mdworker: 'Spotlight helper reading file contents for search.',
  mdworker_shared: 'Spotlight helper reading file contents for search.',
  corespotlightd: 'Indexes content from apps (mail, messages, notes) for Spotlight.',
  coreaudiod: 'The audio system. Needed for any sound.',
  bluetoothd: 'Bluetooth connections.',
  cfprefsd: 'Reads and writes app preferences.',
  distnoted: 'Delivers notifications between processes.',
  trustd: 'Checks certificates for secure connections.',
  syspolicyd: 'Gatekeeper: checks that apps are safe to open.',
  xprotectservice: 'Built-in malware scanning (XProtect).',
  nsurlsessiond: 'Background downloads and uploads for apps and iCloud.',
  cloudd: 'iCloud sync.',
  bird: 'iCloud Drive file sync.',
  fileproviderd: 'Cloud file providers (iCloud Drive, OneDrive, Dropbox, Google Drive).',
  photoanalysisd: 'Photos analysing faces and scenes. Runs mostly when the Mac is idle.',
  mediaanalysisd: 'Analyses photos and videos for search and Visual Look Up.',
  photolibraryd: 'Manages the Photos library.',
  softwareupdated: 'Checks for and installs macOS updates.',
  backupd: 'Time Machine backups.',
  suggestd: 'Siri Suggestions learning from mail, messages and apps.',
  sharingd: 'AirDrop, Handoff and Universal Clipboard.',
  rapportd: 'Lets your Apple devices find each other (Continuity).',
  windowmanager: 'Stage Manager and window tiling.',
  hidd: 'Keyboard, mouse and trackpad input.',
  powerd: 'Power management, sleep and battery.',
  opendirectoryd: 'User accounts and login.',
  // ── Windows system
  system: 'The Windows kernel and drivers.',
  'memory compression': 'Windows compressing memory to avoid using the page file.',
  registry: 'Holds the Windows registry in memory.',
  smss: 'Session Manager: starts the Windows session.',
  csrss: 'Core Windows subsystem. Ending it crashes Windows.',
  wininit: 'Starts core Windows services at boot.',
  winlogon: 'Sign-in, lock screen and Ctrl+Alt+Del.',
  services: 'Starts and stops Windows services.',
  lsass: 'Security: sign-in and credentials.',
  svchost: 'Hosts one or more Windows services. Many copies are normal.',
  explorer: 'The taskbar, Start menu and File Explorer.',
  dwm: 'Desktop Window Manager: draws windows and effects.',
  msmpeng: 'Microsoft Defender antivirus scanning.',
  searchindexer: 'Windows Search indexing your files.',
  runtimebroker: 'Manages permissions for Store apps.',
  wmiprvse: 'Answers system-information queries from apps and tools.',
  audiodg: 'Windows audio engine.',
  spoolsv: 'Print spooler.',
  // ── Common tools
  node: 'Node.js runtime: dev servers, build tools or editor extensions.',
  npm: 'npm: runs package scripts such as dev servers.',
  'next-server': 'Next.js development or production server.',
  postgres: 'PostgreSQL database server. Several processes per database are normal.',
  esbuild: 'Fast bundler used by build tools and dev servers.',
  zsh: 'A terminal shell session.',
  bash: 'A terminal shell session.',
  'com.docker.backend': 'Docker Desktop’s engine and Linux VM. Reserves memory for containers.',
};

const PATTERNS: [RegExp, string][] = [
  [/helper \(renderer\)/i, 'Renders a web page, tab or extension.'],
  [/helper \(gpu\)/i, 'Handles graphics and video decoding for the app.'],
  [/helper \(plugin\)/i, 'Runs extensions or plug-ins for the app.'],
  [/helper$/i, 'A background helper of its app.'],
  [/^com\.apple\./i, 'An Apple system service.'],
  [/^mdworker/i, 'Spotlight helper reading file contents for search.'],
  [/crashpad/i, 'Collects crash reports for its app.'],
  [/updater|update(r)?agent|softwareupdate/i, 'Checks for and installs updates for an app.'],
];

export function describe(name: string, command = ''): string | null {
  const n = name.toLowerCase().replace(/\.exe$/, '');
  if (EXACT[n]) return EXACT[n];
  for (const [re, text] of PATTERNS) if (re.test(name)) return text;
  if (/\.vscode\/extensions\//.test(command)) return 'A VS Code extension’s background process.';
  return null;
}
