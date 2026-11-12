import { Controller, Get } from '@nestjs/common';
import { CoreService } from '../core/core.service';

/** /system/* — host metrics shared by every module (one reader, see CoreService). */
@Controller('system')
export class SystemController {
  constructor(private readonly core: CoreService) {}

  @Get('summary') async summary() {
    const s = await this.core.system.sample();
    const m = s.memory;
    return {
      host: s.host,
      memory: { total: m.total, used: m.used, available: m.available, percent: (m.used / m.total) * 100, pressure: m.pressure },
      swap: { ...m.swap, rate: s.swapRate },
      cpu: s.cpu,
      at: s.at,
    };
  }
}
