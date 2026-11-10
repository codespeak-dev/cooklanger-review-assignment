/**
 * Turns a parsed recipe into the lines the preview pane shows.
 *
 * Cooklang markup never reaches the screen: `@flour{250%g}` is rendered as the
 * words a cook reads, with the ingredient, its quantity, the cookware and the
 * timers each marked so the terminal can colour them.
 */

import type { Nutrients } from './registry.js';
import type { Nutrition } from './nutrition.js';
import type { Block, Component, Portion, RecipeDocument, StepItem } from './parser.js';
import type { ShoppingEntry, ShoppingProduct } from './shopping.js';
import { formatAmount, formatIngredientAmount } from './units.js';
import {
  plainText,
  span,
  styled,
  wrapStyled,
  type Span,
  type SpanStyle,
  type StyledLine,
} from './layout.js';

/** Indent for everything that hangs under a heading. */
const INDENT = '  ';
/** Past this, a long metadata key gets its own column width rather than all of them. */
const MAX_KEY_WIDTH = 12;
/** Same, for the quantity column of the ingredient and cookware lists. */
const MAX_QUANTITY_WIDTH = 12;
/** Same, for the shopping list, whose totals run longer ("1 kg, 3 cups"). */
const MAX_SHOPPING_AMOUNT_WIDTH = 18;
/** Same, for the column of recipe names the shopping list was built from. */
const MAX_RECIPE_NAME_WIDTH = 30;
/** Enough for "999.", past which the step text stops being indented further. */
const MAX_STEP_NUMBER_WIDTH = 4;
/** Marks a note the author wrote outside a step. */
const NOTE_BAR = '│ ';
/** The same badge the recipe list uses, so the two screens read as one. */
const LLM_BADGE = '[AI]';

export interface RenderOptions {
  /** Shown as the heading when the recipe has no `title` metadata. */
  name?: string;
  /**
   * Figures worked out from the product registry, when there are any.
   *
   * Passed in rather than read off the recipe: the recipe file says nothing
   * about calories, and the answer is only as good as the registry is today.
   */
  nutrition?: Nutrition;
  /**
   * How the amounts being rendered relate to the ones the author wrote.
   *
   * Absent means nobody rescaled anything, so the recipe speaks for itself and
   * no line is added about it.
   */
  portion?: Portion;
}

/**
 * The line saying whose amounts these are, with the controls that change it.
 *
 * A recipe that could be scaled always gets the line, because it is also where
 * the cook sees that `-` and `+` change the count. The parser brings the
 * `servings` metadata along with the quantities, so what the line adds is
 * whether the numbers are still the author's.
 */
function portionNote(portion: Portion): string {
  if (portion.scaled) {
    const people = `${portion.persons} ${portion.persons === 1 ? 'person' : 'persons'}`;
    const from =
      portion.writtenFor === portion.persons
        ? 'as written'
        : `scaled from a recipe for ${portion.writtenFor}`;
    return `[-] ${people} [+]  ${from}`;
  }
  return portion.writtenFor === undefined
    ? 'amounts as written, no servings given'
    : 'amounts as written, they could not be scaled';
}

/** The rows of the nutrition table, in the order a label reads them. */
const NUTRIENTS: ReadonlyArray<{ label: string; of: (figures: Nutrients) => number; unit: string }> =
  [
    { label: 'Calories', of: (figures) => figures.calories, unit: 'kcal' },
    { label: 'Protein', of: (figures) => figures.protein, unit: 'g' },
    { label: 'Fat', of: (figures) => figures.fat, unit: 'g' },
    { label: 'Carbs', of: (figures) => figures.carbs, unit: 'g' },
  ];

/** Column width for a padded label: the longest, within a cap. */
function columnWidth(values: readonly string[], cap: number): number {
  return Math.min(Math.max(0, ...values.map((value) => value.length)), cap);
}

/** The parenthesised detail after a component: its quantity, then its note. */
function detail(quantity: string | undefined, note: string | undefined): Span[] {
  if (!quantity && !note) return [];

  const parts: Span[] = [span(' (')];
  if (quantity) parts.push(span(quantity, 'quantity'));
  if (quantity && note) parts.push(span(', '));
  if (note) parts.push(span(note, 'note'));
  parts.push(span(')'));
  return parts;
}

/**
 * An ingredient's quantity for the ingredients list, rounded to be read.
 *
 * Built from the amounts rather than the parser's own string, which prints a
 * scaled recipe's thirds to as many places as it has. An amount that is words
 * or a range ("a pinch", "1-2") has nothing to round and is kept as written.
 */
function ingredientQuantity(component: Component): string | undefined {
  if (component.amounts.length === 0) return component.quantity;
  return component.amounts
    .map((amount) => {
      if (amount.value === undefined) return amount.text ?? '';
      const value = formatIngredientAmount(amount.value, amount.unit);
      return amount.unit ? `${value} ${amount.unit}` : value;
    })
    .join(', ');
}

