import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseKeys } from './keys.js';
import {
  clampOffset,
  computeLayout,
  fit,
  fitStyled,
  plainText,
  renderPanel,
  renderScreen,
  scrollToVisible,
  span,
  styled,
  truncate,
  wrapStyled,
  type ViewModel,
} from './layout.js';

describe('computeLayout', () => {
  it('splits the width between the panes, leaving room for the borders', () => {
    const { listWidth, previewWidth, contentHeight } = computeLayout({ columns: 100, rows: 30 });
    assert.equal(listWidth + previewWidth + 3, 100);
    assert.equal(contentHeight, 27);
  });

  it('caps the list pane so a wide terminal gives the space to the preview', () => {
    const { listWidth, previewWidth } = computeLayout({ columns: 400, rows: 30 });
    assert.equal(listWidth, 40);
    assert.equal(previewWidth, 400 - 3 - 40);
  });

  it('keeps both panes usable in a narrow terminal', () => {
    const { listWidth, previewWidth } = computeLayout({ columns: 32, rows: 10 });
    assert.ok(listWidth >= 8);
    assert.ok(previewWidth >= 8);
    assert.equal(listWidth + previewWidth + 3, 32);
  });

  it('never reports a content height below one row', () => {
    assert.equal(computeLayout({ columns: 80, rows: 1 }).contentHeight, 3);
  });
});

describe('truncate and fit', () => {
  it('marks a cut with an ellipsis', () => {
    assert.equal(truncate('tomato soup', 6), 'tomat…');
    assert.equal(truncate('tomato', 6), 'tomato');
    assert.equal(truncate('tomato', 1), '…');
    assert.equal(truncate('tomato', 0), '');
  });

  it('pads to exactly the requested width', () => {
    assert.equal(fit('soup', 8), 'soup    ');
    assert.equal(fit('tomato soup', 8).length, 8);
  });
});

describe('wrapStyled', () => {
  const line = [span('Whisk '), span('flour', 'ingredient'), span(' in the bowl')];
  const wrapPlain = (text: string, width: number): string[] =>
    wrapStyled(styled(text), width).map(plainText);

  it('breaks at spaces', () => {
    assert.deepEqual(wrapPlain('add the tomatoes now', 10), ['add the', 'tomatoes', 'now']);
  });

  it('breaks inside a word that cannot fit', () => {
    assert.deepEqual(wrapPlain('aaaaaaaaaaaa', 5), ['aaaaa', 'aaaaa', 'aa']);
  });

  it('never emits a line wider than the pane', () => {
    for (const width of [12, 7, 1]) {
      for (const wrapped of wrapPlain('Whisk the eggs into the buttermilk.', width)) {
        assert.ok(wrapped.length <= width, wrapped);
      }
    }
  });

  it('keeps each span with its style across a break', () => {
    const wrapped = wrapStyled(line, 10);
    assert.deepEqual(wrapped.map(plainText), ['Whisk', 'flour in', 'the bowl']);
    assert.deepEqual(wrapped[1]![0], { text: 'flour', style: 'ingredient' });
    assert.deepEqual(wrapped[1]![1], { text: ' in', style: 'text' });
  });

  it('indents continuation lines so a step hangs under its number', () => {
    const wrapped = wrapStyled(line, 12, 3);
    assert.deepEqual(wrapped.map(plainText), ['Whisk flour', '   in the', '   bowl']);
  });

  it('merges neighbouring spans that share a style', () => {
    const merged = wrapStyled([span('a'), span('b'), span('c', 'note')], 10);
    assert.deepEqual(merged[0], [
      { text: 'ab', style: 'text' },
      { text: 'c', style: 'note' },
    ]);
  });

  it('keeps a blank line blank, so recipe paragraphs survive', () => {
    assert.deepEqual(wrapStyled([], 10), [[]]);
    assert.deepEqual(wrapStyled(styled(''), 10), [[]]);
  });
});

describe('fitStyled', () => {
  it('pads to exactly the requested width', () => {
    const fitted = fitStyled([span('250 g', 'quantity'), span(' flour', 'ingredient')], 12);
    assert.equal(plainText(fitted), '250 g flour ');
    assert.deepEqual(fitted[0], { text: '250 g', style: 'quantity' });
  });

  it('marks a cut with an ellipsis and drops the spans past it', () => {
    const fitted = fitStyled([span('250 g', 'quantity'), span(' flour', 'ingredient')], 7);
    assert.equal(plainText(fitted), '250 g …');
    assert.equal(fitted.length, 2);
  });
});

