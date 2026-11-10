import type { CooklangParser, CooklangRecipe, Quantity } from '@cooklang/cooklang';

type Cooklang = typeof import('@cooklang/cooklang');

/** The package does not export this type by name, so it is derived instead. */
type GroupedQuantity = CooklangRecipe['groupedIngredients'][number][1];

let cooklang: Cooklang | undefined;
let parser: CooklangParser | undefined;

/**
 * Loads the parser package on first use and reuses it afterwards.
 * Imported dynamically so `warnings.ts` gets a chance to run first.
 */
async function getCooklang(): Promise<Cooklang> {
  if (!cooklang) cooklang = await import('@cooklang/cooklang');
  return cooklang;
}

async function getParser(): Promise<CooklangParser> {
  const module = await getCooklang();
  if (!parser) parser = new module.CooklangParser();
  return parser;
}

/**
 * Parses Cooklang source into a recipe.
 *
 * `scale` multiplies every scalable quantity: 2 makes twice the recipe. The
 * parser is lenient by design: malformed markup degrades into plain text rather
 * than throwing, and recoverable problems come back as a report we currently
 * ignore. It throws only on genuinely unreadable input.
 */
export async function parseRecipe(source: string, scale?: number): Promise<CooklangRecipe> {
  const [recipe] = (await getParser()).parse(source, scale ?? null);
  return recipe;
}

/**
 * A plain, display-ready view of a parsed recipe.
 *
 * Every quantity is already a human string ("250 g", "1-2 cups", "1/2 tsp"),
 * so nothing downstream has to know about the parser's value types — or import
 * its WASM module.
 */
/**
 * Who wrote a recipe, as its own metadata claims.
 *
 * `unknown` is the honest answer for a file that says nothing: most recipes
 * were written before anyone thought to record this, and silence is not the
 * same as a person having signed it.
 */
export type Authorship = 'llm' | 'human' | 'unknown';

/** The metadata field that carries it, and the two values it may hold. */
export const AUTHORED_BY_KEY = 'authored_by';

/** Written as `authored_by`, but a hand-edited file may use a hyphen or caps. */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Reads one `authored_by` value, refusing to guess at anything else. */
export function toAuthorship(value: unknown): Authorship {
  const written = String(value ?? '')
    .trim()
    .toLowerCase();
  if (written === 'llm') return 'llm';
  if (written === 'human') return 'human';
  // A value nobody defined says as little as no value at all.
  return 'unknown';
}

/** The authorship a Cooklang file's metadata claims, straight from its map. */
export function readAuthorship(raw: Map<unknown, unknown>): Authorship {
  for (const [key, value] of raw.entries()) {
    if (normalizeKey(String(key)) === AUTHORED_BY_KEY) return toAuthorship(value);
  }
  return 'unknown';
}

export interface RecipeDocument {
  title?: string;
  description?: string;
  /** Who wrote it, per its `authored_by` field. */
  authorship: Authorship;
  /** How many people the recipe yields, when it says so as a plain number. */
  servings?: number;
  /** Remaining metadata in the order the author wrote it. */
  metadata: MetadataEntry[];
  /** Every ingredient once, with references folded into one total. */
  ingredients: Component[];
  cookware: Component[];
  sections: RecipeSection[];
}

export interface MetadataEntry {
  key: string;
  value: string;
}

export interface Component {
  name: string;
  quantity?: string;
  note?: string;
  /**
   * The same quantity taken apart, so amounts can be added up across recipes.
   *
   * One component can carry several: a `@salt{1%tsp}` used again as `@salt{2%g}`
   * groups into a spoon amount and a mass amount, which cannot be summed.
   */
  amounts: Amount[];
}

/**
 * One measured amount of a component.
 *
 * A quantity that is not a plain number — a range, or a word like "a pinch" —
 * keeps only its `text`, since there is nothing to add it to.
 */
export interface Amount {
  value?: number;
  unit?: string;
  text?: string;
}

export interface RecipeSection {
  name?: string;
  blocks: Block[];
}

export type Block =
  | { kind: 'step'; number: number; items: StepItem[] }
  | { kind: 'note'; text: string };

/** One piece of a step: prose, or a marked-up component in it. */
export type StepItem =
  | { kind: 'text'; text: string }
  | { kind: 'ingredient'; name: string; quantity?: string; note?: string }
  | { kind: 'cookware'; name: string; quantity?: string; note?: string }
  | { kind: 'timer'; name?: string; quantity?: string }
  | { kind: 'quantity'; text: string };

