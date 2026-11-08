import { wfOf } from './assemble.js';
import type { Edge, EdgeKind, GNode, Graph } from './types.js';
import { shortType } from './util.js';

const ASK = 'Do not guess: ask the user which one they mean.';

export class G {
  readonly nodeById = new Map<string, GNode>();
  readonly out = new Map<string, Edge[]>();
  readonly inc = new Map<string, Edge[]>();
  readonly multi: boolean;

  constructor(readonly g: Graph) {
    for (const n of g.nodes) this.nodeById.set(n.id, n);
    for (const e of g.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.inc.get(e.to) ?? this.inc.set(e.to, []).get(e.to)!).push(e);
    }
    this.multi = Object.keys(g.workflows).length > 1;
  }

  outE(id: string, kinds?: EdgeKind[]): Edge[] {
    const es = this.out.get(id) ?? [];
    return kinds ? es.filter((e) => kinds.includes(e.kind)) : es;
  }

  inE(id: string, kinds?: EdgeKind[]): Edge[] {
    const es = this.inc.get(id) ?? [];
    return kinds ? es.filter((e) => kinds.includes(e.kind)) : es;
  }

  nodesOf(wf: string): GNode[] {
    return this.g.nodes.filter((n) => n.wf === wf);
  }

  /** Display name of any vertex id (node, workflow, credential, resource). */
  label(id: string): string {
    const n = this.nodeById.get(id);
    if (n) return this.multi ? `${n.wf}:${n.name}` : n.name;
    if (id.startsWith('wf:')) {
      const w = this.g.workflows[id.slice(3)];
      return w ? `workflow ${w.name} (${w.id})` : id;
    }
    if (id.startsWith('cred:')) return `credential ${id.slice(5)}`;
    if (id.startsWith('res:')) return id.slice(4);
    return id;
  }

  wfName(id: string): string {
    const w = this.g.workflows[id];
    return w ? `${w.name} (${w.id})` : id;
  }

  wfOfVertex(id: string): string | undefined {
    return wfOf(this.g, id);
  }

  resolveWorkflow(q: string): string {
    if (this.g.workflows[q]) return q;
    const ws = Object.values(this.g.workflows);
    const exact = ws.filter((w) => w.name === q);
    if (exact.length === 1) return exact[0].id;
    const ci = ws.filter((w) => w.name.toLowerCase() === q.toLowerCase());
    if (ci.length === 1) return ci[0].id;
    const part = ws.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()));
    if (part.length === 1) return part[0].id;
    const hits = exact.length ? exact : part;
    if (!hits.length) throw new Error(`No workflow matches "${q}". Run flownav_scan to list workflows.`);
    const rows = hits.slice(0, 10).flatMap((w, i) => {
      const trig = [...new Set(this.nodesOf(w.id).filter((n) => n.trigger).map((n) => shortType(n.type)))];
      const state = w.active === undefined ? '' : w.active ? ', active' : ', inactive';
      return [
        `  ${i + 1}. ${w.name}  [id ${w.id}, ${w.nodeCount} nodes${state}]`,
        `       ${trig.length ? `started by: ${trig.slice(0, 4).join(', ')}` : 'no trigger of its own'}${w.errorWorkflow ? ' · has an error workflow' : ''}`,
      ];
    });
    if (hits.length > 10) rows.push(`  ... and ${hits.length - 10} more`);
    throw new Error(
      [`"${q}" matches ${hits.length} workflows. ${ASK} Then use its id.`, ...rows,
        `To search across all of them at once, use flownav_find with match="${q}".`].join('\n'),
    );
  }

  /** Accepts "Node", "workflow:Node" (workflow id or name), or a full vertex id. */
  resolveNode(q: string): GNode {
    return this.resolveNodeEx(q).node;
  }

  /** One line of context so the agent can tell candidates apart and ask a sharper question. */
  private contextLine(n: GNode): string {
    const bits: string[] = [n.summary];
    if (n.group) bits.push(`group "${n.group}"`);
    if (n.disabled) bits.push('disabled');
    const names = (ids: string[]) => [...new Set(ids.map((id) => this.nodeById.get(id)?.name ?? id))];
    const from = names(this.inE(n.id, ['main', 'capability']).map((e) => e.from));
    const into = names(this.outE(n.id, ['capability']).map((e) => e.to));
    if (n.trigger) bits.push('starts the workflow');
    else if (from.length) bits.push(`after: ${from.slice(0, 2).join(', ')}${from.length > 2 ? ` (+${from.length - 2})` : ''}`);
    else if (into.length) bits.push(`plugs into: ${into.slice(0, 2).join(', ')}`);
    else bits.push('not connected to anything');
    const line = bits.join(' · ');
    return line.length > 150 ? `${line.slice(0, 149)}…` : line;
  }

  private ambiguousNodes(q: string, hits: GNode[]): string {
    const rows = hits.slice(0, 10).flatMap((n, i) => [
      `  ${i + 1}. ${this.g.workflows[n.wf]?.name ?? n.wf} › ${n.name}  [${shortType(n.type)}]  use: ${n.wf}:${n.name}`,
      `       ${this.contextLine(n)}`,
    ]);
    if (hits.length > 10) rows.push(`  ... and ${hits.length - 10} more`);
    return [`"${q}" matches ${hits.length} nodes. ${ASK} Then use the workflow:node form.`, ...rows].join('\n');
  }

  /** `fuzzy` is set when the query was only a partial name and matched exactly one node. */
  resolveNodeEx(q: string): { node: GNode; fuzzy?: string } {
    const direct = this.nodeById.get(q);
    if (direct) return { node: direct };
    const pool: GNode[] = [];
    for (let i = q.indexOf(':'); i >= 0; i = q.indexOf(':', i + 1)) {
      const pre = q.slice(0, i);
      const name = q.slice(i + 1).trim();
      const wf = this.g.workflows[pre]?.id ?? Object.values(this.g.workflows).find((w) => w.name === pre)?.id;
      if (wf) {
        const hit = this.nodesOf(wf).find((n) => n.name === name) ?? this.nodesOf(wf).find((n) => n.name.toLowerCase() === name.toLowerCase());
        if (hit) return { node: hit };
      }
    }
    pool.push(...this.g.nodes);
    const tiers = [
      pool.filter((n) => n.name === q),
      pool.filter((n) => n.name.toLowerCase() === q.toLowerCase()),
      pool.filter((n) => n.name.toLowerCase().includes(q.toLowerCase())),
    ];
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      if (t.length === 1) return i === 2 ? { node: t[0], fuzzy: q } : { node: t[0] };
      if (t.length > 1) throw new Error(this.ambiguousNodes(q, t));
    }
    throw new Error(`No node matches "${q}". Use flownav_find to search by text, or flownav_scan to list workflows.`);
  }

  /** Forward BFS reachability over the given kinds. */
  reach(start: string[], kinds: EdgeKind[], reverse = false): Set<string> {
    const seen = new Set(start);
    const queue = [...start];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const e of reverse ? this.inE(cur, kinds) : this.outE(cur, kinds)) {
        const nx = reverse ? e.from : e.to;
        if (!seen.has(nx)) { seen.add(nx); queue.push(nx); }
      }
    }
    return seen;
  }
}

export const edgeTag = (e: Edge): string =>
  `${e.kind}${e.label ? `:${e.label}` : ''}${e.confidence === 'EXPLICIT' ? '' : ` ${e.confidence}`}`;
