/**
 * The product registry: what cooklanger knows about the food in the recipes.
 *
 * A Cooklang file says how much of an ingredient a recipe uses and nothing
 * about what that ingredient is worth, so the figures are kept beside the
 * recipes rather than inside them — in `.cooklanger/products.json`, one entry
 * per product however many recipes call for it. A recipe file stays a recipe;
 * nothing a model guessed about calories is ever written into one.
 *
 * The registry is also what keeps the lookups cheap: a product is asked about
 * once, and every recipe that uses it afterwards is free.
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Component } from './parser.js';
import { EACH, GRAM, productKey, unitScale } from './units.js';

/** Where the registry lives, relative to the directory being browsed. */
export const REGISTRY_DIRECTORY = '.cooklanger';
export const REGISTRY_FILENAME = 'products.json';

/** What one amount of food is worth. Every figure is per 100 g of product. */
export interface Nutrients {
  /** Energy in kilocalories, which is what a cook means by "calories". */
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

export interface Product {
  /** The name as it was first seen, for display and for asking again. */
  name: string;
  per100g: Nutrients;
  /**
   * What one of each unit of this product weighs, in grams.
   *
   * `null` records a unit that could not be weighed — "a clove of flour" — so
   * the same impossible question is not asked a second time. Grams are absent
   * because they need no conversion.
   */
  grams: Record<string, number | null>;
}

/** The registry as the rest of the app reads it, keyed by `productKey`. */
export type Registry = ReadonlyMap<string, Product>;

/** One product a recipe needs figures for, and the units it is measured in. */
export interface ProductNeed {
  name: string;
  /** Canonical units, `EACH` for a count. Never grams, which need no weighing. */
  units: string[];
}

export function registryPath(root: string): string {
  return join(root, REGISTRY_DIRECTORY, REGISTRY_FILENAME);
}

/** The shape on disk: a plain object, so the file reads and diffs cleanly. */
interface RegistryFile {
  products?: Record<string, unknown>;
}

/** Reads one product out of the file, refusing anything malformed. */
function toProduct(name: string, raw: unknown): Product | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { per100g, grams } = raw as { per100g?: unknown; grams?: unknown };
  if (typeof per100g !== 'object' || per100g === null) return undefined;

  const figures = per100g as Record<string, unknown>;
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

  const calories = number(figures.calories);
  const protein = number(figures.protein);
  const fat = number(figures.fat);
  const carbs = number(figures.carbs);
  if (calories === undefined || protein === undefined || fat === undefined || carbs === undefined) {
    return undefined;
  }

  const weights: Record<string, number | null> = {};
  if (typeof grams === 'object' && grams !== null) {
    for (const [unit, value] of Object.entries(grams as Record<string, unknown>)) {
      weights[unit] = number(value) ?? null;
    }
  }

  return { name, per100g: { calories, protein, fat, carbs }, grams: weights };
}

/**
 * Reads the registry under `root`.
 *
 * A missing file is the ordinary case on a collection nobody has priced yet,
 * and a corrupt one is treated the same way: the registry is a cache of answers
 * that can be asked for again, so it is never worth failing over.
 */
export async function readRegistry(root: string): Promise<Registry> {
  const products = new Map<string, Product>();

  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(await readFile(registryPath(root), 'utf8')) as RegistryFile;
  } catch {
    return products;
  }

  for (const [key, raw] of Object.entries(parsed?.products ?? {})) {
    const product = toProduct(key, raw);
    if (product) products.set(productKey(key), product);
  }
  return products;
}

/** Writes the registry, creating `.cooklanger` if this is the first product. */
export async function writeRegistry(root: string, registry: Registry): Promise<void> {
  // Sorted, so two runs that learned the same products produce the same file.
  const products: Record<string, unknown> = {};
  for (const key of [...registry.keys()].sort()) {
    const product = registry.get(key)!;
    products[product.name] = { per100g: product.per100g, grams: product.grams };
  }

  await mkdir(join(root, REGISTRY_DIRECTORY), { recursive: true });
  await writeFile(registryPath(root), `${JSON.stringify({ products }, null, 2)}\n`, 'utf8');
}

