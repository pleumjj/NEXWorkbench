import { BadRequestException, Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { streamSse } from '@nex/telemetry-core';
import { DevnexService } from './devnex.service';
import { handle } from './http-errors';

const confirm = (body: { confirmed?: boolean } | undefined) => { if (body?.confirmed !== true) throw new BadRequestException('Confirmation required.'); };
const path = (body: { path?: string } | undefined) => { if (typeof body?.path !== 'string' || !body.path.trim()) throw new BadRequestException('path is required.'); return body.path.trim(); };

/** Routes only. Commands are never accepted from requests — only service ids defined by the project's own files. */
@Controller('devnex')
export class DevnexController {
  constructor(private readonly devnex: DevnexService) {}
  private get engine() { return this.devnex.engine; }

  @Get('overview') overview() { return handle(this.engine.overview()); }
  @Get('projects') projects() { return handle(this.engine.projects()); }
  @Get('projects/:id') project(@Param('id') id: string) { return handle(this.engine.projectDetail(id)); }
  @Get('ports') ports() { return handle(this.engine.ports()); }
  @Get('environment') environment() { return handle(this.engine.environment()); }
  @Get('registry') registry() { return this.engine.registry.get(); }

  /** AI Agent Monitor: sessions, servers they started, leftovers of ended sessions. Read-only. */
  @Get('agents') agents() { return handle(this.engine.agentOverview()); }
  /** Normal stop request to chosen leftovers of an ended agent session ({ confirmed: true, pids }). Re-checked; never forced. */
  @Post('agents/:id/cleanup') cleanupAgent(@Param('id') id: string, @Body() body: { confirmed?: boolean; pids?: unknown }) {
    confirm(body);
    return handle(this.engine.cleanupAgentSession(id, body.pids));
  }

  @Get('services/:id/logs') logs(@Param('id') id: string) { return handle(() => this.engine.logs(id)); }
  @Post('services/:id/logs/clear') clearLogs(@Param('id') id: string) { return handle(() => this.engine.clearLogs(id)); }
  @Post('services/:id/start') start(@Param('id') id: string) { return handle(this.engine.start(id)); }
  @Post('services/:id/stop') stop(@Param('id') id: string, @Body() body: { confirmed?: boolean }) { confirm(body); return handle(this.engine.stop(id)); }
  @Post('services/:id/restart') restart(@Param('id') id: string, @Body() body: { confirmed?: boolean }) { confirm(body); return handle(this.engine.restart(id)); }
  @Post('processes/:pid/stop') stopProcess(@Param('pid') pid: string, @Body() body: { confirmed?: boolean; name?: string }) {
    confirm(body);
    return handle(this.engine.stopProcess(Number(pid)).then(r => { if (!r.stillRunning) this.devnex.core.bus.publish('devnex.process.stopped', { pid: r.pid, name: typeof body.name === 'string' ? body.name.slice(0, 80) : undefined }); return r; }));
  }

  @Post('projects') addProject(@Body() body: { path?: string }) { return handle(this.engine.addProject(path(body))); }
  @Post('roots') addRoot(@Body() body: { path?: string }) { return handle(this.engine.addRoot(path(body))); }
  @Post('projects/:id/start') startProject(@Param('id') id: string) { return handle(this.engine.startProject(id)); }
  @Post('projects/:id/stop') stopProject(@Param('id') id: string, @Body() body: { confirmed?: boolean }) { confirm(body); return handle(this.engine.stopProject(id)); }
  @Post('projects/:id/restart') restartProject(@Param('id') id: string, @Body() body: { confirmed?: boolean }) { confirm(body); return handle(this.engine.restartProject(id)); }
  @Post('projects/:id/open-folder') openFolder(@Param('id') id: string) { return handle(this.engine.openFolder(id)); }
  @Post('projects/:id/remove') remove(@Param('id') id: string) { return handle(this.engine.removeProject(id)); }

  /** SSE: devnex.service.*, devnex.port.conflict, devnex.log, devnex.overview.updated, system.* */
  @Get('events') events(@Req() req: Request, @Res() res: Response) {
    const core = this.devnex.core;
    core.listeners++;
    req.on('close', () => { core.listeners--; });
    streamSse(req, res, core.bus, String(req.query.topics ?? 'devnex.*').split(',').filter(Boolean));
  }
}
