export type FilenexErrorCode = 'bad_request' | 'not_found' | 'forbidden' | 'conflict' | 'unprocessable';
/** Domain errors; the API maps `code` to HTTP. Messages are user-facing reasons. */
export class FilenexError extends Error {
  constructor(public readonly code: FilenexErrorCode, message: string) { super(message); }
}
