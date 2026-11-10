// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainText, type SpanStyle, type StyledLine } from './layout.js';
import type { Nutrition } from './nutrition.js';
import { parseRecipeDocument, toPersons, type Portion } from './parser.js';
import { recipeText, renderRecipe } from './render.js';

const WIDTH = 60;

async function render(source: string, name = 'fallback'): Promise<StyledLine[]> {
  return renderRecipe(await parseRecipeDocument(source), WIDTH, { name });
}

/** The whole preview as text, which is what a reader actually sees. */
function text(lines: readonly StyledLine[]): string {
  return lines.map(plainText).join('\n');
}

/** Every run rendered in `style`, so a test can assert on what is highlighted. */
function marked(lines: readonly StyledLine[], style: SpanStyle): string[] {
  return lines.flatMap((line) =>
    line.filter((part) => part.style === style).map((part) => part.text),
  );
}

const RECIPE = `---
title: Buttermilk Pancakes
servings: 4
time: 25 minutes
---

Whisk @flour{250%g} and @baking powder{2%tsp} in a #large bowl{}.

Rest for ~{10%minutes}.
`;

describe('renderRecipe', () => {
  it('leaves no Cooklang markup on the screen', async () => {
    const rendered = text(await render(RECIPE));
    for (const markup of ['@', '#', '~', '{', '}', '%', '---']) {
      assert.ok(!rendered.includes(markup), `${markup} survived in:\n${rendered}`);
    }
  });

  it('writes each component as the words a cook reads', async () => {
    // Wrapping is irrelevant here, so the steps are read back as one run of text.
    const rendered = text(await render(RECIPE)).replace(/\s+/g, ' ');
    assert.ok(
      rendered.includes('Whisk flour (250 g) and baking powder (2 tsp) in a large bowl.'),
      rendered,
    );
    assert.ok(rendered.includes('Rest for 10 minutes.'));
  });

  it('highlights ingredients, cookware, quantities and timers apart', async () => {
    const lines = await render(RECIPE);
    assert.ok(marked(lines, 'ingredient').includes('flour'));
    assert.ok(marked(lines, 'cookware').includes('large bowl'));
    assert.ok(marked(lines, 'quantity').includes('250 g'));
    assert.ok(marked(lines, 'timer').includes('10 minutes'));
  });

  it('heads the preview with the title and lists the metadata', async () => {
    const lines = await render(RECIPE);
    assert.deepEqual(marked(lines, 'title'), ['Buttermilk Pancakes']);
    const rendered = text(lines);
    assert.match(rendered, /Servings {2}4/);
    assert.match(rendered, /Time {6}25 minutes/);
  });

  it('falls back to the recipe name when there is no title', async () => {
    const lines = await render('Melt @butter{20%g}.', 'Brownies');
    assert.deepEqual(marked(lines, 'title'), ['Brownies']);
  });

  it('sums an ingredient used twice into one list entry', async () => {
    const rendered = text(await render('Add @flour{200%g}, then @&flour{50%g} more.'));
    assert.match(rendered, /250 g {2}flour/);
    // The step still says what goes in at that moment.
    assert.match(rendered, /Add flour \(200 g\), then flour \(50 g\) more\./);
  });

  it('keeps an ingredient note beside its name', async () => {
    const rendered = text(await render('Add @yeast{7%g}(instant).'));
    assert.match(rendered, /7 g {2}yeast \(instant\)/);
    assert.match(rendered, /Add yeast \(7 g, instant\)\./);
  });

  it('drops the quantity column when nothing is measured', async () => {
    const rendered = text(await render('Stir with a #spoon{}.'));
    assert.match(rendered, /^ {2}spoon$/m);
  });

  it('numbers the steps and hangs their text under the number', async () => {
    const lines = await render(
      `Beat @eggs{2} with @buttermilk{300%ml} and pour into the dry mix slowly.\n\nServe.`,
    );
    const rendered = text(lines);
    assert.match(rendered, /^ {2}1\. Beat eggs/m);
    assert.match(rendered, /^ {5}\S/m);
    assert.match(rendered, /^ {2}2\. Serve\./m);
    assert.deepEqual(marked(lines, 'stepNumber'), ['1.', '2.']);
  });

  it('uses the section names the author wrote as headings', async () => {
    const lines = await render('= Prep\n\nChop @onion{1}.\n\n= Cook\n\nFry it.');
    assert.deepEqual(marked(lines, 'section'), ['Prep', 'Cook']);
    assert.ok(!text(lines).includes('Method'));
  });

  it('marks a note as a note rather than a step', async () => {
    const lines = await render('> Read this first.\n\nBake it.');
    assert.match(text(lines), /^ {2}│ Read this first\.$/m);
    assert.ok(!text(lines).includes('1. Read this first.'));
  });

  it('never exceeds the width it was given', async () => {
    for (const line of await render(RECIPE)) {
      assert.ok(plainText(line).length <= WIDTH, plainText(line));
    }
  });

  it('says so when a recipe holds nothing', async () => {
    assert.equal(text(await render('', '')), 'This recipe is empty.');
  });
});

