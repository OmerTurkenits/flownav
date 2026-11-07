import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { G } from '../dist/graph.js';
import { MAX_CHARS, readNode, redactCode } from '../dist/read.js';
import { buildFromFiles } from '../dist/source.js';
import { stats } from '../dist/stats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fn-read-'));
  const lines = Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`);
  lines[49] = 'const apiKey = "abcdef1234567890";';
  lines[59] = "const h = { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123' };";
  lines[99] = 'function helper(a) {';
  lines[109] = 'const arrow = (x) => x + 1;';
  lines[119] = "const a = $('Source').item.json.id;";
  lines[129] = 'const b = $("Source").first().json.name;';
  lines[199] = 'x'.repeat(3000) + 'needle' + 'y'.repeat(1994); // 5,000 chars
  const wf = {
    id: 'wf-big',
    name: 'Big workflow',
    nodes: [
      { name: 'Source', type: 'n8n-nodes-base.set', typeVersion: 3, position: [0, 0], parameters: { assignments: { assignments: [{ name: 'id', value: '1' }] } } },
      { name: 'Big Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: lines.join('\n') } },
      { name: 'Other Thing', type: 'n8n-nodes-base.code', typeVersion: 2, position: [400, 0], parameters: { jsCode: 'return [];' } },
    ],
    connections: {
      Source: { main: [[{ node: 'Big Code', type: 'main', index: 0 }]] },
      'Big Code': { main: [[{ node: 'Other Thing', type: 'main', index: 0 }]] },
    },
  };
  const file = join(dir, 'big.json');
  writeFileSync(file, JSON.stringify(wf, null, 2));
  const { graph } = buildFromFiles(dir);
  return { dir, file, wf, g: new G(graph), graph };
}

test('read: outline lists size, functions and node references with line numbers', async () => {
  const { g } = fixture();
  const t = (await readNode(g, { node: 'Big Code' })).text;
  assert.match(t, /Big Code · jsCode · 300 line\(s\)/);
  assert.match(t, /longest line: 5,000 chars \(minified or generated/);
  assert.match(t, /functions \(2\): L100 helper, L110 arrow/);
  assert.match(t, /Source  lines 120, 130/);
});

test('read: line ranges are numbered, open-ended ranges are capped, hints point to the next slice', async () => {
  const { g } = fixture();
  const a = (await readNode(g, { node: 'Big Code', lines: '118-122' })).text;
  assert.match(a, /\n {2}118: \/\/ line 118\n {2}119: \/\/ line 119\n {2}120: const a = \$\('Source'\)/);
  assert.match(a, /showing 118-122 of 300; next: lines 123-182/);
  const open = (await readNode(g, { node: 'Big Code', lines: '120-' })).text;
  assert.match(open, /showing 120-179 of 300; next: lines 180-239/);
  const tail = (await readNode(g, { node: 'Big Code', lines: '295-310' })).text;
  assert.match(tail, /showing 295-300 of 300 \(end\)/);
  await assert.rejects(readNode(g, { node: 'Big Code', lines: '400-410' }), /past the end/);
  await assert.rejects(readNode(g, { node: 'Big Code', lines: 'abc' }), /must look like/);
  await assert.rejects(readNode(g, { node: 'Big Code', lines: '9-3' }), /not a valid range/);
});

test('read: grep marks matches, keeps context, merges nearby hits and separates distant ones', async () => {
  const { g } = fixture();
  const sep = (await readNode(g, { node: 'Big Code', grep: 'source' })).text;
  assert.match(sep, /> 120: const a = \$\('Source'\)/);
  assert.match(sep, /> 130: const b = \$\("Source"\)/);
  assert.match(sep, /  118: \/\/ line 118/);
  assert.match(sep, / {2}--\n/);
  assert.match(sep, /2 of 2 matching line\(s\) shown/);
  const merged = (await readNode(g, { node: 'Big Code', grep: 'source', context: 6 })).text;
  assert.ok(!/ {2}--\n/.test(merged), 'overlapping windows merge into one block');
  const none = (await readNode(g, { node: 'Big Code', grep: 'nothing-here' })).text;
  assert.match(none, /no match for "nothing-here"/);
  const cs = (await readNode(g, { node: 'Big Code', grep: 'SOURCE', caseSensitive: true })).text;
  assert.match(cs, /no match/);
  const re = (await readNode(g, { node: 'Big Code', grep: 'function\\s+helper', regex: true })).text;
  assert.match(re, /> 100: function helper/);
  await assert.rejects(readNode(g, { node: 'Big Code', grep: '(', regex: true }), /Invalid regex/);
  await assert.rejects(readNode(g, { node: 'Big Code', grep: 'x'.repeat(201), regex: true }), /at most 200/);
});

test('read: secrets in code are redacted in every mode, including grep', async () => {
  const { g } = fixture();
  const lines = (await readNode(g, { node: 'Big Code', lines: '48-62' })).text;
  assert.ok(!lines.includes('abcdef1234567890'));
  assert.ok(!lines.includes('abcdefghijklmnopqrstuvwxyz0123'));
  assert.match(lines, /const apiKey = "\[REDACTED\]";/);
  const grep = (await readNode(g, { node: 'Big Code', grep: 'Bearer' })).text;
  assert.ok(!grep.includes('abcdefghijklmnopqrstuvwxyz0123'));
  // grep cannot be used as an oracle for the secret value
  assert.match((await readNode(g, { node: 'Big Code', grep: 'abcdef1234567890' })).text, /no match/);
  assert.equal(redactCode("token: 'sk-abcdefghijklmnopqrstuvwxyz'"), "token: '[REDACTED]'");
});

test('read: very long lines are windowed; cols reads inside them; output never exceeds the cap', async () => {
  const { g } = fixture();
  const hit = (await readNode(g, { node: 'Big Code', grep: 'needle' })).text;
  assert.match(hit, /> 200: …x+needle/);
  assert.match(hit, /\[\+[\d,]+ chars, 5,000 total\]/);
  const cols = (await readNode(g, { node: 'Big Code', lines: '200', cols: '3001-3010' })).text;
  assert.match(cols, /200: …needleyyyy… \[\+1,990 chars, 5,000 total\]/);
  const far = (await readNode(g, { node: 'Big Code', lines: '1', cols: '9000-9100' })).text;
  assert.match(far, /window starts at column 9000/);
  // 100 lines of 200 chars is ~20k chars: the reply must stop at the cap and say where to continue
  const dir = mkdtempSync(join(tmpdir(), 'fn-cap-'));
  const wide = { id: 'w', name: 'Wide', nodes: [{ name: 'Wide Code', type: 'n8n-nodes-base.code', parameters: { jsCode: Array.from({ length: 100 }, () => 'z'.repeat(200)).join('\n') } }], connections: {} };
  writeFileSync(join(dir, 'w.json'), JSON.stringify(wide));
  const wg = new G(buildFromFiles(dir).graph);
  const big = await readNode(wg, { node: 'Wide Code', lines: '1-100' });
  assert.ok(big.text.length <= MAX_CHARS + 400, `capped, got ${big.text.length}`);
  assert.match(big.text, /showing 1-\d+ of 100 \(output capped at 6000 chars\); next: lines \d+-/);
  const grepCap = await readNode(wg, { node: 'Wide Code', grep: 'z', max: 100, context: 0 });
  assert.ok(grepCap.text.length <= MAX_CHARS + 400);
  assert.match(grepCap.text, /matching line\(s\) shown \(output capped at 6000 chars\)/);
});

test('read: partial names warn, non-code nodes list their text parameters, param can name any text', async () => {
  const { g } = fixture();
  assert.match((await readNode(g, { node: 'Big' })).text, /^NOTE: "Big" was only a partial name/);
  await assert.rejects(readNode(g, { node: 'o' }), /matches 3 nodes\. Do not guess/);
  await assert.rejects(readNode(g, { node: 'Source' }), /no code parameter; pass param\. Text parameters: assignments\.assignments\[0\]\.name/);
  const t = (await readNode(g, { node: 'Source', param: 'assignments.assignments[0].value' })).text;
  assert.ok(t.includes('1'));
  await assert.rejects(readNode(g, { node: 'Big Code', param: 'nope' }), /is not text/);
  await assert.rejects(readNode(g, { node: 'Big Code', grep: 'a', lines: '1-2' }), /only one of/);
});

test('read: warns when the workflow changed since the graph was built, and reads the current source', async () => {
  const { g, file, wf } = fixture();
  const changed = structuredClone(wf);
  changed.nodes[1].parameters.jsCode += '\nreturn [{ json: { added: true } }];';
  writeFileSync(file, JSON.stringify(changed, null, 2));
  const t = (await readNode(g, { node: 'Big Code', lines: '300-302' })).text;
  assert.match(t, /^WARNING: this workflow changed since the graph was built/);
  assert.match(t, /301: return \[\{ json: \{ added: true \} \}\];/);
  assert.match(t, /showing 300-301 of 301 \(end\)/);
  const gone = structuredClone(wf);
  gone.nodes = gone.nodes.filter((n) => n.name !== 'Big Code');
  writeFileSync(file, JSON.stringify(gone));
  await assert.rejects(readNode(g, { node: 'Big Code' }), /no longer in the current source/);
});

test('read: from= reads exports from another folder (the graph came from an API or moved files)', async () => {
  const { g, file, dir } = fixture();
  const other = mkdtempSync(join(tmpdir(), 'fn-from-'));
  copyFileSync(file, join(other, 'copy.json'));
  rmSync(file);
  await assert.rejects(readNode(g, { node: 'Big Code' }), /Cannot read/);
  const t = (await readNode(g, { node: 'Big Code', lines: '100', from: other })).text;
  assert.match(t, /100: function helper\(a\) \{/);
  await assert.rejects(readNode(g, { node: 'Big Code', from: dir }), /was not found/);
});

test('read: an API graph without a key explains how to proceed and never calls out', async () => {
  const { graph } = fixture();
  const api = structuredClone(graph);
  api.source = { type: 'api', ref: 'http://127.0.0.1:9', profile: 'nope' };
  const saved = process.env.N8N_API_KEY;
  delete process.env.N8N_API_KEY;
  try {
    await assert.rejects(readNode(new G(api), { node: 'Big Code' }), /needs the API key in the N8N_API_KEY environment variable/);
  } finally {
    if (saved !== undefined) process.env.N8N_API_KEY = saved;
  }
});

test('mcp: flownav_read works over the protocol and ambiguity comes back as an error result', async () => {
  const { graph } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'fn-mcp-'));
  const graphFile = join(dir, 'graph.json');
  writeFileSync(graphFile, JSON.stringify(graph));
  const p = spawn(process.execPath, [join(root, 'dist', 'cli.js'), 'serve', '--graph', graphFile]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const call = (id, args) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'flownav_read', arguments: args } }) + '\n');
  call(1, { node: 'Big Code', grep: 'helper' });
  call(2, { node: 'o' });
  call(3, { node: 'Big Code', from: '/etc' });
  for (let i = 0; i < 80 && out.split('\n').filter(Boolean).length < 3; i++) await new Promise((r) => setTimeout(r, 50));
  p.kill();
  const rs = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m.result]));
  assert.match(rs[1].content[0].text, /> 100: function helper/);
  assert.equal(rs[2].isError, true);
  assert.match(rs[2].content[0].text, /Do not guess/);
  // the agent cannot point the server at arbitrary folders: "from" is not an MCP argument
  assert.match(rs[3].content[0].text, /Big Code · jsCode · 300 line/);
});

test('stats: measures raw workflow tokens against flownav replies on real files', async () => {
  const { graph } = buildFromFiles(join(root, 'examples'));
  const r = await stats(new G(graph), {});
  assert.match(r.text, /workflow\s+nodes\s+raw tokens\s+per node/);
  assert.match(r.text, /Order intake\s+15\s+[\d,]+\s+\d+/);
  assert.match(r.text, /read the whole workflow JSON\s+[\d,]+ tokens/);
  assert.match(r.text, /upper bounds/);
  assert.ok(r.data.median.explain > 0 && r.data.median.explain < r.data.median.workflow);
  assert.equal(r.data.workflows.length, 3);
});

test('read: live graph makes exactly one read-only GET for the workflow and sends the key as a header', async () => {
  const { createServer } = await import('node:http');
  const { wf, graph } = fixture();
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, key: req.headers['x-n8n-api-key'] });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/workflows/wf-big') return res.end(JSON.stringify({ ...wf, pinData: { Source: [{ json: { secret: 'pin' } }] } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, r));
  const api = structuredClone(graph);
  api.source = { type: 'api', ref: `http://127.0.0.1:${srv.address().port}` };
  const saved = process.env.N8N_API_KEY;
  process.env.N8N_API_KEY = 'test-key';
  try {
    const t = (await readNode(new G(api), { node: 'Big Code', grep: 'helper' })).text;
    assert.match(t, /> 100: function helper/);
    assert.ok(!t.includes('test-key') && !t.includes('pin'));
    assert.deepEqual(seen, [{ method: 'GET', url: '/api/v1/workflows/wf-big', key: 'test-key' }]);
  } finally {
    srv.close();
    if (saved === undefined) delete process.env.N8N_API_KEY; else process.env.N8N_API_KEY = saved;
  }
});
