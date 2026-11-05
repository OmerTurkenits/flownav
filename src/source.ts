import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { assemble, BUILDER_VERSION, splitGraph } from './assemble.js';
import { buildWorkflow } from './build.js';
import type { Graph, RawWorkflow, WorkflowResult } from './types.js';
import { slug } from './util.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.flownav', 'dist']);

function isWorkflow(o: any): o is RawWorkflow {
  return o && typeof o === 'object' && Array.isArray(o.nodes) && typeof o.connections === 'object';
}

export function extractWorkflows(json: unknown): RawWorkflow[] {
  if (Array.isArray(json)) return json.flatMap(extractWorkflows);
  if (isWorkflow(json)) return [json];
  const o = json as any;
  if (o && Array.isArray(o.data)) return o.data.flatMap(extractWorkflows);
  return [];
}

function collect(path: string, out: string[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      collect(join(path, e.name), out);
    }
  } else if (extname(path).toLowerCase() === '.json' && basename(path) !== 'graph.json') {
    out.push(path);
  }
}

export interface Loaded {
  raw: RawWorkflow;
  file: string;
}

export function loadFiles(path: string): { items: Loaded[]; skipped: string[] } {
  const files: string[] = [];
  collect(resolve(path), files);
  const items: Loaded[] = [];
  const skipped: string[] = [];
  for (const f of files.sort()) {
    try {
      const wfs = extractWorkflows(JSON.parse(readFileSync(f, 'utf8')));
      if (!wfs.length) skipped.push(f);
      for (const raw of wfs) {
        delete raw.pinData; // never keep execution sample data
        items.push({ raw, file: f });
      }
    } catch {
      skipped.push(f);
    }
  }
  return { items, skipped };
}

export function buildFromFiles(path: string): { graph: Graph; skipped: string[] } {
  const { items, skipped } = loadFiles(path);
  const used = new Set<string>();
  const results: WorkflowResult[] = items.map(({ raw, file }) => {
    let id = raw.id != null ? String(raw.id) : slug(basename(file, '.json'));
    for (let i = 2; used.has(id); i++) id = `${raw.id ?? slug(basename(file, '.json'))}-${i}`;
    used.add(id);
    return buildWorkflow(raw, id, file);
  });
  return { graph: assemble(results, { type: 'files', ref: resolve(path) }), skipped };
}

/* ---------------- live n8n (read-only) ---------------- */

export class N8nApi {
  private readonly base: string;
  constructor(baseUrl: string, private readonly key: string) {
    this.base = baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  }

  /** The only network method: GET. The key is sent as X-N8N-API-KEY and never logged. */
  async get(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
    const url = new URL(`${this.base}/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-N8N-API-KEY': this.key, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`n8n API returned ${res.status} for GET ${path}`);
    return res.json();
  }

  async list(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.get(path, { limit: 250, ...params, cursor });
      out.push(...(page.data ?? []));
      cursor = page.nextCursor || undefined;
    } while (cursor);
    return out;
  }
}

export interface SyncOptions {
  baseUrl: string;
  key: string;
  profile?: string;
  active?: boolean;
  tags?: string;
  name?: string;
  projectId?: string;
  executions?: boolean;
  /** ignore the previous graph and refetch everything */
  full?: boolean;
  prev?: Graph;
  log?: (s: string) => void;
}

export async function syncApi(o: SyncOptions): Promise<{ graph: Graph; fetched: number; reused: number }> {
  const api = new N8nApi(o.baseUrl, o.key);
  const items = await api.list('/workflows', {
    active: o.active, tags: o.tags, name: o.name, projectId: o.projectId,
  });
  const reusable =
    o.prev && !o.full && o.prev.builder === BUILDER_VERSION && o.prev.source.type === 'api' && o.prev.source.ref === o.baseUrl;
  const prev = reusable && o.prev ? splitGraph(o.prev) : new Map<string, WorkflowResult>();
  const results: WorkflowResult[] = [];
  let fetched = 0;
  let reused = 0;
  for (const item of items) {
    if (item.isArchived) continue;
    const id = String(item.id);
    const old = prev.get(id);
    const unchanged =
      old && item.updatedAt && old.info.updatedAt === item.updatedAt && (old.info.versionId ?? '') === (item.versionId ?? '');
    if (unchanged && !Array.isArray(item.nodes)) {
      old.info.active = item.active ?? old.info.active;
      old.info.tags = (item.tags ?? []).map((t: any) => String(t?.name ?? t));
      results.push(old);
      reused++;
      continue;
    }
    const raw: RawWorkflow = Array.isArray(item.nodes) ? item : await api.get(`/workflows/${encodeURIComponent(id)}`);
    delete raw.pinData;
    fetched++;
    results.push(buildWorkflow(raw, id));
  }

  if (o.executions) {
    try {
      const execs = await api.list('/executions', { limit: 100, includeData: false });
      const seen = new Set<string>();
      for (const e of execs) {
        const w = results.find((r) => r.info.id === String(e.workflowId));
        if (!w || seen.has(w.info.id)) continue;
        seen.add(w.info.id);
        w.info.lastRun = { status: String(e.status ?? (e.finished ? 'success' : 'unknown')), at: e.stoppedAt ?? e.startedAt };
      }
    } catch (err) {
      o.log?.(`executions skipped: ${(err as Error).message}`);
    }
  }

  const graph = assemble(results, { type: 'api', ref: o.baseUrl, profile: o.profile });
  return { graph, fetched, reused };
}
