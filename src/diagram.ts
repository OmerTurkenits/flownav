import { G } from './graph.js';
import { pickWorkflows, workflowLinks } from './overview.js';
import type { Edge, EdgeKind } from './types.js';
import { shortType, trunc } from './util.js';

export interface DiagramOpts {
  workflow?: string;
  /** draw every workflow whose name contains this text (comma separated for several) */
  match?: string;
  /** one box per workflow, with the calls between them */
  collapse?: boolean;
  focus?: string;
  depth?: number;
  reads?: boolean;
  dir?: 'LR' | 'TD';
}

const esc = (s: string): string => s.replace(/"/g, '#quot;').replace(/[<>]/g, (c) => (c === '<' ? '#lt;' : '#gt;'));

/** Vertex ids for a workflow, the whole graph, or the neighbourhood of one node. */
export function selectScope(g: G, o: DiagramOpts, kinds: EdgeKind[]): Set<string> {
  let ids = new Set<string>();
  if (o.focus) {
    const n = g.resolveNode(o.focus);
    const depth = o.depth ?? 2;
    const dist = new Map<string, number>([[n.id, 0]]);
    const queue = [n.id];
    while (queue.length) {
      const cur = queue.shift() as string;
      const d = dist.get(cur) as number;
      if (d >= depth) continue;
      for (const e of [...g.outE(cur, kinds), ...g.inE(cur, kinds)]) {
        const nx = e.from === cur ? e.to : e.from;
        if (!dist.has(nx)) { dist.set(nx, d + 1); queue.push(nx); }
      }
    }
    ids = new Set(dist.keys());
  } else if (o.workflow || o.match) {
    for (const wf of pickWorkflows(g, o)) for (const n of g.nodesOf(wf)) ids.add(n.id);
  } else {
    for (const n of g.g.nodes) ids.add(n.id);
  }
  return ids;
}

/** Mermaid flowchart of a workflow, the whole graph, or the neighbourhood of one node. */
export function diagram(g: G, o: DiagramOpts = {}): { text: string; nodes: number } {
  if (o.collapse) return collapsedDiagram(g, o);
  const kinds: EdgeKind[] = ['main', 'capability', 'calls', 'on_error', 'webhook_calls'];
  if (o.reads !== false) kinds.push('reads');
  const ids = selectScope(g, o, kinds);

  const edges: Edge[] = g.g.edges.filter((e) => kinds.includes(e.kind) && ids.has(e.from) && ids.has(e.to));
  // keep the ends of cross-workflow edges that leave a single-workflow view out; they are not in `ids`

  const alias = new Map<string, string>();
  const a = (id: string): string => {
    if (!alias.has(id)) alias.set(id, `n${alias.size}`);
    return alias.get(id) as string;
  };
  const shape = (id: string): string => {
    const n = g.nodeById.get(id);
    if (!n) return `["${esc(g.label(id))}"]`;
    const label = `"${esc(trunc(n.name, 40))}${n.summary && shortType(n.type) === 'webhook' ? '<br/>' + esc(trunc(n.summary, 40)) : ''}"`;
    const t = shortType(n.type);
    if (n.trigger) return `([${label}])`;
    if (t === 'if' || t === 'switch') return `{${label}}`;
    if (t === 'agent') return `{{${label}}}`;
    if (t === 'splitInBatches') return `[/${label}/]`;
    return `[${label}]`;
  };

  const lines: string[] = [`flowchart ${o.dir ?? 'LR'}`];
  const byWf = new Map<string, string[]>();
  for (const id of ids) {
    const wf = g.wfOfVertex(id) ?? '';
    byWf.set(wf, [...(byWf.get(wf) ?? []), id]);
  }
  const multi = byWf.size > 1;
  for (const [wf, members] of byWf) {
    if (multi && wf) lines.push(`  subgraph ${a('sg:' + wf)}["${esc(g.g.workflows[wf]?.name ?? wf)}"]`);
    for (const id of members) lines.push(`  ${multi && wf ? '  ' : ''}${a(id)}${shape(id)}`);
    if (multi && wf) lines.push('  end');
  }

  for (const e of edges) {
    const label =
      e.kind === 'reads' ? `reads ${(e.fields ?? []).slice(0, 3).join(', ')}`.trim()
      : e.kind === 'calls' ? e.label ?? 'calls'
      : e.kind === 'main' ? e.label ?? ''
      : e.label ?? e.kind;
    const l = label ? `|"${esc(label)}"|` : '';
    const arrow = e.kind === 'main' ? '-->' : e.kind === 'calls' || e.kind === 'on_error' || e.kind === 'webhook_calls' ? '==>' : '-.->';
    lines.push(`  ${a(e.from)} ${arrow}${l} ${a(e.to)}`);
  }

  const disabled = [...ids].filter((id) => g.nodeById.get(id)?.disabled).map(a);
  if (disabled.length) {
    lines.push('  classDef off stroke-dasharray: 4 4,opacity:0.5', `  class ${disabled.join(',')} off`);
  }
  if (o.focus) {
    lines.push('  classDef focus stroke-width:3px', `  class ${a(g.resolveNode(o.focus).id)} focus`);
  }
  return { text: lines.join('\n'), nodes: ids.size };
}

const WORD: Record<string, string> = { calls: 'calls', on_error: 'on error', webhook_calls: 'webhook' };

/** One box per workflow, arrows for calls between them. */
function collapsedDiagram(g: G, o: DiagramOpts): { text: string; nodes: number } {
  if (o.focus) throw new Error('--collapse cannot be combined with --focus.');
  const wfs = pickWorkflows(g, o);
  const lines = [`flowchart ${o.dir ?? 'LR'}`];
  const alias = new Map(wfs.map((id, i) => [id, `w${i}`]));
  for (const id of wfs) {
    const w = g.g.workflows[id];
    lines.push(`  ${alias.get(id)}["${esc(w.name)}<br/>${w.nodeCount} nodes"]`);
  }
  for (const l of workflowLinks(g, wfs)) {
    const label = `${l.count > 1 ? `${l.count}× ` : ''}${WORD[l.kind]}`;
    lines.push(`  ${alias.get(l.from)} ==>|"${esc(label)}"| ${alias.get(l.to)}`);
  }
  const off = wfs.filter((id) => g.g.workflows[id].active === false).map((id) => alias.get(id));
  if (off.length) lines.push('  classDef off stroke-dasharray: 4 4,opacity:0.5', `  class ${off.join(',')} off`);
  return { text: lines.join('\n'), nodes: wfs.length };
}
