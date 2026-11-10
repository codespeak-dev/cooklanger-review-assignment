// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainText, type StyledLine } from './layout.js';
import { parseRecipeDocument, type Component } from './parser.js';
import { renderShoppingList } from './render.js';
import {
  buildShoppingList,
  formatAmount,
  scaleFor,
  shoppingText,
  withEntry,
  type ShoppingEntry,
} from './shopping.js';

/** An ingredient list written the short way tests read best. */
function ingredients(...items: Array<[string, number?, string?]>): Component[] {
  return items.map(([name, value, unit]) => ({
    name,
    amounts: value === undefined ? [] : [{ value, unit }],
  }));
}

function entry(name: string, items: Component[], persons = 2): ShoppingEntry {
  return { path: `/recipes/${name}.cook`, name, persons, ingredients: items };
}

/** The list as "amounts name" pairs, which is what the cook reads. */
function lines(entries: readonly ShoppingEntry[]): string[] {
  return buildShoppingList(entries).map((product) =>
    [product.amounts.join(', '), product.name].filter(Boolean).join(' '),
  );
}

describe('buildShoppingList', () => {
  it('adds up the same ingredient across recipes', () => {
    const list = lines([
      entry('pancakes', ingredients(['flour', 250, 'g'])),
      entry('bread', ingredients(['flour', 500, 'g'])),
    ]);
    assert.deepEqual(list, ['750 g flour']);
  });

  it('converts within a unit family before adding up', () => {
    const list = lines([
      entry('soup', ingredients(['stock', 500, 'ml'])),
      entry('stew', ingredients(['stock', 1, 'l'])),
    ]);
    assert.deepEqual(list, ['1.5 l stock']);
  });

  it('keeps a total in the smaller unit until it is worth switching', () => {
    const list = lines([entry('cake', ingredients(['flour', 900, 'g']))]);
    assert.deepEqual(list, ['900 g flour']);
  });

  it('keeps units it cannot convert as separate amounts', () => {
    const list = lines([
      entry('rub', ingredients(['salt', 1, 'tsp'])),
      entry('brine', ingredients(['salt', 30, 'g'])),
    ]);
    assert.deepEqual(list, ['1 tsp, 30 g salt']);
  });

  it('adds up countable ingredients that carry no unit', () => {
    const list = lines([
      entry('pancakes', ingredients(['eggs', 2])),
      entry('custard', ingredients(['eggs', 3])),
    ]);
    assert.deepEqual(list, ['5 eggs']);
  });

  it('treats different spellings of one ingredient as one product', () => {
    const list = lines([
      entry('a', ingredients(['Olive Oil', 2, 'tbsp'])),
      entry('b', ingredients(['olive oil', 1, 'tbsp'])),
    ]);
    assert.deepEqual(list, ['3 tbsp Olive Oil']);
  });

  it('lists an ingredient with no quantity, since it still has to be bought', () => {
    const list = lines([entry('salad', ingredients(['pepper']))]);
    assert.deepEqual(list, ['pepper']);
  });

  it('keeps a quantity that is not a number as the words it was written in', () => {
    const list = lines([
      { ...entry('soup', []), ingredients: [{ name: 'basil', amounts: [{ text: 'a handful' }] }] },
    ]);
    assert.deepEqual(list, ['a handful basil']);
  });

  it('sorts products by name so the list can be walked down', () => {
    const list = lines([
      entry('one', ingredients(['sugar', 1, 'tbsp'], ['butter', 1, 'tbsp'], ['flour', 1, 'g'])),
    ]);
    assert.deepEqual(list, ['1 tbsp butter', '1 g flour', '1 tbsp sugar']);
  });

  it('is empty when nothing has been added', () => {
    assert.deepEqual(buildShoppingList([]), []);
  });
});

describe('withEntry', () => {
  const pancakes = entry('pancakes', ingredients(['flour', 250, 'g']), 4);

  it('adds a recipe that is not on the list yet', () => {
    const list = withEntry([], pancakes);
    assert.deepEqual(
      list.map((item) => [item.name, item.persons]),
      [['pancakes', 4]],
    );
  });

  it('replaces the count when the same recipe is added again', () => {
    const list = withEntry([pancakes], { ...pancakes, persons: 6 });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.persons, 6);
  });

  it('takes a recipe off the list when it is added for nobody', () => {
    assert.deepEqual(withEntry([pancakes], { ...pancakes, persons: 0 }), []);
  });

  it('leaves other recipes alone', () => {
    const soup = entry('soup', ingredients(['tomatoes', 1, 'kg']));
    const list = withEntry([pancakes, soup], { ...pancakes, persons: 2 });
    assert.deepEqual(
      list.map((item) => item.name),
      ['soup', 'pancakes'],
    );
  });
});

