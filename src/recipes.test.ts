import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import './warnings.js';
import {
  findRecipeFiles,
  loadRecipe,
  scanRecipes,
  sortRecipes,
  type Recipe,
} from './recipes.js';

let root: string;

async function write(relativePath: string, contents: string): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, 'utf8');
  return path;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cooklanger-test-'));
  await write('pancakes.cook', '---\ntitle: Easy Pancakes\n---\n\nWhisk @eggs{3}.\n');
  await write('legacy.cook', '>> title: Roast Chicken\n\nRoast the @chicken{1}.\n');
  await write('untitled-dish.cook', 'Just add @water{1%l}.\n');
  await write('blank-title.cook', '---\ntitle: "   "\n---\n\nAdd @salt.\n');
  await write('desserts/Apple Crumble.cook', 'Bake the @apples{6}.\n');
  await write('notes.md', '# not a recipe\n');
  await write('.hidden/secret.cook', '---\ntitle: Hidden\n---\n\nAdd @salt.\n');
  await write('node_modules/pkg/vendored.cook', '---\ntitle: Vendored\n---\n\nAdd @salt.\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findRecipeFiles', () => {
  it('finds .cook files recursively and ignores other extensions', async () => {
    const files = await findRecipeFiles(root);
    const names = files.map((file) => file.slice(root.length + 1)).sort();
    assert.deepEqual(names, [
      'blank-title.cook',
      'desserts/Apple Crumble.cook',
      'legacy.cook',
      'pancakes.cook',
      'untitled-dish.cook',
    ]);
  });

  it('skips hidden and vendored directories', async () => {
    const files = await findRecipeFiles(root);
    assert.ok(!files.some((file) => file.includes('.hidden')));
    assert.ok(!files.some((file) => file.includes('node_modules')));
  });

  it('stays in the top directory when not recursive', async () => {
    const files = await findRecipeFiles(root, { recursive: false });
    assert.ok(!files.some((file) => file.includes('desserts')));
    assert.equal(files.length, 4);
  });
});

describe('loadRecipe', () => {
  it('prefers the title metadata field', async () => {
    const { recipe } = await loadRecipe(join(root, 'pancakes.cook'), root);
    assert.equal(recipe.name, 'Easy Pancakes');
    assert.equal(recipe.relativePath, 'pancakes.cook');
  });

  it('reads titles from the legacy >> metadata syntax', async () => {
    const { recipe } = await loadRecipe(join(root, 'legacy.cook'), root);
    assert.equal(recipe.name, 'Roast Chicken');
  });

  it('falls back to the filename stem when there is no title', async () => {
    const { recipe } = await loadRecipe(join(root, 'untitled-dish.cook'), root);
    assert.equal(recipe.name, 'untitled-dish');
  });

  it('treats a whitespace-only title as missing', async () => {
    const { recipe } = await loadRecipe(join(root, 'blank-title.cook'), root);
    assert.equal(recipe.name, 'blank-title');
  });

  it('reports unreadable files without throwing', async () => {
    const missing = join(root, 'does-not-exist.cook');
    const { recipe, problem } = await loadRecipe(missing, root);
    assert.equal(recipe.name, 'does-not-exist');
    assert.equal(problem?.path, missing);
  });
});