describe('the nutrition table', () => {
  const NUTRITION: Nutrition = {
    total: { calories: 310.1, protein: 10.59, fat: 15.25, carbs: 32 },
    counted: 2,
    listed: 2,
  };

  async function withNutrition(nutrition: Nutrition): Promise<StyledLine[]> {
    return renderRecipe(await parseRecipeDocument(RECIPE), WIDTH, { nutrition });
  }

  it('sits above the ingredients, where the whole recipe belongs', async () => {
    const rendered = text(await withNutrition(NUTRITION));
    assert.ok(rendered.indexOf('Nutrition') < rendered.indexOf('Ingredients'));
  });

  it('gives one figure per nutrient, for the recipe as it is being read', async () => {
    const rendered = text(await withNutrition(NUTRITION));
    assert.match(rendered, /^ {2}Calories {2}310 kcal$/m);
    assert.match(rendered, /^ {2}Protein {3}10.6 g$/m);
    assert.ok(!rendered.includes('per serving'));
  });

  it('names the count when the figures are for more than one person', async () => {
    const rendered = text(
      renderRecipe(await parseRecipeDocument(RECIPE), WIDTH, {
        nutrition: NUTRITION,
        portion: { writtenFor: 4, persons: 3, scaled: true },
      }),
    );
    assert.match(rendered, /^Nutrition, for 3 persons$/m);
  });

  it('admits the figures are an estimate', async () => {
    assert.match(text(await withNutrition(NUTRITION)), /estimated from the product registry/);
  });

  it('says how much of the recipe the figures cover when some is missing', async () => {
    const rendered = text(await withNutrition({ ...NUTRITION, counted: 2, listed: 5 }));
    assert.match(rendered, /estimated from 2 of 5 ingredients/);
  });

  it('is absent altogether when there are no figures', async () => {
    assert.ok(!text(await render(RECIPE)).includes('Nutrition'));
  });

  it('never exceeds the width it was given', async () => {
    for (const line of await withNutrition(NUTRITION)) {
      assert.ok(plainText(line).length <= WIDTH, plainText(line));
    }
  });
});