describe('scaleFor', () => {
  it('scales by the ratio of people to servings', () => {
    assert.equal(scaleFor(8, 4), 2);
    assert.equal(scaleFor(6, 4), 1.5);
    assert.equal(scaleFor(4, 4), 1);
  });

  it('does not scale a recipe that never said how many it serves', () => {
    assert.equal(scaleFor(4, undefined), undefined);
    assert.equal(scaleFor(4, 0), undefined);
  });
});

describe('formatAmount', () => {
  it('drops the decimals a whole amount does not need', () => {
    assert.equal(formatAmount(750), '750');
    assert.equal(formatAmount(1.5), '1.5');
  });

  it('rounds away the noise that scaling leaves behind', () => {
    assert.equal(formatAmount(333.33333), '333.33');
    assert.equal(formatAmount(2.0000001), '2');
  });
});

describe('shoppingText', () => {
  it('writes one product per line, ready to paste', () => {
    const text = shoppingText(
      buildShoppingList([entry('pancakes', ingredients(['flour', 250, 'g'], ['pepper']))]),
    );
    assert.equal(text, '- 250 g flour\n- pepper');
  });
});

/** The rendered list as text, which is what the shopping mode shows. */
function rendered(entries: readonly ShoppingEntry[], width = 50): string {
  const shown: StyledLine[] = renderShoppingList(buildShoppingList(entries), entries, width);
  return shown.map(plainText).join('\n');
}

describe('renderShoppingList', () => {
  it('shows every product with the amount to buy', () => {
    const text = rendered([
      entry('pancakes', ingredients(['flour', 250, 'g'], ['eggs', 2]), 4),
      entry('bread', ingredients(['flour', 500, 'g']), 2),
    ]);
    assert.match(text, /750 g\s+flour/);
    assert.match(text, /2\s+eggs/);
  });

  it('says which recipes the amounts are for', () => {
    const text = rendered([entry('pancakes', ingredients(['flour', 250, 'g']), 4)]);
    assert.match(text, /pancakes\s+4 persons/);
  });

  it('uses the singular for a list for one person', () => {
    const text = rendered([entry('pancakes', ingredients(['flour', 60, 'g']), 1)]);
    assert.match(text, /1 person\b/);
  });

  it('flags a recipe whose amounts could not be scaled', () => {
    const text = rendered(
      [{ ...entry('mystery', ingredients(['flour', 250, 'g'])), unscaled: true }],
      70,
    );
    assert.match(text, /no servings given/);
  });

  it('says the list is empty rather than showing an empty frame', () => {
    assert.match(rendered([]), /shopping list is empty/i);
  });

  it('never renders a line wider than the pane', () => {
    const flour = 'a very finely ground wholemeal spelt flour';
    const long = entry('long', ingredients([flour, 1250, 'g']));
    for (const line of renderShoppingList(buildShoppingList([long]), [long], 24)) {
      assert.ok(plainText(line).length <= 24, `too wide: ${plainText(line)}`);
    }
  });
});

describe('scaled parsing', () => {
  const RECIPE = `---
title: Pancakes
servings: 4
---

Whisk @flour{250%g} with @eggs{2}.
`;

  it('reads the servings the recipe yields', async () => {
    const doc = await parseRecipeDocument(RECIPE);
    assert.equal(doc.servings, 4);
  });

  it('multiplies the ingredient amounts by the scale', async () => {
    const doc = await parseRecipeDocument(RECIPE, 2);
    assert.deepEqual(
      doc.ingredients.map((item) => [item.name, item.quantity]),
      [
        ['flour', '500 g'],
        ['eggs', '4'],
      ],
    );
  });

  it('carries amounts that can be added up alongside the display text', async () => {
    const doc = await parseRecipeDocument(RECIPE, 2);
    assert.deepEqual(doc.ingredients[0]?.amounts, [{ value: 500, unit: 'g' }]);
    assert.deepEqual(doc.ingredients[1]?.amounts, [{ value: 4, unit: undefined }]);
  });

  it('builds a list for a party straight from a parsed recipe', async () => {
    // Twelve people at four servings is three times the recipe as written.
    const doc = await parseRecipeDocument(RECIPE, scaleFor(12, 4));
    const list = lines([entry('pancakes', doc.ingredients, 12)]);
    assert.deepEqual(list, ['6 eggs', '750 g flour']);
  });
});
