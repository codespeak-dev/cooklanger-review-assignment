/**
 * What a recipe comes to, from what its ingredients are worth.
 *
 * Nothing here reads a file, calls anything, or draws anything: ingredients and
 * a registry go in, figures come out. The figures are worked out every time they
 * are shown rather than stored anywhere — they belong to the registry as it
 * stands, not to the recipe, and a recipe file should not claim to know them.
 *
 * An ingredient that cannot be turned into grams is left out of the totals and
 * counted, because a figure that quietly skipped the butter is worse than a
 * figure that says how much of the recipe it covers.
 */

import type { Registry, Nutrients, Product } from './registry.js';
import type { Amount, Component } from './parser.js';
import { GRAM, productKey, unitScale } from './units.js';

/**
 * The figures for one recipe, and how much of it they actually cover.
 *
 * There is one column rather than two: recipes are read at one person, so the
 * whole recipe and a portion of it are the same thing.
 */
export interface Nutrition {
  /** The whole recipe, at the amounts it was read at. */
  total: Nutrients;
  /** Ingredients that could be turned into grams and counted. */
  counted: number;
  /** Ingredients the recipe lists altogether. */
  listed: number;
}

/** How many grams of a product one amount of it is, if that can be told. */
export function gramsOf(amount: Amount, product: Product): number | undefined {
  // A quantity that is words rather than a number ("a pinch") weighs nothing
  // anybody can name.
  if (amount.value === undefined) return undefined;

  const { base, factor } = unitScale(amount.unit);
  const measured = amount.value * factor;
  if (base === GRAM) return measured;

  const perUnit = product.grams[base];
  // Absent means never asked; null means asked and unweighable. Neither counts.
  return typeof perUnit === 'number' ? measured * perUnit : undefined;
}

/** Scales one product's figures to `grams` of it. */
function nutrientsFor(product: Product, grams: number): Nutrients {
  const share = grams / 100;
  return {
    calories: product.per100g.calories * share,
    protein: product.per100g.protein * share,
    fat: product.per100g.fat * share,
    carbs: product.per100g.carbs * share,
  };
}

const NONE: Nutrients = { calories: 0, protein: 0, fat: 0, carbs: 0 };

function add(into: Nutrients, more: Nutrients): Nutrients {
  return {
    calories: into.calories + more.calories,
    protein: into.protein + more.protein,
    fat: into.fat + more.fat,
    carbs: into.carbs + more.carbs,
  };
}

/**
 * Adds up what a recipe's ingredients come to, against the registry.
 *
 * The ingredients are whatever the caller read — which is a recipe normalized to
 * one person — so the figures are for however much food went in, and there is no
 * dividing to do here.
 *
 * Returns nothing at all when not one ingredient could be counted: an empty
 * table of zeroes says the recipe has no calories, which is a different and
 * false claim.
 */
export function recipeNutrition(
  ingredients: readonly Component[],
  registry: Registry,
): Nutrition | undefined {
  let total = NONE;
  let counted = 0;

  for (const ingredient of ingredients) {
    const product = registry.get(productKey(ingredient.name));
    if (!product) continue;

    // One ingredient can carry several amounts — `@salt{1%tsp}` used again as
    // `@salt{2%g}` — and all of them were cooked with.
    let grams: number | undefined;
    for (const amount of ingredient.amounts) {
      const weight = gramsOf(amount, product);
      if (weight !== undefined) grams = (grams ?? 0) + weight;
    }
    if (grams === undefined) continue;

    total = add(total, nutrientsFor(product, grams));
    counted += 1;
  }

  if (counted === 0) return undefined;

  return { total, counted, listed: ingredients.length };
}
