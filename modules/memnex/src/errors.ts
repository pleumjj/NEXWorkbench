import { ActionError } from '@nex/platform-core';

/** Domain errors; the API layer maps `code` to an HTTP status. Messages are user-facing reasons. */
export type MemnexErrorCode = 'bad_request' | 'not_found' | 'forbidden' | 'conflict' | 'unprocessable';
export class MemnexError extends Error {
  constructor(public readonly code: MemnexErrorCode, message: string) { super(message); }
}

export function fromActionError(e: unknown): MemnexError {
  if (e instanceof MemnexError) return e;
  if (e instanceof ActionError) {
    const code = e.code === 'permission' ? 'forbidden' : e.code === 'gone' ? 'not_found' : e.code === 'refused' ? 'conflict' : 'unprocessable';
    return new MemnexError(code, e.message);
  }
  return new MemnexError('unprocessable', `Unsupported operation: ${(e as Error)?.message ?? e}`);
}
