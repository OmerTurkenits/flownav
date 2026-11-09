import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractRefs } from '../dist/expressions.js';
import { buildFromFiles, syncApi } from '../dist/source.js';
import { G } from '../dist/graph.js';
import { affected, callers, explain, find, paths } from '../dist/queries.js';
import { runChecks } from '../dist/checks.js';
import { outputLabels } from '../dist/build.js';
import { diffGraphs } from '../dist/diff.js';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const { graph } = buildFromFiles(examples);
const g = new G(graph);

test('expression refs: all syntaxes, fields, dynamic', () => {
  const r = extractRefs(`$('A').item.json.email + $("B").first().json["x"].y + $node["C"].json.z + $items("D") + $(name)`);
  const by = Object.fromEntries(r.refs.map((x) => [x.name, x.fields]));
  assert.deepEqual(by.A, ['email']);
  assert.deepEqual(by.B, ['x.y']);
  assert.deepEqual(by.C, ['z']);
  assert.ok('D' in by);
  assert.equal(r.dynamic, 1);
});

test('output labels', () => {
  assert.deepEqual(outputLabels({ name: 'x', type: 'n8n-nodes-base.if' }), ['true', 'false']);
  assert.deepEqual(outputLabels({ name: 'x', type: 'n8n-nodes-base.splitInBatches' }), ['done', 'loop']);
  assert.deepEqual(
    outputLabels({ name: 'x', type: 'n8n-nodes-base.switch', parameters: { rules: { values: [{ outputKey: 'paid' }, {}] }, options: { fallbackOutput: 'extra' } } }),
    ['paid', 'case 1', 'fallback'],
  );
  assert.deepEqual(outputLabels({ name: 'x', type: 'n8n-nodes-base.set', onError: 'continueErrorOutput' }), ['main', 'error']);
  // exact match, not substring: "shopify" must not look like an IF node
  assert.deepEqual(outputLabels({ name: 'x', type: 'n8n-nodes-base.shopify' }), ['main']);
});

test('typed edges: branch labels, capability, reads', () => {
  const e = graph.edges.find((x) => x.kind === 'main' && x.from === 'wf-orders::Is Large Order' && x.to === 'wf-orders::Save Order');
  assert.equal(e.label, 'false');
  assert.ok(graph.edges.some((x) => x.kind === 'capability' && x.label === 'ai_tool' && x.to === 'wf-orders::Support Agent'));
  const r = graph.edges.find((x) => x.kind === 'reads' && x.from === 'wf-orders::Normalize' && x.to === 'wf-orders::Notify Sales');
  assert.deepEqual(r.fields, ['email']);
});

test('affected --rename lists breaking readers, including code nodes', () => {
  const out = affected(g, 'Normalize', 'rename').data;
  assert.deepEqual(out.breaks.map((e) => e.to).sort(), ['wf-orders::Notify Sales', 'wf-orders::Orphan Code']);
});

test('affected --delete finds readers and callers', () => {
  assert.equal(affected(g, 'Enrich', 'delete').data.breaks.length, 1);
  assert.equal(affected(g, 'wf-enrich:When called', 'delete').data.callers.length, 2);
});

test('cross-workflow: calls, tool workflows, error workflow, webhook call', () => {
  assert.equal(callers(g, 'wf-enrich').data.length, 2);
  assert.ok(graph.edges.some((e) => e.kind === 'on_error' && e.to === 'wf-errors::Error Trigger'));
  assert.ok(graph.edges.some((e) => e.kind === 'webhook_calls' && e.from === 'wf-orders::Ping Self'));
  assert.ok(paths(g, 'Save Order', 'Shape').data.length >= 1);
});

test('checks find the planted problems and nothing noisy', () => {
  const f = runChecks(g);
  const has = (check, text) => f.some((x) => x.check === check && x.message.includes(text));
  assert.ok(has('dead-refs', 'Deleted Step'));
  assert.ok(has('fragile-reads', 'Orphan Code'));
  assert.ok(has('unreachable', 'Orphan Code'));
  assert.ok(has('cycles', 'Loop Over Items'));
  assert.ok(!f.some((x) => x.check === 'unreachable' && x.node !== 'Orphan Code'));
  assert.ok(!has('webhook-no-respond', 'Order Webhook'));
});

test('sticky notes become groups and are not nodes', () => {
  assert.equal(g.resolveNode('Is Large Order').group, 'Intake');
  assert.ok(!graph.nodes.some((n) => n.type.endsWith('stickyNote')));
});

