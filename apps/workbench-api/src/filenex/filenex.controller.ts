import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import type { FileType } from '@nex/filenex';
import { FilenexService } from './filenex.service';
import { handle } from './http-errors';

const TYPES: FileType[] = ['presentation', 'spreadsheet', 'document', 'pdf', 'text', 'data', 'code', 'image', 'design', 'archive', 'video', 'audio', 'other'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getTime(); };

/** /filenex/* — routing and validation only. There are deliberately no delete/move/rename endpoints for files. */
@Controller('filenex')
export class FilenexController {
  constructor(private readonly filenex: FilenexService) {}
  private get engine() { return this.filenex.engine; }

  @Get('status') status() { return this.engine.status(); }

  @Get('search') search(@Query('q') q = '', @Query('type') type?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('location') location?: string, @Query('project') project?: string, @Query('context') context?: string) {
    if (q.length > 200) throw new BadRequestException('Query is too long.');
    if (type && !TYPES.includes(type as FileType)) throw new BadRequestException('Unknown file type.');
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw new BadRequestException('from/to must be YYYY-MM-DD.');
    return handle(() => this.engine.search(q, {
      type: (type as FileType) || null, modifiedFrom: from ? dayStart(from) : null, modifiedTo: to ? dayStart(to) + 86_400_000 : null,
      locationId: location || null, projectId: project || null, contextId: context || null,
    }));
  }

  @Get('recent') recent() { return this.engine.recentFiles(20); }
  @Get('recent-work') recentWork() { return handle(() => this.engine.recentWork()); }

  @Get('files/:id') file(@Param('id') id: string) { return handle(() => this.engine.fileDetail(id)); }
  @Get('files/:id/related') related(@Param('id') id: string) { return handle(() => this.engine.related(id)); }
  @Get('files/:id/versions') versions(@Param('id') id: string) { return handle(async () => (await this.engine.fileDetail(id)).versions); }
  @Post('files/:id/open') open(@Param('id') id: string) { return handle(() => this.engine.open(id)); }
  @Post('files/:id/reveal') reveal(@Param('id') id: string) { return handle(() => this.engine.reveal(id)); }

  @Get('versions') versionGroups() { return this.engine.versionGroups().slice(0, 300); }
  @Get('duplicates') duplicates() { return this.engine.duplicates().slice(0, 300); }

  @Get('collections') collections() { return handle(() => this.engine.collections()); }
  @Get('collections/:id') collection(@Param('id') id: string) { return handle(() => this.engine.collection(id)); }
  @Post('collections') createCollection(@Body() body: { name?: unknown }) { return handle(() => this.engine.createCollection(body?.name)); }
  @Delete('collections/:id') deleteCollection(@Param('id') id: string) { return handle(() => this.engine.deleteCollection(id)); }
  @Post('collections/:id/items') addItem(@Param('id') id: string, @Body() body: { fileId?: unknown }) {
    if (typeof body?.fileId !== 'string') throw new BadRequestException('fileId is required.');
    return handle(() => this.engine.addToCollection(id, body.fileId as string));
  }
  @Delete('collections/:id/items/:fileId') removeItem(@Param('id') id: string, @Param('fileId') fileId: string) { return handle(() => this.engine.removeFromCollection(id, fileId)); }

  /* ── The allowlist: no folder permission, no indexing ── */
  @Get('locations') locations() { return this.engine.status().locations; }
  @Post('locations') addLocation(@Body() body: { path?: unknown; confirmBroad?: unknown }) {
    return handle(() => this.engine.addLocation(body?.path, { confirmBroad: body?.confirmBroad === true }));
  }
  @Put('locations/:id') updateLocation(@Param('id') id: string, @Body() body: { paused?: unknown; label?: unknown; excludedFolders?: unknown }) {
    return handle(() => this.engine.updateLocation(id, body ?? {}));
  }
  /** Stops indexing now. The user must choose: ?deleteIndex=true (delete its FileNEX records) or false (keep). Files are never touched. */
  @Delete('locations/:id') removeLocation(@Param('id') id: string, @Query('deleteIndex') deleteIndex?: string) {
    if (deleteIndex !== 'true' && deleteIndex !== 'false') throw new BadRequestException('Choose whether to keep or delete this folder’s FileNEX index (deleteIndex=true|false).');
    return handle(() => this.engine.removeLocation(id, deleteIndex === 'true'));
  }
  @Post('locations/:id/scan') scanNow(@Param('id') id: string) { this.engine.enqueue(id); return { ok: true }; }
  /** Folder picker: sub-folder names only (nothing is indexed by browsing). */
  @Get('browse') browse(@Query('path') path?: string) { return handle(() => this.engine.browse(path)); }

  @Post('index/pause') pause() { return this.engine.pause(); }
  @Post('index/resume') resume() { return this.engine.resume(); }
  @Post('index/rebuild') rebuild(@Body() body: { confirmed?: unknown }) {
    if (body?.confirmed !== true) throw new BadRequestException('Confirmation required.');
    return this.engine.rebuild();
  }
  /** Deletes FileNEX's index only. ?confirmed=true required; &includeCollections=true also deletes collections. Real files are never touched. */
  @Delete('index') clear(@Query('confirmed') confirmed?: string, @Query('includeCollections') includeCollections?: string) {
    if (confirmed !== 'true') throw new BadRequestException('Confirmation required.');
    return this.engine.clearIndex(includeCollections === 'true');
  }

  @Get('settings') settings() { return this.engine.settings(); }
  @Put('settings') updateSettings(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Settings must be an object.');
    return this.engine.updateSettings(body);
  }
}
