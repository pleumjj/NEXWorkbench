import type { PlatformAdapter } from './platform.interface';
import { MacOSAdapter } from './macos/macos.adapter';
import { WindowsAdapter } from './windows/windows.adapter';

/** The single place that branches on the OS. */
export function createPlatform(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  if (platform === 'darwin') return new MacOSAdapter();
  if (platform === 'win32') return new WindowsAdapter();
  throw new Error('NEX Workbench supports macOS and Windows only.');
}
