import { readFileSync } from 'node:fs';
import { buildWorkflow } from './build.js';
import { extractRefs } from './expressions.js';
import { G } from './graph.js';
import { extractWorkflows, loadFiles, N8nApi } from './source.js';
import { loadProfiles } from './store.js';
import type { Out, RawNode, RawWorkflow } from './types.js';
import { redactString } from './util.js';

/** Hard cap on what one call returns, whatever the request asks for. */
export const MAX_CHARS = 6000;
const DEFAULT_WIDTH = 240;
const MAX_LINE_SCAN = 5000;
const CODE_PARAMS = ['jsCode', 'pythonCode', 'functionCode', 'code'];

export interface ReadOpts {
  node: string;
  /** parameter to read (dot path); default: the node's code parameter */
  param?: string;
  /** "120-180", "120" or "120-" */
  lines?: string;
  grep?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  context?: number;
  max?: number;
  outline?: boolean;
  /** character window per line, "241-480" */
  cols?: string;
  /** folder or file of exported workflows to read the source from */
  from?: string;
  /** directory holding profiles.json (the graph's .flownav folder) */
  dir?: string;
}

/* ---------------- source ---------------- */

export async function loadRaw(g: G, wfId: string, o: { from?: string; dir?: string }): Promise<RawWorkflow> {
  const info = g.g.workflows[wfId];
  const pick = (wfs: RawWorkflow[]): RawWorkflow | undefined =>
    wfs.find((w) => w.id != null && String(w.id) === wfId) ??
    wfs.find((w) => w.name === info.name) ??
    (wfs.length === 1 ? wfs[0] : undefined);

  if (o.from) {
    const hit = pick(loadFiles(o.from).items.map((i) => i.raw));
    if (!hit) throw new Error(`Workflow "${info.name}" (${wfId}) was not found under ${o.from}.`);
    return hit;
  }
  if (g.g.source.type === 'files') {
    if (!info.file) throw new Error(`The graph does not record a source file for ${wfId}. Rebuild it, or pass a folder of exports.`);
    let wfs: RawWorkflow[];
    try {
      wfs = extractWorkflows(JSON.parse(readFileSync(info.file, 'utf8')));
    } catch {
      throw new Error(`Cannot read ${info.file}. Pass the folder of exports to read from.`);
    }
    const hit = pick(wfs);
    if (!hit) throw new Error(`Workflow "${info.name}" is not in ${info.file} any more.`);
    delete hit.pinData;
    return hit;
  }
  const profile = g.g.source.profile ? loadProfiles(o.dir)[g.g.source.profile] : undefined;
  const keyEnv = profile?.keyEnv ?? 'N8N_API_KEY';
  const key = process.env[keyEnv];
  if (!key) {
    throw new Error(
      `Reading code from the live instance needs the API key in the ${keyEnv} environment variable of this process (read-only GET). Set it, or read from exported files instead.`,
    );
  }
  const wf: RawWorkflow = await new N8nApi(g.g.source.ref, key).get(`/workflows/${encodeURIComponent(wfId)}`);
  delete wf.pinData;
  return wf;
}

/* ---------------- parameter + redaction ---------------- */

function getPath(obj: unknown, path: string): unknown {
  // accepts the paths this module prints, e.g. "assignments.assignments[0].value"
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce<any>((a, k) => (a == null ? undefined : a[k]), obj);
}

