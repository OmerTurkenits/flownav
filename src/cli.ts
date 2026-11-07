#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { ALL_CHECKS, formatFindings, runChecks } from './checks.js';
import type { CheckName } from './checks.js';
import { diagram } from './diagram.js';
import { diffGraphs } from './diff.js';
import { G } from './graph.js';
import { installClaude } from './install.js';
import { serve } from './mcp.js';
import { affected, callers, calls, explain, find, neighbors, paths, uses } from './queries.js';
import type { AffectMode } from './queries.js';
import { report, scan } from './report.js';
import { buildFromFiles, N8nApi, syncApi } from './source.js';
import { DEFAULT_DIR, graphPath, loadGraph, loadProfiles, saveGraph, saveProfiles, writeText } from './store.js';
import { FLOW_KINDS } from './types.js';
import { VERSION } from './version.js';
import { viewHtml } from './viewer.js';
import type { EdgeKind, Out } from './types.js';

const program = new Command();
program
  .name('flownav')
  .description('Typed node graph for n8n workflows. Read-only against n8n.')
  .version(VERSION)
  .option('--graph <file>', 'graph file (default .flownav/graph.json)')
  .option('--format <fmt>', 'text | json', 'text');

const opts = () => program.opts<{ graph?: string; format: string }>();
const load = (): G => new G(loadGraph(opts().graph));
const emit = (o: Out) => console.log(opts().format === 'json' ? JSON.stringify(o.data, null, 2) : o.text);

function run(fn: () => void | Promise<void>) {
  return async (...a: unknown[]) => {
    try { await fn.apply(null, a as []); } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  };
}

const kindsOpt = (s?: string): EdgeKind[] => (s ? (s.split(',') as EdgeKind[]) : FLOW_KINDS);

program
  .command('build <path>')
  .description('Build the graph from exported workflow JSON (file or directory)')
  .option('--out <dir>', 'output dir', DEFAULT_DIR)
  .option('--no-report', 'skip WORKFLOW_REPORT.md')
  .action((path: string, o: { out: string; report: boolean }) => run(() => {
    const { graph, skipped } = buildFromFiles(path);
    if (!graph.nodes.length) throw new Error(`No n8n workflows found under ${path}`);
    const p = saveGraph(graph, o.out);
    console.log(`${Object.keys(graph.workflows).length} workflow(s), ${graph.nodes.length} node(s), ${graph.edges.length} edge(s) -> ${p}`);
    if (skipped.length) console.log(`skipped ${skipped.length} non-workflow file(s)`);
    if (o.report) console.log(`report -> ${writeText(o.out, 'WORKFLOW_REPORT.md', report(new G(graph)))}`);
  })());

program
  .command('sync')
  .description('Sync from a live n8n instance (GET only, incremental)')
  .option('--profile <name>', 'saved profile')
  .option('--url <baseUrl>', 'n8n base URL')
  .option('--key-env <name>', 'env var holding the API key', 'N8N_API_KEY')
  .option('--active', 'only active workflows')
  .option('--tags <tags>', 'comma separated tags')
  .option('--name <name>', 'name filter')
  .option('--project <id>', 'project id')
  .option('--executions', 'also record last run status per workflow')
  .option('--full', 'refetch every workflow, ignoring the previous graph')
  .option('--out <dir>', 'output dir', DEFAULT_DIR)
  .action((o) => run(async () => {
    const prof = o.profile ? loadProfiles(o.out)[o.profile] : undefined;
    if (o.profile && !prof) throw new Error(`No profile "${o.profile}". Add it with: flownav profile add ${o.profile} --url <baseUrl>`);
    const baseUrl: string | undefined = o.url ?? prof?.baseUrl ?? process.env.N8N_BASE_URL;
    if (!baseUrl) throw new Error('Give --url, --profile, or set N8N_BASE_URL.');
    const keyEnv: string = prof?.keyEnv ?? o.keyEnv;
    const key = process.env[keyEnv];
    if (!key) throw new Error(`Environment variable ${keyEnv} is empty. Set it to your n8n API key.`);
    let prev;
    try { prev = loadGraph(graphPath(o.out)); } catch { /* first sync */ }
    const { graph, fetched, reused } = await syncApi({
      baseUrl, key, profile: o.profile, active: o.active, tags: o.tags, name: o.name, projectId: o.project,
      executions: o.executions, full: o.full, prev, log: (s) => console.error(s),
    });
    const p = saveGraph(graph, o.out);
    writeText(o.out, 'WORKFLOW_REPORT.md', report(new G(graph)));
    console.log(`${Object.keys(graph.workflows).length} workflow(s): ${fetched} fetched, ${reused} unchanged -> ${p}`);
  })());

