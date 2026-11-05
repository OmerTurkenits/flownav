import { G, edgeTag } from './graph.js';
import { pickWorkflows } from './overview.js';
import { FLOW_KINDS } from './types.js';
import type { Edge, EdgeKind, GNode, Out } from './types.js';
import { shortType, trunc } from './util.js';

const list = <T>(xs: T[], f: (x: T) => string, indent = '  '): string =>
  xs.length ? xs.map((x) => `${indent}${f(x)}`).join('\n') : `${indent}(none)`;

const fuzzyNote = (g: G, q: string | undefined, id: string): string =>
  q ? `NOTE: "${q}" was only a partial name and matched just ${g.label(id)}. Confirm with the user that this is the node they mean before changing anything.\n` : '';

export function explain(g: G, q: string): Out {
  const { node: n, fuzzy } = g.resolveNodeEx(q);
  const ins = g.inE(n.id, ['main', 'capability']);
  const outs = g.outE(n.id, ['main', 'capability']);
  const reads = g.inE(n.id, ['reads']);
  const readBy = g.outE(n.id, ['reads']);
  const cross = [...g.outE(n.id, ['calls', 'webhook_calls']), ...g.inE(n.id, ['calls', 'webhook_calls', 'on_error'])];
  const res = [...g.outE(n.id, ['writes_resource', 'uses_resource']), ...g.inE(n.id, ['reads_resource'])];

  const lines: string[] = [];
  const flags = [n.disabled ? 'DISABLED' : '', n.trigger ? 'trigger' : '', n.group ? `group "${n.group}"` : '', n.onError ? `onError=${n.onError}` : '']
    .filter(Boolean).join(', ');
  lines.push(`${g.label(n.id)}  [${shortType(n.type)}${n.typeVersion ? ` v${n.typeVersion}` : ''}]${flags ? `  (${flags})` : ''}`);
  lines.push(`  ${n.summary}`);
  lines.push('inputs:');
  lines.push(list(ins, (e) => `← ${g.label(e.from)}${e.label ? ` [${e.label}]` : ''}${e.kind === 'capability' ? ' (sub-node)' : ''}`));
  lines.push('outputs:');
  if (n.outputs.length > 1 || outs.length) {
    const byIdx = new Map<number, Edge[]>();
    for (const e of outs) if (e.kind === 'main') byIdx.set(e.outputIndex ?? 0, [...(byIdx.get(e.outputIndex ?? 0) ?? []), e]);
    n.outputs.forEach((lab, i) => {
      const es = byIdx.get(i) ?? [];
      if (n.outputs.length === 1 && !es.length) return;
      lines.push(`  [${i} ${lab}] ${es.length ? '→ ' + es.map((e) => g.label(e.to)).join(', ') : '(unwired)'}`);
    });
    for (const e of outs.filter((x) => x.kind === 'capability')) lines.push(`  ${e.label} → ${g.label(e.to)}`);
  } else lines.push('  (none)');

  const caps = g.inE(n.id, ['capability']);
  if (shortType(n.type) === 'agent' || caps.length) {
    lines.push('agent card:');
    const byType = new Map<string, string[]>();
    for (const e of caps) byType.set(e.label ?? 'ai', [...(byType.get(e.label ?? 'ai') ?? []), g.label(e.from)]);
    for (const [t, ns] of byType) lines.push(`  ${t}: ${ns.join(', ')}`);
  }
  if (reads.length) {
    lines.push('reads from:');
    lines.push(list(reads, (e) => `${g.label(e.from)}${e.fields?.length ? ` {${e.fields.join(', ')}}` : ''}  in ${(e.params ?? []).join(', ')}`));
  }
  if (readBy.length) {
    lines.push('read by:');
    lines.push(list(readBy, (e) => `${g.label(e.to)}${e.fields?.length ? ` {${e.fields.join(', ')}}` : ''}`));
  }
  if (n.credentials.length) lines.push(`credentials: ${n.credentials.map((c) => `${c.type}:${c.name ?? c.id}`).join(', ')}`);
  if (res.length) lines.push(`resources: ${res.map((e) => (e.from.startsWith('res:') ? g.label(e.from) : g.label(e.to)) + (e.label ? ` (${e.label})` : '')).join(', ')}`);
  if (cross.length) {
    lines.push('cross-workflow:');
    lines.push(list(cross, (e) => (e.from === n.id ? `→ ${g.label(e.to)}` : `← ${g.label(e.from)}`) + `  (${edgeTag(e)})`));
  }
  const unres = g.g.unresolved.filter((u) => u.wf === n.wf && u.node === n.name);
  if (unres.length) {
    lines.push('unresolved:');
    lines.push(list(unres, (u) => `${u.kind}: ${u.detail}`));
  }
  return { text: fuzzyNote(g, fuzzy, n.id) + lines.join('\n'), data: { node: n, inputs: ins, outputs: outs, reads, readBy, cross, unresolved: unres } };
}

