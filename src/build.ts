import { expressionBlocks, extractRefs } from './expressions.js';
import type {
  CallRef, Edge, GNode, RawNode, RawWorkflow, Unresolved, WorkflowInfo, WorkflowResult,
} from './types.js';
import { redactString, rlValue, sha, shortType, stable, trunc, walkStrings } from './util.js';

const MAX_SNIPPETS = 3;
const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `L12: <the line>` for a reference at offset `at` of a code string. */
function codeSnippet(raw: string, at: number): string {
  const line = raw.slice(0, at).split('\n').length;
  const start = raw.lastIndexOf('\n', at - 1) + 1;
  let end = raw.indexOf('\n', at);
  if (end < 0) end = raw.length;
  return `L${line}: ${clip(raw.slice(start, end).trim())}`;
}

const CODE_KEYS = new Set(['jsCode', 'pythonCode', 'functionCode', 'code']);
const CODE_TYPES = new Set(['code', 'function', 'functionItem']);
const TRIGGER_NAMES = new Set(['webhook', 'manualTrigger', 'start', 'cron', 'interval']);

export function isTrigger(type: string): boolean {
  const t = shortType(type);
  return TRIGGER_NAMES.has(t) || /trigger$/i.test(t);
}

/** Output labels in output-index order. Single-output nodes yield ['main']. */
export function outputLabels(n: RawNode): string[] {
  const t = shortType(n.type);
  const p = (n.parameters ?? {}) as Record<string, any>;
  let out: string[];
  switch (t) {
    case 'if':
      out = ['true', 'false'];
      break;
    case 'splitInBatches':
      out = ['done', 'loop'];
      break;
    case 'compareDatasets':
      out = ['in A only', 'same', 'different', 'in B only'];
      break;
    case 'switch': {
      const rules: any[] = p.rules?.values ?? p.rules?.rules ?? [];
      if (p.mode === 'expression') {
        const k = Number(p.numberOutputs ?? 4);
        out = Array.from({ length: Number.isFinite(k) ? k : 4 }, (_, i) => `case ${i}`);
      } else {
        out = rules.map((r, i) => (typeof r?.outputKey === 'string' && r.outputKey ? r.outputKey : `case ${i}`));
        if (!out.length) out = ['case 0'];
      }
      if (p.options?.fallbackOutput === 'extra') out.push('fallback');
      break;
    }
    default:
      out = ['main'];
  }
  if (n.onError === 'continueErrorOutput') out.push('error');
  return out;
}

function summarize(n: RawNode): string {
  const t = shortType(n.type);
  const p = (n.parameters ?? {}) as Record<string, any>;
  const s = (v: unknown) => redactString(String(v ?? ''));
  let out: string;
  switch (t) {
    case 'webhook':
      out = `Webhook ${p.httpMethod ?? 'GET'} /${s(p.path)}${p.responseMode ? ` (${p.responseMode})` : ''}`;
      break;
    case 'httpRequest':
      out = `HTTP ${p.method ?? 'GET'} ${s(p.url)}`;
      break;
    case 'set': {
      const k = p.assignments?.assignments?.length ?? p.values?.string?.length ?? 0;
      out = `Set ${k} field(s)`;
      break;
    }
    case 'code': {
      const src = String(p.jsCode ?? p.pythonCode ?? '');
      out = `Code (${p.language ?? 'js'}, ${src ? src.split('\n').length : 0} lines)`;
      break;
    }
    case 'if':
      out = `IF ${p.conditions?.conditions?.length ?? ''} condition(s)`.replace('  ', ' ');
      break;
    case 'switch':
      out = `Switch (${outputLabels(n).length} outputs)`;
      break;
    case 'executeWorkflow':
    case 'toolWorkflow':
      out = `${t === 'toolWorkflow' ? 'Tool: ' : ''}Execute workflow ${rlValue(p.workflowId).value ?? rlValue(p.workflowId).name ?? '?'}`;
      break;
    case 'agent':
      out = 'AI Agent';
      break;
    case 'scheduleTrigger':
      out = 'Schedule trigger';
      break;
    default: {
      const bits = [p.resource, p.operation].filter((x) => typeof x === 'string');
      out = bits.length ? `${t}: ${bits.join(' ')}` : t;
    }
  }
  return trunc(out, 110);
}

