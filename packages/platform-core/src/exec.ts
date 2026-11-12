import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** execFile without a shell — arguments are never interpreted by a shell. */
export const exec = promisify(execFile);
export const BIG = { maxBuffer: 16 * 1024 * 1024 };