export function neighbors(g: G, q: string, depth = 1, dir: 'in' | 'out' | 'both' = 'both', kinds: EdgeKind[] = FLOW_KINDS): Out {
  const n = g.resolveNode(q);
  const dist = new Map<string, number>([[n.id, 0]]);
  const via = new Map<string, string>();
  const queue = [n.id];
  while (queue.length) {
    const cur = queue.shift() as string;
    const d = dist.get(cur) as number;
    if (d >= depth) continue;
    const step: Array<[Edge, string, string]> = [];
    if (dir !== 'in') for (const e of g.outE(cur, kinds)) step.push([e, e.to, '→']);
    if (dir !== 'out') for (const e of g.inE(cur, kinds)) step.push([e, e.from, '←']);
    for (const [e, nx, arrow] of step) {
      if (dist.has(nx)) continue;
      dist.set(nx, d + 1);
      via.set(nx, `${arrow} ${edgeTag(e)}`);
      queue.push(nx);
    }
  }
  const rows = [...dist].filter(([id]) => id !== n.id).sort((a, b) => a[1] - b[1]);
  const text = [`${g.label(n.id)} — neighbors (depth ${depth}, ${dir})`, ...rows.map(([id, d]) => `  d${d} ${via.get(id)}  ${g.label(id)}`)].join('\n');
  return { text, data: rows.map(([id, d]) => ({ id, depth: d, via: via.get(id) })) };
}

export function paths(g: G, a: string, b: string, max = 5, kinds: EdgeKind[] = FLOW_KINDS): Out {
  const A = g.resolveNode(a);
  const B = g.resolveNode(b);
  const dist = new Map<string, number>([[A.id, 0]]);
  const queue = [A.id];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of g.outE(cur, kinds)) {
      if (!dist.has(e.to)) { dist.set(e.to, (dist.get(cur) as number) + 1); queue.push(e.to); }
    }
  }
  if (!dist.has(B.id)) {
    return { text: `No path from ${g.label(A.id)} to ${g.label(B.id)} over ${kinds.join(', ')}.`, data: [] };
  }
  // Enumerate shortest paths only, walking the BFS layers backwards.
  const found: Edge[][] = [];
  const walk = (at: string, acc: Edge[]) => {
    if (found.length >= max) return;
    if (at === A.id) { found.push([...acc].reverse()); return; }
    for (const e of g.inE(at, kinds)) {
      if (dist.get(e.from) === (dist.get(at) as number) - 1) walk(e.from, [...acc, e]);
    }
  };
  walk(B.id, []);
  const text = [
    `${found.length} shortest path(s), ${dist.get(B.id)} hop(s):`,
    ...found.map((p, i) => `#${i + 1} ${g.label(A.id)}` + p.map((e) => ` —${edgeTag(e)}→ ${g.label(e.to)}`).join('')),
  ].join('\n');
  return { text, data: found };
}

export interface FindOpts {
  type?: string; cred?: string; text?: string; disabled?: boolean; resource?: string; workflow?: string; trigger?: boolean;
  /** only workflows whose name contains this text (comma separated for several) */
  match?: string;
  /** only nodes whose NAME contains this text (unlike text, ignores parameters and code) */
  name?: string;
}