test('secrets and pinData never reach the graph', () => {
  const json = JSON.stringify(graph);
  assert.ok(!json.includes('example-not-a-real-token-0000'));
  assert.ok(!json.includes('secret@example.com'));
});

test('ambiguity errors name candidates; find works', () => {
  assert.throws(() => g.resolveNode('Order'), /matches 5 nodes[\s\S]*use: wf-orders:Save Order/);
  assert.equal(find(g, { cred: 'slack' }).data.length, 2);
  assert.match(explain(g, 'Support Agent').text, /ai_languageModel: wf-orders:Chat Model/);
});

test('diff reports changed nodes', () => {
  const b = structuredClone(graph);
  b.nodes.find((n) => n.name === 'Normalize').hash = 'changed';
  assert.deepEqual(diffGraphs(graph, b).data.changed, ['wf-orders::Normalize']);
});

test('sync: GET only, header auth, pagination, incremental reuse', async () => {
  const wfs = ['orders', 'enrich', 'errors'].map((n) => JSON.parse(readFileSync(join(examples, `${n}.json`), 'utf8')));
  wfs.forEach((w) => { w.updatedAt = '2026-01-01T00:00:00Z'; w.versionId = 'v1'; });
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, key: req.headers['x-n8n-api-key'] });
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/v1/workflows') {
      const cursor = u.searchParams.get('cursor');
      // list without nodes, 2 pages
      const slim = (w) => ({ id: w.id, name: w.name, active: w.active, updatedAt: w.updatedAt, versionId: w.versionId });
      return res.end(JSON.stringify(cursor ? { data: [slim(wfs[2])] } : { data: [slim(wfs[0]), slim(wfs[1])], nextCursor: 'c2' }));
    }
    const m = /^\/api\/v1\/workflows\/(.+)$/.exec(u.pathname);
    const w = m && wfs.find((x) => x.id === decodeURIComponent(m[1]));
    if (w) return res.end(JSON.stringify(w));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const first = await syncApi({ baseUrl: base, key: 'test-key' });
    assert.equal(first.fetched, 3);
    assert.equal(Object.keys(first.graph.workflows).length, 3);
    assert.ok(first.graph.edges.some((e) => e.kind === 'calls'));
    const second = await syncApi({ baseUrl: base, key: 'test-key', prev: first.graph });
    assert.equal(second.reused, 3);
    assert.equal(second.fetched, 0);
    assert.ok(second.graph.edges.some((e) => e.kind === 'on_error'));
    assert.ok(seen.every((r) => r.method === 'GET' && r.key === 'test-key'));
    assert.ok(!JSON.stringify(first.graph).includes('test-key'));
  } finally {
    srv.close();
  }
});

test('diagram: mermaid with labels, dashed reads, focus subgraphs', async () => {
  const { diagram } = await import('../dist/diagram.js');
  const wf = diagram(g, { workflow: 'wf-orders' });
  assert.match(wf.text, /^flowchart LR/);
  assert.match(wf.text, /-->\|"false"\|/);
  assert.match(wf.text, /-\.->\|"reads email"\|/);
  assert.ok(!diagram(g, { workflow: 'wf-orders', reads: false }).text.includes('reads email'));
  const f = diagram(g, { focus: 'Enrich', depth: 2 });
  assert.match(f.text, /subgraph/);
  assert.match(f.text, /==>\|"tool"\|/);
});

test('literal text in "=" strings is not scanned (browser JS like $(\'form\'))', async () => {
  const { buildWorkflow } = await import('../dist/build.js');
  const r = buildWorkflow({
    nodes: [
      { name: 'Page HTML', type: 'n8n-nodes-base.set', parameters: { html: "=<script>$('form').hide(); $('#go')</script>" } },
      { name: 'Real', type: 'n8n-nodes-base.set', parameters: { v: "={{ $('Page HTML').item.json.x }} and $('form')" } },
    ],
    connections: {},
  }, 'w');
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.edges.filter((e) => e.kind === 'reads').length, 1);
});

