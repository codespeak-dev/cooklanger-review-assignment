/**
 * Reading secrets out of a `.env` file.
 *
 * Small enough not to warrant a dependency: only `KEY=value` lines are
 * understood, which is all a `.env` beside the recipes ever holds. Nothing is
 * written back into `process.env`, so a key read here cannot leak into a
 * subprocess that had no business seeing it.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ENV_FILENAME = '.env';

/** How far up the tree to look before giving up. */
const MAX_ASCENT = 12;

/** Strips one layer of matching quotes, which a value may or may not have. */
function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Parses `.env` contents into a plain map, ignoring blanks and comments. */
export function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const equals = line.indexOf('=');
    if (equals <= 0) continue;

    // `export KEY=value` is common in files that double as shell snippets.
    const key = line.slice(0, equals).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    values[key] = unquote(line.slice(equals + 1).trim());
  }

  return values;
}

/**
 * Finds the nearest `.env` at or above `from` and reads it.
 *
 * Walking up means the key can live at the root of a recipe collection while
 * the browser is opened on a subdirectory of it. A missing file is not an
 * error — the environment may hold the key instead.
 */
export async function loadEnvFile(from: string): Promise<Record<string, string>> {
  let directory = resolve(from);

  for (let step = 0; step < MAX_ASCENT; step += 1) {
    try {
      return parseEnv(await readFile(join(directory, ENV_FILENAME), 'utf8'));
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  return {};
}

/**
 * The Anthropic key, from `.env` near `from` or from the environment.
 *
 * The file wins: it is the one the user was told to edit, so a stale variable
 * left over in a shell cannot quietly take precedence over it.
 */
export async function anthropicApiKey(from: string): Promise<string | undefined> {
  const fromFile = (await loadEnvFile(from)).ANTHROPIC_API_KEY?.trim();
  return fromFile || process.env.ANTHROPIC_API_KEY?.trim() || undefined;
}
