export type WorknexErrorCode = 'bad_request' | 'not_found' | 'forbidden' | 'conflict' | 'unprocessable';
/** Domain errors; the API maps `code` to HTTP. Messages are user-facing reasons. */
export class WorknexError extends Error {
  constructor(public readonly code: WorknexErrorCode, message: string) { super(message); }
}
