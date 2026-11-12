export type DevnexErrorCode = 'bad_request' | 'not_found' | 'forbidden' | 'conflict' | 'unprocessable';
/** Domain errors; the API maps `code` to HTTP. Messages are user-facing reasons. */
export class DevnexError extends Error {
  constructor(public readonly code: DevnexErrorCode, message: string) { super(message); }
}
