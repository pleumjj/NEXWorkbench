import { BadRequestException, Body, Controller, Delete, Get, Header, Param, Post, Put, Query } from '@nestjs/common';
import type { DevSort } from '@nex/filenex';
import { FilenexService } from './filenex.service';
import { handle } from './http-errors';

const SORTS: DevSort[] = ['largest', 'recoverable', 'oldest-active', 'dependencies', 'build-cache', 'growth'];
const LARGE_SORTS = ['largest', 'oldest', 'newest', 'recent', 'location'] as const;

/**
 * /filenex/storage/* — Storage Intelligence. Routing and validation only.
 * Analyze first, delete deliberately: there is deliberately NO endpoint that deletes files, folders or Docker data.
 * Cleanup preview only lists exact paths; the user acts in Finder / Explorer / their tools.
 */
@Controller('filenex/storage')
export class FilenexStorageController {
  constructor(private readonly filenex: FilenexService) {}
  private get storage() { return this.filenex.engine.storage; }

  @Get('status') status() { return this.storage.status(); }
  @Get('overview') overview() { return handle(() => this.storage.overview()); }
  @Get('volumes') volumes() { return handle(() => this.storage.volumes()); }

  @Get('large-files') largeFiles(@Query('min') min?: string, @Query('sort') sort?: string) {
    const mb = min ? Number(min) : undefined;
    if (mb !== undefined && (!Number.isFinite(mb) || mb < 1 || mb > 1_000_000)) throw new BadRequestException('min is a size in MB.');
    if (sort && !LARGE_SORTS.includes(sort as typeof LARGE_SORTS[number])) throw new BadRequestException('Unknown sort.');
    return handle(() => this.storage.largeFiles(mb, (sort as typeof LARGE_SORTS[number]) || 'largest'));
  }

  @Get('growth') growth(@Query('days') days?: string) {
    const d = days ? Number(days) : 7;
    if (![7, 30].includes(d)) throw new BadRequestException('days is 7 or 30.');
    return handle(() => this.storage.growth(d));
  }

  @Get('developer') developer(@Query('q') q = '', @Query('sort') sort?: string) {
    if (q.length > 200) throw new BadRequestException('Query is too long.');
    if (sort && !SORTS.includes(sort as DevSort)) throw new BadRequestException('Unknown sort.');
    return handle(() => this.storage.developer(q, (sort as DevSort) || 'largest'));
  }
  @Get('developer/:projectId') developerDetail(@Param('projectId') id: string) { return handle(() => this.storage.developerDetail(id)); }

  @Get('cleanup-candidates') candidates() { return handle(() => this.storage.candidates()); }
  /** Suggested, explained cleanup plan (deterministic rules; suggestions only). */
  @Get('cleanup-plan') plan() { return handle(() => this.storage.cleanupPlan()); }

  /** Markdown report (download) for an assistant to continue the cleanup with the user. Read-only. */
  @Get('cleanup-report.md') @Header('Content-Type', 'text/markdown; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="filenex-cleanup-report.md"')
  report(@Query('ids') ids?: string, @Query('risk') risk?: string, @Query('project') project?: string) {
    if (risk && !['SAFE_TO_REVIEW', 'REVIEW_CAREFULLY'].includes(risk)) throw new BadRequestException('Unknown risk.');
    if (ids && ids.length > 20_000) throw new BadRequestException('Too many ids.');
    return handle(() => this.storage.cleanupReport({ ids: ids ? ids.split(',').filter(Boolean) : undefined, risk: risk || null, project: project || null }));
  }

  /** Preview only: lists exactly what a selection covers. Nothing is deleted. */
  @Post('cleanup-preview') preview(@Body() body: { ids?: unknown }) { return handle(() => this.storage.cleanupPreview(body?.ids)); }

  /** Open / reveal an item FileNEX found in an approved folder (validated server-side). */
  @Post('open') open(@Body() body: { path?: unknown }) { return handle(() => this.storage.open(body?.path)); }
  @Post('reveal') reveal(@Body() body: { path?: unknown }) { return handle(() => this.storage.reveal(body?.path)); }

  @Post('scan') scan(@Body() body: { force?: unknown }) { return handle(() => this.storage.scanAll(body?.force === true)); }
  @Post('pause') pause() { return this.storage.pause(); }
  @Post('resume') resume() { return this.storage.resume(); }

  @Get('settings') settings() { return this.storage.settings(); }
  @Put('settings') updateSettings(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Settings must be an object.');
    return this.storage.updateSettings(body);
  }
  /** Deletes FileNEX's storage history only (?confirmed=true; &includeAnalyses=true also drops cached analyses). Never touches files. */
  @Delete('history') clearHistory(@Query('confirmed') confirmed?: string, @Query('includeAnalyses') includeAnalyses?: string) {
    if (confirmed !== 'true') throw new BadRequestException('Confirmation required.');
    return this.storage.clearHistory(includeAnalyses === 'true');
  }
}
