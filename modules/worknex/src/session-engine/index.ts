import type { Insights, TimelineEntry, WhereWasI, WorkContext } from '../types';
import { isMeaningful, spanMs } from '../context-engine';

/**
 * Session engine: turns stored context spans into what people read — a timeline of work, sessions,
 * and a few descriptive facts. Deterministic and configurable; never a score.
 */

export type SessionOptions = {
  /** A different context shorter than this, between two spans of the same context, is a brief interruption, not a split. */
  mergeGapMs: number;
  /** Timeline entries shorter than this are folded into their neighbour as "brief". */
  minEntryMs: number;
  /** Gap with no observation longer than this ends a session. */
  idleGapMs: number;
};
export const DEFAULT_SESSION_OPTIONS: SessionOptions = { mergeGapMs: 3 * 60_000, minEntryMs: 60_000, idleGapMs: 10 * 60_000 };

const t = (iso: string) => new Date(iso).getTime();
const iso = (n: number) => new Date(n).toISOString();

/** Local calendar day "YYYY-MM-DD" of a timestamp (the user's day, not UTC). */
export const dayOf = (d: Date | string | number) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const dayBounds = (day: string): [number, number] => {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, new Date(y, m - 1, d + 1).getTime()];
};

/** True when the user has been away long enough to end what they were doing. */
export const isIdle = (idleMs: number | null, idleMinutes: number) => idleMs != null && idleMs >= idleMinutes * 60_000;

/**
 * Timeline for one day: contexts, not raw app events.
 * 1. Spans clipped to the day, sorted.  2. Consecutive spans of the same context merge when the gap is short.
 * 3. A short excursion (A · B(brief) · A) collapses into A with B noted as brief.  4. Tiny leftovers fold into a neighbour.
 */
export function buildTimeline(contexts: WorkContext[], day: string, opts: SessionOptions = DEFAULT_SESSION_OPTIONS): TimelineEntry[] {
  const [from, to] = dayBounds(day);
  type E = TimelineEntry & { s: number; e: number; active: boolean };
  const spans: E[] = contexts.flatMap(c => c.spans.map((sp, i) => {
    const s = Math.max(t(sp.start), from), e = Math.min(t(sp.end), to);
    const active = c.isActive && i === c.spans.length - 1;
    return { contextId: c.id, title: c.title, type: c.type, start: iso(s), end: active ? null : iso(e), brief: [], s, e, active };
  })).filter(x => x.e > x.s || (x.active && x.s < to && x.e >= from)).sort((a, b) => a.s - b.s);

  const out: E[] = [];
  for (const x of spans) {
    const last = out[out.length - 1];
    if (last && last.contextId === x.contextId && x.s - last.e <= opts.mergeGapMs) {
      last.e = Math.max(last.e, x.e); last.end = x.active ? null : iso(last.e); last.active = last.active || x.active;
      continue;
    }
    const prev = out[out.length - 2];
    if (last && prev && prev.contextId === x.contextId && last.e - last.s < opts.mergeGapMs && x.s - prev.e <= opts.mergeGapMs * 2) {
      prev.brief = [...new Set([...prev.brief, last.title])];
      prev.e = Math.max(prev.e, x.e); prev.end = x.active ? null : iso(prev.e); prev.active = x.active;
      out.pop();
      continue;
    }
    out.push({ ...x, brief: [] });
  }
  // Fold glances (< minEntry) into the entry before them, unless they are what's happening now.
  const folded: E[] = [];
  for (const x of out) {
    const last = folded[folded.length - 1];
    if (!x.active && x.e - x.s < opts.minEntryMs && last) { last.brief = [...new Set([...last.brief, x.title])]; continue; }
    folded.push(x);
  }
  return folded.map(({ s: _s, e: _e, active: _a, ...rest }) => rest);
}

