import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { dataDir, workspaceRoot } from '@nex/config';
import { MemnexEngine, createMemnexModule } from '@nex/memnex';
import { every } from '@nex/telemetry-core';
import { CoreService } from '../core/core.service';

/** Wiring only — MemNEX behaviour lives in @nex/memnex. */
@Injectable()
export class MemnexService implements OnModuleInit, OnModuleDestroy {
  readonly engine: MemnexEngine;
  readonly module;
  private stopTicker: (() => void) | null = null;
  private lastState: string | null = null;

  constructor(readonly core: CoreService) {
    this.engine = new MemnexEngine({ platform: core.platform, system: core.system, dataDir: dataDir('memnex'), workspaceRoot: workspaceRoot() });
    this.module = createMemnexModule(this.engine);
  }
  get platform() { return this.core.platform; }

  onModuleInit() {
    this.engine.start();
    // System metrics every 3 s, only while a client listens over SSE.
    this.stopTicker = every(3000, async () => {
      if (!this.core.listeners) return;
      const s = await this.engine.snapshot();
      this.core.bus.publish('system.memory.updated', { ...s.memory, swap: s.swap });
      this.core.bus.publish('system.cpu.updated', s.cpu);
      if (s.memory.state !== this.lastState && (s.memory.state === 'High' || s.memory.state === 'Critical')) this.core.bus.publish('memnex.memory.high', { state: s.memory.state, headline: s.insight.headline });
      this.lastState = s.memory.state;
    });
  }
  onModuleDestroy() { this.stopTicker?.(); this.engine.stop(); }
}
