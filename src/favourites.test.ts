import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import './warnings.js';
import {
  favouriteKey,
  favouritesPath,
  isFavourite,
  readFavourites,
  toggleFavourite,
  withoutFavourite,
  writeFavourites,
} from './favourites.js';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cooklanger-favourites-'));
});

beforeEach(async () => {
  await rm(join(root, '.cooklanger'), { recursive: true, force: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes the marks file by hand, to read something the app did not write. */
async function writeRaw(contents: string): Promise<void> {
  await mkdir(join(root, '.cooklanger'), { recursive: true });
  await writeFile(favouritesPath(root), contents, 'utf8');
}

describe('readFavourites', () => {
  it('reads nothing from a collection nobody has starred', async () => {
    const favourites = await readFavourites(root);
    assert.equal(favourites.size, 0);
  });

  it('reads a file the app wrote', async () => {
    await writeFavourites(root, new Set(['soups/tomato-soup.cook', 'pancakes.cook']));

    const favourites = await readFavourites(root);
    assert.equal(favourites.size, 2);
    assert.ok(isFavourite(favourites, 'pancakes.cook'));
    assert.ok(isFavourite(favourites, 'soups/tomato-soup.cook'));
    assert.ok(!isFavourite(favourites, 'curry.cook'));
  });

  // A shortlist is worth less than the recipes it points at, so nothing about a
  // broken one is worth refusing to open them over.
  it('reads a corrupt file as an empty one', async () => {
    await writeRaw('{ this is not json');
    assert.equal((await readFavourites(root)).size, 0);
  });

  it('reads a file of the wrong shape as an empty one', async () => {
    await writeRaw('{"favourites":"pancakes.cook"}');
    assert.equal((await readFavourites(root)).size, 0);
  });

  it('skips entries that are not paths, keeping the ones that are', async () => {
    await writeRaw('{"favourites":["pancakes.cook",7,null,"  ","curry.cook"]}');

    const favourites = await readFavourites(root);
    assert.deepEqual([...favourites].sort(), ['curry.cook', 'pancakes.cook']);
  });
});

describe('writeFavourites', () => {
  it('creates the state directory on the first favourite', async () => {
    await writeFavourites(root, new Set(['pancakes.cook']));
    assert.match(await readFile(favouritesPath(root), 'utf8'), /pancakes\.cook/);
  });

  // Sorted, so marking two recipes in either order produces the same file.
  it('writes the same file whichever order the marks were made in', async () => {
    await writeFavourites(root, new Set(['b.cook', 'a.cook']));
    const first = await readFile(favouritesPath(root), 'utf8');

    await writeFavourites(root, new Set(['a.cook', 'b.cook']));
    assert.equal(await readFile(favouritesPath(root), 'utf8'), first);
  });

  it('writes an empty list once the last favourite is dropped', async () => {
    await writeFavourites(root, new Set(['pancakes.cook']));
    await writeFavourites(root, new Set());

    assert.equal((await readFavourites(root)).size, 0);
    assert.deepEqual(JSON.parse(await readFile(favouritesPath(root), 'utf8')), {
      favourites: [],
    });
  });
});

describe('favouriteKey', () => {
  it('leaves a forward-slashed path alone', () => {
    assert.equal(favouriteKey('soups/tomato-soup.cook'), 'soups/tomato-soup.cook');
  });

  // A collection carried between platforms marks the same recipes on both.
  it('matches a path however the platform separates it', async () => {
    await writeRaw('{"favourites":["soups/tomato-soup.cook"]}');
    const favourites = await readFavourites(root);
    assert.ok(isFavourite(favourites, join('soups', 'tomato-soup.cook')));
  });
});

describe('toggleFavourite', () => {
  it('marks a recipe that was not marked', () => {
    const marked = toggleFavourite(new Set(), 'pancakes.cook');
    assert.ok(isFavourite(marked, 'pancakes.cook'));
  });

  it('unmarks a recipe that was marked', () => {
    const marked = toggleFavourite(new Set(['pancakes.cook']), 'pancakes.cook');
    assert.ok(!isFavourite(marked, 'pancakes.cook'));
  });

  it('leaves the marks it was given untouched', () => {
    const before = new Set(['pancakes.cook']);
    toggleFavourite(before, 'curry.cook');
    assert.deepEqual([...before], ['pancakes.cook']);
  });
});

describe('withoutFavourite', () => {
  it('drops the mark on a recipe that has stopped existing', () => {
    const left = withoutFavourite(new Set(['pancakes.cook', 'curry.cook']), 'curry.cook');
    assert.deepEqual([...left], ['pancakes.cook']);
  });

  // Unlike toggling, dropping a mark that is not there is not the same as making
  // one: a deleted recipe nobody had starred leaves the shortlist alone.
  it('does nothing for a recipe that was not marked', () => {
    const left = withoutFavourite(new Set(['pancakes.cook']), 'curry.cook');
    assert.deepEqual([...left], ['pancakes.cook']);
  });
});