export function find(g: G, o: FindOpts): Out {
  const wf = o.workflow ? g.resolveWorkflow(o.workflow) : undefined;
  const family = o.match ? new Set(pickWorkflows(g, { match: o.match })) : undefined;
  const lc = (s?: string) => (s ?? '').toLowerCase();
  const hits = g.g.nodes.filter((n) => {
    if (wf && n.wf !== wf) return false;
    if (family && !family.has(n.wf)) return false;
    if (o.name && !lc(n.name).includes(lc(o.name))) return false;
    if (o.type && !(shortType(n.type).toLowerCase() === lc(o.type) || lc(n.type).includes(lc(o.type)))) return false;
    if (o.cred && !n.credentials.some((c) => [c.id, c.name, c.type].some((x) => lc(x).includes(lc(o.cred))))) return false;
    if (o.text && !(lc(n.text).includes(lc(o.text)) || lc(n.name).includes(lc(o.text)) || lc(n.summary).includes(lc(o.text)))) return false;
    if (o.disabled && !n.disabled) return false;
    if (o.trigger && !n.trigger) return false;
    if (o.resource) {
      const rs = [...g.outE(n.id), ...g.inE(n.id)].filter((e) => /_resource$/.test(e.kind));
      if (!rs.some((e) => lc(e.from.startsWith('res:') ? e.from : e.to).includes(lc(o.resource)))) return false;
    }
    return true;
  });
  return {
    text: [`${hits.length} node(s)`, ...hits.map((n) => `  ${g.label(n.id)}  [${shortType(n.type)}]  ${trunc(n.summary, 70)}${n.disabled ? '  (disabled)' : ''}`)].join('\n'),
    data: hits,
  };
}

export type AffectMode = 'rename' | 'delete' | 'schema' | 'behavior';

export function affected(g: G, q: string, mode: AffectMode = 'rename'): Out {
  const { node: n, fuzzy } = g.resolveNodeEx(q);
  const readers = g.outE(n.id, ['reads']);
  const lines: string[] = [`${g.label(n.id)} — impact of ${mode}`];
  const data: Record<string, unknown> = { node: n.id, mode };

  const fmtReader = (e: Edge) =>
    `${g.label(e.to)}${e.fields?.length ? ` uses {${e.fields.join(', ')}}` : ''}  in ${(e.params ?? []).join(', ')}${e.confidence === 'INFERRED' ? '  (inferred from a literal name list)' : ''}`;

  if (mode === 'rename' || mode === 'delete') {
    lines.push(
      readers.length
        ? `${readers.length} node(s) reference "${n.name}" by name and will ${mode === 'rename' ? 'break unless their expressions are rewritten' : 'read a missing node'}:`
        : `No expression references "${n.name}" by name.${mode === 'rename' ? " Safe to rename (connections are keyed by name; update them with the rename)." : ''}`,
    );
    for (const e of readers) lines.push(`  × ${fmtReader(e)}`);
    data.breaks = readers;
  }
  if (mode === 'delete') {
    const downstream = g.outE(n.id, ['main']).map((e) => e.to);
    const orphaned = downstream.filter((d) => {
      const other = g.inE(d, ['main']).filter((e) => e.from !== n.id);
      return other.length === 0;
    });
    const subs = g.inE(n.id, ['capability']);
    if (orphaned.length) {
      lines.push('lose their only input (become unreachable):');
      for (const d of orphaned) lines.push(`  × ${g.label(d)}`);
    }
    const heads = g.outE(n.id, ['capability']);
    if (heads.length) {
      lines.push(`removes a capability from: ${heads.map((e) => `${g.label(e.to)} (${e.label})`).join(', ')}`);
    }
    if (subs.length) lines.push(`removing this agent orphans ${subs.length} sub-node(s): ${subs.map((e) => g.label(e.from)).join(', ')}`);
    const callers = g.inE(n.id, ['calls', 'webhook_calls', 'on_error']);
    if (callers.length) {
      lines.push('callers that will fail:');
      for (const e of callers) lines.push(`  × ${g.label(e.from)}  (${edgeTag(e)})`);
    }
    data.orphaned = orphaned;
    data.callers = callers;
  }
  if (mode === 'schema') {
    lines.push(
      readers.length ? 'nodes reading fields from this node:' : 'No node reads this node by name.',
    );
    for (const e of readers) lines.push(`  ! ${fmtReader(e)}`);
    const succ = g.outE(n.id, ['main']);
    if (succ.length) {
      lines.push('direct successors (may use $json / $input, field use is not tracked):');
      for (const e of succ) lines.push(`  ? ${g.label(e.to)}${e.label ? ` [${e.label}]` : ''}`);
    }
    data.readers = readers;
    data.successors = succ;
  }
  if (mode === 'behavior') {
    const down = g.reach([n.id], ['main', 'capability', 'reads', 'calls', 'on_error', 'webhook_calls', 'responds_via']);
    down.delete(n.id);
    const nodes = [...down].filter((id) => g.nodeById.has(id));
    const wfs = new Set(nodes.map((id) => g.wfOfVertex(id)).filter((x): x is string => !!x && x !== n.wf));
    lines.push(`${nodes.length} node(s) downstream, ${wfs.size} other workflow(s):`);
    for (const id of nodes) lines.push(`  → ${g.label(id)}`);
    data.downstream = nodes;
    data.workflows = [...wfs];
  }
  return { text: fuzzyNote(g, fuzzy, n.id) + lines.join('\n'), data };
}

