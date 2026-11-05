import { G } from './graph.js';
import type { GNode, Out } from './types.js';
import { shortType } from './util.js';

export type CheckName =
  | 'fragile-reads' | 'dead-refs' | 'cycles' | 'unreachable' | 'dead-ends' | 'no-error-handler' | 'webhook-no-respond';

export const ALL_CHECKS: CheckName[] = [
  'fragile-reads', 'dead-refs', 'cycles', 'unreachable', 'dead-ends', 'no-error-handler', 'webhook-no-respond',
];

export interface Finding {
  check: CheckName;
  severity: 'error' | 'warn' | 'info';
  wf: string;
  node?: string;
  message: string;
}

const MAIN = ['main' as const];

/** Strongly connected components over main edges (iterative Tarjan). */
export function sccs(g: G, nodes: GNode[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let i = 0;
  for (const root of nodes) {
    if (index.has(root.id)) continue;
    const work: Array<[string, number]> = [[root.id, 0]];
    while (work.length) {
      const [v, k] = work[work.length - 1];
      if (k === 0) { index.set(v, i); low.set(v, i); i++; stack.push(v); on.add(v); }
      const es = g.outE(v, MAIN).filter((e) => g.nodeById.has(e.to));
      if (k < es.length) {
        work[work.length - 1][1]++;
        const w = es[k].to;
        if (!index.has(w)) work.push([w, 0]);
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p)!, low.get(v)!));
        }
        if (low.get(v) === index.get(v)) {
          const comp: string[] = [];
          let w: string;
          do { w = stack.pop() as string; on.delete(w); comp.push(w); } while (w !== v);
          out.push(comp);
        }
      }
    }
  }
  return out;
}

export function entryPoints(g: G, wf: string): GNode[] {
  const ns = g.nodesOf(wf);
  const trig = ns.filter((n) => n.trigger);
  if (trig.length) return trig;
  return ns.filter((n) => g.inE(n.id, ['main']).length === 0 && g.outE(n.id, ['capability']).length === 0);
}

export function reachableFromEntries(g: G, wf: string): Set<string> {
  const seen = g.reach(entryPoints(g, wf).map((n) => n.id), ['main']);
  // Sub-nodes (models, tools, memory) run when their agent runs.
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of g.g.edges) {
      if (e.kind === 'capability' && seen.has(e.to) && !seen.has(e.from)) { seen.add(e.from); changed = true; }
    }
  }
  return seen;
}

function ancestors(g: G, id: string): Set<string> {
  const anc = g.reach([id], MAIN, true);
  // A sub-node executes inside its agent, so it inherits the agent's ancestors.
  for (const e of g.outE(id, ['capability'])) for (const a of g.reach([e.to], MAIN, true)) anc.add(a);
  return anc;
}

export function runChecks(g: G, only?: CheckName[]): Finding[] {
  const want = new Set(only ?? ALL_CHECKS);
  const f: Finding[] = [];
  const wfs = Object.values(g.g.workflows);

  if (want.has('dead-refs')) {
    for (const u of g.g.unresolved) {
      if (u.kind === 'dead-ref' || u.kind === 'dead-connection' || u.kind === 'missing-workflow') {
        f.push({ check: 'dead-refs', severity: 'error', wf: u.wf, node: u.node, message: u.detail });
      }
    }
  }

  if (want.has('fragile-reads')) {
    for (const e of g.g.edges) {
      if (e.kind !== 'reads' || e.confidence === 'INFERRED') continue; // inferred reads are often try/catch-guarded
      const reader = g.nodeById.get(e.to);
      const src = g.nodeById.get(e.from);
      if (!reader || !src) continue;
      if (!ancestors(g, reader.id).has(src.id)) {
        f.push({
          check: 'fragile-reads', severity: 'warn', wf: reader.wf, node: reader.name,
          message: `${reader.name} reads $('${src.name}') but ${src.name} is not upstream via main; it may not have run`,
        });
      } else if (src.disabled) {
        f.push({ check: 'fragile-reads', severity: 'warn', wf: reader.wf, node: reader.name, message: `${reader.name} reads disabled node ${src.name}` });
      }
    }
  }

  for (const w of wfs) {
    const ns = g.nodesOf(w.id);
    if (want.has('cycles')) {
      for (const comp of sccs(g, ns)) {
        const selfLoop = comp.length === 1 && g.outE(comp[0], MAIN).some((e) => e.to === comp[0]);
        if (comp.length < 2 && !selfLoop) continue;
        const types = comp.map((id) => shortType(g.nodeById.get(id)!.type));
        const kind = types.includes('splitInBatches') ? 'loop (Loop Over Items)'
          : types.includes('wait') ? 'polling loop (contains Wait)'
          : undefined;
        f.push({
          check: 'cycles', severity: kind ? 'info' : 'warn', wf: w.id,
          message: `${kind ?? 'cycle without Loop Over Items or Wait'}: ${comp.map((id) => g.nodeById.get(id)!.name).join(' <-> ')}`,
        });
      }
    }
    if (want.has('unreachable')) {
      const seen = reachableFromEntries(g, w.id);
      for (const n of ns) {
        if (!seen.has(n.id)) f.push({ check: 'unreachable', severity: 'warn', wf: w.id, node: n.name, message: `${n.name} is not reachable from any trigger` });
      }
    }
    if (want.has('dead-ends')) {
      for (const n of ns) {
        if (n.outputs.length < 2) continue;
        const wired = new Set(g.outE(n.id, MAIN).map((e) => e.outputIndex ?? 0));
        n.outputs.forEach((lab, i) => {
          if (lab === 'error' || wired.has(i)) return;
          f.push({ check: 'dead-ends', severity: 'info', wf: w.id, node: n.name, message: `${n.name} output [${i} ${lab}] is not connected` });
        });
      }
    }
    if (want.has('no-error-handler')) {
      const hasTrigger = ns.some((n) => n.trigger && shortType(n.type) !== 'errorTrigger');
      const isHandler = ns.some((n) => shortType(n.type) === 'errorTrigger');
      const handled = !!w.errorWorkflow || isHandler || ns.some((n) => n.onError?.startsWith('continue'));
      if (hasTrigger && !handled && w.active !== false) {
        f.push({ check: 'no-error-handler', severity: 'info', wf: w.id, message: `${w.name} has no error workflow and no node-level error handling` });
      }
    }
    if (want.has('webhook-no-respond')) {
      const resp = ns.filter((n) => shortType(n.type) === 'respondToWebhook');
      for (const n of ns.filter((x) => x.webhook?.responseMode === 'responseNode')) {
        if (!g.outE(n.id, ['responds_via']).length) {
          f.push({ check: 'webhook-no-respond', severity: 'error', wf: w.id, node: n.name, message: `${n.name} waits for a Respond to Webhook node, but none is reachable` });
        }
      }
      if (resp.length && !ns.some((n) => n.webhook)) {
        for (const r of resp) f.push({ check: 'webhook-no-respond', severity: 'info', wf: w.id, node: r.name, message: `${r.name} has no Webhook node in this workflow` });
      }
    }
  }
  const order = { error: 0, warn: 1, info: 2 };
  return f.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
}

export function formatFindings(g: G, f: Finding[]): Out {
  if (!f.length) return { text: 'No findings.', data: [] };
  const lines = [`${f.length} finding(s)`];
  for (const x of f) lines.push(`  ${x.severity.toUpperCase().padEnd(5)} ${x.check.padEnd(18)} ${g.multi ? `[${x.wf}] ` : ''}${x.message}`);
  return { text: lines.join('\n'), data: f };
}
