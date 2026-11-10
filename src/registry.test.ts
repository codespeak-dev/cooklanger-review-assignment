// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  REGISTRY_DIRECTORY,
  registryPath,
  lookupPrompt,
  missingNeeds,
  neededProducts,
  parseLookup,
  readRegistry,
  withProducts,
  writeRegistry,
  type Registry,
  type Product,
} from './registry.js';
import { parseRecipeDocument } from './parser.js';
import { EACH } from './units.js';

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cooklanger-registry-'));
}

function product(name: string, grams: Record<string, number | null> = {}): Product {
  return { name, per100g: { calories: 100, protein: 1, fat: 2, carbs: 3 }, grams };
}

function registryOf(...products: Product[]): Registry {
  return withProducts(new Map(), products);
}

async function ingredientsOf(source: string) {
  return (await parseRecipeDocument(source)).ingredients;
}

describe('neededProducts', () => {
  it('lists every ingredient, with the units it is measured in', async () => {
    const needs = neededProducts(
      await ingredientsOf('Mix @flour{250%g} with @milk{300%ml} and @eggs{2}.\n'),
    );

    assert.deepEqual(needs, [
      { name: 'flour', units: [] },
      { name: 'milk', units: ['ml'] },
      { name: 'eggs', units: [EACH] },
    ]);
  });

  it('asks nothing about a weight, which is already grams', async () => {
    const needs = neededProducts(await ingredientsOf('Weigh @butter{1.5%kg}.\n'));
    assert.deepEqual(needs, [{ name: 'butter', units: [] }]);
  });

  it('keeps an ingredient with no amount at all', async () => {
    const needs = neededProducts(await ingredientsOf('Season with @pepper{}.\n'));
    assert.deepEqual(needs, [{ name: 'pepper', units: [] }]);
  });

  it('asks about a unit the author invented, since it can still be weighed', async () => {
    const needs = neededProducts(await ingredientsOf('Add @basil{1 handful}.\n'));
    assert.deepEqual(needs, [{ name: 'basil', units: ['handful'] }]);
  });

  it('has no unit to ask about for an amount that is not a number', async () => {
    const needs = neededProducts(await ingredientsOf('Add @basil{1-2 handfuls}.\n'));
    assert.deepEqual(needs, [{ name: 'basil', units: [] }]);
  });

  it('folds the same product used twice into one need', async () => {
    const needs = neededProducts(
      await ingredientsOf('Add @salt{1%tsp}.\n\nAdd more @Salt{2%g}.\n'),
    );
    assert.deepEqual(needs, [{ name: 'salt', units: ['tsp'] }]);
  });
});

describe('missingNeeds', () => {
  it('asks about a product the registry has never seen', () => {
    const missing = missingNeeds(registryOf(product('flour')), [{ name: 'milk', units: ['ml'] }]);
    assert.deepEqual(missing, [{ name: 'milk', units: ['ml'] }]);
  });

  it('asks nothing about a product it already knows', () => {
    const missing = missingNeeds(registryOf(product('flour')), [{ name: 'flour', units: [] }]);
    assert.deepEqual(missing, []);
  });

  it('asks only about the unit that is new', () => {
    const known = product('olive oil', { ml: 0.91 });
    const missing = missingNeeds(registryOf(known), [
      { name: 'olive oil', units: ['ml', 'tbsp'] },
    ]);
    assert.deepEqual(missing, [{ name: 'olive oil', units: ['tbsp'] }]);
  });

  it('does not ask again about a unit that came back unweighable', () => {
    const known = product('flour', { clove: null });
    const missing = missingNeeds(registryOf(known), [{ name: 'flour', units: ['clove'] }]);
    assert.deepEqual(missing, []);
  });
});

describe('withProducts', () => {
  it('keeps units learned earlier when a later lookup adds one', () => {
    const merged = withProducts(registryOf(product('olive oil', { ml: 0.91 })), [
      product('olive oil', { tbsp: 13.5 }),
    ]);

    assert.deepEqual(merged.get('olive oil')?.grams, { ml: 0.91, tbsp: 13.5 });
  });

  it('keeps the name the product was first seen under', () => {
    const merged = withProducts(registryOf(product('Olive Oil')), [product('olive oil')]);
    assert.equal(merged.get('olive oil')?.name, 'Olive Oil');
  });

  it('leaves the registry it was given alone', () => {
    const original = registryOf(product('flour'));
    withProducts(original, [product('milk')]);
    assert.equal(original.size, 1);
  });
});