/** Workflow-level call relations derived from calls / on_error / webhook_calls edges. */
function wfRelations(g: G): Array<{ from: string; to: string; edge: Edge }> {
  const rel: Array<{ from: string; to: string; edge: Edge }> = [];
  for (const e of g.g.edges) {
    if (e.kind !== 'calls' && e.kind !== 'on_error' && e.kind !== 'webhook_calls') continue;
    const from = g.wfOfVertex(e.from);
    const to = g.wfOfVertex(e.to);
    if (from && to) rel.push({ from, to, edge: e });
  }
  return rel;
}

export function callers(g: G, w: string): Out {
  const id = g.resolveWorkflow(w);
  const rows = wfRelations(g).filter((r) => r.to === id && r.from !== id);
  return {
    text: [`${g.wfName(id)} is called by ${rows.length} edge(s):`, ...rows.map((r) => `  ${g.label(r.edge.from)}  (${edgeTag(r.edge)})`)].join('\n'),
    data: rows,
  };
}

export function calls(g: G, w: string): Out {
  const id = g.resolveWorkflow(w);
  const rows = wfRelations(g).filter((r) => r.from === id && r.to !== id);
  const unres = g.g.unresolved.filter((u) => u.scope === 'cross' && u.wf === id);
  return {
    text: [
      `${g.wfName(id)} calls ${rows.length} edge(s):`,
      ...rows.map((r) => `  ${g.label(r.edge.from)} → ${g.label(r.edge.to)}  (${edgeTag(r.edge)})`),
      ...(unres.length ? ['unresolved:', ...unres.map((u) => `  ${u.kind}: ${u.detail}`)] : []),
    ].join('\n'),
    data: { calls: rows, unresolved: unres },
  };
}

export function uses(g: G, cred: string): Out {
  const lc = cred.toLowerCase();
  const hits = g.g.nodes.filter((n) => n.credentials.some((c) => [c.id, c.name, c.type].some((x) => (x ?? '').toLowerCase().includes(lc))));
  const byWf = new Map<string, GNode[]>();
  for (const n of hits) byWf.set(n.wf, [...(byWf.get(n.wf) ?? []), n]);
  const lines = [`${hits.length} node(s) in ${byWf.size} workflow(s) use credential matching "${cred}":`];
  for (const [wf, ns] of byWf) {
    lines.push(`  ${g.wfName(wf)}`);
    for (const n of ns) lines.push(`    ${n.name}  [${n.credentials.filter((c) => [c.id, c.name, c.type].some((x) => (x ?? '').toLowerCase().includes(lc))).map((c) => `${c.type}:${c.name ?? c.id}`).join(', ')}]`);
  }
  return { text: lines.join('\n'), data: hits };
}