/** Work sessions of a day: continuous stretches separated by idle gaps. */
export function buildSessions(contexts: WorkContext[], day: string, opts: SessionOptions = DEFAULT_SESSION_OPTIONS) {
  const [from, to] = dayBounds(day);
  const spans = contexts.flatMap(c => c.spans.map(sp => ({ id: c.id, s: Math.max(t(sp.start), from), e: Math.min(t(sp.end), to) }))).filter(x => x.e >= x.s && x.s < to).sort((a, b) => a.s - b.s);
  const sessions: { start: string; end: string; contextIds: string[] }[] = [];
  let cur: { s: number; e: number; ids: Set<string> } | null = null;
  for (const x of spans) {
    if (cur && x.s - cur.e <= opts.idleGapMs) { cur.e = Math.max(cur.e, x.e); cur.ids.add(x.id); continue; }
    if (cur) sessions.push({ start: iso(cur.s), end: iso(cur.e), contextIds: [...cur.ids] });
    cur = { s: x.s, e: x.e, ids: new Set([x.id]) };
  }
  if (cur) sessions.push({ start: iso(cur.s), end: iso(cur.e), contextIds: [...cur.ids] });
  return sessions;
}

/** "Where was I?" — the most recent meaningful context and why it stopped (only when the evidence is clear). */
export function whereWasI(contexts: WorkContext[]): WhereWasI {
  const c = [...contexts].filter(x => isMeaningful(x) && x.type !== 'meeting').sort((a, b) => t(b.lastActiveAt) - t(a.lastActiveAt))[0];
  if (!c) return null;
  const last = c.interruptions[c.interruptions.length - 1];
  const lastEnd = c.spans[c.spans.length - 1]?.end;
  const clear = !c.isActive && last && lastEnd && Math.abs(t(last.at) - t(lastEnd)) < 60_000;
  return {
    context: c,
    isActive: c.isActive,
    recentFile: c.files[0]?.name ?? null,
    related: c.urls.slice(0, 3).map(u => u.url),
    changedWhen: !clear ? null : last.kind === 'idle' ? 'You stepped away from the computer.' : `Context changed when ${last.by} became active.`,
  };
}

/** Descriptive facts about a day. No scores, no judgement. */
export function buildInsights(contexts: WorkContext[], day: string, opts: SessionOptions = DEFAULT_SESSION_OPTIONS): Insights {
  const entries = buildTimeline(contexts, day, opts);
  const now = Date.now();
  const len = (e: TimelineEntry) => (e.end ? t(e.end) : now) - t(e.start);
  const perContext = new Map<string, { title: string; ms: number }>();
  for (const e of entries) {
    const p = perContext.get(e.contextId) ?? { title: e.title, ms: 0 };
    p.ms += len(e);
    perContext.set(e.contextId, p);
  }
  const major = [...perContext.values()].filter(p => p.ms >= 5 * 60_000);
  const longest = entries.reduce<TimelineEntry | null>((m, e) => (!m || len(e) > len(m) ? e : m), null);
  const observations: string[] = [];
  // Frequent back-and-forth between the same two contexts within a half-day (purely descriptive).
  for (const [label, fromH, toH] of [['this morning', 0, 12], ['this afternoon', 12, 18], ['this evening', 18, 24]] as const) {
    const part = entries.filter(e => { const h = new Date(e.start).getHours(); return h >= fromH && h < toH; });
    const counts = new Map<string, number>();
    part.forEach(e => counts.set(e.title, (counts.get(e.title) ?? 0) + 1));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    if (top.length < 2) continue;
    let switches = 0;
    for (let i = 1; i < part.length; i++) if (top.includes(part[i].title) && top.includes(part[i - 1].title) && part[i].title !== part[i - 1].title) switches++;
    if (switches >= 4) observations.push(`You switched ${switches} times between ${top[0]} and ${top[1]} ${label}.`);
  }
  const meetings = entries.filter(e => e.type === 'meeting');
  if (meetings.length) observations.push(`${meetings.length} meeting-like context${meetings.length > 1 ? 's' : ''} (detected from meeting apps).`);
  return {
    day, majorContexts: major.length,
    longestSpanMinutes: longest ? Math.round(len(longest) / 60_000) : 0, longestSpanTitle: longest?.title ?? null,
    averageContextMinutes: major.length ? Math.round(major.reduce((n, p) => n + p.ms, 0) / major.length / 60_000) : 0,
    observations,
  };
}

/**
 * Retention: drop contexts last active before the cutoff, and glances (< 30 s) once they ended.
 * Saved contexts are kept (they are the user's explicit checkpoints).
 */
