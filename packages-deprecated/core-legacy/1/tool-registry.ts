/**
 * Tool registry queries — read-only operations on the guild.json tools catalog.
 */
import { readGuildConfig } from './guild-config.ts';

export interface ToolSummary {
  name: string;
  category: 'tools' | 'engines' | 'curricula' | 'temperaments';
  upstream: string | null;
  installedAt: string;
  bundle: string | undefined;
}

/**
 * List all installed tools/engines/curricula/temperaments from guild.json.
 */
export function listTools(home: string, category?: string): ToolSummary[] {
  const config = readGuildConfig(home);
  const results: ToolSummary[] = [];

  const categories: Array<'tools' | 'engines' | 'curricula' | 'temperaments'> =
    category
      ? [category as 'tools' | 'engines' | 'curricula' | 'temperaments']
      : ['tools', 'engines', 'curricula', 'temperaments'];

  for (const cat of categories) {
    const registry = config[cat] ?? {};
    for (const [name, entry] of Object.entries(registry)) {
      results.push({
        name,
        category: cat,
        upstream: entry.upstream,
        installedAt: entry.installedAt,
        bundle: entry.bundle,
      });
    }
  }

  return results;
}
