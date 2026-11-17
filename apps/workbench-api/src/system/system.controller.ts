import { Controller, Get } from '@nestjs/common';
import { exec } from '@nex/platform-core';
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

  /**
   * The operating system's preferred UI language (macOS: first of AppleLanguages, Windows/Linux: the user locale).
   * Used when the Workbench language is "Follow system". Read once and cached.
   */
  private locale: Promise<string> | null = null;
  @Get('locale') async osLocale() {
    this.locale ??= (async () => {
      if (process.platform === 'darwin') {
        try {
          const { stdout } = await exec('defaults', ['read', '-g', 'AppleLanguages'], { timeout: 3000 });
          const first = stdout.match(/"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?/g)?.map(x => x.replace(/"/g, '')).find(x => /^[a-z]{2}/i.test(x));
          if (first) return first;
        } catch { /* fall through */ }
      }
      return Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en';
    })();
    const locale = await this.locale;
    return { locale, language: /^th\b/i.test(locale) ? 'th' : 'en' };
  }
}
