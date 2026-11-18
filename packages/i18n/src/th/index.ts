import { thCore } from './core';
import { thDevnex } from './devnex';
import { thWorknex } from './worknex';
import { thFilenexA } from './filenexA';
import { thFilenexB } from './filenexB';
import { thStorage } from './storage';
import { thCleanup } from './cleanup';
import { thAgents } from './agents';
import { thExtra } from './extra';

/** Thai dictionary: English source text → Thai. Later files win on duplicates; extra.ts holds the final choices. */
export const TH: Record<string, string> = { ...thCore, ...thDevnex, ...thWorknex, ...thFilenexA, ...thFilenexB, ...thStorage, ...thCleanup, ...thAgents, ...thExtra };