/** Renders one step as prose, marking each component it mentions. */
function stepSpans(items: readonly StepItem[]): Span[] {
  const spans: Span[] = [];

  for (const item of items) {
    switch (item.kind) {
      case 'text':
        spans.push(span(item.text));
        break;
      case 'ingredient':
        spans.push(span(item.name, 'ingredient'), ...detail(item.quantity, item.note));
        break;
      case 'cookware':
        spans.push(span(item.name, 'cookware'), ...detail(item.quantity, item.note));
        break;
      case 'timer':
        // A named timer reads as "resting (30 minutes)"; an unnamed one is just
        // the duration.
        if (item.name) spans.push(span(item.name, 'timer'), ...detail(item.quantity, undefined));
        else spans.push(span(item.quantity ?? '', 'timer'));
        break;
      case 'quantity':
        spans.push(span(item.text, 'quantity'));
        break;
    }
  }

  return spans;
}

export function renderRecipe(
  doc: RecipeDocument,
  width: number,
  options: RenderOptions = {},
): StyledLine[] {
  const lines: StyledLine[] = [];

  const wrap = (line: StyledLine, hanging = 0): void => {
    lines.push(...wrapStyled(line, width, hanging));
  };

  /** A blank separator, never leading and never doubled. */
  const gap = (): void => {
    const last = lines.at(-1);
    if (last && plainText(last).trim() !== '') lines.push([]);
  };

  const heading = (text: string, style: 'heading' | 'section' = 'heading'): void => {
    gap();
    wrap(styled(text, style));
  };

  const title = doc.title ?? options.name;
  if (title) wrap(styled(title, 'title'));

  // Under the title, because who wrote a recipe changes how it should be read.
  // Silence is left silent: a file that says nothing gets no line at all.
  if (doc.authorship === 'llm') wrap(styled(`${LLM_BADGE} written by a model`, 'note'));
  else if (doc.authorship === 'human') wrap(styled('written by a person', 'note'));

  // Beside who wrote it, because both are things to know before reading on.
  if (options.portion) wrap(styled(portionNote(options.portion), 'note'));

  if (doc.description) {
    gap();
    wrap(styled(doc.description, 'description'));
  }

  if (doc.metadata.length > 0) {
    gap();
    const keyWidth = columnWidth(
      doc.metadata.map((entry) => entry.key),
      MAX_KEY_WIDTH,
    );
    for (const entry of doc.metadata) {
      wrap(
        [
          span(entry.key.padEnd(keyWidth), 'metaKey'),
          span('  '),
          span(entry.value, 'metaValue'),
        ],
        keyWidth + 2,
      );
    }
  }

  const list = (
    label: string,
    components: readonly Component[],
    style: SpanStyle,
    quantityOf: (component: Component) => string | undefined = (component) => component.quantity,
  ): void => {
    if (components.length === 0) return;

    heading(label);
    const quantities = components.map((component) => quantityOf(component) ?? '');
    const quantityWidth = columnWidth(quantities, MAX_QUANTITY_WIDTH);
    // A list where nothing carries a quantity has no quantity column at all.
    const column = quantityWidth > 0 ? quantityWidth + 2 : 0;
    components.forEach((component, index) => {
      wrap(
        [
          span(INDENT),
          span((quantities[index] ?? '').padEnd(quantityWidth), 'quantity'),
          span(column > 0 ? '  ' : ''),
          span(component.name, style),
          ...(component.note ? [span(` (${component.note})`, 'note')] : []),
        ],
        INDENT.length + column,
      );
    });
  };

  // Above the ingredients, because it is the recipe as a whole rather than a
  // property of any one thing in it.
  if (options.nutrition) {
    // The figures are for the amounts on screen, so a count other than one is
    // named: otherwise a table for four reads as one person's worth.
    const persons = options.portion?.scaled ? options.portion.persons : 1;
    renderNutrition(
      options.nutrition,
      wrap,
      heading,
      persons === 1 ? 'Nutrition' : `Nutrition, for ${persons} persons`,
    );
  }

  list('Ingredients', doc.ingredients, 'ingredient', ingredientQuantity);
  list('Cookware', doc.cookware, 'cookware');

  for (const section of doc.sections) {
    // A section the author named keeps its name; an unnamed one is the method.
    if (section.name) heading(section.name, 'section');
    else heading('Method');

    const numberWidth = columnWidth(
      section.blocks.map((block) => (block.kind === 'step' ? `${block.number}.` : '')),
      MAX_STEP_NUMBER_WIDTH,
    );

    for (const block of section.blocks) {
      gap();
      renderBlock(block, numberWidth, wrap, width);
    }
  }

  if (lines.length === 0) lines.push(styled('This recipe is empty.', 'note'));
  return lines;
}

/** Wide enough that no line of a recipe is ever wrapped. */
const UNWRAPPED = 100_000;