describe('scrollToVisible', () => {
  it('leaves the offset alone while the selection is on screen', () => {
    assert.equal(scrollToVisible(5, 7, 10, 40), 5);
  });

  it('scrolls up just enough to reveal the selection', () => {
    assert.equal(scrollToVisible(5, 3, 10, 40), 3);
  });

  it('scrolls down just enough to reveal the selection', () => {
    assert.equal(scrollToVisible(0, 12, 10, 40), 3);
  });

  it('does not scroll past the end of the list', () => {
    assert.equal(scrollToVisible(100, 39, 10, 40), 30);
  });

  it('stays at zero when everything fits', () => {
    assert.equal(scrollToVisible(0, 2, 10, 4), 0);
  });
});

describe('clampOffset', () => {
  it('holds the offset inside the scrollable range', () => {
    assert.equal(clampOffset(-5, 10, 40), 0);
    assert.equal(clampOffset(999, 10, 40), 30);
    assert.equal(clampOffset(999, 10, 4), 0);
  });
});

const view = (overrides: Partial<ViewModel> = {}): ViewModel => ({
  directory: './recipes',
  recipes: [
    { name: 'Apple Crumble', relativePath: 'desserts/apple-crumble.cook' },
    { name: 'Pancakes', relativePath: 'pancakes.cook' },
    { name: 'Tomato Soup', relativePath: 'tomato-soup.cook' },
  ],
  selected: 0,
  listOffset: 0,
  previewLines: [styled('Apple Crumble', 'title'), [], styled('Bake the apples.')],
  previewOffset: 0,
  focus: 'list',
  ...overrides,
});