describe('the registry file', () => {
  it('reads back what it wrote', async () => {
    const root = await directory();
    await writeRegistry(root, registryOf(product('eggs', { [EACH]: 50 })));

    const read = await readRegistry(root);
    assert.deepEqual(read.get('eggs'), {
      name: 'eggs',
      per100g: { calories: 100, protein: 1, fat: 2, carbs: 3 },
      grams: { [EACH]: 50 },
    });
  });

  it('lands in the .cooklanger directory, creating it', async () => {
    const root = await directory();
    await writeRegistry(root, registryOf(product('flour')));

    assert.equal(registryPath(root), join(root, REGISTRY_DIRECTORY, 'products.json'));
    assert.match(await readFile(registryPath(root), 'utf8'), /"flour"/);
  });

  it('writes products in a stable order, so the file diffs cleanly', async () => {
    const root = await directory();
    await writeRegistry(root, registryOf(product('milk'), product('butter'), product('flour')));

    const written = await readFile(registryPath(root), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(written).products), ['butter', 'flour', 'milk']);
  });

  it('is empty rather than an error when there is no file', async () => {
    assert.equal((await readRegistry(await directory())).size, 0);
  });

  it('is empty rather than an error when the file is corrupt', async () => {
    const root = await directory();
    await mkdir(join(root, REGISTRY_DIRECTORY), { recursive: true });
    await writeFile(registryPath(root), 'not json at all', 'utf8');

    assert.equal((await readRegistry(root)).size, 0);
  });

  it('drops a product whose figures are not numbers', async () => {
    const root = await directory();
    await mkdir(join(root, REGISTRY_DIRECTORY), { recursive: true });
    await writeFile(
      registryPath(root),
      JSON.stringify({
        products: {
          flour: { per100g: { calories: 364, protein: 10, fat: 1, carbs: 76 }, grams: {} },
          milk: { per100g: { calories: 'lots' }, grams: {} },
        },
      }),
      'utf8',
    );

    const read = await readRegistry(root);
    assert.deepEqual([...read.keys()], ['flour']);
  });
});

describe('lookupPrompt', () => {
  it('names the units each product has to be weighed in', () => {
    const prompt = lookupPrompt([
      { name: 'olive oil', units: ['tbsp', 'ml'] },
      { name: 'flour', units: [] },
    ]);

    assert.match(prompt, /- olive oil \(units: tbsp, ml\)/);
    assert.match(prompt, /- flour$/m);
  });

  it('spells the countable unit as a word', () => {
    assert.match(lookupPrompt([{ name: 'eggs', units: [EACH] }]), /\(units: each\)/);
  });
});

describe('parseLookup', () => {
  const needs = [{ name: 'eggs', units: [EACH] }];

  const answer = (products: unknown): string => JSON.stringify({ products });

  it('reads a product and its unit weights', () => {
    const products = parseLookup(
      answer([
        {
          name: 'eggs',
          calories: 143,
          protein: 12.6,
          fat: 9.5,
          carbs: 0.7,
          units: [{ unit: 'each', grams: 50 }],
        },
      ]),
      needs,
    );

    assert.deepEqual(products, [
      {
        name: 'eggs',
        per100g: { calories: 143, protein: 12.6, fat: 9.5, carbs: 0.7 },
        grams: { [EACH]: 50 },
      },
    ]);
  });

  it('records a unit the model could not weigh, so it is not asked again', () => {
    const [oil] = parseLookup(
      answer([
        {
          name: 'olive oil',
          calories: 884,
          protein: 0,
          fat: 100,
          carbs: 0,
          units: [{ unit: 'each', grams: null }],
        },
      ]),
      [{ name: 'olive oil', units: [EACH] }],
    );

    assert.deepEqual(oil?.grams, { [EACH]: null });
  });

  it('records a unit the model simply left out', () => {
    const [oil] = parseLookup(
      answer([{ name: 'olive oil', calories: 884, protein: 0, fat: 100, carbs: 0, units: [] }]),
      [{ name: 'olive oil', units: ['tbsp'] }],
    );

    assert.deepEqual(oil?.grams, { tbsp: null });
  });

  it('drops a product nobody asked about', () => {
    const products = parseLookup(
      answer([
        { name: 'eggs', calories: 143, protein: 12.6, fat: 9.5, carbs: 0.7, units: [] },
        { name: 'caviar', calories: 264, protein: 25, fat: 18, carbs: 4, units: [] },
      ]),
      needs,
    );

    assert.deepEqual(
      products.map((entry) => entry.name),
      ['eggs'],
    );
  });

  it('answers under the name that was asked, not the one that came back', () => {
    const [eggs] = parseLookup(
      answer([{ name: 'EGGS', calories: 143, protein: 12.6, fat: 9.5, carbs: 0.7, units: [] }]),
      [{ name: 'Eggs', units: [] }],
    );

    assert.equal(eggs?.name, 'Eggs');
  });

  it('drops a product with a missing figure', () => {
    const products = parseLookup(answer([{ name: 'eggs', calories: 143, units: [] }]), needs);
    assert.deepEqual(products, []);
  });

  it('refuses an answer that is not JSON', () => {
    assert.throws(() => parseLookup('sorry, no idea', needs), /unreadable/);
  });

  it('refuses an answer with no products in it', () => {
    assert.throws(() => parseLookup(JSON.stringify({ ok: true }), needs), /unreadable/);
  });
});