function textParams(v: unknown, prefix = '', out: Array<{ path: string; len: number }> = [], depth = 0) {
  if (depth > 8 || v == null) return out;
  if (typeof v === 'string') {
    if (v.length) out.push({ path: prefix, len: v.length });
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => textParams(x, `${prefix}[${i}]`, out, depth + 1));
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) textParams(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

function listText(node: RawNode): string {
  const rows = textParams(node.parameters).sort((a, b) => b.len - a.len).slice(0, 8);
  return rows.length ? `Text parameters: ${rows.map((r) => `${r.path} (${r.len.toLocaleString('en-US')} chars)`).join(', ')}.` : 'It has no text parameters.';
}

function pickParam(node: RawNode, wanted?: string): { name: string; text: string } {
  const p = (node.parameters ?? {}) as Record<string, unknown>;
  if (wanted) {
    const v = getPath(p, wanted);
    if (typeof v !== 'string') throw new Error(`Parameter "${wanted}" of ${node.name} is not text. ${listText(node)}`);
    return { name: wanted, text: v };
  }
  for (const k of CODE_PARAMS) if (typeof p[k] === 'string') return { name: k, text: p[k] as string };
  throw new Error(`${node.name} has no code parameter; pass param. ${listText(node)}`);
}

const KEYED = /((?:api[-_]?key|token|secret|passw(?:or)?d|authorization|private[-_]?key|client[-_]?secret)["']?\s*[:=]\s*)(["'`])([^"'`\n]{6,})\2/gi;

/** Best-effort redaction of a line of code: key-like assignments and known token shapes. */
export function redactCode(line: string): string {
  return redactString(line.replace(KEYED, (_m, pre: string, q: string) => `${pre}${q}[REDACTED]${q}`));
}

/* ---------------- formatting ---------------- */

function parseRange(s: string | undefined, what: string): [number, number | undefined] {
  const m = /^\s*(\d*)\s*(-?)\s*(\d*)\s*$/.exec(s ?? '');
  if (!s || !m || (!m[1] && !m[3])) throw new Error(`${what} must look like "120-180", "120" or "120-".`);
  const a = m[1] ? Number(m[1]) : 1;
  const b = m[2] ? (m[3] ? Number(m[3]) : undefined) : a;
  if (a < 1 || (b !== undefined && b < a)) throw new Error(`${what} "${s}" is not a valid range.`);
  return [a, b];
}

/** One line for display: windowed and marked when it is longer than the window. */
function show(line: string, cols: [number, number | undefined] | undefined, focus?: number): string {
  let start = 0;
  let end = line.length;
  if (cols) {
    start = cols[0] - 1;
    end = cols[1] ?? start + DEFAULT_WIDTH;
  } else if (line.length > DEFAULT_WIDTH) {
    start = focus != null && focus > DEFAULT_WIDTH - 40 ? Math.max(0, focus - 80) : 0;
    end = start + DEFAULT_WIDTH;
  }
  if (start >= line.length && line.length > 0) return `[line has ${line.length} chars; the window starts at column ${start + 1}]`;
  const body = line.slice(start, end);
  return `${start > 0 ? '…' : ''}${body}${end < line.length ? `… [+${(line.length - end).toLocaleString('en-US')} chars, ${line.length.toLocaleString('en-US')} total]` : ''}`;
}

const lineIndexOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

function outlineOf(text: string, lines: string[]): string[] {
  const out: string[] = [];
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  out.push(`longest line: ${longest.toLocaleString('en-US')} chars${longest > 1000 ? ' (minified or generated: use cols to read inside long lines)' : ''}`);

  const fns: string[] = [];
  lines.forEach((l, i) => {
    const m =
      /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l) ??
      /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(l) ??
      /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/.exec(l) ??
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(l);
    if (m) fns.push(`L${i + 1} ${m[1]}`);
  });
  out.push(fns.length ? `functions (${fns.length}): ${fns.slice(0, 30).join(', ')}${fns.length > 30 ? ', …' : ''}` : 'functions: none found');

  const ex = extractRefs(text);
  if (ex.refs.length || ex.inferred.length) {
    out.push('node references:');
    for (const r of ex.refs) {
      const ls = [...new Set(r.at.map((a) => lineIndexOf(text, a)))];
      out.push(`  ${r.name}  line${ls.length > 1 ? 's' : ''} ${ls.slice(0, 12).join(', ')}${ls.length > 12 ? ', …' : ''}${r.fields.length ? `  {${r.fields.join(', ')}}` : ''}`);
    }
    if (ex.inferred.length) out.push(`  via a literal name list (inferred): ${ex.inferred.join(', ')}`);
  } else {
    out.push('node references: none');
  }
  if (ex.dynamic) out.push(`computed-name references: ${ex.dynamic} (cannot be resolved statically)`);
  if (ex.env.length) out.push(`env vars: ${ex.env.join(', ')}`);
  if (ex.vars.length) out.push(`vars: ${ex.vars.join(', ')}`);
  return out;
}

/* ---------------- main ---------------- */

export async function readNode(g: G, o: ReadOpts): Promise<Out> {
  const modes = [o.lines != null, o.grep != null, o.outline === true].filter(Boolean).length;
  if (modes > 1) throw new Error('Give only one of: lines, grep, outline.');

  const { node: n, fuzzy } = g.resolveNodeEx(o.node);
  const wf = await loadRaw(g, n.wf, o);
  const notes: string[] = [];
  if (fuzzy) notes.push(`NOTE: "${fuzzy}" was only a partial name and matched just ${g.label(n.id)}. Confirm with the user that this is the node they mean before changing anything.`);
  if (buildWorkflow(wf, n.wf).info.hash !== g.g.workflows[n.wf].hash) {
    notes.push('WARNING: this workflow changed since the graph was built, so line numbers and references may not match the graph. Run flownav sync (or build) to refresh it. Showing the current source.');
  }
  const raw = wf.nodes?.find((x) => x.name === n.name);
  if (!raw) throw new Error(`Node "${n.name}" is no longer in the current source of ${g.wfName(n.wf)}. The graph is stale: run flownav sync (or build).`);

  const { name: param, text } = pickParam(raw, o.param);
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const safe = lines.map(redactCode);
  const cols = o.cols ? parseRange(o.cols, 'cols') : undefined;
  const head = `${g.label(n.id)} · ${param} · ${total.toLocaleString('en-US')} line(s), ${text.length.toLocaleString('en-US')} chars`;
  const out: string[] = [...notes, head];
  let used = out.join('\n').length;
  const data: Record<string, unknown> = { node: n.id, param, totalLines: total, chars: text.length };
  const push = (s: string): boolean => {
    if (used + s.length + 1 > MAX_CHARS) return false;
    out.push(s);
    used += s.length + 1;
    return true;
  };

  if (!text.length) {
    out.push('(empty)');
    return { text: out.join('\n'), data };
  }

  if (o.lines != null) {
    const [a, b] = parseRange(o.lines, 'lines');
    if (a > total) throw new Error(`lines "${o.lines}" starts past the end: ${param} has ${total} line(s).`);
    const end = Math.min(b ?? a + 59, total, a + 199);
    const w = String(end).length;
    let shown = a - 1;
    for (let i = a; i <= end; i++) {
      if (!push(`  ${String(i).padStart(w)}: ${show(safe[i - 1], cols)}`)) break;
      shown = i;
    }
    const next = shown < total ? `; next: lines ${shown + 1}-${Math.min(total, shown + 60)}` : ' (end)';
    out.push(`showing ${a}-${shown} of ${total}${shown < end ? ` (output capped at ${MAX_CHARS} chars)` : ''}${next}`);
    Object.assign(data, { mode: 'lines', from: a, to: shown });
    return { text: out.join('\n'), data };
  }

  if (o.grep != null) {
    const pattern = o.grep;
    if (!pattern) throw new Error('grep needs a pattern.');
    if (o.regex && pattern.length > 200) throw new Error('A regex pattern may be at most 200 characters.');
    let re: RegExp;
    try {
      re = new RegExp(o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.caseSensitive ? '' : 'i');
    } catch (e) {
      throw new Error(`Invalid regex: ${(e as Error).message}`);
    }
    const ctx = Math.min(Math.max(o.context ?? 2, 0), 10);
    const max = Math.min(Math.max(o.max ?? 20, 1), 100);
    const hits: Array<{ i: number; col: number }> = [];
    safe.forEach((l, i) => {
      const m = re.exec(l.slice(0, MAX_LINE_SCAN));
      if (m) hits.push({ i, col: m.index });
    });
    if (!hits.length) {
      out.push(`no match for ${o.regex ? 'regex ' : ''}"${pattern}"${o.caseSensitive ? '' : ' (case-insensitive)'}. Try a shorter pattern, regex=true, or outline.`);
      Object.assign(data, { mode: 'grep', matches: 0 });
      return { text: out.join('\n'), data };
    }
    const use = hits.slice(0, max);
    const focus = new Map(use.map((h) => [h.i, h.col]));
    const groups: Array<[number, number]> = [];
    for (const h of use) {
      const from = Math.max(0, h.i - ctx);
      const to = Math.min(total - 1, h.i + ctx);
      const last = groups[groups.length - 1];
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else groups.push([from, to]);
    }
    const w = String(total).length;
    let shownMatches = 0;
    let capped = false;
    outer: for (let gi = 0; gi < groups.length; gi++) {
      if (gi > 0 && !push('  --')) { capped = true; break; }
      for (let i = groups[gi][0]; i <= groups[gi][1]; i++) {
        const isHit = focus.has(i);
        if (!push(`${isHit ? '>' : ' '} ${String(i + 1).padStart(w)}: ${show(safe[i], cols, focus.get(i))}`)) { capped = true; break outer; }
        if (isHit) shownMatches++;
      }
    }
    out.push(`${shownMatches} of ${hits.length} matching line(s) shown${capped ? ` (output capped at ${MAX_CHARS} chars)` : ''}${hits.length > shownMatches ? '; narrow the pattern, raise max, or read a range with lines' : ''}`);
    Object.assign(data, { mode: 'grep', matches: hits.length, shown: shownMatches });
    return { text: out.join('\n'), data };
  }

  // default and explicit outline
  for (const l of outlineOf(text, lines)) if (!push(l)) break;
  out.push('next: grep for a name, or read a range with lines');
  Object.assign(data, { mode: 'outline' });
  return { text: out.join('\n'), data };
}
