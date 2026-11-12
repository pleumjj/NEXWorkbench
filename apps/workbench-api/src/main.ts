import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { API_HOST, PORTS, checkLocalRequest, originsFor } from '@nex/config';
import { createLogger } from '@nex/logger';
import { AppModule } from './app.module';

const log = createLogger('workbench-api');

async function bootstrap() {
  const origins = originsFor(PORTS.web);
  const app = await NestFactory.create(AppModule, { cors: { origin: origins }, logger: ['error', 'warn'] });
  // Local-only guard: process control must never be reachable from another site or host (PRD §25).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const problem = checkLocalRequest({ host: req.headers.host, origin: req.headers.origin }, { origins, ports: [PORTS.api, PORTS.web] });
    if (problem) return res.status(403).json({ statusCode: 403, error: 'Forbidden', message: problem });
    next();
  });
  app.enableShutdownHooks();
  // Backstop: never hang on shutdown (a stuck keep-alive connection would block node --watch restarts forever).
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { setTimeout(() => process.exit(0), 3000).unref(); });
  await app.listen(PORTS.api, API_HOST);
  log.info(`NEX Workbench API listening at http://${API_HOST}:${PORTS.api} (internal — open http://localhost:${PORTS.web})`);
}
bootstrap().catch(e => {
  const busy = /EADDRINUSE/.test(String(e?.code ?? e?.message));
  log.error(busy ? `Port ${PORTS.api} is already in use. Is NEX Workbench already running? Set NEX_API_PORT to use another port.` : `API failed to start: ${e?.message ?? e}`);
  process.exit(1);
});
