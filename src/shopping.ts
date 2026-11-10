/**
 * The shopping list: recipes the cook plans to make, and what to buy for them.
 *
 * Nothing here reads a file or draws anything. Recipes go in already scaled to
 * the number of people they are for, and come out as one line per product with
 * the amounts added up, which is what a shopping list is.
 */

import type { Amount, Component } from './parser.js';
import { formatAmount, productKey, UNIT_FAMILIES, unitScale } from './units.js';

// Re-exported because a shopping list is where a formatted amount is read.
export { formatAmount };

/** One recipe on the list, scaled for a number of people. */
export interface ShoppingEntry {
  /** Absolute path to the `.cook` file, which is what identifies the recipe. */
  path: string;
  name: string;
  persons: number;
  /** Ingredients already scaled to `persons`. */
  ingredients: readonly Component[];
  /**
   * Set when the recipe does not say how many people it serves, so its amounts
   * are the ones the author wrote rather than amounts for `persons`.
   */
  unscaled?: boolean;
}

/** One product to buy: a name and everything to be bought of it. */
export interface ShoppingProduct {
  name: string;
  /** Summed amounts, in reading order: measured first, then plain words. */
  amounts: string[];
}

/** A running total for one bucket of one product. */
interface Total {
  value: number;
  /** The unit the total is kept in, which is the family's base unit. */
  unit?: string;
  family?: string;
}

function formatTotal(total: Total): string {
  const family = UNIT_FAMILIES.find((candidate) => candidate.family === total.family);
  if (family?.large && Math.abs(total.value) >= family.large.step) {
    return `${formatAmount(total.value / family.large.step)} ${family.large.unit}`;
  }
  return total.unit ? `${formatAmount(total.value)} ${total.unit}` : formatAmount(total.value);
}

/** Everything collected for one product before it is formatted. */
interface Collected {
  name: string;
  /** Summed amounts, keyed by unit bucket, in the order first seen. */
  totals: Map<string, Total>;
  /** Amounts that are words rather than numbers, each kept once. */
  texts: string[];
}

function addAmount(collected: Collected, amount: Amount): void {
  if (amount.value === undefined) {
    const text = amount.text?.trim();
    if (text && !collected.texts.includes(text)) collected.texts.push(text);
    return;
  }

  const { key, factor } = unitScale(amount.unit);
  const existing = collected.totals.get(key);
  if (existing) {
    existing.value += amount.value * factor;
    return;
  }

  const family = UNIT_FAMILIES.find((candidate) => candidate.family === key);
  collected.totals.set(key, {
    value: amount.value * factor,
    unit: family ? family.base : amount.unit?.trim() || undefined,
    family: family?.family,
  });
}

/**
 * Folds the entries into one line per product, alphabetically by name.
 *
 * A product bought in units that cannot be converted into one another keeps
 * both figures ("1 kg, 3 cups") rather than being guessed into a single one.
 */
export function buildShoppingList(entries: readonly ShoppingEntry[]): ShoppingProduct[] {
  const collected = new Map<string, Collected>();

  for (const entry of entries) {
    for (const ingredient of entry.ingredients) {
      const key = productKey(ingredient.name);
      if (!key) continue;

      let product = collected.get(key);
      if (!product) {
        product = { name: ingredient.name.trim(), totals: new Map(), texts: [] };
        collected.set(key, product);
      }

      // An ingredient with no quantity at all still belongs on the list: it has
      // to be bought, just in whatever amount the shop sells it in.
      for (const amount of ingredient.amounts) addAmount(product, amount);
    }
  }

  return [...collected.values()]
    .map((product) => ({
      name: product.name,
      amounts: [...[...product.totals.values()].map(formatTotal), ...product.texts],
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The list as plain text, one product per line, for the clipboard. */
export function shoppingText(products: readonly ShoppingProduct[]): string {
  return products
    .map((product) => {
      const amounts = product.amounts.join(', ');
      return amounts ? `- ${amounts} ${product.name}` : `- ${product.name}`;
    })
    .join('\n');
}

/**
 * Adds a recipe to the list, or resets the one already on it.
 *
 * Adding a recipe twice is a correction rather than a doubling, so the second
 * count replaces the first; a count of zero takes the recipe off the list.
 */
export function withEntry(
  entries: readonly ShoppingEntry[],
  entry: ShoppingEntry,
): ShoppingEntry[] {
  const rest = entries.filter((existing) => existing.path !== entry.path);
  return entry.persons > 0 ? [...rest, entry] : rest;
}

/**
 * How much of a recipe to make for `persons`.
 *
 * A recipe that says how many it serves is scaled by the ratio; one that does
 * not is left as written, since there is nothing to scale from.
 */
export function scaleFor(persons: number, servings: number | undefined): number | undefined {
  if (!servings || servings <= 0) return undefined;
  // Deliberately not rounded: a third of a recipe scaled from a rounded 0.333
  // drifts by enough to show up in the totals.
  return persons / servings;
}
