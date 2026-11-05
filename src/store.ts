import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Graph } from './types.js';

export const DEFAULT_DIR = '.flownav';

export const graphPath = (dir = DEFAULT_DIR): string => join(dir, 'graph.json');

export function saveGraph(g: Graph, dir = DEFAULT_DIR): string {
  const p = graphPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(g));
  return p;
}

export function loadGraph(path?: string): Graph {
  const p = path ?? graphPath();
  if (!existsSync(p)) throw new Error(`No graph at ${p}. Run "flownav build <dir>" or "flownav sync" first.`);
  const g = JSON.parse(readFileSync(p, 'utf8')) as Graph;
  if (g.version !== 1) throw new Error(`Unsupported graph version ${g.version}`);
  return g;
}

export function writeText(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

/* Profiles hold the base URL and the NAME of the env var with the key, never the key. */
export interface Profile {
  baseUrl: string;
  keyEnv: string;
}

export const profilesPath = (dir = DEFAULT_DIR): string => join(dir, 'profiles.json');

export function loadProfiles(dir = DEFAULT_DIR): Record<string, Profile> {
  const p = profilesPath(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

export function saveProfiles(profiles: Record<string, Profile>, dir = DEFAULT_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(profilesPath(dir), JSON.stringify(profiles, null, 2));
}