test('code: refs inside string literals and comments are ignored, real ones kept', async () => {
  const { buildWorkflow } = await import('../dist/build.js');
  const code = [
    `const html = "<script>$('form').hide(); $(this)</script>";`,
    `const t = \`<b>\${$('Source').item.json["name"]}</b> $('inTemplateText')\`;`,
    `// $('commented')`,
    `return [{ json: { html, a: $('Source').first().json.id, b: $("Missing").item.json.x } }];`,
  ].join('\n');
  const r = buildWorkflow({
    nodes: [
      { name: 'Source', type: 'n8n-nodes-base.set', parameters: {} },
      { name: 'Page', type: 'n8n-nodes-base.code', parameters: { jsCode: code } },
    ],
    connections: {},
  }, 'w');
  const reads = r.edges.filter((e) => e.kind === 'reads');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].fields, ['id', 'name']);
  assert.deepEqual(r.unresolved.map((u) => u.detail), ['Page reads "Missing", which does not exist']);
});

test('code: $(n) over a literal list of names becomes INFERRED reads edges', async () => {
  const { buildWorkflow } = await import('../dist/build.js');
  const mk = (jsCode) => buildWorkflow({
    nodes: [
      { name: 'A', type: 'n8n-nodes-base.set', parameters: {} },
      { name: 'B', type: 'n8n-nodes-base.set', parameters: {} },
      { name: 'Ledger', type: 'n8n-nodes-base.code', parameters: { jsCode } },
    ],
    connections: {},
  }, 'w');
  const forOf = mk(`for (const n of ['A', 'B', 'Gone']) { try { $(n).all(); } catch (e) { continue; } }`);
  const reads = forOf.edges.filter((e) => e.kind === 'reads');
  assert.deepEqual(reads.map((e) => e.from).sort(), ['w::A', 'w::B']);
  assert.ok(reads.every((e) => e.confidence === 'INFERRED'));
  assert.deepEqual(forOf.unresolved.map((u) => u.kind), ['maybe-dead-ref']);

  const viaVar = mk(`const NAMES = ["A","B"]; NAMES.forEach((n) => $(n).first()); const one = 'A'; $(one);`);
  assert.equal(viaVar.edges.filter((e) => e.kind === 'reads').length, 2);
  assert.equal(viaVar.unresolved.length, 0);

  const truly = mk(`const n = getName(); $(n).first();`);
  assert.equal(truly.edges.filter((e) => e.kind === 'reads').length, 0);
  assert.deepEqual(truly.unresolved.map((u) => u.kind), ['dynamic-ref']);
});

test('view: self-contained HTML, hostile names cannot break out of the data block', async () => {
  const { viewHtml, viewPayload } = await import('../dist/viewer.js');
  const evil = structuredClone(graph);
  evil.nodes[0].name = '</script><img src=x onerror=alert(1)>';
  evil.nodes[0].summary = '<b>x</b>';
  const { html, nodes } = viewHtml(new G(evil), {});
  assert.equal(nodes, 20);
  assert.ok(!html.includes('</script><img'), 'closing script tag must be escaped');
  assert.equal((html.match(/<script/g) ?? []).length, 2);
  assert.ok(!/<(link|script)[^>]+(src|href)=/i.test(html), 'no external resources');
  const p = viewPayload(new G(graph), { focus: 'Enrich', depth: 1 });
  assert.ok(p.focus && p.nodes.length < 20 && p.edges.every((e) => p.nodes.some((n) => n.id === e.from)));
  assert.match(p.nodes[0].card, /inputs:/);
});

test('--match picks workflows by name; --collapse gives one node per workflow', async () => {
  const { diagram } = await import('../dist/diagram.js');
  const { viewPayload } = await import('../dist/viewer.js');
  const m = viewPayload(g, { match: 'order, enrich' });
  assert.deepEqual([...new Set(m.nodes.map((n) => n.wf))].sort(), ['wf-enrich', 'wf-orders']);
  assert.ok(m.edges.some((e) => e.kind === 'calls'));
  const c = viewPayload(g, { match: 'order,enrich,error', collapse: true });
  assert.equal(c.nodes.length, 3);
  const call = c.edges.find((e) => e.from === 'wf:wf-orders' && e.to === 'wf:wf-enrich');
  assert.equal(call.label, '2×');
  assert.match(c.nodes.find((n) => n.id === 'wf:wf-orders').card, /called by:\n  \(none\)/);
  assert.match(diagram(g, { match: 'order,enrich', collapse: true }).text, /w1 ==>\|"2× calls"\| w0/);
  assert.throws(() => viewPayload(g, { match: 'zzz' }), /No workflow name contains/);
  assert.throws(() => viewPayload(g, { workflow: 'wf-orders', match: 'x' }), /not both/);
  assert.throws(() => viewPayload(g, { collapse: true, focus: 'Enrich' }), /cannot be combined/);
});