/** The registry with `learned` folded in, leaving the original untouched. */
export function withProducts(registry: Registry, learned: readonly Product[]): Registry {
  const merged = new Map(registry);

  for (const product of learned) {
    const key = productKey(product.name);
    if (!key) continue;
    const existing = merged.get(key);
    merged.set(key, {
      // The name first seen is kept: it is the one the recipes are written with.
      name: existing?.name ?? product.name,
      per100g: product.per100g,
      // Units already known survive, so a top-up never forgets an earlier answer.
      grams: { ...existing?.grams, ...product.grams },
    });
  }

  return merged;
}

/**
 * What a recipe's ingredients would have to be priced in.
 *
 * Every ingredient is a product, whether or not it carries an amount: the
 * registry is meant to cover the food in the collection, and an ingredient
 * written without a quantity is still something that was cooked with.
 */
export function neededProducts(ingredients: readonly Component[]): ProductNeed[] {
  const needs = new Map<string, ProductNeed>();

  for (const ingredient of ingredients) {
    const key = productKey(ingredient.name);
    if (!key) continue;

    let need = needs.get(key);
    if (!need) {
      need = { name: ingredient.name.trim(), units: [] };
      needs.set(key, need);
    }

    for (const amount of ingredient.amounts) {
      // A quantity that is words rather than a number ("a pinch") cannot be
      // weighed, so there is no unit to ask about.
      if (amount.value === undefined) continue;
      const { base } = unitScale(amount.unit);
      if (base === GRAM) continue;
      if (!need.units.includes(base)) need.units.push(base);
    }
  }

  return [...needs.values()];
}

/**
 * The part of `needs` the registry cannot answer yet.
 *
 * A product already priced but measured in a new unit comes back carrying only
 * that unit, so a recipe using olive oil by the tablespoon does not pay for the
 * whole product again.
 */
export function missingNeeds(registry: Registry, needs: readonly ProductNeed[]): ProductNeed[] {
  const missing: ProductNeed[] = [];

  for (const need of needs) {
    const known = registry.get(productKey(need.name));
    if (!known) {
      missing.push(need);
      continue;
    }
    const units = need.units.filter((unit) => !(unit in known.grams));
    if (units.length > 0) missing.push({ name: need.name, units });
  }

  return missing;
}

const MODEL = 'claude-opus-5';

/** Small answers, but thinking comes out of the same budget. */
const MAX_TOKENS = 8000;

/** How `EACH` is written for the model, which has no use for an empty string. */
const EACH_LABEL = 'each';

/**
 * What the model is told about the job.
 *
 * The awkward part is not the calories but the weights: a recipe asks for three
 * tablespoons of oil and two eggs, and neither is a number of grams until
 * someone says what a tablespoon of that oil and one of those eggs weigh.
 */
const SYSTEM_PROMPT = `You give nutrition figures for cooking ingredients.

For each product you are asked about, answer with two things.

First, its energy and macronutrients per 100 g of the product: calories in kcal, and protein, fat and carbohydrate in grams. Answer for the raw product as it is bought, unless the name says otherwise — "cooked rice", "smoked bacon" and "roasted peanuts" are each asked about in the state they name.

Second, what one of each listed unit of that product weighs, in grams. "${EACH_LABEL}" means one whole one of it, the way a recipe counting "2 eggs" or "3 onions" does. A unit that means nothing for that product — "${EACH_LABEL}" for olive oil, "clove" for flour — gets null rather than a guess. Weigh the part that is cooked with: one whole garlic clove, one banana without its skin.

Ordinary food reference values are what is wanted, not laboratory precision, so give your best figure rather than declining. Answer for every product you are given, once each, under exactly the name you were given.`;

