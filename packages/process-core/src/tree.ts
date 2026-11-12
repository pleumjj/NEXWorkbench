import type { ProcessInfo } from '@nex/shared';

/** pid and all its ancestors (parent, grandparent…). Used to find the app a process runs inside. */
export function ancestorsOf(processes: ProcessInfo[], pid: number): Set<number> {
  const parent = new Map(processes.map(p => [p.pid, p.ppid]));
  const out = new Set<number>();
  for (let cur: number | undefined = pid, guard = 0; cur && cur > 1 && guard < 64; guard++) {
    out.add(cur);
    cur = parent.get(cur);
  }
  return out;
}

/** All descendants of pid (children, grandchildren…). */
export function descendantsOf(processes: ProcessInfo[], pid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of processes) if (p.ppid) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const out = new Set<number>();
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}
