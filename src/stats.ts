import { formatFindings, runChecks } from './checks.js';
import { G } from './graph.js';
import { affected, explain } from './queries.js';
import { loadRaw } from './read.js';
import { scan } from './report.js';
import type { Out } from './types.js';
import { trunc } from './util.js';

const tok = (s: string): number => Math.round(s.length / 4);
const fmt = (n: number): string => n.toLocaleString('en-US');

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const pct = (small: number, big: number): string => (big > 0 ? `${Math.max(0, Math.round((1 - small / big) * 100))}% fewer` : 'n/a');

/**
 * Measure, on your own workflows, how much an agent would read without flownav (the whole
 * workflow JSON) against what flownav replies with. Tokens are estimated as characters / 4.
 */
export async function stats(g: G, o: { from?: string; dir?: string }): Promise<Out> {
  const wfs = Object.values(g.g.workflows);
  const rows: Array<{ id: string; name: string; nodes: number; rawTokens: number; perNode: number }> = [];
  for (const w of wfs) {
    const raw = await loadRaw(g, w.id, o);
    delete raw.pinData;
    const rawTokens = tok(JSON.stringify(raw, null, 2));
    rows.push({ id: w.id, name: w.name, nodes: w.nodeCount, rawTokens, perNode: w.nodeCount ? Math.round(rawTokens / w.nodeCount) : 0 });
  }
  rows.sort((a, b) => b.rawTokens - a.rawTokens);

  const explainToks = g.g.nodes.map((n) => tok(explain(g, n.id).text));
  const withReaders = g.g.nodes.filter((n) => g.outE(n.id, ['reads']).length);
  const affectedToks = withReaders.map((n) => tok(affected(g, n.id, 'rename').text));
  const scanTok = tok(scan(g).text);
  const checkTok = tok(formatFindings(g, runChecks(g)).text);

  const totalRaw = rows.reduce((a, r) => a + r.rawTokens, 0);
  const totalNodes = rows.reduce((a, r) => a + r.nodes, 0);
  const medRaw = median(rows.map((r) => r.rawTokens));
  const medExplain = median(explainToks);
  const medAffected = median(affectedToks);
  const tau = totalNodes ? Math.round(totalRaw / totalNodes) : 0;

  const w = Math.min(36, Math.max(...rows.map((r) => r.name.length), 8));
  const L: string[] = [];
  L.push(`${'workflow'.padEnd(w)}  ${'nodes'.padStart(5)}  ${'raw tokens'.padStart(10)}  ${'per node'.padStart(8)}`);
  for (const r of rows) L.push(`${trunc(r.name, w).padEnd(w)}  ${String(r.nodes).padStart(5)}  ${fmt(r.rawTokens).padStart(10)}  ${String(r.perNode).padStart(8)}`);
  L.push(`${'total'.padEnd(w)}  ${String(totalNodes).padStart(5)}  ${fmt(totalRaw).padStart(10)}  ${String(tau).padStart(8)}`);
  L.push('');
  L.push('Cost of one question about one workflow (median):');
  L.push(`  read the whole workflow JSON      ${fmt(medRaw).padStart(8)} tokens`);
  L.push(`  flownav explain                   ${fmt(medExplain).padStart(8)} tokens   ${pct(medExplain, medRaw)}`);
  L.push(`  flownav affected --rename         ${fmt(medAffected).padStart(8)} tokens   ${pct(medAffected, medRaw)}${withReaders.length ? '' : '  (no references found)'}`);
  L.push('');
  L.push('Whole instance:');
  L.push(`  read every workflow               ${fmt(totalRaw).padStart(8)} tokens`);
  L.push(`  flownav scan                      ${fmt(scanTok).padStart(8)} tokens   ${pct(scanTok, totalRaw)}`);
  L.push(`  flownav check (all findings)      ${fmt(checkTok).padStart(8)} tokens   ${pct(checkTok, totalRaw)}`);
  L.push('');
  L.push(`Tokens are estimated as characters / 4 on each workflow's JSON re-printed with 2-space indentation (about ${tau} tokens per node here).`);
  L.push('These compare against an agent that reads the whole workflow. An agent that searches first reads less, so treat the percentages as upper bounds.');

  return {
    text: L.join('\n'),
    data: { workflows: rows, totalRawTokens: totalRaw, tokensPerNode: tau, median: { workflow: medRaw, explain: medExplain, affected: medAffected }, scan: scanTok, check: checkTok },
  };
}