describe('renderScreen', () => {
  const size = { columns: 60, rows: 12 };

  it('fills the terminal exactly, one string per row', () => {
    const lines = renderScreen(view(), size, false);
    assert.equal(lines.length, size.rows);
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('draws both panes with a shared divider', () => {
    const [top] = renderScreen(view(), size, false);
    assert.ok(top!.startsWith('┌'));
    assert.ok(top!.endsWith('┐'));
    assert.equal([...top!].filter((char) => char === '┬').length, 1);
  });

  it('titles the panes with the directory and the selected recipe path', () => {
    const lines = renderScreen(view({ selected: 1 }), { columns: 80, rows: 12 }, false);
    assert.match(lines[0]!, /\.\/recipes/);
    assert.match(lines[0]!, /pancakes\.cook/);
  });

  it('truncates a pane title that cannot fit rather than widening the frame', () => {
    const lines = renderScreen(view({ directory: './a/very/deeply/nested/folder' }), size, false);
    assert.equal(lines[0]!.length, size.columns);
    assert.ok(lines[0]!.includes('…'));
  });

  it('marks the selected recipe and shows the preview beside it', () => {
    const lines = renderScreen(view({ selected: 2 }), size, false);
    const row = lines.find((line) => line.includes('Tomato Soup'));
    assert.ok(row?.includes('› Tomato Soup'));
    assert.ok(lines.some((line) => line.includes('Bake the apples.')));
  });

  it('badges a recipe a model wrote, and only that one', () => {
    const lines = renderScreen(
      view({
        recipes: [
          { name: 'Apple Crumble', relativePath: 'a.cook', authorship: 'human' },
          { name: 'Vegan Soup', relativePath: 'b.cook', authorship: 'llm' },
          { name: 'Tomato Soup', relativePath: 'c.cook', authorship: 'unknown' },
        ],
      }),
      size,
      false,
    );

    const rowFor = (name: string): string =>
      lines.find((line) => line.includes(name)) ?? '';

    assert.match(rowFor('Vegan Soup'), /Vegan Soup\s+\[AI\]/);
    // The badge is inside the pane, not added to it: the frame must still line up.
    for (const line of lines) assert.equal(line.length, size.columns, line);
    // A person's recipe and one that says nothing both stay unbadged: saying
    // them apart at a glance would claim more than the files do.
    assert.ok(!rowFor('Apple Crumble').includes('[AI]'));
    assert.ok(!rowFor('Tomato Soup').includes('[AI]'));
  });

  it('stars a favourite recipe, and only that one', () => {
    const lines = renderScreen(
      view({
        recipes: [
          { name: 'Apple Crumble', relativePath: 'a.cook', favourite: true },
          { name: 'Pancakes', relativePath: 'b.cook' },
        ],
      }),
      size,
      false,
    );

    const rowFor = (name: string): string => lines.find((line) => line.includes(name)) ?? '';

    assert.match(rowFor('Apple Crumble'), /\u2605 Apple Crumble/);
    assert.ok(!rowFor('Pancakes').includes('\u2605'));
    // The star is inside the pane, not added to it: the frame must still line up.
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('holds no room for a star when nothing is marked', () => {
    const lines = renderScreen(view(), size, false);
    assert.ok(lines.some((line) => line.includes('\u203a Apple Crumble')));
  });

  it('shows both marks on a favourite a model wrote', () => {
    const lines = renderScreen(
      view({
        recipes: [{ name: 'Vegan Soup', relativePath: 'a.cook', authorship: 'llm', favourite: true }],
      }),
      { columns: 80, rows: 12 },
      false,
    );

    const row = lines.find((line) => line.includes('Vegan Soup'))!;
    assert.match(row, /\u2605 Vegan Soup\s+\[AI\]/);
  });

  it('titles the list pane favourites while the filter is on', () => {
    const lines = renderScreen(view({ filtered: true }), size, false);
    assert.match(lines[0]!, /favourites/);
    assert.ok(!lines[0]!.includes('./recipes'));
  });

  // An empty filtered list is a state the cook can put themselves in, so the
  // pane explains itself rather than reading as a list still loading.
  it('says the filter matched nothing when it is on and the list is empty', () => {
    const lines = renderScreen(view({ recipes: [], previewLines: [], filtered: true }), size, false);
    assert.ok(lines.some((line) => line.includes('no favourites')));
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('says there are no recipes when the folder itself is empty', () => {
    const lines = renderScreen(view({ recipes: [], previewLines: [] }), size, false);
    assert.ok(lines.some((line) => line.includes('no recipes')));
    assert.ok(!lines.some((line) => line.includes('no favourites')));
  });

  it('shows the scrolled window of a list taller than the pane', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      name: `Recipe ${index}`,
      relativePath: `recipe-${index}.cook`,
    }));
    const lines = renderScreen(
      view({ recipes: many, selected: 30, listOffset: 25 }),
      size,
      false,
    ).join('\n');

    assert.ok(lines.includes('› Recipe 30'));
    assert.ok(lines.includes('Recipe 25'));
    assert.ok(!lines.includes('Recipe 0 '));
  });

  it('reports the position and the key hints in the status line', () => {
    const lines = renderScreen(view({ selected: 1 }), size, false);
    const status = lines.at(-1)!;
    assert.match(status, /2\/3/);
    // The hints outrun a narrow terminal, so this is the last one that fits.
    assert.match(status, /r remix/);
  });

  it('shows every hint when the terminal is wide enough for them', () => {
    const status = renderScreen(view({}), { columns: 140, rows: 12 }, false).at(-1)!;
    for (const hint of ['↑↓ move', 'tab pane', '-/+ persons', 'n note', 'r remix', 'd delete', 'q quit']) {
      assert.ok(status.includes(hint), `missing “${hint}” in: ${status}`);
    }
  });

  it('trades hints away rather than cutting off how to quit', () => {
    for (const columns of [40, 60, 80, 100, 120, 140]) {
      const status = renderScreen(view({}), { columns, rows: 12 }, false).at(-1)!;
      assert.ok(status.includes('q quit'), `no way to quit at ${columns} columns: ${status}`);
      assert.ok(!status.includes('…'), `hints were cut at ${columns} columns: ${status}`);
    }
  });

  it('replaces the hints with a transient status message', () => {
    const lines = renderScreen(view({ status: 'Copied “Pancakes”' }), size, false);
    const status = lines.at(-1)!;
    assert.match(status, /Copied “Pancakes”/);
    assert.ok(!status.includes('r remix'));
  });

  it('colours the preview by what each span means', () => {
    const lines = renderScreen(
      view({ previewLines: [[span('250 g', 'quantity'), span(' flour', 'ingredient')]] }),
      size,
      true,
    );
    const row = lines.find((line) => line.includes('flour'))!;
    assert.ok(row.includes('\x1b[33m250 g\x1b[0m'));
    assert.ok(row.includes('\x1b[32m flour\x1b[0m'));
  });

  it('stays rectangular once colour is switched on', () => {
    const plain = renderScreen(view(), size, false);
    const colored = renderScreen(view(), size, true);
    assert.equal(colored.length, plain.length);
    // eslint-disable-next-line no-control-regex
    const stripped = colored.map((line) => line.replace(/\x1b\[[\d;]*m/g, ''));
    assert.deepEqual(stripped, plain);
  });

  it('handles an empty preview and a list shorter than the pane', () => {
    const lines = renderScreen(view({ previewLines: [], recipes: [] }), size, false);
    assert.equal(lines.length, size.rows);
    for (const line of lines) assert.equal(line.length, size.columns);
    assert.match(lines.at(-1)!, /0\/0/);
    assert.match(lines[0]!, /no recipe/);
  });
});

describe('renderScreen with a diet on', () => {
  const size = { columns: 60, rows: 12 };
  const recipes = [
    { name: 'Apple Crumble', relativePath: 'a.cook', diet: 'pass' as const },
    { name: 'Chicken Soup', relativePath: 'b.cook', diet: 'fail' as const },
    { name: 'Pancakes', relativePath: 'c.cook', diet: 'pending' as const },
  ];
  const rowFor = (lines: string[], name: string): string =>
    lines.find((line) => line.includes(name)) ?? '';

  it('crosses a recipe that breaks the diet, and only that one', () => {
    const lines = renderScreen(view({ recipes, diet: 'vegan' }), size, false);
    assert.match(rowFor(lines, 'Chicken Soup'), /Chicken Soup\s+✗│/);
    assert.ok(!rowFor(lines, 'Apple Crumble').includes('✗'));
    assert.ok(!rowFor(lines, 'Pancakes').includes('✗'));
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('marks a recipe not checked yet as not known', () => {
    const lines = renderScreen(view({ recipes, diet: 'vegan' }), size, false);
    assert.match(rowFor(lines, 'Pancakes'), /Pancakes\s+·│/);
    assert.ok(!rowFor(lines, 'Apple Crumble').includes('·'));
  });

  it('dims the row of a recipe that breaks the diet', () => {
    const lines = renderScreen(view({ recipes, diet: 'vegan' }), size, true);
    const row = rowFor(lines, 'Chicken Soup');
    assert.match(row, /\x1b\[2m {2}Chicken Soup\s*\x1b\[0m/);
    assert.ok(row.includes('\x1b[31m ✗\x1b[0m'));
  });

  it('puts the diet mark after the [AI] badge', () => {
    const lines = renderScreen(
      view({
        recipes: [{ name: 'Beef Stew', relativePath: 'a.cook', authorship: 'llm', diet: 'fail' }],
        diet: 'vegan',
      }),
      size,
      false,
    );
    assert.match(rowFor(lines, 'Beef Stew'), /Beef Stew\s+\[AI\] ✗│/);
  });

  it('holds no room for the mark when no diet is on', () => {
    const rows = renderScreen(view(), size, false).slice(1, -2);
    assert.ok(!rows.some((line) => /[✗·]/.test(line)));
  });

  it('names the diet beside the position in the status line', () => {
    const status = renderScreen(view({ recipes, diet: 'vegan' }), size, false).at(-1)!;
    assert.match(status, /vegan · 1\/3 $/);
  });

  it('offers the diet keys in the hints', () => {
    const off = renderScreen(view(), { columns: 160, rows: 12 }, false).at(-1)!;
    assert.ok(off.includes('D diet') && !off.includes('V fits'));
    const on = renderScreen(view({ diet: 'vegan' }), { columns: 160, rows: 12 }, false).at(-1)!;
    assert.ok(on.includes('D diet · R fit · V fits'), on);
  });

  it('titles the list pane after the diet while recipes that break it are hidden', () => {
    const size = { columns: 100, rows: 12 };
    const lines = renderScreen(view({ diet: 'vegan', dietFilter: 'vegan' }), size, false);
    assert.match(lines[0]!, /fits vegan/);
    const both = renderScreen(view({ diet: 'vegan', dietFilter: 'vegan', filtered: true }), size, false);
    assert.match(both[0]!, /favourites · vegan/);
  });

  it('says what an empty diet-filtered list is empty of', () => {
    const size = { columns: 100, rows: 12 };
    const empty = { recipes: [], previewLines: [], diet: 'vegan', dietFilter: 'vegan' };
    assert.ok(renderScreen(view(empty), size, false).some((line) => line.includes('nothing fits vegan')));
    assert.ok(
      renderScreen(view({ ...empty, filtered: true }), size, false).some((line) =>
        line.includes('no favourites fit vegan'),
      ),
    );
  });
});

describe('renderScreen with a picker', () => {
  const size = { columns: 60, rows: 14 };
  const picker = {
    title: 'diet',
    items: [
      { label: 'none' },
      { label: 'vegetarian', tag: 'on' },
      { label: 'low fodmap', tag: 'yours' },
      { label: 'new…' },
    ],
    selected: 2,
    hint: 'return picks · esc cancels',
  };

  it('shows every choice, the arrow, the tags and the hint, inside the frame', () => {
    const lines = renderScreen(view({ picker }), size, false);
    const screen = lines.join('\n');
    assert.ok(screen.includes('diet'));
    assert.match(screen, /› low fodmap\s+yours/);
    assert.match(screen, / {2}vegetarian\s+on/);
    assert.ok(screen.includes('new…'));
    assert.ok(screen.includes('return picks · esc cancels'));
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('scrolls a list of choices longer than the screen to keep the arrow in view', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ label: `diet ${index}` }));
    const lines = renderScreen(view({ picker: { ...picker, items, selected: 25 } }), size, false);
    const screen = lines.join('\n');
    assert.ok(screen.includes('› diet 25'));
    assert.ok(!screen.includes('diet 0 '));
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('stays rectangular once colour is switched on', () => {
    const plain = renderScreen(view({ picker }), size, false);
    const colored = renderScreen(view({ picker }), size, true);
    assert.deepEqual(colored.map((line) => line.replace(/\x1b\[[\d;]*m/g, '')), plain);
  });
});

describe('renderScreen with an overlay', () => {
  const size = { columns: 60, rows: 14 };
  const overlay = { title: 'note on Pancakes', typed: 'Rest it overnight', hint: 'esc cancels' };

  it('keeps the frame rectangular', () => {
    const lines = renderScreen(view({ overlay }), size, false);
    assert.equal(lines.length, size.rows);
    for (const line of lines) assert.equal(line.length, size.columns, line);
  });

  it('shows the title, the typed text and the hint', () => {
    const screen = renderScreen(view({ overlay }), size, false).join('\n');
    assert.ok(screen.includes('note on Pancakes'));
    assert.ok(screen.includes('Rest it overnight'));
    assert.ok(screen.includes('esc cancels'));
  });

  it('puts a cursor after the text, so an empty draft still shows one', () => {
    const empty = renderScreen(view({ overlay: { ...overlay, typed: '' } }), size, false);
    assert.ok(empty.some((line) => line.includes('█')));
    const typed = renderScreen(view({ overlay }), size, false);
    assert.ok(typed.some((line) => line.includes('Rest it overnight█')));
  });

  it('hides the rows of both panes it covers and leaves the rest alone', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      name: `Recipe ${index}`,
      relativePath: `recipe-${index}.cook`,
    }));
    const previewLines = many.map((_, index) => styled(`preview line ${index}`));
    const behind = view({ recipes: many, previewLines });

    const without = renderScreen(behind, size, false).join('\n');
    const withOverlay = renderScreen({ ...behind, overlay }, size, false).join('\n');

    // Centred over eleven content rows, the box takes four of them.
    assert.ok(without.includes('preview line 4') && without.includes('Recipe 4'));
    assert.ok(!withOverlay.includes('preview line 4') && !withOverlay.includes('Recipe 4'));
    assert.ok(withOverlay.includes('preview line 0') && withOverlay.includes('Recipe 0'));
    assert.ok(withOverlay.includes('preview line 10') && withOverlay.includes('Recipe 10'));
  });

  it('wraps a note too long for one row and keeps the cursor in view', () => {
    const long = 'a'.repeat(200);
    const lines = renderScreen(view({ overlay: { ...overlay, typed: long } }), size, false);
    for (const line of lines) assert.equal(line.length, size.columns, line);
    assert.ok(lines.some((line) => line.includes('a█')));
  });

  it('shows as much of the box as a short terminal has room for', () => {
    const lines = renderScreen(view({ overlay }), { columns: 60, rows: 7 }, false);
    assert.equal(lines.length, 7);
    for (const line of lines) assert.equal(line.length, 60, line);
    assert.ok(lines.join('\n').includes('note on Pancakes'));
  });

  it('stays rectangular once colour is switched on', () => {
    const plain = renderScreen(view({ overlay }), size, false);
    const colored = renderScreen(view({ overlay }), size, true);
    // eslint-disable-next-line no-control-regex
    assert.deepEqual(colored.map((line) => line.replace(/\x1b\[[\d;]*m/g, '')), plain);
  });
});

describe('renderPanel', () => {
  const size = { columns: 40, rows: 10 };
  const lines = [styled('Shopping list', 'title'), [], styled('  750 g  flour')];

  it('fills the terminal exactly with one full-width pane', () => {
    const rows = renderPanel({ title: 'shopping list', lines, offset: 0 }, size, false);
    assert.equal(rows.length, size.rows);
    for (const row of rows) assert.equal(row.length, size.columns, row);
    assert.ok(!rows[0]!.includes('┬'));
  });

  it('titles the pane and shows its content', () => {
    const rows = renderPanel({ title: 'shopping list', lines, offset: 0 }, size, false);
    assert.match(rows[0]!, /shopping list/);
    assert.ok(rows.some((row) => row.includes('750 g  flour')));
  });

  it('shows the scrolled window of content taller than the pane', () => {
    const many = Array.from({ length: 40 }, (_, index) => styled(`item ${index}`));
    const rows = renderPanel({ title: 'shopping list', lines: many, offset: 20 }, size, false);
    assert.ok(rows.some((row) => row.includes('item 20')));
    assert.ok(!rows.some((row) => row.includes('item 19')));
  });

  it('reports how far down a long list the view has reached', () => {
    const many = Array.from({ length: 40 }, (_, index) => styled(`item ${index}`));
    const status = renderPanel({ title: 'list', lines: many, offset: 0 }, size, false).at(-1)!;
    assert.match(status, /7\/40/);
  });

  it('leaves the position out when everything already fits', () => {
    const status = renderPanel({ title: 'list', lines, offset: 0 }, size, false).at(-1)!;
    assert.ok(!/\d+\/\d+/.test(status));
    assert.match(status, /s recipes/);
  });

  it('replaces the hints with a transient status message', () => {
    const status = renderPanel(
      { title: 'list', lines, offset: 0, status: 'Copied the shopping list' },
      size,
      false,
    ).at(-1)!;
    assert.match(status, /Copied the shopping list/);
  });
});

describe('parseKeys', () => {
  it('names the arrow keys in both cursor modes', () => {
    assert.deepEqual(parseKeys('\x1b[A\x1b[B'), [{ name: 'up' }, { name: 'down' }]);
    assert.deepEqual(parseKeys('\x1bOA\x1bOB'), [{ name: 'up' }, { name: 'down' }]);
  });

  it('names paging and jump keys', () => {
    assert.deepEqual(parseKeys('\x1b[5~\x1b[6~\x1b[H\x1b[F'), [
      { name: 'pageUp' },
      { name: 'pageDown' },
      { name: 'home' },
      { name: 'end' },
    ]);
  });

  it('passes plain characters through', () => {
    assert.deepEqual(parseKeys('cq'), [
      { name: 'char', value: 'c' },
      { name: 'char', value: 'q' },
    ]);
  });

  it('reads tab and shift-tab', () => {
    assert.deepEqual(parseKeys('\t\x1b[Z'), [{ name: 'tab' }, { name: 'shiftTab' }]);
  });

  it('reads return and backspace however the terminal sends them', () => {
    assert.deepEqual(parseKeys('\r\n'), [{ name: 'enter' }, { name: 'enter' }]);
    assert.deepEqual(parseKeys('\x7f\b'), [{ name: 'backspace' }, { name: 'backspace' }]);
  });

  it('reports a bare escape', () => {
    assert.deepEqual(parseKeys('\x1b'), [{ name: 'escape' }]);
  });

  it('swallows unbound sequences instead of reading their tail as letters', () => {
    assert.deepEqual(parseKeys('\x1b[200~c'), [{ name: 'char', value: 'c' }]);
    assert.deepEqual(parseKeys('\x1b[1;5Dj'), [{ name: 'char', value: 'j' }]);
  });

  it('decodes a burst of keys arriving in one chunk', () => {
    assert.deepEqual(parseKeys('j\x1b[Bk'), [
      { name: 'char', value: 'j' },
      { name: 'down' },
      { name: 'char', value: 'k' },
    ]);
  });
});
