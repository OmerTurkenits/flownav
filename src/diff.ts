import type { Edge, Graph, Out } from './types.js';

const ek = (e: Edge): string => `${e.from} -${e.kind}${e.label ? ':' + e.label : ''}-> ${e.to}`;

export function diffGraphs(a: Graph, b: Graph): Out {
  const lines: string[] = [];
  const data: Record<string, string[]> = { added: [], removed: [], changed: [], edgesAdded: [], edgesRemoved: [] };
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  for (const [id, n] of bn) {
    const o = an.get(id);
    if (!o) data.added.push(id);
    else if (o.hash !== n.hash) data.changed.push(id);
  }
  for (const id of an.keys()) if (!bn.has(id)) data.removed.push(id);
  const ae = new Set(a.edges.map(ek));
  const be = new Set(b.edges.map(ek));
  for (const e of be) if (!ae.has(e)) data.edgesAdded.push(e);
  for (const e of ae) if (!be.has(e)) data.edgesRemoved.push(e);
  for (const id of Object.keys(b.workflows)) if (!a.workflows[id]) lines.push(`+ workflow ${id}`);
  for (const id of Object.keys(a.workflows)) if (!b.workflows[id]) lines.push(`- workflow ${id}`);
  for (const [k, sym] of [['added', '+'], ['removed', '-'], ['changed', '~']] as const) {
    for (const id of data[k]) lines.push(`${sym} node ${id.replace('::', ':')}`);
  }
  for (const e of data.edgesAdded) lines.push(`+ edge ${e.replaceAll('::', ':')}`);
  for (const e of data.edgesRemoved) lines.push(`- edge ${e.replaceAll('::', ':')}`);
  return { text: lines.length ? lines.join('\n') : 'No differences.', data };
}
