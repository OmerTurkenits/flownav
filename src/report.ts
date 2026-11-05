import { entryPoints, formatFindings, reachableFromEntries, runChecks } from './checks.js';
import { G } from './graph.js';
import type { Out } from './types.js';
import { shortType } from './util.js';

function depth(g: G, wf: string): number {
  const entries = entryPoints(g, wf);
  const dist = new Map<string, number>(entries.map((n) => [n.id, 0]));
  const queue = entries.map((n) => n.id);
  let max = 0;
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of g.outE(cur, ['main'])) {
      if (!dist.has(e.to)) { dist.set(e.to, (dist.get(cur) as number) + 1); max = Math.max(max, dist.get(e.to) as number); queue.push(e.to); }
    }
  }
  return max;
}

export function scan(g: G): Out {
  const g0 = g.g;
  const hist = new Map<string, number>();
  for (const n of g0.nodes) hist.set(shortType(n.type), (hist.get(shortType(n.type)) ?? 0) + 1);
  const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const lines = [
    `${Object.keys(g0.workflows).length} workflow(s), ${g0.nodes.length} node(s), ${g0.edges.length} edge(s)`,
    'workflows:',
    ...Object.values(g0.workflows).map(
      (w) => `  ${w.id}  ${w.name}  nodes=${w.nodeCount}${w.active === undefined ? '' : w.active ? ' active' : ' inactive'}  triggers=${entryPoints(g, w.id).filter((n) => n.trigger).map((n) => shortType(n.type)).join(',') || '-'}`,
    ),
    'node types:',
    ...top.map(([t, c]) => `  ${String(c).padStart(4)}  ${t}`),
  ];
  return { text: lines.join('\n'), data: { workflows: Object.values(g0.workflows), types: Object.fromEntries(hist) } };
}

export function report(g: G): string {
  const g0 = g.g;
  const wfs = Object.values(g0.workflows);
  const L: string[] = [];
  L.push('# Workflow report', '');
  L.push(`Source: ${g0.source.type} \`${g0.source.ref}\`  ·  built ${g0.builtAt}`);
  L.push(`${wfs.length} workflow(s) · ${g0.nodes.length} node(s) · ${g0.edges.length} edge(s) · ${g0.unresolved.length} unresolved reference(s)`, '');

  L.push('## Workflows', '', '| id | name | nodes | active | entry points | depth | calls | called by |', '|---|---|---|---|---|---|---|---|');
  for (const w of wfs) {
    const rel = g0.edges.filter((e) => ['calls', 'on_error', 'webhook_calls'].includes(e.kind));
    const out = new Set(rel.filter((e) => g.wfOfVertex(e.from) === w.id && g.wfOfVertex(e.to) !== w.id).map((e) => g.wfOfVertex(e.to)));
    const inn = new Set(rel.filter((e) => g.wfOfVertex(e.to) === w.id && g.wfOfVertex(e.from) !== w.id).map((e) => g.wfOfVertex(e.from)));
    const eps = entryPoints(g, w.id).map((n) => n.name).join(', ') || '-';
    L.push(`| ${w.id} | ${w.name} | ${w.nodeCount} | ${w.active === undefined ? '?' : w.active ? 'yes' : 'no'} | ${eps} | ${depth(g, w.id)} | ${[...out].join(', ') || '-'} | ${[...inn].join(', ') || '-'} |`);
  }

  const gods = g0.nodes
    .map((n) => ({ n, deg: g.inE(n.id, ['main', 'capability', 'reads']).length + g.outE(n.id, ['main', 'capability', 'reads']).length }))
    .sort((a, b) => b.deg - a.deg)
    .slice(0, 8)
    .filter((x) => x.deg >= 4);
  if (gods.length) {
    L.push('', '## God nodes (highest degree)', '');
    for (const { n, deg } of gods) L.push(`- ${g.label(n.id)} — ${deg} links (${shortType(n.type)})`);
  }

  const groups = wfs.flatMap((w) => w.groups.map((x) => ({ w, ...x })));
  if (groups.length) {
    L.push('', '## Groups (sticky notes)', '');
    for (const x of groups) L.push(`- ${x.w.id} / **${x.name}**: ${x.nodes.join(', ')}`);
  }

  const creds = new Map<string, Set<string>>();
  for (const n of g0.nodes) for (const c of n.credentials) creds.set(`${c.type}:${c.name ?? c.id}`, new Set([...(creds.get(`${c.type}:${c.name ?? c.id}`) ?? []), n.wf]));
  if (creds.size) {
    L.push('', '## Credentials', '');
    for (const [c, ws] of creds) L.push(`- ${c} — ${g0.nodes.filter((n) => n.credentials.some((x) => `${x.type}:${x.name ?? x.id}` === c)).length} node(s) in ${[...ws].join(', ')}`);
  }

  const shared = new Map<string, Set<string>>();
  for (const e of g0.edges) {
    if (!/_resource$/.test(e.kind)) continue;
    const res = e.from.startsWith('res:') ? e.from : e.to;
    const node = e.from.startsWith('res:') ? e.to : e.from;
    shared.set(res, new Set([...(shared.get(res) ?? []), node]));
  }
  const multi = [...shared].filter(([, s]) => s.size > 1);
  if (multi.length) {
    L.push('', '## Shared resources (inferred)', '');
    for (const [r, s] of multi) L.push(`- ${r.slice(4)} — ${[...s].map((id) => g.label(id)).join(', ')}`);
  }

  const unreach = wfs.reduce((a, w) => a + g.nodesOf(w.id).filter((n) => !reachableFromEntries(g, w.id).has(n.id)).length, 0);
  L.push('', '## Checks', '', `${unreach} unreachable node(s).`, '');
  const findings = runChecks(g);
  L.push('```', formatFindings(g, findings.slice(0, 80)).text, findings.length > 80 ? `… ${findings.length - 80} more (run flownav check)` : '', '```');

  if (g0.unresolved.length) {
    L.push('', '## Unresolved references', '', 'Never guessed; listed so an agent knows what the graph cannot see.', '');
    for (const u of g0.unresolved.slice(0, 60)) L.push(`- [${u.wf}] ${u.kind}: ${u.detail}`);
  }
  return L.join('\n') + '\n';
}