describe('scanRecipes', () => {
  it('sorts recipes by display name, not by filename', async () => {
    const { recipes, problems } = await scanRecipes(root);
    assert.deepEqual(
      recipes.map((recipe) => recipe.name),
      ['Apple Crumble', 'blank-title', 'Easy Pancakes', 'Roast Chicken', 'untitled-dish'],
    );
    assert.deepEqual(problems, []);
  });

  it('reverses the names when asked for Z→A', async () => {
    const { recipes } = await scanRecipes(root, { order: 'za' });
    assert.deepEqual(
      recipes.map((recipe) => recipe.name),
      ['untitled-dish', 'Roast Chicken', 'Easy Pancakes', 'blank-title', 'Apple Crumble'],
    );
  });

  it('returns nothing for a directory with no recipes', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'cooklanger-empty-'));
    try {
      const { recipes, problems } = await scanRecipes(empty);
      assert.deepEqual(recipes, []);
      assert.deepEqual(problems, []);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('sortRecipes', () => {
  // A literal root rather than the temporary directory: these suites sort
  // recipes without reading them, and `root` is not assigned until `before`
  // runs, which is after the body of a `describe`.
  const recipe = (name: string, relativePath: string): Recipe => ({
    name,
    path: `/recipes/${relativePath}`,
    relativePath,
    authorship: 'unknown',
  });

  const unsorted = [
    recipe('Pancakes', 'b.cook'),
    recipe('apple pie', 'a.cook'),
    recipe('Pancakes', 'a-pancakes.cook'),
  ];

  it('sorts A→Z ignoring case', () => {
    assert.deepEqual(
      sortRecipes(unsorted, 'az').map((entry) => entry.relativePath),
      ['a.cook', 'a-pancakes.cook', 'b.cook'],
    );
  });

  it('reads Z→A as A→Z backwards, ties included', () => {
    assert.deepEqual(
      sortRecipes(unsorted, 'za').map((entry) => entry.relativePath),
      ['b.cook', 'a-pancakes.cook', 'a.cook'],
    );
  });

  it('leaves the given list alone', () => {
    const original = [...unsorted];
    sortRecipes(unsorted, 'za');
    assert.deepEqual(unsorted, original);
  });
});

describe('sortRecipes with favourites', () => {
  // A literal root rather than the temporary directory: these suites sort
  // recipes without reading them, and `root` is not assigned until `before`
  // runs, which is after the body of a `describe`.
  const recipe = (name: string, relativePath: string): Recipe => ({
    name,
    path: `/recipes/${relativePath}`,
    relativePath,
    authorship: 'unknown',
  });

  const all = [
    recipe('Apple Pie', 'apple-pie.cook'),
    recipe('Bread', 'bread.cook'),
    recipe('Curry', 'curry.cook'),
    recipe('Zucchini Soup', 'soups/zucchini.cook'),
  ];

  // Turning the list round is how a cook reaches the far end of the alphabet,
  // and it must not be able to bury the shortlist on the way.
  const favourites = new Set(['apple-pie.cook', 'soups/zucchini.cook']);

  it('pins favourites above the rest, each group A\u2192Z', () => {
    assert.deepEqual(
      sortRecipes(all, 'az', favourites).map((entry) => entry.name),
      ['Apple Pie', 'Zucchini Soup', 'Bread', 'Curry'],
    );
  });

  it('keeps favourites above the rest when the names run Z\u2192A', () => {
    assert.deepEqual(
      sortRecipes(all, 'za', favourites).map((entry) => entry.name),
      ['Zucchini Soup', 'Apple Pie', 'Curry', 'Bread'],
    );
  });

  it('reads the order back to itself when the list is turned round twice', () => {
    const there = sortRecipes(all, 'za', favourites);
    assert.deepEqual(
      sortRecipes(there, 'az', favourites).map((entry) => entry.relativePath),
      sortRecipes(all, 'az', favourites).map((entry) => entry.relativePath),
    );
  });

  it('sorts on the names alone when nothing is marked', () => {
    assert.deepEqual(
      sortRecipes(all, 'az', new Set()).map((entry) => entry.name),
      sortRecipes(all, 'az').map((entry) => entry.name),
    );
  });

  it('matches a favourite by its path, not by its name', () => {
    const twins = [recipe('Soup', 'a/soup.cook'), recipe('Soup', 'b/soup.cook')];
    assert.deepEqual(
      sortRecipes(twins, 'az', new Set(['b/soup.cook'])).map((entry) => entry.relativePath),
      ['b/soup.cook', 'a/soup.cook'],
    );
  });

  it('pins a scanned folder\u2019s favourites to the top', async () => {
    const { recipes } = await scanRecipes(root, {
      order: 'az',
      favourites: new Set(['legacy.cook']),
    });
    assert.deepEqual(
      recipes.map((entry) => entry.name),
      ['Roast Chicken', 'Apple Crumble', 'blank-title', 'Easy Pancakes', 'untitled-dish'],
    );
  });
});
