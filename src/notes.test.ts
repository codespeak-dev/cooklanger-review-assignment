// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendNote, appendNoteToFile, noteLine } from './notes.js';
import { parseRecipeDocument } from './parser.js';

/** The notes a source parses to, which is what the preview will show. */
async function notes(source: string): Promise<string[]> {
  const document = await parseRecipeDocument(source);
  return document.sections.flatMap((section) =>
    section.blocks.filter((block) => block.kind === 'note').map((block) => block.text),
  );
}

const RECIPE = `---
title: Buttermilk Pancakes
---

Whisk @flour{250%g} into a #bowl{}.
`;

describe('noteLine', () => {
  it('marks the line as a note', () => {
    assert.equal(noteLine('Rest it overnight'), '> Rest it overnight');
  });

  it('flattens the text onto one line', () => {
    assert.equal(noteLine('  two\nlines  '), '> two lines');
  });

  it('escapes a run of dashes, which would otherwise start a comment', () => {
    assert.equal(noteLine('grandma -- her words'), '> grandma \\-\\- her words');
  });

  it('leaves a lone dash alone, so the file stays readable', () => {
    assert.equal(noteLine('2-3 cloves'), '> 2-3 cloves');
  });
});

describe('appendNote', () => {
  it('separates the note from the last step with a blank line', () => {
    const updated = appendNote(RECIPE, 'Rest it overnight');
    assert.ok(updated.endsWith('\n\n> Rest it overnight\n'));
  });

  it('keeps everything the file already said', () => {
    const updated = appendNote(RECIPE, 'Rest it overnight');
    assert.ok(updated.startsWith(RECIPE.trimEnd()));
  });

  it('writes the only line of an empty file', () => {
    assert.equal(appendNote('', 'First thoughts'), '> First thoughts\n');
    assert.equal(appendNote('\n\n', 'First thoughts'), '> First thoughts\n');
  });

  it('adds one blank line however many the file ended with', () => {
    assert.equal(appendNote('Mix it.\n\n\n\n', 'Then wait'), 'Mix it.\n\n> Then wait\n');
  });

  it('reads back as a note beside the steps, not as part of one', async () => {
    const updated = appendNote(RECIPE, 'Rest it overnight');
    assert.deepEqual(await notes(updated), ['Rest it overnight']);

    const document = await parseRecipeDocument(updated);
    const steps = document.sections.flatMap((section) =>
      section.blocks.filter((block) => block.kind === 'step'),
    );
    assert.equal(steps.length, 1);
    assert.ok(!JSON.stringify(steps).includes('Rest it'));
  });

  it('reads back verbatim even when it contains Cooklang punctuation', async () => {
    const text = 'use @salt -- 2-3 pinches -- and a #pan for ~{5%min}';
    assert.deepEqual(await notes(appendNote(RECIPE, text)), [text]);
  });

  it('keeps earlier notes when a second one is added', async () => {
    const twice = appendNote(appendNote(RECIPE, 'First'), 'Second');
    assert.deepEqual(await notes(twice), ['First', 'Second']);
  });
});

describe('appendNoteToFile', () => {
  it('writes the note to disk and returns the new source', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cooklanger-notes-')), 'pancakes.cook');
    await writeFile(path, RECIPE, 'utf8');

    const returned = await appendNoteToFile(path, 'Rest it overnight');
    assert.equal(returned, await readFile(path, 'utf8'));
    assert.deepEqual(await notes(returned), ['Rest it overnight']);
  });

  it('appends to the file as it stands on disk, not to a stale copy', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cooklanger-notes-')), 'pancakes.cook');
    await writeFile(path, RECIPE, 'utf8');
    // Something else edits the recipe between two notes.
    await writeFile(path, `${RECIPE}\nFold in the berries.\n`, 'utf8');

    const returned = await appendNoteToFile(path, 'Rest it overnight');
    assert.ok(returned.includes('Fold in the berries.'));
  });
});
