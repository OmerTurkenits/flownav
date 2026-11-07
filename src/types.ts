export type Confidence = 'EXPLICIT' | 'EXTRACTED' | 'INFERRED' | 'OBSERVED';

export type EdgeKind =
  | 'main'
  | 'capability'
  | 'reads'
  | 'calls'
  | 'on_error'
  | 'webhook_calls'
  | 'uses'
  | 'reads_resource'
  | 'writes_resource'
  | 'uses_resource'
  | 'responds_via';

/** Edge kinds that are recomputed across workflows on every assemble. */
export const CROSS_KINDS: EdgeKind[] = ['calls', 'on_error', 'webhook_calls'];

/** Kinds followed by path / neighbors by default (flow of data or control). */
export const FLOW_KINDS: EdgeKind[] = [
  'main', 'capability', 'reads', 'calls', 'on_error', 'webhook_calls', 'responds_via',
];

export interface RawNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string; name?: string }>;
  disabled?: boolean;
  onError?: string;
  [k: string]: unknown;
}

export interface RawWorkflow {
  id?: string | number;
  name?: string;
  active?: boolean;
  nodes?: RawNode[];
  connections?: Record<string, Record<string, Array<Array<{ node: string; type?: string; index?: number }> | null>>>;
  settings?: Record<string, unknown>;
  updatedAt?: string;
  versionId?: string;
  tags?: Array<{ name?: string } | string>;
  [k: string]: unknown;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  fields?: string[];
  params?: string[];
  /** the exact expression (or code line) that holds the reference, for reads edges */
  snippets?: Array<{ param: string; text: string }>;
  confidence: Confidence;
  outputIndex?: number;
  inputIndex?: number;
}

export interface CallRef {
  via: string;
  targetId?: string;
  targetName?: string;
  dynamic?: boolean;
  /** sub-workflow embedded in parameters, or loaded from url / local file */
  external?: string;
}

export interface GNode {
  id: string;
  wf: string;
  name: string;
  type: string;
  typeVersion?: number;
  summary: string;
  disabled: boolean;
  trigger: boolean;
  outputs: string[];
  credentials: Array<{ type: string; id: string; name?: string }>;
  group?: string;
  hash: string;
  /** searchable, redacted text of string parameters (truncated) */
  text: string;
  onError?: string;
  webhook?: { path: string; method?: string; responseMode?: string };
  httpUrls?: string[];
  calls?: CallRef[];
}

export interface WorkflowInfo {
  id: string;
  name: string;
  active?: boolean;
  updatedAt?: string;
  versionId?: string;
  tags?: string[];
  file?: string;
  errorWorkflow?: string;
  nodeCount: number;
  hash: string;
  groups: Array<{ name: string; nodes: string[] }>;
  lastRun?: { status: string; at?: string };
}

export interface Unresolved {
  scope: 'local' | 'cross';
  wf: string;
  node?: string;
  kind: string;
  detail: string;
}

export interface Graph {
  version: 1;
  /** parser revision; sync rebuilds everything when it differs */
  builder?: number;
  builtAt: string;
  source: { type: 'files' | 'api'; ref: string; profile?: string };
  workflows: Record<string, WorkflowInfo>;
  nodes: GNode[];
  edges: Edge[];
  unresolved: Unresolved[];
}

export interface WorkflowResult {
  info: WorkflowInfo;
  nodes: GNode[];
  edges: Edge[];
  unresolved: Unresolved[];
}

export interface Out {
  text: string;
  data: unknown;
}