function callRefs(n: RawNode): CallRef[] {
  const t = shortType(n.type);
  if (t !== 'executeWorkflow' && t !== 'toolWorkflow') return [];
  const p = (n.parameters ?? {}) as Record<string, any>;
  const source = String(p.source ?? 'database');
  if (source === 'parameter') return [{ via: t, external: 'embedded' }];
  if (source === 'url' || source === 'localFile') return [{ via: t, external: source }];
  const { value, name } = rlValue(p.workflowId);
  if (!value && !name) return [{ via: t, dynamic: true }];
  if (value?.startsWith('=')) return [{ via: t, dynamic: true }];
  return [{ via: t, targetId: value, targetName: name }];
}

const READ_OPS = new Set(['get', 'getAll', 'getMany', 'read', 'search', 'select', 'list', 'lookup', 'find']);
const WRITE_OPS = new Set([
  'append', 'appendOrUpdate', 'update', 'upsert', 'insert', 'delete', 'create', 'send', 'post', 'remove', 'clear', 'upload', 'replace',
]);
const RES_KEYS: Record<string, string> = {
  documentId: 'doc', spreadsheetId: 'doc', sheetName: 'sheet', table: 'table', tableId: 'table', schema: 'schema',
  channelId: 'channel', channel: 'channel', baseId: 'base', base: 'base', fileId: 'file', folderId: 'folder', databaseId: 'database',
};

function resources(n: RawNode): string[] {
  const p = (n.parameters ?? {}) as Record<string, unknown>;
  const t = shortType(n.type).replace(/Trigger$/, '');
  const out: string[] = [];
  for (const [k, kind] of Object.entries(RES_KEYS)) {
    const { value } = rlValue(p[k]);
    if (value && !value.startsWith('=')) out.push(`res:${t}:${kind}=${value}`);
  }
  return out;
}

