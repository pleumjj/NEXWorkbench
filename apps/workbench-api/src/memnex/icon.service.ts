import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@nex/config';
import { MemnexService } from './memnex.service';

const SIZE = 128;

/** Real application icons, cached as PNG under .memnex/icons. Input is a pid; the path comes from the OS. */
@Injectable()
export class IconService {
  private readonly dir = join(dataDir('memnex'), 'icons');
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly missing = new Set<string>();

  constructor(private readonly memnex: MemnexService) {}

  async forPid(pid: number): Promise<string | null> {
    const command = await this.memnex.engine.commandOf(pid);
    const target = command ? this.memnex.platform.appPathOf(command) : null;
    if (!target || this.missing.has(target)) return null;
    const file = join(this.dir, `${createHash('sha1').update(target).digest('hex')}.png`);
    if (existsSync(file)) return file;
    if (!this.pending.has(target)) {
      mkdirSync(this.dir, { recursive: true });
      this.pending.set(target, this.memnex.platform.extractIcon(target, file, SIZE).catch(() => false)
        .then(ok => { if (!ok) this.missing.add(target); return ok ? file : null; })
        .finally(() => this.pending.delete(target)));
    }
    return this.pending.get(target)!;
  }
}
