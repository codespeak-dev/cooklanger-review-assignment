/**
 * Units, and what converts into what.
 *
 * Shared by the shopping list, which adds amounts of the same thing up, and by
 * the nutrition figures, which turn an amount into grams. Both have to know
 * that 2 kg and 500 g are the same kind of measurement and that a tablespoon is
 * not — and they had better agree about it, or a recipe's totals and its
 * shopping line would be measuring different things.
 */

/**
 * Units that convert exactly within their family, so amounts in them can be
 * added and shown as one figure.
 *
 * Spoons, cups and ounces are deliberately absent: converting them depends on
 * what is being measured, and a wrong total on a shopping list is worse than
 * two figures side by side.
 */
export const UNIT_FAMILIES: ReadonlyArray<{
  family: string;
  /** How many base units one of each unit is, and the base unit's own name. */
  units: Record<string, number>;
  /** Base unit, then the larger unit to switch to at `step` of the base. */
  base: string;
  large?: { unit: string; step: number };
}> = [
  {
    family: 'mass',
    units: { mg: 0.001, g: 1, gram: 1, grams: 1, gr: 1, kg: 1000, kilogram: 1000, kilograms: 1000 },
    base: 'g',
    large: { unit: 'kg', step: 1000 },
  },
  {
    family: 'volume',
    units: {
      ml: 1,
      milliliter: 1,
      milliliters: 1,
      cl: 10,
      dl: 100,
      l: 1000,
      liter: 1000,
      liters: 1000,
    },
    base: 'ml',
    large: { unit: 'l', step: 1000 },
  },
];

/** The base unit of the mass family, which is what a weight is measured in. */
export const GRAM = 'g';

/**
 * The unit of an amount that names no unit at all.
 *
 * `@eggs{2}` counts two of a thing rather than measuring it, so the empty unit
 * is a unit of its own: whatever one whole one of that product weighs.
 */
export const EACH = '';

/** Rounds away the noise a scaling factor leaves behind. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Formats a number the way a shopping list reads: no trailing zeros. */
export function formatAmount(value: number): string {
  const rounded = round(value);
  return Number.isInteger(rounded) ? String(rounded) : String(Number(rounded.toFixed(2)));
}

/**
 * Formats one amount the way the ingredients list reads it.
 *
 * Grams are whole: nobody weighs a tenth of a gram of flour. Everything else
 * keeps one decimal place at most, which is as fine as a spoon or a cup can be
 * read, and a scaled recipe otherwise fills the list with thirds.
 */
export function formatIngredientAmount(value: number, unit: string | undefined): string {
  const { key, factor } = unitScale(unit);
  const rounded = key === 'mass' && factor === 1 ? Math.round(value) : Math.round(value * 10) / 10;
  // Rounding a tiny negative leaves -0, which would print as "0" but compare oddly.
  return String(rounded === 0 ? 0 : rounded);
}

/** How one unit is measured: which bucket it falls in, and its size in it. */
export interface UnitScale {
  /** Bucket amounts in the same unit family, or in the same exact unit. */
  key: string;
  /** The unit the scaled value lands in: a family's base unit, or the unit itself. */
  base: string;
  factor: number;
}

export function unitScale(unit: string | undefined): UnitScale {
  const normalized = (unit ?? '').trim().toLowerCase();
  if (!normalized) return { key: EACH, base: EACH, factor: 1 };

  for (const family of UNIT_FAMILIES) {
    const factor = family.units[normalized];
    if (factor !== undefined) return { key: family.family, base: family.base, factor };
  }
  return { key: normalized, base: normalized, factor: 1 };
}

/** Two spellings of the same ingredient are the same product. */
export function productKey(name: string): string {
  return name.trim().toLowerCase();
}
