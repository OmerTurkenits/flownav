import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ALL_CHECKS, formatFindings, runChecks } from './checks.js';
import type { CheckName } from './checks.js';
import { G } from './graph.js';
import { affected, callers, calls, explain, find, neighbors, paths, uses } from './queries.js';
import type { AffectMode } from './queries.js';
import { report, scan } from './report.js';
import { graphPath, loadGraph } from './store.js';
import type { Out } from './types.js';
import { VERSION } from './version.js';

type Args = Record<string, any>;
const str = { type: 'string' } as const;

const TOOLS: Array<{ name: string; description: string; schema: object; run: (g: G, a: Args) => Out | string }> = [
  { name: 'flownav_scan', description: 'Inventory: workflows, entry points, node-type histogram. Start here.', schema: {}, run: (g) => scan(g) },
  { name: 'flownav_explain', description: 'Compact card for one node: summary, labeled inputs/outputs, reads, credentials, cross-workflow links. Use "workflow:node" if the name is ambiguous. If the reply says the name matches several nodes, ask the user which; never pick one yourself.', schema: { node: str }, run: (g, a) => explain(g, a.node) },
  { name: 'flownav_neighbors', description: 'Nodes within N hops of a node.', schema: { node: str, depth: { type: 'number' }, dir: { enum: ['in', 'out', 'both'] } }, run: (g, a) => neighbors(g, a.node, a.depth ?? 1, a.dir ?? 'both') },
  { name: 'flownav_path', description: 'Shortest ordered paths between two nodes with edge kinds and labels.', schema: { from: str, to: str }, run: (g, a) => paths(g, a.from, a.to) },
  { name: 'flownav_find', description: 'Find nodes by type, credential, text, resource, disabled flag or workflow. Use match="<name part>" to search a family of workflows (e.g. match="RiseZ", name="save"). Use name= when the user refers to a node by (part of) its name; text= also searches parameters and code. If several nodes come back and the user named only part of a name, show them and ask which one.', schema: { type: str, cred: str, text: str, resource: str, workflow: str, match: str, name: str, disabled: { type: 'boolean' } }, run: (g, a) => find(g, a) },
  { name: 'flownav_affected', description: 'Run BEFORE renaming or deleting a node. Lists expressions that would break (mode rename|delete|schema|behavior). If the reply says the name matches several nodes, or starts with NOTE (a partial match), ask the user to confirm which node before changing anything.', schema: { node: str, mode: { enum: ['rename', 'delete', 'schema', 'behavior'] } }, run: (g, a) => affected(g, a.node, (a.mode ?? 'rename') as AffectMode) },
  { name: 'flownav_callers', description: 'Which workflows/nodes call this workflow (Execute Workflow, tool workflows, error workflow, webhook calls).', schema: { workflow: str }, run: (g, a) => callers(g, a.workflow) },
  { name: 'flownav_calls', description: 'What this workflow calls, plus unresolved dynamic calls.', schema: { workflow: str }, run: (g, a) => calls(g, a.workflow) },
  { name: 'flownav_uses', description: 'Nodes that use a credential (id, name or type).', schema: { credential: str }, run: (g, a) => uses(g, a.credential) },
  { name: 'flownav_check', description: `Health checks: ${ALL_CHECKS.join(', ')}. Pass only="a,b" to run some.`, schema: { only: str }, run: (g, a) => formatFindings(g, runChecks(g, a.only ? (String(a.only).split(',').map((x) => x.trim()) as CheckName[]) : undefined)) },
  { name: 'flownav_report', description: 'Full markdown workflow report.', schema: {}, run: (g) => report(g) },
];

export function serve(graphFile?: string): void {
  const file = graphFile ?? graphPath();
  let cache: { mtime: number; g: G } | undefined;
  const getG = (): G => {
    const m = statSync(file).mtimeMs;
    if (!cache || cache.mtime !== m) cache = { mtime: m, g: new G(loadGraph(file)) };
    return cache.g;
  };
  const send = (o: object) => process.stdout.write(JSON.stringify(o) + '\n');

  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        reply({ protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flownav', version: VERSION } });
      } else if (method === 'ping') {
        reply({});
      } else if (method === 'tools/list') {
        reply({
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: 'object', properties: t.schema, required: Object.keys(t.schema).filter((k) => ['node', 'from', 'to', 'workflow', 'credential'].includes(k)) },
          })),
        });
      } else if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return void fail(-32602, `Unknown tool ${params?.name}`);
        try {
          const r = tool.run(getG(), params.arguments ?? {});
          reply({ content: [{ type: 'text', text: typeof r === 'string' ? r : r.text }] });
        } catch (err) {
          reply({ isError: true, content: [{ type: 'text', text: (err as Error).message }] });
        }
      } else if (id !== undefined) {
        fail(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      fail(-32603, (err as Error).message);
    }
  });
}
