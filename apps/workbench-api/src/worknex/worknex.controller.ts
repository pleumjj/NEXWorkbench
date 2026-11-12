import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WorknexService } from './worknex.service';
import { handle } from './http-errors';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kindOf = (k: string) => { if (k !== 'contexts' && k !== 'saved') throw new BadRequestException('Unknown source.'); return k === 'saved' ? 'saved' as const : 'context' as const; };
const strings = (v: unknown, name: string) => {
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string') || v.length > 100) throw new BadRequestException(`${name} must be a list of ids.`);
  return v as string[];
};
const optText = (v: unknown, name: string, max: number) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`${name} must be text up to ${max} characters.`);
  return v;
};

/** /worknex/* — routing and input validation only; behaviour lives in @nex/worknex. */
@Controller('worknex')
export class WorknexController {
  constructor(private readonly worknex: WorknexService) {}
  private get engine() { return this.worknex.engine; }

  @Get('status') status() { return this.engine.status(); }
  @Get('active-context') active() { return { context: this.engine.tracker.active() }; }
  /** Always a JSON body: { context: null } when there is no tracked work context yet (a bare null would be sent as an empty response). */
  @Get('where') where() { return handle(async () => (await this.engine.where()) ?? { context: null }); }
  @Get('recent') recent(@Query('limit') limit?: string) { return this.engine.recent(Math.min(50, Math.max(1, Number(limit) || 12))); }
  @Get('contexts') contexts() { return this.engine.recent(50); }
  @Get('contexts/:id') context(@Param('id') id: string) { return handle(() => this.engine.contextDetail(id)); }
  @Get('timeline') timeline(@Query('day') day?: string) {
    if (day && !DAY.test(day)) throw new BadRequestException('day must be YYYY-MM-DD.');
    return this.engine.timeline(day);
  }
  /** Daily/weekly summary for filling in a timesheet. ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: today). */
  @Get('timesheet') timesheet(@Query('from') from?: string, @Query('to') to?: string) {
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw new BadRequestException('from/to must be YYYY-MM-DD.');
    return handle(() => this.engine.timesheet(from, to ?? from));
  }
  /** Same data as CSV (UTF-8 with BOM, opens correctly in Excel). Generated on demand, never stored. */
  @Get('timesheet.csv') timesheetCsv(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @Res() res: Response) {
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw new BadRequestException('from/to must be YYYY-MM-DD.');
    const csv = this.engine.timesheetCsv(from, to ?? from);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="worknex-timesheet-${from ?? 'today'}${to && to !== from ? `-to-${to}` : ''}.csv"`);
    res.send(csv);
  }

  @Get('insights') insights(@Query('day') day?: string) {
    if (day && !DAY.test(day)) throw new BadRequestException('day must be YYYY-MM-DD.');
    return this.engine.insights(day);
  }

  @Post('contexts/:id/save') save(@Param('id') id: string, @Body() body: { label?: unknown; note?: unknown }) {
    return handle(() => this.engine.save(id, { label: optText(body?.label, 'label', 120), note: optText(body?.note, 'note', 1000) }));
  }
  @Get('saved') saved() { return this.engine.saved(); }
  @Delete('saved/:id') deleteSaved(@Param('id') id: string) { return handle(() => this.engine.deleteSaved(id)); }

  /** Resume is two steps: preview (what would open) → resume (only the ids the user kept). */
  @Post(':source/:id/resume-preview') preview(@Param('source') source: string, @Param('id') id: string) {
    return handle(() => this.engine.resumePreview(kindOf(source), id));
  }
  @Post(':source/:id/resume') resume(@Param('source') source: string, @Param('id') id: string, @Body() body: { itemIds?: unknown; confirmed?: unknown }) {
    if (body?.confirmed !== true) throw new BadRequestException('Confirmation required.');
    return handle(() => this.engine.resume(kindOf(source), id, strings(body.itemIds, 'itemIds')));
  }

  /* ── The allowlist: WorkNEX tracks only these apps ── */
  @Get('tracked-apps') trackedApps() { return this.engine.trackedApps(); }
  @Post('tracked-apps') addTracked(@Body() body: { applicationId?: unknown; displayName?: unknown; bundleId?: unknown; executable?: unknown }) {
    return handle(() => this.engine.addTrackedApp(body ?? {}));
  }
  @Get('tracked-apps/:id') trackedApp(@Param('id') id: string) { return handle(() => this.engine.trackedApp(id)); }
  @Put('tracked-apps/:id') updateTracked(@Param('id') id: string, @Body() body: { level?: unknown; url?: unknown; enabled?: unknown }) {
    if (body?.level !== undefined && ![1, 2, 3].includes(body.level as number)) throw new BadRequestException('level must be 1, 2 or 3.');
    return handle(() => this.engine.updateTrackedApp(id, body ?? {}));
  }
  /** Stop tracking now. The user must choose explicitly: ?deleteHistory=true (delete its WorkNEX history) or false (keep). */
  @Delete('tracked-apps/:id') removeTracked(@Param('id') id: string, @Query('deleteHistory') deleteHistory?: string) {
    if (deleteHistory !== 'true' && deleteHistory !== 'false') throw new BadRequestException('Choose whether to keep or delete this app’s WorkNEX history (deleteHistory=true|false).');
    return handle(() => this.engine.removeTrackedApp(id, deleteHistory === 'true'));
  }
  /** Apps the user can choose from. Discovery is not consent, and listing records nothing. */
  @Get('available-apps') available() { return handle(() => this.engine.availableApps()); }

  @Get('settings') settings() { return { settings: this.engine.settings(), rawInMemory: this.engine.rawCount(), sampleSeconds: this.engine.sampleMs / 1000 }; }
  @Put('settings') update(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Settings must be an object.');
    return this.engine.updateSettings(body);
  }
  @Post('pause') pause() { return this.engine.pause(); }
  @Post('resume-tracking') resumeTracking() { return this.engine.resumeTracking(); }

  /** Deletes WorkNEX history only. ?confirmed=true required; &includeSaved=true also removes save points. */
  @Delete('history') clear(@Query('confirmed') confirmed?: string, @Query('includeSaved') includeSaved?: string) {
    if (confirmed !== 'true') throw new BadRequestException('Confirmation required.');
    return this.engine.clearHistory(includeSaved === 'true');
  }
}
