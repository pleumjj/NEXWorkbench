import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { dataDir, workspaceRoot } from '@nex/config';
import { DevnexEngine, createDevnexModule } from '@nex/devnex';
import { CoreService } from '../core/core.service';
import { MemnexService } from '../memnex/memnex.service';

/** Wiring only — DevNEX behaviour lives in @nex/devnex. Shares the process inventory with MemNEX. */
@Injectable()
export class DevnexService implements OnModuleDestroy {
  readonly engine: DevnexEngine;
  readonly module;

  constructor(readonly core: CoreService, memnex: MemnexService) {
    this.engine = new DevnexEngine({
      platform: core.platform, system: core.system, dataDir: dataDir('devnex'), workspaceRoot: workspaceRoot(),
      // One protected-apps list for the whole Workbench (managed in MemNEX settings).
      isProtected: name => memnex.engine.preferences.isProtected(name),
      emit: (type, data) => {
        // Enrich service events with the service name for the activity log.
        const d = data as { serviceId?: string };
        const name = d?.serviceId ? (() => { try { return this.engine.logs(d.serviceId!).name; } catch { return undefined; } })() : undefined;
        core.bus.publish(type, name ? { ...d, name } : data);
      },
    });
    this.module = createDevnexModule(this.engine);
  }
  async onModuleDestroy() { await this.engine.shutdown(); }
}
