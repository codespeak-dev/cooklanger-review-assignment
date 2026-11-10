// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRecipeDocument, toPersons } from './parser.js';

/** The one ingredient's amount, as the preview would show it. */
async function amountOf(source: string): Promise<string | undefined> {
  const written = await parseRecipeDocument(source);
  return (await toPersons(source, written)).document.ingredients[0]?.quantity;
}

describe('toPersons', () => {
  it('brings the amounts down by the servings the recipe gives', async () => {
    assert.equal(await amountOf('---\nservings: 4\n---\n\nMix @flour{800%g}.\n'), '200 g');
  });

  it('says what the amounts were scaled from', async () => {
    const source = '---\nservings: 4\n---\n\nMix @flour{800%g}.\n';
    const portion = await toPersons(source, await parseRecipeDocument(source));

    assert.equal(portion.writtenFor, 4);
    assert.equal(portion.scaled, true);
  });

  it('brings the servings metadata down with the amounts', async () => {
    const source = '---\nservings: 4\n---\n\nMix @flour{800%g}.\n';
    const portion = await toPersons(source, await parseRecipeDocument(source));

    assert.equal(portion.document.servings, 1);
  });

  it('leaves a recipe that never says how many it serves as written', async () => {
    const source = 'Mix @flour{800%g}.\n';
    const portion = await toPersons(source, await parseRecipeDocument(source));

    assert.equal(portion.scaled, false);
    assert.equal(portion.writtenFor, undefined);
    assert.equal(portion.document.ingredients[0]?.quantity, '800 g');
  });

  it('leaves a recipe already written for one person untouched', async () => {
    const source = '---\nservings: 1\n---\n\nMix @flour{200%g}.\n';
    const written = await parseRecipeDocument(source);
    const portion = await toPersons(source, written);

    assert.equal(portion.scaled, true);
    assert.equal(portion.writtenFor, 1);
    // The very same document, so scaling by one cannot cost precision.
    assert.equal(portion.document, written);
  });

  it('ignores a servings field that is not a usable number', async () => {
    for (const servings of ['lots', '0', '-2']) {
      const source = `---\nservings: ${servings}\n---\n\nMix @flour{800%g}.\n`;
      const portion = await toPersons(source, await parseRecipeDocument(source));

      assert.equal(portion.scaled, false, servings);
      assert.equal(portion.document.ingredients[0]?.quantity, '800 g', servings);
    }
  });

  it('scales every ingredient of a recipe, not just the first', async () => {
    const source = '---\nservings: 2\n---\n\nMix @flour{500%g} and @milk{300%ml}.\n';
    const portion = await toPersons(source, await parseRecipeDocument(source));

    assert.deepEqual(
      portion.document.ingredients.map((one) => one.quantity),
      ['250 g', '150 ml'],
    );
  });

  it('leaves an amount that is only words alone', async () => {
    assert.equal(await amountOf('---\nservings: 4\n---\n\nAdd @salt{a pinch}.\n'), 'a pinch');
  });

  it('reads a servings field the author wrote as a phrase', async () => {
    // "4 people" is not a plain number, so there is nothing to divide by.
    const source = '---\nservings: 4 people\n---\n\nMix @flour{800%g}.\n';
    const portion = await toPersons(source, await parseRecipeDocument(source));

    assert.equal(portion.document.ingredients[0]?.quantity, '200 g');
    assert.equal(portion.writtenFor, 4);
  });

  it('scales to any number of people, from what the author wrote', async () => {
    const source = '---\nservings: 4\n---\n\nMix @flour{800%g}.\n';
    const portion = await toPersons(source, await parseRecipeDocument(source), 6);

    assert.equal(portion.document.ingredients[0]?.quantity, '1.2 kg');
    assert.equal(portion.document.servings, 6);
    assert.equal(portion.persons, 6);
    assert.equal(portion.scaled, true);
  });

  it('leaves a recipe asked for at its own count untouched', async () => {
    const source = '---\nservings: 4\n---\n\nMix @flour{800%g}.\n';
    const written = await parseRecipeDocument(source);

    assert.equal((await toPersons(source, written, 4)).document, written);
  });
});