/** The shape the model answers in, so nothing has to be parsed out of prose. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The product name, exactly as it was given.',
          },
          calories: { type: 'number', description: 'kcal per 100 g.' },
          protein: { type: 'number', description: 'Grams of protein per 100 g.' },
          fat: { type: 'number', description: 'Grams of fat per 100 g.' },
          carbs: { type: 'number', description: 'Grams of carbohydrate per 100 g.' },
          units: {
            type: 'array',
            description: 'One entry per unit that was asked about, in the same order.',
            items: {
              type: 'object',
              properties: {
                unit: { type: 'string', description: 'The unit, as it was given.' },
                grams: {
                  anyOf: [{ type: 'number' }, { type: 'null' }],
                  description: 'What one of that unit weighs, or null if the unit makes no sense.',
                },
              },
              required: ['unit', 'grams'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'calories', 'protein', 'fat', 'carbs', 'units'],
        additionalProperties: false,
      },
    },
  },
  required: ['products'],
  additionalProperties: false,
} as const;

/** A problem worth mentioning once, rather than retrying forever. */
export class RegistryError extends Error {}

/** The user turn: one line per product, with the units it has to be weighed in. */
export function lookupPrompt(needs: readonly ProductNeed[]): string {
  const lines = needs.map((need) => {
    const units = need.units.map((unit) => (unit === EACH ? EACH_LABEL : unit));
    return units.length > 0 ? `- ${need.name} (units: ${units.join(', ')})` : `- ${need.name}`;
  });

  return ['Give nutrition figures for these products:', '', ...lines].join('\n');
}

interface RawProduct {
  name?: unknown;
  calories?: unknown;
  protein?: unknown;
  fat?: unknown;
  carbs?: unknown;
  units?: unknown;
}

/**
 * Reads the model's answer into products, against what was asked for.
 *
 * Anything the model volunteered that nobody asked about is dropped, and a unit
 * that was asked about but came back missing is recorded as unweighable — so
 * one lookup settles the question either way.
 */
export function parseLookup(text: string, needs: readonly ProductNeed[]): Product[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RegistryError('the nutrition figures came back unreadable');
  }

  const raw = (parsed as { products?: unknown })?.products;
  if (!Array.isArray(raw)) throw new RegistryError('the nutrition figures came back unreadable');

  const wanted = new Map(needs.map((need) => [productKey(need.name), need]));
  const products: Product[] = [];

  for (const entry of raw as RawProduct[]) {
    const need = typeof entry?.name === 'string' ? wanted.get(productKey(entry.name)) : undefined;
    if (!need) continue;

    const number = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

    const calories = number(entry.calories);
    const protein = number(entry.protein);
    const fat = number(entry.fat);
    const carbs = number(entry.carbs);
    if (calories === undefined || protein === undefined || fat === undefined || carbs === undefined) {
      continue;
    }

    const answered = new Map<string, number | null>();
    if (Array.isArray(entry.units)) {
      for (const item of entry.units as { unit?: unknown; grams?: unknown }[]) {
        if (typeof item?.unit !== 'string') continue;
        const unit = item.unit.trim().toLowerCase();
        answered.set(unit === EACH_LABEL ? EACH : unit, number(item.grams) ?? null);
      }
    }

    const grams: Record<string, number | null> = {};
    for (const unit of need.units) grams[unit] = answered.get(unit) ?? null;

    products.push({ name: need.name, per100g: { calories, protein, fat, carbs }, grams });
  }

  return products;
}

/**
 * Asks the model what the given products are worth.
 *
 * Rejects with a `RegistryError` whose message is fit to show the cook; anything
 * else that goes wrong is the SDK's own error, passed along untouched.
 */
export async function lookupNutrition(
  needs: readonly ProductNeed[],
  apiKey: string,
): Promise<Product[]> {
  if (needs.length === 0) return [];

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: {
      // Looking figures up is recall, not a problem to be worked through.
      effort: 'low',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: lookupPrompt(needs) }],
  });

  if (message.stop_reason === 'refusal') {
    throw new RegistryError('the model declined to give nutrition figures');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new RegistryError('the nutrition figures came back cut off');
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseLookup(text, needs);
}
