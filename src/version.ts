import { createRequire } from 'node:module';

/** Read from package.json (one level above dist/) so it never drifts from the published version. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
