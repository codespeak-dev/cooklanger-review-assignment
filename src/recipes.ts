import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { isFavourite, NO_FAVOURITES, type Favourites } from './favourites.js';
import { parseRecipe, readAuthorship, type Authorship } from './parser.js';

export const RECIPE_EXTENSION = '.cook';

/** Directories that never contain recipes worth listing. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build']);

export interface Recipe {
  /** Display name: the `title` metadata field, else the filename stem. */
  name: string;
  /** Absolute path to the `.cook` file. */
  path: string;
  /** Path relative to the scanned directory, for display. */
  relativePath: string;
  /** Who wrote it, per its `authored_by` field, so the list can mark it. */
  authorship: Authorship;
}

export interface RecipeProblem {
  path: string;
  message: string;
}

export interface ScanResult {
  recipes: Recipe[];
  /** Files that could not be read or parsed. They still appear in `recipes`. */
  problems: RecipeProblem[];
}

export interface ScanOptions {
  /** Descend into subdirectories. Defaults to true. */
  recursive?: boolean;
  /** Which way to sort the names. Defaults to A→Z. */
  order?: SortOrder;
  /** The cook's marks, which sort above the rest. Defaults to none. */
  favourites?: Favourites;
}

function isRecipeFile(name: string): boolean {
  return name.toLowerCase().endsWith(RECIPE_EXTENSION);
}

function isSkippedDirectory(name: string): boolean {
  // Hidden directories are skipped so `.git` and friends are never walked.
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);
}

/**
 * Collects `.cook` file paths under `directory`.
 *
 * Unreadable subdirectories are skipped rather than aborting the whole walk, so
 * one bad permission does not hide every other recipe.
 */
export async function findRecipeFiles(
  directory: string,
  options: ScanOptions = {},
): Promise<string[]> {
  const recursive = options.recursive ?? true;
  const found: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);

      // A symlink reports neither isFile() nor isDirectory(), so resolve it.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (recursive && !isSkippedDirectory(entry.name)) await walk(path);
      } else if (isFile && isRecipeFile(entry.name)) {
        found.push(path);
      }
    }
  };

  await walk(directory);
  return found;
}

/** The filename without its `.cook` extension. */
function filenameStem(path: string): string {
  return basename(path).slice(0, -RECIPE_EXTENSION.length);
}

/**
 * Reads and parses a single recipe file.
 *
 * Never rejects: a file that cannot be read or parsed still yields a Recipe
 * named after its filename, paired with the problem that occurred.
 */
export async function loadRecipe(
  path: string,
  directory: string,
): Promise<{ recipe: Recipe; problem?: RecipeProblem }> {
  const base: Recipe = {
    name: filenameStem(path),
    path,
    relativePath: relative(directory, path) || basename(path),
    // A file that cannot be read cannot claim anything about who wrote it.
    authorship: 'unknown',
  };

  try {
    const source = await readFile(path, 'utf8');
    const parsed = await parseRecipe(source);
    const title = parsed.title?.trim();
    return {
      recipe: {
        ...base,
        ...(title ? { name: title } : {}),
        authorship: readAuthorship(parsed.rawMetadata),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { recipe: base, problem: { path, message } };
  }
}

/** Which way round the list runs: `az` is A→Z, `za` is Z→A. */
export type SortOrder = 'az' | 'za';

export const DEFAULT_SORT_ORDER: SortOrder = 'az';

/** Alphabetical by display name, falling back to path so ties are stable. */
export function byDisplayName(a: Recipe, b: Recipe): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.relativePath.localeCompare(b.relativePath);
}

/**
 * The comparator for one order.
 *
 * Favourites come first whichever way the names run. Turning the list round is
 * how a cook reaches the far end of the alphabet, and it should not be able to
 * bury the shortlist at the same time — so the order describes each of the two
 * groups rather than the whole list. Inside a group, Z→A is A→Z read backwards,
 * tie-break included, so turning the list round and back leaves it exactly as
 * it was.
 */
export function comparingRecipes(
  order: SortOrder,
  favourites: Favourites = NO_FAVOURITES,
): (a: Recipe, b: Recipe) => number {
  const byName = order === 'az' ? byDisplayName : (a: Recipe, b: Recipe) => byDisplayName(b, a);
  // Nothing marked means one group, and the names alone decide the whole list.
  if (favourites.size === 0) return byName;

  const rank = (recipe: Recipe): number => (isFavourite(favourites, recipe.relativePath) ? 0 : 1);
  return (a, b) => {
    const byGroup = rank(a) - rank(b);
    return byGroup !== 0 ? byGroup : byName(a, b);
  };
}

/** A copy of `recipes` in the given order. */
export function sortRecipes(
  recipes: readonly Recipe[],
  order: SortOrder,
  favourites: Favourites = NO_FAVOURITES,
): Recipe[] {
  return [...recipes].sort(comparingRecipes(order, favourites));
}

/** How an order reads in the interface, for hints and status messages. */
export function describeOrder(order: SortOrder): string {
  return order === 'az' ? 'A→Z' : 'Z→A';
}

/** Finds, parses, and sorts every recipe under `directory`. */
export async function scanRecipes(
  directory: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const files = await findRecipeFiles(directory, options);
  const loaded = await Promise.all(files.map((file) => loadRecipe(file, directory)));

  return {
    recipes: loaded
      .map(({ recipe }) => recipe)
      .sort(comparingRecipes(options.order ?? DEFAULT_SORT_ORDER, options.favourites)),
    problems: loaded.flatMap(({ problem }) => (problem ? [problem] : [])),
  };
}

/** Formats a directory for display, keeping `./` on relative paths. */
export function describeDirectory(directory: string, cwd: string): string {
  const rel = relative(cwd, directory);
  if (rel === '') return '.';
  if (rel.startsWith('..')) return directory;
  return `.${sep}${rel}`;
}