/**
 * Metadata rendered on their own, so they are not repeated in the list.
 *
 * `authored_by` is among them because it is shown as a line of its own rather
 * than as a row reading "Authored by  llm".
 */
const HEADLINE_KEYS = new Set(['title', 'description', AUTHORED_BY_KEY]);

/** `snake_case` and `kebab-case` keys read better as words. */
function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Formats a raw metadata value, which YAML may have given us as anything.
 *
 * Nested maps (a `time:` with `prep:` and `cook:`) collapse onto one line so
 * every metadata entry stays a single row.
 */
function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatMetadataValue).filter(Boolean).join(', ');
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, nested]) => `${String(key)} ${formatMetadataValue(nested)}`.trim())
      .join(' · ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key} ${formatMetadataValue(nested)}`.trim())
      .join(' · ');
  }
  return String(value);
}

function toMetadata(raw: Map<unknown, unknown>): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  for (const [rawKey, rawValue] of raw.entries()) {
    const key = String(rawKey);
    if (HEADLINE_KEYS.has(normalizeKey(key))) continue;
    const value = formatMetadataValue(rawValue);
    if (value) entries.push({ key: humanizeKey(key), value });
  }
  return entries;
}

/**
 * A grouped quantity as the parser actually serialises it.
 *
 * Its published type names a map type the package does not export, so the few
 * fields we read are described structurally instead.
 */
interface RawGroupedQuantity {
  /** Quantities in units the parser knows, one slot per physical quantity. */
  known?: Record<string, Quantity | null>;
  /** Quantities in units it does not know, keyed by the unit as written. */
  unknown?: Record<string, Quantity>;
  no_unit?: Quantity | null;
  /** Anything that could not be grouped at all, such as a range. */
  other?: (Quantity | null)[];
}

/**
 * A number as the parser writes it: either plain, or a fraction it chose
 * because "1 1/2 tbsp" reads better than "1.5 tbsp".
 *
 * The published types stop one level short of this, so it is described here.
 */
type RawNumber =
  | { type: 'regular'; value: number }
  | { type: 'fraction'; value: { whole: number; num: number; den: number } };

/** The number behind a value, or undefined for ranges and words. */
function numericValue(quantity: Quantity): number | undefined {
  const value = quantity.value;
  if (value.type !== 'number') return undefined;

  const raw = value.value as unknown as RawNumber;
  // A fraction has to be worked out, or "1 1/2 tbsp" would not be a number at
  // all and could never be added to anything.
  const number =
    raw.type === 'fraction' && raw.value.den !== 0
      ? Number(raw.value.whole) + Number(raw.value.num) / Number(raw.value.den)
      : Number((raw as { value: unknown }).value);

  return Number.isFinite(number) ? number : undefined;
}

/** Takes a grouped quantity apart into amounts that can be added up. */
function toAmounts(grouped: GroupedQuantity, module: Cooklang): Amount[] {
  const raw = grouped as unknown as RawGroupedQuantity;
  const quantities: Quantity[] = [
    ...Object.values(raw.known ?? {}),
    ...Object.values(raw.unknown ?? {}),
    raw.no_unit ?? null,
    ...(raw.other ?? []),
  ].filter((quantity): quantity is Quantity => Boolean(quantity));

  return quantities.map((quantity) => {
    const value = numericValue(quantity);
    if (value === undefined) return { text: module.quantity_display(quantity) };
    return { value, unit: quantity.unit ?? undefined };
  });
}

