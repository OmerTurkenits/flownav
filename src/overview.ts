import { entryPoints } from './checks.js';
import { G } from './graph.js';
import type { EdgeKind } from './types.js';
import { shortType } from './util.js';

const CALL_KINDS: EdgeKind[] = ['calls', 'on_error', 'webhook_calls'];

/** Workflow ids picked by a positional workflow, a --match text (comma separated), or all. */
export function pickWorkflows(g: G, o: { workflow?: string; match?: string }): string[] {
  if (o.workflow && o.match) throw new Error('Give either a workflow or --match, not both.');
  if (o.workflow) return [g.resolveWorkflow(o.workflow)];
  if (o.match) {
    const terms = o.match.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const hit = Object.values(g.g.workflows)
      .filter((w) => terms.some((t) => w.name.toLowerCase().includes(t) || w.id.toLowerCase() === t))
      .map((w) => w.id);
    if (!hit.length) throw new Error(`No workflow name contains "${o.match}".`);
    return hit;
  }
  return Object.keys(g.g.workflows);
}

export interface WfLink {
  from: string;
  to: string;
  kind: EdgeKind;
  count: number;
}

/** Aggregated workflow-to-workflow links; both ends must be in `within` when given. */
export function workflowLinks(g: G, within?: string[]): WfLink[] {
  const set = within ? new Set(within) : undefined;
  const acc = new Map<string, WfLink>();
  for (const e of g.g.edges) {
    if (!CALL_KINDS.includes(e.kind)) continue;
    const from = g.wfOfVertex(e.from);
    const to = g.wfOfVertex(e.to);
    if (!from || !to || from === to) continue;
    if (set && !(set.has(from) && set.has(to))) continue;
    const key = `${from}|${to}|${e.kind}`;
    const cur = acc.get(key) ?? { from, to, kind: e.kind, count: 0 };
    cur.count++;
    acc.set(key, cur);
  }
  return [...acc.values()];
}

const KIND_WORD: Record<string, string> = { calls: 'calls', on_error: 'error workflow', webhook_calls: 'webhook calls' };

/** Short text card for one workflow (links are over the whole graph, not just the selection). */
export function workflowCard(g: G, id: string, all: WfLink[]): string {
  const w = g.g.workflows[id];
  const name = (x: string) => g.g.workflows[x]?.name ?? x;
  const L: string[] = [`${w.name}  (${id})`];
  const bits = [`${w.nodeCount} nodes`];
  if (w.active !== undefined) bits.push(w.active ? 'active' : 'inactive');
  if (w.lastRun) bits.push(`last run ${w.lastRun.status}${w.lastRun.at ? ` at ${w.lastRun.at}` : ''}`);
  L.push(`  ${bits.join(' · ')}`);
  const eps = entryPoints(g, id);
  L.push('entry points:');
  L.push(...(eps.length ? eps.map((n) => `  ${n.name}  [${shortType(n.type)}]`) : ['  (none)']));
  const out = all.filter((l) => l.from === id);
  const inn = all.filter((l) => l.to === id);
  L.push('calls:');
  L.push(...(out.length ? out.map((l) => `  → ${name(l.to)}  (${l.count}× ${KIND_WORD[l.kind]})`) : ['  (none)']));
  L.push('called by:');
  L.push(...(inn.length ? inn.map((l) => `  ← ${name(l.from)}  (${l.count}× ${KIND_WORD[l.kind]})`) : ['  (none)']));
  const creds = new Set(g.nodesOf(id).flatMap((n) => n.credentials.map((c) => c.type)));
  if (creds.size) L.push(`credentials: ${[...creds].join(', ')}`);
  if (w.groups.length) L.push(`groups: ${w.groups.map((x) => x.name).join(', ')}`);
  return L.join('\n');
}
