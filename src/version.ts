import { readFileSync } from 'node:fs';

/** Single source of truth: package.json, which sits one level above dist/. */
export const VERSION: string = (() => {
  try {
    const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof p.version === 'string' ? p.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