program
  .command('status')
  .description('Show what the graph contains and (with --check) whether it is stale')
  .option('--check', 'compare with the live instance')
  .action((o) => run(async () => {
    const g = loadGraph(opts().graph);
    console.log(`source: ${g.source.type} ${g.source.ref}${g.source.profile ? ` (profile ${g.source.profile})` : ''}`);
    console.log(`built:  ${g.builtAt}`);
    console.log(`${Object.keys(g.workflows).length} workflow(s), ${g.nodes.length} node(s), ${g.edges.length} edge(s), ${g.unresolved.length} unresolved`);
    if (o.check && g.source.type === 'api') {
      const prof = g.source.profile ? loadProfiles()[g.source.profile] : undefined;
      const key = process.env[prof?.keyEnv ?? 'N8N_API_KEY'];
      if (!key) throw new Error('API key env var is empty; cannot check.');
      const items = await new N8nApi(g.source.ref, key).list('/workflows');
      const stale = items.filter((i) => { const w = g.workflows[String(i.id)]; return !w || w.updatedAt !== i.updatedAt; }).map((i) => String(i.id));
      const gone = Object.keys(g.workflows).filter((id) => !items.some((i) => String(i.id) === id));
      console.log(stale.length || gone.length ? `STALE: ${stale.length} changed/new, ${gone.length} removed. Run "flownav sync".` : 'up to date');
    } else if (o.check) console.log('--check applies to API graphs only; rebuild from files with "flownav build".');
  })());

const profile = program.command('profile').description('Manage n8n connection profiles (no secrets stored)');
profile
  .command('add <name>')
  .requiredOption('--url <baseUrl>')
  .option('--key-env <name>', 'env var holding the API key', 'N8N_API_KEY')
  .action((name: string, o: { url: string; keyEnv: string }) => run(() => {
    const ps = loadProfiles();
    ps[name] = { baseUrl: o.url.replace(/\/+$/, ''), keyEnv: o.keyEnv };
    saveProfiles(ps);
    console.log(`profile ${name} saved (key read from $${o.keyEnv})`);
  })());
profile.command('list').action(() => run(() => {
  for (const [n, p] of Object.entries(loadProfiles())) console.log(`${n}  ${p.baseUrl}  key=$${p.keyEnv}`);
})());
profile.command('remove <name>').action((name: string) => run(() => {
  const ps = loadProfiles();
  delete ps[name];
  saveProfiles(ps);
})());

program.command('report').description('Print the workflow report').option('--write', 'also write WORKFLOW_REPORT.md')
  .action((o) => run(() => {
    const text = report(load());
    if (o.write) writeText(DEFAULT_DIR, 'WORKFLOW_REPORT.md', text);
    console.log(text);
  })());
program.command('scan').description('Compact inventory').action(() => run(() => emit(scan(load())))());
program.command('explain <node>').description('Node card').action((n: string) => run(() => emit(explain(load(), n)))());
program
  .command('neighbors <node>')
  .option('--depth <n>', 'hops', '1')
  .option('--dir <d>', 'in | out | both', 'both')
  .option('--kinds <k>', 'comma separated edge kinds')
  .action((n: string, o) => run(() => emit(neighbors(load(), n, Number(o.depth), o.dir, kindsOpt(o.kinds))))());
program
  .command('path <from> <to>')
  .option('--max <n>', 'max paths', '5')
  .option('--kinds <k>', 'comma separated edge kinds')
  .action((a: string, b: string, o) => run(() => emit(paths(load(), a, b, Number(o.max), kindsOpt(o.kinds))))());
program
  .command('find')
  .option('--type <t>').option('--cred <c>').option('--text <t>').option('--resource <r>')
  .option('--name <text>', 'only nodes whose name contains the text').option('--workflow <w>').option('--match <text>', 'only workflows whose name contains the text (comma separated)').option('--disabled').option('--trigger')
  .action((o) => run(() => emit(find(load(), o)))());
program
  .command('affected <node>')
  .description('Impact of changing a node (default --rename)')
  .option('--rename').option('--delete').option('--schema').option('--behavior')
  .action((n: string, o) => run(() => {
    const mode: AffectMode = o.delete ? 'delete' : o.schema ? 'schema' : o.behavior ? 'behavior' : 'rename';
    emit(affected(load(), n, mode));
  })());
