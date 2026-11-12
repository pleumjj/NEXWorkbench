import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { streamSse } from '@nex/telemetry-core';
import { MemnexService } from './memnex.service';
import { IconService } from './icon.service';
import { handle } from './http-errors';

/** MemNEX routes (/api/memnex/*). Routing only — behaviour lives in @nex/memnex. */
@Controller('memnex')
export class MemnexController {
  constructor(private readonly memnex: MemnexService, private readonly icons: IconService) {}

  private get engine() { return this.memnex.engine; }

  @Get('snapshot') snapshot() { return handle(this.engine.snapshot()); }
  @Get('cleanup-preview') cleanupPreview() { return handle(this.engine.cleanupPreview()); }

  @Post('processes/:pid/:action') act(@Param('pid') pid: string, @Param('action') action: 'quit' | 'kill' | 'restart', @Body() body: { confirmed?: boolean }) {
    if (body?.confirmed !== true) throw new BadRequestException('Confirmation required.');
    return handle(this.engine.act(Number(pid), action).then(r => { if (!r.stillRunning && action !== 'restart') this.memnex.core.bus.publish('memnex.app.closed', { app: r.app }); return r; }));
  }

  @Post('apps/reopen') reopen(@Body() body: { appId?: string }) {
    if (typeof body?.appId !== 'string' || !body.appId) throw new BadRequestException('appId is required.');
    return handle(this.engine.reopen(body.appId));
  }

  @Post('cleanup') cleanup(@Body() body: { appIds?: string[]; shownIds?: string[]; confirmed?: boolean }) {
    if (body?.confirmed !== true) throw new BadRequestException('Confirmation required.');
    if (!Array.isArray(body.appIds) || !body.appIds.every(id => typeof id === 'string')) throw new BadRequestException('appIds must be a list of application ids.');
    const shown = Array.isArray(body.shownIds) ? body.shownIds.filter(id => typeof id === 'string') : [];
    return handle(this.engine.executeCleanup(body.appIds, shown).then(r => { this.memnex.core.bus.publish('memnex.cleanup.completed', r); return r; }));
  }

  @Get('icon/:pid') async icon(@Param('pid') pid: string, @Res() res: Response) {
    const file = await this.icons.forPid(Number(pid));
    if (!file) throw new NotFoundException('No icon for this application');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, { dotfiles: 'allow' });
  }

  @Get('settings') settings() { return this.engine.preferences.get(); }
  @Post('settings/protected') protect(@Body() body: { app?: string; protected?: boolean }) {
    if (typeof body?.app !== 'string' || !body.app) throw new BadRequestException('app is required.');
    return this.engine.preferences.setProtected(body.app, body.protected === true);
  }
  @Post('settings/suggest-again') suggestAgain(@Body() body: { app?: string }) {
    if (typeof body?.app !== 'string' || !body.app) throw new BadRequestException('app is required.');
    return this.engine.preferences.unmute(body.app);
  }
  @Get('history') history() { return this.engine.history.list(); }

  /** Live system metrics (SSE): system.memory.updated, system.cpu.updated, memnex.*. */
  @Get('events') events(@Req() req: Request, @Res() res: Response) {
    const core = this.memnex.core;
    core.listeners++;
    req.on('close', () => { core.listeners--; });
    streamSse(req, res, core.bus, String(req.query.topics ?? 'system.*,memnex.*').split(',').filter(Boolean));
  }
}