test('ambiguity: several matches tell the agent to ask; partial single match asks for confirmation', () => {
  assert.throws(() => g.resolveNode('order'), (e) => /matches 5 nodes\. Do not guess: ask the user/.test(e.message) && /use: wf-orders:Save Order/.test(e.message));
  assert.throws(() => g.resolveWorkflow('e'), /matches 3 workflows\. Do not guess/);
  const fuzzy = affected(g, 'Normal', 'rename').text;
  assert.match(fuzzy, /^NOTE: "Normal" was only a partial name/);
  assert.doesNotMatch(affected(g, 'Normalize', 'rename').text, /^NOTE/);
  assert.doesNotMatch(explain(g, 'wf-orders:Normalize').text, /^NOTE/);
  assert.equal(find(g, { match: 'order,enrich', text: 'slack' }).data.length, 1);
  assert.deepEqual(find(g, { match: 'order', name: 'save' }).data.map((n) => n.name), ['Save Order']);
  assert.ok(find(g, { text: 'normalize' }).data.length > find(g, { name: 'normalize' }).data.length);
  assert.throws(() => find(g, { match: 'zzz' }), /No workflow name contains/);
});

test('mcp: ambiguity comes back as an error result the agent can relay', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'fn-'));
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify(graph));
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const p = spawn(process.execPath, [cli, 'serve', '--graph', file]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flownav_affected', arguments: { node: 'order' } } }) + '\n');
  for (let i = 0; i < 50 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 50));
  p.kill();
  const res = JSON.parse(out.split('\n')[0]).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ask the user which one/);
});

test('version comes from package.json for the CLI and the MCP server', async () => {
  const { spawnSync, spawn } = await import('node:child_process');
  const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const want = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const cli = join(root, 'dist', 'cli.js');
  assert.equal(spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).stdout.trim(), want);

  const file = join(mkdtempSync(join(tmpdir(), 'fn-')), 'graph.json');
  writeFileSync(file, JSON.stringify(graph));
  const p = spawn(process.execPath, [cli, 'serve', '--graph', file]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  for (let i = 0; i < 50 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 50));
  p.kill();
  assert.equal(JSON.parse(out.split('\n')[0]).result.serverInfo.version, want);
});

test('stripLiterals keeps offsets: same length, newlines kept, refs still found at the right place', async () => {
  const { stripLiterals, extractRefs } = await import('../dist/expressions.js');
  const code = "const a = 'x $(\"fake\") y'; // $('commented')\nconst t = `${$('Real').item.json.id} $('inText')`;\nreturn $(\"Other\").first();";
  const out = stripLiterals(code);
  assert.equal(out.length, code.length);
  assert.deepEqual([...code].map((c, i) => (c === '\n') === (out[i] === '\n')).every(Boolean), true);
  const refs = Object.fromEntries(extractRefs(code).refs.map((r) => [r.name, r.at]));
  assert.deepEqual(Object.keys(refs).sort(), ['Other', 'Real']);
  assert.equal(code.slice(refs.Real[0], refs.Real[0] + 9), "$('Real')");
  assert.equal(code.slice(refs.Other[0], refs.Other[0] + 10), '$("Other")');
});

test('affected shows the exact expression or code line under each reader', () => {
  const text = affected(g, 'wf-orders:Normalize', 'rename').text;
  assert.match(text, /text: \{\{ 'Big order from ' \+ \$\('Normalize'\)\.item\.json\.email \}\}/);
  assert.match(text, /jsCode: L1: const row = \$\('Normalize'\)\.first\(\)\.json\.email;/);
  const e = graph.edges.find((x) => x.kind === 'reads' && x.to === 'wf-orders::Orphan Code' && x.from === 'wf-orders::Normalize');
  assert.ok(e.snippets.length >= 1 && e.snippets.length <= 3);
});

