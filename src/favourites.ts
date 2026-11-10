/**
 * The favourite marks: which recipes the cook keeps coming back to.
 *
 * A mark says nothing about the dish, only about who is cooking it, so it is
 * kept beside the recipes rather than inside them — in
 * `.cooklanger/favourites.json`, one path per favourite. A `.cook` file is
 * never rewritten for a favourite: the file is the recipe, and the next person
 * to read it has no reason to inherit this cook's shortlist.
 *
 * A recipe is marked under its path relative to the folder being browsed, so
 * two recipes that happen to share a title stay apart. Renaming the file loses
 * the mark, which is the price of keeping them apart.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** Where the marks live, relative to the directory being browsed. */
export const FAVOURITES_DIRECTORY = '.cooklanger';
export const FAVOURITES_FILENAME = 'favourites.json';

/** The marks as the rest of the app reads them, keyed by `favouriteKey`. */
export type Favourites = ReadonlySet<string>;

/** Nothing marked, for a caller with no file to read from. */
export const NO_FAVOURITES: Favourites = new Set<string>();

export function favouritesPath(root: string): string {
  return join(root, FAVOURITES_DIRECTORY, FAVOURITES_FILENAME);
}

/**
 * The key one relative path is marked under.
 *
 * Separators are written forward-slashed whatever the platform used them, so a
 * collection carried between a Mac and a Windows box marks the same recipes on
 * both.
 */
export function favouriteKey(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

export function isFavourite(favourites: Favourites, relativePath: string): boolean {
  return favourites.has(favouriteKey(relativePath));
}

/** The shape on disk: a plain array of paths, so the file reads and diffs cleanly. */
interface FavouritesFile {
  favourites?: unknown;
}

/**
 * Reads the marks under `root`.
 *
 * A missing file is the ordinary case on a collection nobody has starred yet,
 * and a corrupt one is treated the same way: a shortlist is worth less than the
 * recipes it points at, and losing it is never worth refusing to open them.
 */
export async function readFavourites(root: string): Promise<Favourites> {
  const marked = new Set<string>();

  let parsed: FavouritesFile;
  try {
    parsed = JSON.parse(await readFile(favouritesPath(root), 'utf8')) as FavouritesFile;
  } catch {
    return marked;
  }

  const listed = parsed?.favourites;
  if (!Array.isArray(listed)) return marked;

  for (const entry of listed) {
    if (typeof entry !== 'string') continue;
    const key = favouriteKey(entry.trim());
    if (key) marked.add(key);
  }
  return marked;
}

/** Writes the marks, creating `.cooklanger` if this is the first favourite. */
export async function writeFavourites(root: string, favourites: Favourites): Promise<void> {
  // Sorted, so marking two recipes in either order produces the same file.
  const listed = [...favourites].sort();
  const contents = `${JSON.stringify({ favourites: listed }, null, 2)}\n`;

  await mkdir(join(root, FAVOURITES_DIRECTORY), { recursive: true });
  await writeFile(favouritesPath(root), contents, 'utf8');
}

/** The marks with one recipe turned round, leaving the original untouched. */
export function toggleFavourite(favourites: Favourites, relativePath: string): Favourites {
  const next = new Set(favourites);
  const key = favouriteKey(relativePath);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** The marks without one recipe, for a recipe that has just stopped existing. */
export function withoutFavourite(favourites: Favourites, relativePath: string): Favourites {
  const next = new Set(favourites);
  next.delete(favouriteKey(relativePath));
  return next;
}
