import { Module } from '@nestjs/common';
import { CoreService } from './core/core.service';
import { SystemController } from './system/system.controller';
import { MemnexController } from './memnex/memnex.controller';
import { MemnexService } from './memnex/memnex.service';
import { IconService } from './memnex/icon.service';
import { DevnexController } from './devnex/devnex.controller';
import { DevnexService } from './devnex/devnex.service';
import { WorknexController } from './worknex/worknex.controller';
import { WorknexService } from './worknex/worknex.service';
import { FilenexController } from './filenex/filenex.controller';
import { FilenexStorageController } from './filenex/storage.controller';
import { FilenexService } from './filenex/filenex.service';
import { WorkbenchController } from './workbench/workbench.controller';
import { WorkbenchService } from './workbench/workbench.service';

/**
 * One local API for the whole Workbench:
 *   /system/*     shared host metrics
 *   /memnex/*     MemNEX
 *   /devnex/*     DevNEX
 *   /worknex/*    WorkNEX
 *   /filenex/*    FileNEX (incl. /filenex/storage/* — Storage Intelligence)
 *   /workbench/*  aggregation (status, attention, continue working, activity, commands)
 * The web app on :3900 proxies /api/* here, so the browser only ever talks to localhost:3900.
 */
@Module({
  controllers: [SystemController, MemnexController, DevnexController, WorknexController, FilenexStorageController, FilenexController, WorkbenchController],
  providers: [CoreService, MemnexService, IconService, DevnexService, WorknexService, FilenexService, WorkbenchService],
})
export class AppModule {}
