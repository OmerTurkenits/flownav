export interface Ref {
  name: string;
  fields: string[];
}

export interface Extracted {
  refs: Ref[];
  /** node names reached through a variable that provably holds only literal names */
  inferred: string[];
  env: string[];
  vars: string[];
  dynamic: number;
}

const Q = String.raw`(['"\`])((?:\\.|(?!\1)[^\\])*)\1`;
const RE_PAREN = new RegExp(String.raw`\$\(\s*${Q}\s*\)`, 'g');
const RE_NODE = new RegExp(String.raw`\$node\s*\[\s*${Q}\s*\]`, 'g');
const RE_ITEMS = new RegExp(String.raw`\$items\(\s*${Q}`, 'g');
const RE_DYNAMIC = /\$\(\s*(?!['"`\s)])|\$node\s*\[\s*(?!['"`\s\]])|\$items\(\s*(?!['"`\s)])/g;
const RE_ENV = /\$env(?:\.([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
const RE_VARS = /\$vars(?:\.([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

const ACCESSOR = /^\s*\.(?:item|first\(\s*\)|last\(\s*\)|all\(\s*\)(?:\[[^\]]*\])?|itemMatching\([^)]*\))/;
const JSON_PATH = /^\s*\.json((?:\.[A-Za-z_$][\w$]*|\[\s*(?:'[^']*'|"[^"]*")\s*\])*)/;

function field(tail: string, needAccessor: boolean): string | undefined {
  let t = tail;
  const acc = ACCESSOR.exec(t);
  if (acc) t = t.slice(acc[0].length);
  else if (needAccessor) return undefined;
  const m = JSON_PATH.exec(t);
  if (!m || !m[1]) return undefined;
  const segs = m[1].match(/\.[A-Za-z_$][\w$]*|\[\s*(?:'[^']*'|"[^"]*")\s*\]/g) ?? [];
  return segs
    .slice(0, 3)
    .map((s) => (s.startsWith('.') ? s.slice(1) : s.replace(/^\[\s*['"]|['"]\s*\]$/g, '')))
    .join('.');
}

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

/** Text inside {{ ... }} blocks of an expression string. */
export function expressionBodies(s: string): string {
  const out: string[] = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  return out.join('\n');
}

// String literals worth keeping: the argument of $('X') / $items('X') / $node['X'] and ["field"] accesses.
const KEEP_BEFORE = /(?:\$\(|\$items\(|\$node\[|[\w$\])]\[)\s*$/;

/**
 * Blank out comments and string-literal contents so text such as an HTML page held in a
 * string (`"...$('form')..."`) is not mistaken for a node reference. Template-literal
 * `${...}` code is kept and scanned.
 */
export function stripLiterals(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      out += KEEP_BEFORE.test(out) ? src.slice(i, j + 1) : c + c;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let code = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth > 0) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') depth--;
            k++;
          }
          code += ` ${stripLiterals(src.slice(j + 2, k - 1))} `;
          j = k;
          continue;
        }
        j++;
      }
      out += KEEP_BEFORE.test(out) ? src.slice(i, j + 1) : '``' + code;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const STR = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Names in an array literal made only of string literals, else undefined. */
function literalList(arr: string): string[] | undefined {
  const names: string[] = [];
  const rest = arr.slice(1, -1).replace(STR, (_m, _q, body: string) => {
    names.push(unescape(body));
    return '';
  });
  return names.length && /^[\s,]*$/.test(rest) ? names : undefined;
}

/**
 * Best-effort: which literal names can `ident` hold in `$(ident)`?
 * Handles `for (const n of ['A','B'])`, `['A','B'].forEach(n => ...)`, the same with a
 * `const NAMES = [...]` variable, and `const n = 'A'`.
 */
export function resolveIdent(ident: string, src: string): string[] | undefined {
  const id = ident.replace(/\$/g, '\\$');
  const lists = new Map<string, string[]>();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\[[^[\]]*\])/g)) {
    const l = literalList(m[2]);
    if (l) lists.set(m[1], l);
  }
  const out = new Set<string>();
  const take = (a: string) => (a.startsWith('[') ? literalList(a) : lists.get(a))?.forEach((x) => out.add(x));
  const source = String.raw`(\[[^[\]]*\]|[A-Za-z_$][\w$]*)`;
  for (const m of src.matchAll(new RegExp(String.raw`for\s*\(\s*(?:const|let|var)\s+${id}\s+of\s+${source}`, 'g'))) take(m[1]);
  const iter = String.raw`\s*\.\s*(?:forEach|map|filter|flatMap|some|every|find)\s*\(\s*(?:async\s*)?\(?\s*${id}\b`;
  for (const m of src.matchAll(new RegExp(source + iter, 'g'))) take(m[1]);
  const assign = String.raw`(?:const|let|var)\s+${id}\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*[;\n]`;
  for (const m of src.matchAll(new RegExp(assign, 'g'))) out.add(unescape(m[2]));
  return out.size ? [...out] : undefined;
}

const RE_VARUSE = /\$(?:\(|items\()\s*([A-Za-z_$][\w$]*)\s*[,)]|\$node\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g;

export function extractRefs(raw: string): Extracted {
  const src = stripLiterals(raw);
  const byName = new Map<string, Set<string>>();
  const add = (name: string, f?: string) => {
    const set = byName.get(name) ?? new Set<string>();
    if (f) set.add(f);
    byName.set(name, set);
  };
  const scan = (re: RegExp, needAccessor: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      add(unescape(m[2]), field(src.slice(re.lastIndex, re.lastIndex + 240), needAccessor));
    }
  };
  scan(RE_PAREN, true);
  scan(RE_NODE, false);
  scan(RE_ITEMS, true);

  const names = (re: RegExp): string[] => {
    const set = new Set<string>();
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) set.add(m[1] ?? m[2]);
    return [...set];
  };
  RE_DYNAMIC.lastIndex = 0;
  const dynamicUses = (src.match(RE_DYNAMIC) ?? []).length;

  const inferred = new Set<string>();
  let resolved = 0;
  for (const m of src.matchAll(RE_VARUSE)) {
    const hit = resolveIdent(m[1] ?? m[2], raw);
    if (!hit) continue;
    resolved++;
    hit.forEach((n) => inferred.add(n));
  }

  return {
    refs: [...byName].map(([name, f]) => ({ name, fields: [...f].sort() })),
    inferred: [...inferred],
    env: names(RE_ENV),
    vars: names(RE_VARS),
    dynamic: Math.max(0, dynamicUses - resolved),
  };
}