/**
 * The recipe as plain text for the clipboard, at the amounts being read.
 *
 * The same reading the preview shows, not the Cooklang source: the source has
 * no ingredients list of its own and holds the author's amounts, and a copy is
 * for pasting somewhere a cook reads it. The nutrition table and the scaling
 * controls are left out — the one is a reading of the registry rather than part
 * of the recipe, and the other is only a key to press. The `servings` line
 * already says who the amounts are for.
 */
export function recipeText(doc: RecipeDocument, name?: string): string {
  return renderRecipe(doc, UNWRAPPED, { name })
    .map((line) => plainText(line).trimEnd())
    .join('\n');
}

/**
 * Renders the shopping list: what to buy, then what it is for.
 *
 * The amounts share one column so the eye can run down them, and the recipes
 * are listed after them so it is clear where a total came from.
 */
export function renderShoppingList(
  products: readonly ShoppingProduct[],
  entries: readonly ShoppingEntry[],
  width: number,
): StyledLine[] {
  const lines: StyledLine[] = [];
  const wrap = (line: StyledLine, hanging = 0): void => {
    lines.push(...wrapStyled(line, width, hanging));
  };

  if (entries.length === 0) {
    return [
      styled('The shopping list is empty.', 'note'),
      [],
      styled('Press “a” in the recipe list to add a recipe to it.', 'note'),
    ];
  }

  wrap(styled('Shopping list', 'title'));
  lines.push([]);

  const amounts = products.map((product) => product.amounts.join(', '));
  const amountWidth = columnWidth(amounts, MAX_SHOPPING_AMOUNT_WIDTH);
  const column = amountWidth > 0 ? amountWidth + 2 : 0;

  products.forEach((product, index) => {
    wrap(
      [
        span(INDENT),
        span((amounts[index] ?? '').padEnd(amountWidth), 'quantity'),
        span(column > 0 ? '  ' : ''),
        span(product.name, 'ingredient'),
      ],
      INDENT.length + column,
    );
  });

  lines.push([]);
  wrap(styled('For', 'heading'));
  const nameWidth = columnWidth(
    entries.map((entry) => entry.name),
    MAX_RECIPE_NAME_WIDTH,
  );
  for (const entry of entries) {
    const persons = `${entry.persons} ${entry.persons === 1 ? 'person' : 'persons'}`;
    wrap(
      [
        span(INDENT),
        span(entry.name.padEnd(nameWidth), 'metaValue'),
        span('  '),
        span(persons, 'metaKey'),
        // The amounts are the author's own when the recipe never said how many
        // it serves, and saying so is better than implying they were scaled.
        ...(entry.unscaled ? [span('  as written, no servings given', 'note')] : []),
      ],
      INDENT.length,
    );
  }

  return lines;
}

/**
 * One nutrition figure, at the precision an estimate deserves.
 *
 * Calories are whole numbers — nobody counts a third of one — and the grams
 * keep a single decimal, which is as far as a table of reference values can
 * honestly be read.
 */
function formatFigure(value: number, unit: string): string {
  const rounded = unit === 'kcal' ? Math.round(value) : Math.round(value * 10) / 10;
  return `${formatAmount(rounded)} ${unit}`;
}

/**
 * The nutrition table for the recipe as it is being read.
 *
 * One column, because the recipe on screen is already a single person's worth of
 * it. The last line says where the numbers came from — an estimate that does not
 * admit to being one is worse than no estimate.
 */
function renderNutrition(
  nutrition: Nutrition,
  wrap: (line: StyledLine, hanging?: number) => void,
  heading: (text: string) => void,
  label: string,
): void {
  heading(label);

  const labelWidth = columnWidth(
    NUTRIENTS.map((row) => row.label),
    MAX_KEY_WIDTH,
  );
  const hanging = INDENT.length + labelWidth + 2;

  for (const row of NUTRIENTS) {
    wrap(
      [
        span(INDENT),
        span(row.label.padEnd(labelWidth), 'metaKey'),
        span('  '),
        span(formatFigure(row.of(nutrition.total), row.unit), 'quantity'),
      ],
      hanging,
    );
  }

  const source =
    nutrition.counted < nutrition.listed
      ? `estimated from ${nutrition.counted} of ${nutrition.listed} ingredients`
      : 'estimated from the product registry';
  wrap([span(INDENT), span(source, 'note')], INDENT.length);
}

function renderBlock(
  block: Block,
  numberWidth: number,
  wrap: (line: StyledLine, hanging?: number) => void,
  width: number,
): void {
  if (block.kind === 'note') {
    // The bar is repeated on every line, so a wrapped note still reads as one.
    const inner = Math.max(width - INDENT.length - NOTE_BAR.length, 1);
    for (const line of wrapStyled(styled(block.text, 'note'), inner)) {
      wrap([span(INDENT), span(NOTE_BAR, 'note'), ...line]);
    }
    return;
  }

  const label = `${block.number}.`.padEnd(numberWidth);
  wrap(
    [span(INDENT), span(label, 'stepNumber'), span(' '), ...stepSpans(block.items)],
    INDENT.length + numberWidth + 1,
  );
}