describe('the portion line', () => {
  async function withPortion(portion: Portion, source = RECIPE): Promise<string> {
    return text(renderRecipe(await parseRecipeDocument(source), WIDTH, { portion }));
  }

  it('says the amounts were scaled, and what they were scaled from', async () => {
    const rendered = await withPortion({ writtenFor: 4, persons: 1, scaled: true });
    assert.match(rendered, /^\[-\] 1 person \[\+\]  scaled from a recipe for 4$/m);
  });

  it('names a count above one in the plural', async () => {
    const rendered = await withPortion({ writtenFor: 4, persons: 6, scaled: true });
    assert.match(rendered, /^\[-\] 6 persons \[\+\]  scaled from a recipe for 4$/m);
  });

  it('keeps the controls when the count is the one the author wrote for', async () => {
    const rendered = await withPortion({ writtenFor: 1, persons: 1, scaled: true });
    assert.match(rendered, /^\[-\] 1 person \[\+\]  as written$/m);
  });

  it('leaves the amounts alone when the recipe gives no servings', async () => {
    const rendered = await withPortion({ persons: 1, scaled: false });
    assert.match(rendered, /^amounts as written, no servings given$/m);
  });

  it('says so when a recipe that could be scaled was not', async () => {
    const rendered = await withPortion({ writtenFor: 4, persons: 1, scaled: false });
    assert.match(rendered, /^amounts as written, they could not be scaled$/m);
  });

  it('sits under the title, before anything about the food', async () => {
    const rendered = await withPortion({ writtenFor: 4, persons: 1, scaled: true });
    assert.ok(rendered.indexOf('1 person') < rendered.indexOf('Servings'));
  });

  it('is absent altogether when nobody rescaled anything', async () => {
    assert.ok(!text(await render(RECIPE)).includes('amounts'));
  });
});

describe('recipeText', () => {
  it('lists the ingredients, which the Cooklang source never does', async () => {
    const copied = recipeText(await parseRecipeDocument(RECIPE));
    assert.match(copied, /^Ingredients$/m);
    assert.match(copied, /^ {2}250 g +flour$/m);
  });

  it('copies the amounts at the count they were scaled to', async () => {
    const written = await parseRecipeDocument(RECIPE);
    const copied = recipeText((await toPersons(RECIPE, written, 2)).document);
    assert.match(copied, /^ {2}125 g +flour$/m);
    assert.match(copied, /^servings +2$/im);
  });

  it('leaves out the markup, the controls and the colours', async () => {
    const copied = recipeText(await parseRecipeDocument(RECIPE));
    for (const markup of ['@', '{', '[-]', '\x1b']) {
      assert.ok(!copied.includes(markup), `${markup} survived in:\n${copied}`);
    }
  });

  it('never wraps a line, whatever the terminal width', async () => {
    const long = `Stir @flour{250%g} ${'and keep stirring '.repeat(20)}until smooth.\n`;
    const copied = recipeText(await parseRecipeDocument(long));
    assert.ok(copied.split('\n').some((line) => line.length > 300));
  });
});

describe('the ingredients list', () => {
  async function ingredients(source: string, persons: number): Promise<string> {
    const written = await parseRecipeDocument(source);
    return recipeText((await toPersons(source, written, persons)).document);
  }

  const THIRDS = '---\nservings: 3\n---\n\nMix @flour{100%g}, @milk{100%ml}, @sugar{1%cup} and @egg{2}.\n';

  it('rounds grams to whole grams', async () => {
    assert.match(await ingredients(THIRDS, 1), /^ {2}33 g +flour$/m);
  });

  it('rounds every other amount to one decimal place', async () => {
    const copied = await ingredients(THIRDS, 1);
    assert.match(copied, /^ {2}33.3 ml +milk$/m);
    assert.match(copied, /^ {2}0.3 c +sugar$/m);
    assert.match(copied, /^ {2}0.7 +egg$/m);
  });

  it('writes a whole amount without a decimal point', async () => {
    assert.match(await ingredients(THIRDS, 3), /^ {2}2 +egg$/m);
  });

  it('leaves the amounts in the method as the parser wrote them', async () => {
    assert.match(await ingredients(THIRDS, 1), /flour \(33\.3+\d* g\)/);
  });

  it('keeps an amount that is only words', async () => {
    assert.match(await ingredients('Add @salt{a pinch}.\n', 1), /^ {2}a pinch +salt$/m);
  });
});
