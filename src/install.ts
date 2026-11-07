import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SKILL = `---
name: flownav
description: Navigate n8n workflows through a typed node graph instead of reading raw JSON. Use before reading, renaming, deleting or debugging n8n workflow nodes.
---

# flownav

Build once: \`flownav build <dir-with-exports>\` (or \`flownav sync --profile <name>\` for a live instance).
Then query the graph; do not open workflow JSON unless the graph cannot answer.

- \`flownav scan\` inventory of workflows
- \`flownav explain "<node>"\` one-screen card for a node (use \`workflow:node\` if ambiguous)
- \`flownav path A B\` ordered paths with edge kinds and labels
- \`flownav neighbors "<node>" --depth 2\`
- \`flownav find --type httpRequest --cred slack --text "api.example"\`
- \`flownav affected "<node>" --rename|--delete|--schema|--behavior\` **run before renaming or deleting a node**: references like \`$('Old Name')\` are not reliably rewritten (reportedly not inside Code nodes, and not for renames made through the API or by editing JSON), so list them first
- \`flownav callers <workflow>\` / \`calls <workflow>\` cross-workflow links
- \`flownav check\` fragile reads, dead refs, unreachable nodes, cycles, missing error handling
- \`flownav read "<node>"\` read part of a Code node: start with the default outline (size, functions, node references with line numbers), then \`--grep "text"\` or \`--lines 120-180\`. Never read a whole large node at once; every reply is capped and secrets are redacted

## When the request is not specific

- If a flownav tool replies that a name matches **several** nodes or workflows, **stop and ask the user which one**. Show the numbered candidates (workflow name > node) and wait for the answer. Never choose one yourself, and never edit a node on a guess.
- If the user names only a family or part of a name ("the RiseZ workflows", "the node with *save* in it"), run \`flownav find --match "<family>" --name "<word>"\` (\`--name\` searches node names only; \`--text\` also searches parameters and code), show the results, and ask which node they mean.
- A reply that starts with \`NOTE:\` means the name was only a partial match for a single node: tell the user which node it is and get their confirmation before changing anything.
- Once confirmed, use the \`workflow:node\` form for every later call.

Edge confidence: EXPLICIT (connection), EXTRACTED (parsed from expression/ID), INFERRED (matched by name/URL/resource). Unresolved dynamic references are listed, never guessed.
`;

export function installClaude(opts: { global?: boolean; mcp?: boolean; cwd?: string }): string[] {
  const base = opts.global ? join(homedir(), '.claude') : join(opts.cwd ?? process.cwd(), '.claude');
  const done: string[] = [];
  const skill = join(base, 'skills', 'flownav', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, SKILL);
  done.push(skill);
  if (opts.mcp) {
    const p = join(opts.cwd ?? process.cwd(), '.mcp.json');
    const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), flownav: { command: 'npx', args: ['-y', 'flownav', 'serve'] } };
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    done.push(p);
  }
  return done;
}