/** The servings metadata, when the author wrote it as a plain number. */
function toServings(servings: string | number | undefined): number | undefined {
  if (servings === undefined) return undefined;
  const value = typeof servings === 'number' ? servings : Number.parseFloat(servings);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * How the amounts of a recipe on screen relate to the ones its author wrote.
 *
 * A recipe is written for whatever number of people its author was cooking for,
 * which makes two recipes side by side impossible to compare. So they are all
 * read at the same number of people — one, unless the cook asks for more — but
 * a cook looking at amounts that are not the author's has to be told so, which
 * is what this carries.
 */
export interface Portion {
  /** How many people the author wrote the amounts for, when the recipe says. */
  writtenFor?: number;
  /** How many people the amounts were asked for. */
  persons: number;
  /** Whether the amounts were brought to `persons`, or left as written. */
  scaled: boolean;
}

export interface PortionedRecipe extends Portion {
  document: RecipeDocument;
}

/**
 * Reads `document` again with its amounts brought to `persons` people.
 *
 * A recipe that never says how many it serves is left exactly as written: there
 * is nothing to divide by, and inventing a number would put amounts on screen
 * that no recipe ever called for. The parser scales the `servings` metadata
 * along with the quantities, so a scaled recipe says `persons` about itself.
 */
export async function toPersons(
  source: string,
  document: RecipeDocument,
  persons = 1,
): Promise<PortionedRecipe> {
  const writtenFor = document.servings;
  if (writtenFor === undefined) return { document, persons, scaled: false };
  // Already a recipe for that many: scaling it by 1 would only lose precision.
  if (writtenFor === persons) return { document, writtenFor, persons, scaled: true };

  try {
    const scaled = await parseRecipeDocument(source, persons / writtenFor);
    return { document: scaled, writtenFor, persons, scaled: true };
  } catch {
    // Scaling failed, so the author's own amounts are shown and said to be.
    return { document, writtenFor, persons, scaled: false };
  }
}

/**
 * Reads a Cooklang recipe into the display model above.
 *
 * `scale` multiplies every scalable quantity, so the same recipe can be read at
 * the size it was written or at the size it is being cooked.
 */
export async function parseRecipeDocument(
  source: string,
  scale?: number,
): Promise<RecipeDocument> {
  const module = await getCooklang();
  const recipe = await parseRecipe(source, scale);

  const quantity = (value: Quantity | null | undefined): string | undefined =>
    value ? module.quantity_display(value) || undefined : undefined;

  const ingredients = recipe.groupedIngredients
    .filter(([ingredient]) => module.ingredient_should_be_listed(ingredient))
    .map(([ingredient, grouped]) => ({
      name: module.ingredient_display_name(ingredient),
      quantity: module.grouped_quantity_is_empty(grouped)
        ? undefined
        : module.grouped_quantity_display(grouped) || undefined,
      note: ingredient.note ?? undefined,
      amounts: module.grouped_quantity_is_empty(grouped) ? [] : toAmounts(grouped, module),
    }));

  const cookware = recipe.groupedCookware
    .filter(([item]) => module.cookware_should_be_listed(item))
    .map(([item, grouped]) => ({
      name: module.cookware_display_name(item),
      quantity: module.grouped_quantity_is_empty(grouped)
        ? undefined
        : module.grouped_quantity_display(grouped) || undefined,
      note: item.note ?? undefined,
      amounts: module.grouped_quantity_is_empty(grouped) ? [] : toAmounts(grouped, module),
    }));

  const sections: RecipeSection[] = recipe.sections.map((section) => {
    const blocks: Block[] = [];

    for (const content of section.content) {
      if (content.type === 'text') {
        const text = content.value.trim();
        if (text) blocks.push({ kind: 'note', text });
        continue;
      }

      const items: StepItem[] = [];
      for (const item of content.value.items) {
        switch (item.type) {
          case 'text':
            items.push({ kind: 'text', text: item.value });
            break;
          case 'ingredient': {
            const ingredient = recipe.ingredients[item.index];
            if (!ingredient) break;
            items.push({
              kind: 'ingredient',
              name: module.ingredient_display_name(ingredient),
              quantity: quantity(ingredient.quantity),
              note: ingredient.note ?? undefined,
            });
            break;
          }
          case 'cookware': {
            const tool = recipe.cookware[item.index];
            if (!tool) break;
            items.push({
              kind: 'cookware',
              name: module.cookware_display_name(tool),
              quantity: quantity(tool.quantity),
              note: tool.note ?? undefined,
            });
            break;
          }
          case 'timer': {
            const timer = recipe.timers[item.index];
            if (!timer) break;
            items.push({
              kind: 'timer',
              name: timer.name ?? undefined,
              quantity: quantity(timer.quantity),
            });
            break;
          }
          case 'inlineQuantity': {
            const text = quantity(recipe.inlineQuantities[item.index]);
            if (text) items.push({ kind: 'quantity', text });
            break;
          }
        }
      }

      if (items.length > 0) blocks.push({ kind: 'step', number: content.value.number, items });
    }

    return { name: section.name?.trim() || undefined, blocks };
  });

  return {
    title: recipe.title?.trim() || undefined,
    description: recipe.description?.trim() || undefined,
    authorship: readAuthorship(recipe.rawMetadata),
    servings: toServings(recipe.servings),
    metadata: toMetadata(recipe.rawMetadata),
    ingredients,
    cookware,
    sections: sections.filter((section) => section.blocks.length > 0),
  };
}
