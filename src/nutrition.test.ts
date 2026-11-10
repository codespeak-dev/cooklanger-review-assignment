// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withProducts, type Registry, type Nutrients, type Product } from './registry.js';
import { gramsOf, recipeNutrition } from './nutrition.js';
import { parseRecipeDocument, toPersons } from './parser.js';
import { EACH } from './units.js';

function product(
  name: string,
  per100g: Nutrients,
  grams: Record<string, number | null> = {},
): Product {
  return { name, per100g, grams };
}

function registryOf(...products: Product[]): Registry {
  return withProducts(new Map(), products);
}

/** 100 kcal and 10 g of protein per 100 g, so the arithmetic is readable. */
const SIMPLE: Nutrients = { calories: 100, protein: 10, fat: 5, carbs: 20 };

describe('gramsOf', () => {
  const oil = product('olive oil', SIMPLE, { ml: 0.91, tbsp: 13.5, [EACH]: null });

  it('takes a weight as it stands', () => {
    assert.equal(gramsOf({ value: 250, unit: 'g' }, oil), 250);
  });

  it('converts within the mass family', () => {
    assert.equal(gramsOf({ value: 1.5, unit: 'kg' }, oil), 1500);
  });

  it('weighs a volume with the density of that product', () => {
    assert.equal(gramsOf({ value: 100, unit: 'ml' }, oil), 91);
  });

  it('converts a larger volume unit before weighing it', () => {
    assert.equal(gramsOf({ value: 1, unit: 'l' }, oil), 910);
  });

  it('weighs a spoon with what a spoon of that product weighs', () => {
    assert.equal(gramsOf({ value: 3, unit: 'tbsp' }, oil), 40.5);
  });

  it('counts one whole thing with the countable weight', () => {
    const eggs = product('eggs', SIMPLE, { [EACH]: 50 });
    assert.equal(gramsOf({ value: 2 }, eggs), 100);
  });

  it('cannot weigh a unit that made no sense for the product', () => {
    assert.equal(gramsOf({ value: 2 }, oil), undefined);
  });

  it('cannot weigh a unit the registry was never asked about', () => {
    assert.equal(gramsOf({ value: 2, unit: 'cup' }, oil), undefined);
  });

  it('cannot weigh an amount written in words', () => {
    assert.equal(gramsOf({ text: 'a pinch' }, oil), undefined);
  });
});

describe('recipeNutrition', () => {
  const registry = registryOf(
    product('flour', { calories: 364, protein: 10, fat: 1, carbs: 76 }),
    product('milk', { calories: 42, protein: 3.4, fat: 1, carbs: 5 }, { ml: 1.03 }),
    product('eggs', { calories: 143, protein: 12.6, fat: 9.5, carbs: 0.7 }, { [EACH]: 50 }),
  );

  it('adds the whole recipe up from its ingredients', async () => {
    const { ingredients } = await parseRecipeDocument('Mix @flour{200%g} and @eggs{2}.\n');
    const figures = recipeNutrition(ingredients, registry);

    // 200 g of flour at 364/100 g, plus 100 g of egg at 143/100 g.
    assert.equal(figures?.total.calories, 364 * 2 + 143);
    assert.equal(figures?.counted, 2);
    assert.equal(figures?.listed, 2);
  });

  it('follows the amounts it was given, which the caller has already scaled', async () => {
    const source = '---\nservings: 4\n---\n\nMix @flour{200%g}.\n';
    const written = await parseRecipeDocument(source);
    const perPerson = await toPersons(source, written);

    assert.equal(recipeNutrition(written.ingredients, registry)?.total.calories, 364 * 2);
    assert.equal(
      recipeNutrition(perPerson.document.ingredients, registry)?.total.calories,
      (364 * 2) / 4,
    );
  });

  it('counts an ingredient it can weigh and skips one it cannot', async () => {
    const { ingredients } = await parseRecipeDocument(
      'Mix @flour{200%g}, @milk{300%ml} and @saffron{1 pinch}.\n',
    );
    const figures = recipeNutrition(ingredients, registry);

    assert.equal(figures?.counted, 2);
    assert.equal(figures?.listed, 3);
  });

  it('skips a product the registry has never heard of', async () => {
    const { ingredients } = await parseRecipeDocument('Mix @flour{200%g} and @yuzu{50%g}.\n');
    const figures = recipeNutrition(ingredients, registry);

    assert.equal(figures?.total.calories, 364 * 2);
    assert.equal(figures?.counted, 1);
  });

  it('counts every amount of an ingredient the author referred back to', async () => {
    const { ingredients } = await parseRecipeDocument(
      'Add @flour{200%g}.\n\nAdd the rest of the @&flour{50%g}.\n',
    );
    const figures = recipeNutrition(ingredients, registry);

    assert.equal(figures?.counted, 1);
    assert.equal(figures?.total.calories, 364 * 2.5);
  });

  it('says nothing at all rather than a table of zeroes', async () => {
    const { ingredients } = await parseRecipeDocument('Add @yuzu{50%g} and @sumac{1 pinch}.\n');
    assert.equal(recipeNutrition(ingredients, registry), undefined);
  });

  it('says nothing for a recipe with no ingredients', async () => {
    const { ingredients } = await parseRecipeDocument('Boil some water.\n');
    assert.equal(recipeNutrition(ingredients, registry), undefined);
  });
});