program.command('callers <workflow>').action((w: string) => run(() => emit(callers(load(), w)))());
program.command('calls <workflow>').action((w: string) => run(() => emit(calls(load(), w)))());
program.command('uses').requiredOption('--cred <c>').action((o) => run(() => emit(uses(load(), o.cred)))());
program
  .command('check')
  .description(`Health checks (${ALL_CHECKS.join(', ')})`)
  .option('--only <names>', 'run only these checks (comma separated)')
  .option('--fail-on <level>', 'exit 1 when a finding is at least this severe: error | warn | info | none', 'error')
  .action((o) => run(() => {
    const only = o.only ? String(o.only).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const bad = (only ?? []).filter((x) => !ALL_CHECKS.includes(x as CheckName));
    if (bad.length) throw new Error(`Unknown check "${bad.join(', ')}". Choose from: ${ALL_CHECKS.join(', ')}`);
    const rank: Record<string, number> = { error: 0, warn: 1, info: 2 };
    const failOn = String(o.failOn);
    if (failOn !== 'none' && !(failOn in rank)) throw new Error('--fail-on must be one of: error, warn, info, none');
    const g = load();
    const f = runChecks(g, only as CheckName[] | undefined);
    emit(formatFindings(g, f));
    if (failOn !== 'none' && f.some((x) => rank[x.severity] <= rank[failOn])) process.exitCode = 1;
  })());
program
  .command('diagram [workflow]')
  .description('Mermaid flowchart of a workflow, everything, or --focus <node>')
  .option('--focus <node>', 'draw only the neighbourhood of a node')
  .option('--match <text>', 'every workflow whose name contains the text (comma separated for several)')
  .option('--collapse', 'one box per workflow with the calls between them')
  .option('--depth <n>', 'hops around --focus', '2')
  .option('--no-reads', 'hide expression-reference edges')
  .option('--dir <d>', 'LR | TD', 'LR')
  .option('--out <file>', 'write to a file (.md gets a mermaid fence)')
  .action((w: string | undefined, o) => run(() => {
    const d = diagram(load(), { workflow: w, focus: o.focus, depth: Number(o.depth), reads: o.reads, dir: o.dir, match: o.match, collapse: o.collapse });
    if (d.nodes > 60) console.error(`warning: ${d.nodes} nodes is hard to read; pass a workflow or --focus`);
    if (o.out) {
      writeFileSync(o.out, o.out.endsWith('.md') ? '```mermaid\n' + d.text + '\n```\n' : d.text + '\n');
      console.log(`wrote ${o.out}`);
    } else console.log(d.text);
  })());
program
  .command('view [workflow]')
  .description('Interactive offline HTML graph (pan, zoom, search, click for node cards)')
  .option('--focus <node>', 'only the neighbourhood of a node')
  .option('--match <text>', 'every workflow whose name contains the text (comma separated for several)')
  .option('--collapse', 'one box per workflow with the calls between them')
  .option('--depth <n>', 'hops around --focus', '2')
  .option('--out <file>', 'output file', join(DEFAULT_DIR, 'view.html'))
  .option('--open', 'open it in your default browser')
  .action((w: string | undefined, o) => run(() => {
    const { html, nodes } = viewHtml(load(), { workflow: w, focus: o.focus, depth: Number(o.depth), match: o.match, collapse: o.collapse });
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, html);
    console.log(`${nodes} node(s) -> ${o.out}`);
    if (o.open) {
      const abs = resolve(o.out);
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', abs], { detached: true, stdio: 'ignore' }).unref();
      else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
    }
  })());
program.command('diff <old> <new>').action((a: string, b: string) => run(() => {
  emit(diffGraphs(JSON.parse(readFileSync(a, 'utf8')), JSON.parse(readFileSync(b, 'utf8'))));
})());
program
  .command('install <target>')
  .description('Install the agent skill (target: claude)')
  .option('--global', 'install into ~/.claude')
  .option('--mcp', 'also add flownav to .mcp.json')
  .action((t: string, o) => run(() => {
    if (t !== 'claude') throw new Error('Only "claude" is supported.');
    for (const f of installClaude(o)) console.log(`wrote ${f}`);
  })());
program.command('serve').description('Run the MCP server on stdio').action(() => run(() => serve(opts().graph))());

program.parseAsync().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
