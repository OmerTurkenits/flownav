import { CROSS_KINDS } from './types.js';
import type { Edge, GNode, Graph, Unresolved, WorkflowResult } from './types.js';
import { shortType } from './util.js';

/** Bump whenever extraction logic changes so cached per-workflow results are not reused. */
export const BUILDER_VERSION = 5;

export const wfOf = (g: Graph, id: string): string | undefined => {
  if (id.startsWith('wf:')) return id.slice(3);
  const i = id.indexOf('::');
  return i > 0 && g.workflows[id.slice(0, i)] ? id.slice(0, i) : undefined;
};

/** Recompute all cross-workflow edges (calls, on_error, webhook_calls) from node data. */
export function link(
  workflows: Graph['workflows'],
  nodes: GNode[],
): { edges: Edge[]; unresolved: Unresolved[] } {
  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];
  const byName = new Map<string, string[]>();
  for (const w of Object.values(workflows)) byName.set(w.name, [...(byName.get(w.name) ?? []), w.id]);

  const entryOf = (wf: string, type: string): string | undefined =>
    nodes.find((n) => n.wf === wf && shortType(n.type) === type)?.id;

  const resolve = (idOrName?: string, name?: string): { id?: string; inferred: boolean } => {
    if (idOrName && workflows[idOrName]) return { id: idOrName, inferred: false };
    for (const cand of [name, idOrName]) {
      const hit = cand ? byName.get(cand) : undefined;
      if (hit?.length === 1) return { id: hit[0], inferred: true };
    }
    return { inferred: false };
  };

  for (const n of nodes) {
    for (const c of n.calls ?? []) {
      if (c.external) {
        unresolved.push({ scope: 'cross', wf: n.wf, node: n.name, kind: 'external-subworkflow', detail: `${n.name} runs a sub-workflow from "${c.external}"` });
      } else if (c.dynamic) {
        unresolved.push({ scope: 'cross', wf: n.wf, node: n.name, kind: 'dynamic-call', detail: `${n.name} calls a workflow chosen at runtime` });
      } else {
        const r = resolve(c.targetId, c.targetName);
        if (!r.id) {
          unresolved.push({ scope: 'cross', wf: n.wf, node: n.name, kind: 'missing-workflow', detail: `${n.name} calls workflow ${c.targetId ?? c.targetName}, which is not in the graph` });
        } else {
          edges.push({
            from: n.id,
            to: entryOf(r.id, 'executeWorkflowTrigger') ?? `wf:${r.id}`,
            kind: 'calls',
            label: c.via === 'toolWorkflow' ? 'tool' : undefined,
            confidence: r.inferred ? 'INFERRED' : 'EXTRACTED',
          });
        }
      }
    }
  }

  for (const w of Object.values(workflows)) {
    if (!w.errorWorkflow) continue;
    const r = resolve(w.errorWorkflow);
    if (!r.id) {
      unresolved.push({ scope: 'cross', wf: w.id, kind: 'missing-workflow', detail: `error workflow ${w.errorWorkflow} is not in the graph` });
    } else {
      edges.push({ from: `wf:${w.id}`, to: entryOf(r.id, 'errorTrigger') ?? `wf:${r.id}`, kind: 'on_error', confidence: 'EXTRACTED' });
    }
  }

  // HTTP Request to /webhook/<path> matched against Webhook node paths.
  const hooks = nodes
    .filter((n) => n.webhook?.path)
    .map((n) => ({
      n,
      re: new RegExp(`^${n.webhook!.path.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`),
    }));
  for (const n of nodes) {
    for (const url of n.httpUrls ?? []) {
      const m = /\/webhook(-test)?\/([^\s?#"'{}]+)/.exec(url);
      if (!m) continue;
      const path = m[2].replace(/\/+$/, '');
      for (const h of hooks) {
        if (h.n.wf !== n.wf && h.re.test(path)) {
          edges.push({ from: n.id, to: h.n.id, kind: 'webhook_calls', label: m[1] ? 'test' : undefined, confidence: 'INFERRED' });
        } else if (h.n.wf === n.wf && h.re.test(path)) {
          edges.push({ from: n.id, to: h.n.id, kind: 'webhook_calls', label: 'self', confidence: 'INFERRED' });
        }
      }
    }
  }
  return { edges, unresolved };
}

export function assemble(results: WorkflowResult[], source: Graph['source']): Graph {
  const workflows: Graph['workflows'] = {};
  const nodes: GNode[] = [];
  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];
  for (const r of results) {
    workflows[r.info.id] = r.info;
    nodes.push(...r.nodes);
    edges.push(...r.edges.filter((e) => !CROSS_KINDS.includes(e.kind)));
    unresolved.push(...r.unresolved.filter((u) => u.scope === 'local'));
  }
  const cross = link(workflows, nodes);
  edges.push(...cross.edges);
  unresolved.push(...cross.unresolved);
  return { version: 1, builder: BUILDER_VERSION, builtAt: new Date().toISOString(), source, workflows, nodes, edges, unresolved };
}

/** Split a stored graph back into per-workflow results (cross edges dropped) for incremental sync. */
export function splitGraph(g: Graph): Map<string, WorkflowResult> {
  const owner = new Map<string, string>();
  for (const n of g.nodes) owner.set(n.id, n.wf);
  const res = new Map<string, WorkflowResult>();
  for (const info of Object.values(g.workflows)) res.set(info.id, { info, nodes: [], edges: [], unresolved: [] });
  for (const n of g.nodes) res.get(n.wf)?.nodes.push(n);
  for (const e of g.edges) {
    if (CROSS_KINDS.includes(e.kind)) continue;
    const wf = owner.get(e.from) ?? owner.get(e.to);
    if (wf) res.get(wf)?.edges.push(e);
  }
  for (const u of g.unresolved) if (u.scope === 'local') res.get(u.wf)?.unresolved.push(u);
  return res;
}
