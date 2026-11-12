/** Line icons, 1.75 stroke on a 24 grid (extracted from MemNEX; new ones follow the same rules). */
export const iconPaths = {
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  processes: 'M4 6h16M4 12h16M4 18h10',
  cleanup: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  chevron: 'M9 6l6 6-6 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17l9-10',
  // DevNEX
  folder: 'M3 7h7l2 2h9v10H3z',
  services: 'M5 5h14v5H5zM5 14h14v5H5zM8 7.5h.01M8 16.5h.01',
  ports: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3',
  logs: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  env: 'M14 7a4 4 0 1 1-3.5 5.9L4 19v-3h3v-3h3l.5-.5A4 4 0 0 1 14 7zM15 9h.01',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  branch: 'M6 4v12M18 8v3a4 4 0 0 1-4 4H6M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  container: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  // Workbench
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  memory: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  // FileNEX
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  disk: 'M4 5h16v14H4zM4 13h16M8 16.5h.01M12 16.5h4',
  // WorkNEX
  history: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v4.5h4.5M12 7.5V12l3 2',
  timeline: 'M5 6h6M5 12h10M5 18h4M15 6h4M17 12h2M11 18h8',
  layers: 'M12 4l8 4.5-8 4.5-8-4.5zM4 13l8 4.5 8-4.5',
  bookmark: 'M7 4h10v16l-5-3.5L7 20z',
  pause: 'M9 5v14M15 5v14',
  insights: 'M5 20V12M10 20V6M15 20v-9M20 20V9',
  where: 'M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10zM12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
} as const;
export type IconName = keyof typeof iconPaths;

export const Icon = ({ name, size = 18 }: { name: IconName; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={iconPaths[name]} />
  </svg>
);
