import { BadRequestException, Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { streamSse } from '@nex/telemetry-core';
import { CoreService } from '../core/core.service';
import { WorkbenchService } from './workbench.service';

/** /workbench/* — what the Home page, sidebar badges and command palette read. */
@Controller('workbench')
export class WorkbenchController {
  constructor(private readonly workbench: WorkbenchService, private readonly core: CoreService) {}

  @Get('summary') summary() { return this.workbench.summary(); }
  @Get('commands') commands() { return this.workbench.commands(); }
  @Get('activity') activity() { return this.core.activity.toArray().reverse(); }
  @Get('settings') settings() { return this.workbench.settings(); }

  @Post('settings') update(@Body() body: { disabledModules?: unknown; refresh?: unknown }) {
    if (body?.disabledModules !== undefined && !(Array.isArray(body.disabledModules) && body.disabledModules.every(x => typeof x === 'string'))) {
      throw new BadRequestException('disabledModules must be a list of module ids.');
    }
    if (body?.refresh !== undefined && body.refresh !== 'normal' && body.refresh !== 'relaxed') throw new BadRequestException('refresh must be "normal" or "relaxed".');
    return this.workbench.updatePreferences(body as { disabledModules?: string[]; refresh?: 'normal' | 'relaxed' });
  }

  /** SSE for any topics, e.g. ?topics=system.*,devnex.service.* */
  @Get('events') events(@Req() req: Request, @Res() res: Response) {
    this.core.listeners++;
    req.on('close', () => { this.core.listeners--; });
    streamSse(req, res, this.core.bus, String(req.query.topics ?? '').split(',').filter(Boolean));
  }
}
