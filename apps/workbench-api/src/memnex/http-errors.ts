import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MemnexError } from '@nex/memnex';

/** Map domain error codes to HTTP; messages are already user-facing reasons (PRD §26). */
export function toHttp(e: unknown): never {
  if (e instanceof HttpException) throw e;
  if (e instanceof MemnexError) {
    const map = { bad_request: BadRequestException, not_found: NotFoundException, forbidden: ForbiddenException, conflict: ConflictException, unprocessable: UnprocessableEntityException };
    throw new map[e.code](e.message);
  }
  throw new UnprocessableEntityException(`Unsupported operation: ${(e as Error)?.message ?? e}`);
}
/** Accepts a promise or a thunk, so synchronous domain errors are mapped too (not a raw 500). */
export const handle = <T>(work: Promise<T> | (() => Promise<T> | T)) => Promise.resolve().then(() => (typeof work === 'function' ? work() : work)).catch(toHttp);
