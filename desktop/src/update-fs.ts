import * as fs from 'node:fs';
import { createRequire } from 'node:module';

/** Update packages contain opaque .asar files, not Electron virtual directories.
 * Keep ASAR enabled for the running app; use native disk APIs only in the updater.
 */
export const updateFs: typeof fs = process.versions.electron ? createRequire(process.execPath)('original-fs') : fs;