function stripStickyTitle(content: string, x: number, y: number): string {
  const line = content.split('\n').map((l) => l.replace(/^[#*\s_>-]+|[*_\s]+$/g, '')).find(Boolean);
  return trunc(line || `group@${x},${y}`, 60);
}

export function buildWorkflow(raw: RawWorkflow, id: string, file?: string): WorkflowResult {
  const all = (raw.nodes ?? []).filter((n) => n && typeof n.name === 'string' && typeof n.type === 'string');
  const stickies = all.filter((n) => shortType(n.type) === 'stickyNote');
  const stickyNames = new Set(stickies.map((n) => n.name));
  const real = all.filter((n) => shortType(n.type) !== 'stickyNote');
  const byName = new Map(real.map((n) => [n.name, n]));
  const nid = (name: string) => `${id}::${name}`;

  // Groups from sticky-note rectangles (smallest containing sticky wins).
  const rects = stickies
    .filter((s) => Array.isArray(s.position))
    .map((s) => {
      const p = (s.parameters ?? {}) as Record<string, any>;
      const [x, y] = s.position as [number, number];
      const w = Number(p.width ?? 240);
      const h = Number(p.height ?? 160);
      return { x, y, w, h, name: stripStickyTitle(String(p.content ?? ''), x, y) };
    });
  const groups = new Map<string, string[]>();
  const groupOf = (n: RawNode): string | undefined => {
    if (!Array.isArray(n.position)) return undefined;
    const cx = n.position[0] + 50;
    const cy = n.position[1] + 50;
    const hit = rects
      .filter((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    return hit?.name;
  };

  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];
  const nodes: GNode[] = [];

  for (const n of real) {
    const outputs = outputLabels(n);
    const credentials = Object.entries(n.credentials ?? {}).map(([type, c]) => ({
      type, id: String(c?.id ?? c?.name ?? type), name: c?.name,
    }));
    const texts: string[] = [];
    walkStrings(n.parameters, (s) => texts.push(s));
    const p = (n.parameters ?? {}) as Record<string, any>;
    const t = shortType(n.type);
    const urls = t === 'httpRequest' && typeof p.url === 'string' ? [redactString(p.url)] : undefined;
    const group = groupOf(n);
    if (group) groups.set(group, [...(groups.get(group) ?? []), n.name]);
    const calls = callRefs(n);
    const node: GNode = {
      id: nid(n.name),
      wf: id,
      name: n.name,
      type: n.type,
      typeVersion: n.typeVersion,
      summary: summarize(n),
      disabled: n.disabled === true,
      trigger: isTrigger(n.type),
      outputs,
      credentials,
      group,
      hash: sha(stable({ t: n.type, v: n.typeVersion, p: n.parameters, c: credentials.map((c) => c.id), d: n.disabled, e: n.onError })),
      text: trunc(texts.join(' | '), 3000),
      onError: n.onError,
      httpUrls: urls,
      calls: calls.length ? calls : undefined,
    };
    if (t === 'webhook') {
      node.webhook = {
        path: String(p.path ?? '').replace(/^\/+|\/+$/g, ''),
        method: p.httpMethod ? String(p.httpMethod) : undefined,
        responseMode: p.responseMode ? String(p.responseMode) : undefined,
      };
    }
    nodes.push(node);

    for (const c of credentials) {
      edges.push({ from: node.id, to: `cred:${c.id}`, kind: 'uses', label: c.type, confidence: 'EXPLICIT' });
    }
    const op = typeof p.operation === 'string' ? p.operation : '';
    for (const r of resources(n)) {
      if (READ_OPS.has(op)) edges.push({ from: r, to: node.id, kind: 'reads_resource', label: op, confidence: 'INFERRED' });
      else if (WRITE_OPS.has(op)) edges.push({ from: node.id, to: r, kind: 'writes_resource', label: op, confidence: 'INFERRED' });
      else edges.push({ from: node.id, to: r, kind: 'uses_resource', label: op || undefined, confidence: 'INFERRED' });
    }
  }

  // Connections -> main / capability edges.
  const labelFor = (src: RawNode, oi: number): string | undefined => {
    const labels = outputLabels(src);
    if (labels.length > 1) return labels[oi] ?? `output ${oi}`;
    return oi > 0 ? `output ${oi}` : undefined;
  };
  for (const [srcName, byType] of Object.entries(raw.connections ?? {})) {
    if (stickyNames.has(srcName)) continue;
    for (const [ctype, outs] of Object.entries(byType ?? {})) {
      (outs ?? []).forEach((targets, oi) => {
        for (const t of targets ?? []) {
          if (!t?.node || stickyNames.has(t.node)) continue;
          const src = byName.get(srcName);
          if (!src || !byName.has(t.node)) {
            unresolved.push({ scope: 'local', wf: id, node: srcName, kind: 'dead-connection', detail: `${srcName} -> ${t.node}: node does not exist` });
            continue;
          }
          edges.push({
            from: nid(srcName),
            to: nid(t.node),
            kind: ctype === 'main' ? 'main' : 'capability',
            label: ctype === 'main' ? labelFor(src, oi) : ctype,
            confidence: 'EXPLICIT',
            outputIndex: oi,
            inputIndex: t.index ?? 0,
          });
        }
      });
    }
  }

  // Expression / code references -> reads edges (source -> reader).
  for (const n of real) {
    const isCodeNode = CODE_TYPES.has(shortType(n.type));
    const acc = new Map<string, { fields: Set<string>; params: Set<string>; snips: Map<string, { param: string; text: string }> }>();
    const inf = new Map<string, Set<string>>();
    const envs = new Set<string>();
    let dynamic = 0;
    walkStrings(n.parameters, (s, path, key) => {
      // Only {{ }} blocks are expressions; the rest of an "=" string is literal text
      // (e.g. an HTML page whose browser JS contains $('form')).
      const units: Array<{ body: string; snip: (at: number) => string }> = [];
      if (s.startsWith('=')) {
        for (const b of expressionBlocks(s)) {
          const whole = clip(s.slice(b.start, b.end).replace(/\s+/g, ' ').trim());
          units.push({ body: b.body, snip: () => whole });
        }
      } else if (isCodeNode && CODE_KEYS.has(key)) {
        units.push({ body: s, snip: (at) => codeSnippet(s, at) });
      }
      for (const u of units) {
        const ex = extractRefs(u.body);
        dynamic += ex.dynamic;
        ex.env.forEach((e) => envs.add(`res:env:${e}`));
        ex.vars.forEach((e) => envs.add(`res:var:${e}`));
        for (const name of ex.inferred) inf.set(name, new Set([...(inf.get(name) ?? []), path]));
        for (const r of ex.refs) {
          const a = acc.get(r.name) ?? { fields: new Set<string>(), params: new Set<string>(), snips: new Map() };
          r.fields.forEach((f) => a.fields.add(f));
          a.params.add(path);
          for (const at of r.at) {
            const text = u.snip(at);
            a.snips.set(`${path}\u0000${text}`, { param: path, text });
          }
          acc.set(r.name, a);
        }
      }
    });
    for (const [name, a] of acc) {
      if (name === n.name || stickyNames.has(name)) continue;
      if (!byName.has(name)) {
        unresolved.push({ scope: 'local', wf: id, node: n.name, kind: 'dead-ref', detail: `${n.name} reads "${name}", which does not exist` });
        continue;
      }
      edges.push({
        from: nid(name), to: nid(n.name), kind: 'reads', confidence: 'EXTRACTED',
        fields: [...a.fields].sort(), params: [...a.params].sort(),
        snippets: [...a.snips.values()].slice(0, MAX_SNIPPETS),
      });
    }
    // Names reached via a loop variable over a literal list: real dependencies, but only INFERRED.
    for (const [name, params] of inf) {
      if (acc.has(name) || name === n.name || stickyNames.has(name)) continue;
      if (!byName.has(name)) {
        unresolved.push({ scope: 'local', wf: id, node: n.name, kind: 'maybe-dead-ref', detail: `${n.name} may read "${name}" (from a literal list), which does not exist` });
        continue;
      }
      edges.push({ from: nid(name), to: nid(n.name), kind: 'reads', confidence: 'INFERRED', fields: [], params: [...params].sort() });
    }
    for (const e of envs) edges.push({ from: e, to: nid(n.name), kind: 'reads_resource', label: 'env', confidence: 'EXTRACTED' });
    if (dynamic) {
      unresolved.push({ scope: 'local', wf: id, node: n.name, kind: 'dynamic-ref', detail: `${n.name} has ${dynamic} node reference(s) with a computed name` });
    }
  }

  // Webhook -> Respond to Webhook (reachability over main).
  const out = new Map<string, string[]>();
  for (const e of edges) if (e.kind === 'main') out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  for (const w of nodes.filter((x) => x.webhook)) {
    const seen = new Set<string>([w.id]);
    const queue = [w.id];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const nx of out.get(cur) ?? []) if (!seen.has(nx)) { seen.add(nx); queue.push(nx); }
    }
    for (const nd of nodes) {
      if (seen.has(nd.id) && shortType(nd.type) === 'respondToWebhook') {
        edges.push({ from: w.id, to: nd.id, kind: 'responds_via', confidence: 'EXTRACTED' });
      }
    }
  }

  const errWf = raw.settings?.errorWorkflow;
  const info: WorkflowInfo = {
    id,
    name: raw.name || id,
    active: typeof raw.active === 'boolean' ? raw.active : undefined,
    updatedAt: raw.updatedAt,
    versionId: raw.versionId,
    tags: (raw.tags ?? []).map((t) => (typeof t === 'string' ? t : String(t?.name ?? ''))).filter(Boolean),
    file,
    errorWorkflow: errWf != null && String(errWf) && String(errWf) !== 'DEFAULT' ? String(errWf) : undefined,
    nodeCount: real.length,
    hash: sha(stable({ n: nodes.map((x) => x.hash).sort(), c: raw.connections ?? {} })),
    groups: [...groups].map(([name, ns]) => ({ name, nodes: ns })),
  };
  return { info, nodes, edges, unresolved };
}
