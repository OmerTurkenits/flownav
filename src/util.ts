import { createHash } from 'node:crypto';

export const shortType = (t: string): string => t.split('.').pop() ?? t;

export const sha = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

/** Value of a plain string/number or an n8n resource locator ({__rl, value, cachedResultName}). */
export function rlValue(v: unknown): { value?: string; name?: string } {
  if (v == null) return {};
  if (typeof v === 'string' || typeof v === 'number') return { value: String(v) };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return {
      value: o.value != null && o.value !== '' ? String(o.value) : undefined,
      name: typeof o.cachedResultName === 'string' ? o.cachedResultName : undefined,
    };
  }
  return {};
}

const SECRET_KEY = /(api[-_]?key|token|secret|passw(or)?d|authorization|bearer|private[-_]?key)/i;
const SECRET_VAL: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VAL) out = out.replace(re, '[REDACTED]');
  return out;
}

/**
 * Visit every string leaf. Values are redacted before the callback sees them:
 * secrets by key name (unless the value is an expression) and by known token shapes.
 */
export function walkStrings(
  v: unknown,
  cb: (s: string, path: string, key: string) => void,
  path = '',
  key = '',
  depth = 0,
): void {
  if (depth > 14 || v == null) return;
  if (typeof v === 'string') {
    if (!v) return;
    const secret = SECRET_KEY.test(key) && !v.startsWith('=');
    cb(secret ? '[REDACTED]' : redactString(v), path, key);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walkStrings(x, cb, `${path}[${i}]`, key, depth + 1));
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      walkStrings(x, cb, path ? `${path}.${k}` : k, k, depth + 1);
    }
  }
}

export const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