test('check: --fail-on levels and comma separated --only', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'fn-')), 'graph.json');
  writeFileSync(file, JSON.stringify(graph));
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const code = (...a) => spawnSync(process.execPath, [cli, 'check', '--graph', file, ...a], { encoding: 'utf8' });
  assert.equal(code().status, 1);                                    // has an ERROR
  assert.equal(code('--fail-on', 'none').status, 0);
  assert.equal(code('--only', 'unreachable').status, 0);             // warn only, default fails on error
  assert.equal(code('--only', 'unreachable', '--fail-on', 'warn').status, 1);
  assert.equal(code('--only', 'cycles,dead-ends').status, 0);
  assert.equal(code('--only', 'cycles,dead-ends', '--fail-on', 'info').status, 1);
  assert.match(code('--only', 'nope').stderr, /Unknown check "nope"/);
  assert.match(code('--fail-on', 'loud').stderr, /--fail-on must be one of/);
});

test('the published code contains no URL strings at all (supply-chain scanners flag them)', async () => {
  const { readdirSync } = await import('node:fs');
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const hits = [];
  for (const f of readdirSync(dist).filter((x) => x.endsWith('.js'))) {
    const m = readFileSync(join(dist, f), 'utf8').match(/https?:\/\/[A-Za-z0-9./_-]+/g);
    if (m) hits.push(`${f}: ${m.join(', ')}`);
  }
  assert.deepEqual(hits, []);
});

test('ambiguity: each candidate carries context so the follow-up question can be specific', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  // the commenter's case: the same name in two workflows, different kinds of node
  const dir = mkdtempSync(join(tmpdir(), 'fn-ctx-'));
  const mk = (id, name, type, params, fedBy) => ({
    id, name,
    active: id === 'a',
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.webhook', parameters: { path: id } },
      { name: 'Clean', type: 'n8n-nodes-base.set', parameters: {} },
      { name: 'Save', type, parameters: params },
    ],
    connections: { Start: { main: [[{ node: 'Clean', type: 'main', index: 0 }]] }, Clean: { main: [[{ node: 'Save', type: 'main', index: 0 }]] } },
  });
  writeFileSync(join(dir, 'a.json'), JSON.stringify(mk('a', 'Web app', 'n8n-nodes-base.googleSheets', { operation: 'append' })));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(mk('b', 'Billing app', 'n8n-nodes-base.dataTable', { operation: 'upsert' })));
  const cg = new G(buildFromFiles(dir).graph);
  assert.throws(() => cg.resolveNode('Save'), (e) => {
    const m = e.message;
    return /matches 2 nodes\. Do not guess/.test(m)
      && /Web app › Save {2}\[googleSheets\] {2}use: a:Save\n {7}googleSheets: append · after: Clean/.test(m)
      && /Billing app › Save {2}\[dataTable\] {2}use: b:Save\n {7}dataTable: upsert · after: Clean/.test(m);
  });
  assert.throws(
    () => cg.resolveWorkflow('app'), // both names contain "app"
    (e) => /Web app {2}\[id a, 3 nodes, active\]\n {7}started by: webhook/.test(e.message) && /Billing app {2}\[id b, 3 nodes, inactive\]\n {7}started by: webhook/.test(e.message),
  );

  // sticky group, trigger and plug-in context from the bundled examples
  const m = (() => { try { g.resolveNode('order'); } catch (e) { return e.message; } })();
  assert.match(m, /Order Webhook {2}\[webhook\] {2}use: wf-orders:Order Webhook\n {7}Webhook POST \/orders \(responseNode\) · group "Intake" · starts the workflow/);
  assert.match(m, /Lookup Order {2}\[toolWorkflow\] {2}use: wf-orders:Lookup Order\n {7}Tool: Execute workflow wf-enrich · plugs into: Support Agent/);
  assert.match(m, /Loop Orders[^\n]*\n {7}splitInBatches · after: Ping Self, Nightly/);
});

test('MCP registry files stay consistent: mcpName, server.json name/version/package match package.json', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const srv = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
  assert.match(pkg.mcpName, /^io\.github\.[A-Za-z0-9-]+\/flownav$/);
  assert.equal(srv.name, pkg.mcpName);
  assert.equal(srv.version, pkg.version);
  assert.equal(srv.packages.length, 1);
  assert.equal(srv.packages[0].identifier, pkg.name);
  assert.equal(srv.packages[0].version, pkg.version);
  assert.equal(srv.packages[0].registryType, 'npm');
  assert.equal(srv.packages[0].transport.type, 'stdio');
  assert.equal(srv.repository.source, 'github');
  assert.ok(srv.description.length > 0 && srv.description.length <= 100, `description is ${srv.description.length} chars`);
  // server.json is registry metadata only: it must not ship inside the npm package
  assert.ok(!(pkg.files ?? []).includes('server.json'));
});