export function applyRetention(contexts: WorkContext[], retentionDays: number, now = Date.now()): WorkContext[] {
  const cutoff = now - retentionDays * 86_400_000;
  return contexts.filter(c => c.isSaved || (t(c.lastActiveAt) >= cutoff && (c.isActive || spanMs(c) >= 30_000)));
}

/* ───────────── Timesheet (your own summary, e.g. to fill in a Workforce/timesheet system) ───────────── */

export type TimesheetItem = { key: string; title: string; type: WorkContext['type']; projectPath: string | null; minutes: number; hours: number };
export type TimesheetDay = { day: string; items: TimesheetItem[]; totalMinutes: number; totalHours: number; itemsHours: number };

/** Round to the nearest half hour (2 h 14 m → 2.0, 2 h 15 m → 2.5), as timesheets are filled in 0.5 steps. */
export const roundHalfHour = (minutes: number) => Math.round(minutes / 30) / 2;

type Interval = [number, number];
const union = (xs: Interval[]): Interval[] => {
  const out: Interval[] = [];
  for (const [a, b] of [...xs].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
};
/** Length of [a,b] not covered by `cover` (sorted, disjoint). */
const uncovered = ([a, b]: Interval, cover: Interval[]) => {
  let len = b - a;
  for (const [c, d] of cover) len -= Math.max(0, Math.min(b, d) - Math.max(a, c));
  return Math.max(0, len);
};

/**
 * Minutes per work item per day, from tracked apps only (untracked apps, idle and paused time were never recorded).
 * Meetings win overlaps: while a call runs in the background, that time belongs to the meeting, not to the app in front —
 * nothing is counted twice. Items are grouped by context key (the same project across the day is one row).
 */
export function buildTimesheet(contexts: WorkContext[], days: string[], now = Date.now()): TimesheetDay[] {
  return days.map(day => {
    const [from, to] = dayBounds(day);
    const clip = (c: WorkContext): Interval[] => c.spans.map((sp, i) => {
      const end = c.isActive && i === c.spans.length - 1 ? Math.max(t(sp.end), now) : t(sp.end);
      return [Math.max(t(sp.start), from), Math.min(end, to)] as Interval;
    }).filter(([a, b]) => b > a);
    const meetings = union(contexts.filter(c => c.type === 'meeting').flatMap(clip));
    const byKey = new Map<string, TimesheetItem & { last: number }>();
    for (const c of contexts) {
      const spans = clip(c);
      if (!spans.length) continue;
      const ms = c.type === 'meeting' ? union(spans).reduce((n, [a, b]) => n + b - a, 0) : spans.reduce((n, sp) => n + uncovered(sp, meetings), 0);
      if (ms <= 0) continue;
      const cur = byKey.get(c.key);
      const last = t(c.lastActiveAt);
      if (cur) { cur.minutes += ms / 60_000; if (last > cur.last) { cur.title = c.title; cur.last = last; } }
      else byKey.set(c.key, { key: c.key, title: c.title, type: c.type, projectPath: c.projectPath ?? null, minutes: ms / 60_000, hours: 0, last });
    }
    const items = [...byKey.values()]
      .map(({ last: _l, ...i }) => ({ ...i, minutes: Math.round(i.minutes), hours: roundHalfHour(i.minutes) }))
      .filter(i => i.minutes >= 1)
      .sort((a, b) => b.minutes - a.minutes);
    const totalMinutes = items.reduce((n, i) => n + i.minutes, 0);
    return { day, items, totalMinutes, totalHours: roundHalfHour(totalMinutes), itemsHours: items.reduce((n, i) => n + i.hours, 0) };
  });
}

/** Days from `from` to `to` inclusive (local calendar days). */
export function dayRange(from: string, to: string, max = 62): string[] {
  const [y, m, d] = from.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const day = dayOf(new Date(y, m - 1, d + i));
    out.push(day);
    if (day >= to) break;
  }
  return out;
}

/** CSV for spreadsheets/timesheet tools: one row per day and work item. UTF-8 with BOM so Excel shows Thai correctly. */
export function timesheetCsv(days: TimesheetDay[]): string {
  const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Date', 'Work', 'Type', 'Project folder', 'Minutes', 'Hours (rounded 0.5)']];
  for (const d of days) for (const i of d.items) rows.push([d.day, i.title, i.type, i.projectPath ?? '', String(i.minutes), i.hours.toFixed(1)]);
  return '\ufeff' + rows.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
