// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseEnv } from './env.js';
import { appendNote, stripNotes } from './notes.js';
import { parseRecipeDocument } from './parser.js';
import { remixFile, remixPrompt, saveRemix, slugForTitle } from './remix.js';

const RECIPE = `---
title: Roasted Tomato Soup
servings: 3
---

Halve @tomatoes{1%kg} and toss with @olive oil{3%tbsp}.

Blend with @vegetable stock{500%ml} until smooth.
`;

describe('stripNotes', () => {
  it('drops the notes the cook jotted down', () => {
    const withNotes = appendNote(appendNote(RECIPE, 'Add MORE pepper'), 'Too thin last time');
    const stripped = stripNotes(withNotes);

    assert.ok(!stripped.includes('Add MORE pepper'));
    assert.ok(!stripped.includes('Too thin last time'));
  });

  it('keeps every step and the front matter', async () => {
    const stripped = stripNotes(appendNote(RECIPE, 'Add MORE pepper'));
    const document = await parseRecipeDocument(stripped);

    assert.equal(document.title, 'Roasted Tomato Soup');
    assert.equal(document.servings, 3);
    assert.equal(
      document.sections.flatMap((section) => section.blocks).filter((b) => b.kind === 'step')
        .length,
      2,
    );
  });

  it('leaves a recipe without notes as it was', () => {
    assert.equal(stripNotes(RECIPE), RECIPE);
  });

  it('does not mistake a YAML block for a note', () => {
    const source = '---\ntitle: Soup\ndescription: >\n  A long one\n---\n\nBoil @water{1%l}.\n';
    assert.ok(stripNotes(source).includes('description: >'));
  });

  it('leaves no gap where the note used to be', () => {
    assert.equal(stripNotes('Mix it.\n\n> A remark\n'), 'Mix it.\n');
  });
});

describe('remixPrompt', () => {
  it('gives the model the recipe, the name and the request', () => {
    const prompt = remixPrompt({
      source: RECIPE,
      note: 'make it vegan',
      name: 'Roasted Tomato Soup',
      apiKey: 'unused',
    });

    assert.ok(prompt.includes('Roasted Tomato Soup'));
    assert.ok(prompt.includes('@tomatoes{1%kg}'));
    assert.ok(prompt.includes('make it vegan'));
  });

  it('sends the recipe without the notes the cook added', () => {
    const prompt = remixPrompt({
      source: appendNote(RECIPE, 'Add MORE pepper'),
      note: 'make it vegan',
      name: 'Roasted Tomato Soup',
      apiKey: 'unused',
    });

    assert.ok(!prompt.includes('Add MORE pepper'));
  });
});

describe('slugForTitle', () => {
  it('makes a readable filename stem', () => {
    assert.equal(slugForTitle('Vegan Roasted Tomato Soup'), 'vegan-roasted-tomato-soup');
  });

  it('collapses punctuation instead of keeping it in a filename', () => {
    assert.equal(slugForTitle('Grandma’s  Soup (v2)!'), 'grandma-s-soup-v2');
  });

  it('keeps letters that are not English', () => {
    assert.equal(slugForTitle('Томатный суп'), 'томатный-суп');
  });

  it('falls back when a title has nothing to name a file after', () => {
    assert.equal(slugForTitle('!!!'), 'remix');
  });
});

const FROM = { parent: 'tomato-soup.cook' };

describe('remixFile', () => {
  it('keeps the front matter the model wrote', () => {
    const file = remixFile(
      {
        title: 'Vegan Tomato Soup',
        recipe: '---\ntitle: Vegan Tomato Soup\nservings: 3\ntime: 40 minutes\n---\n\nBoil @water{1%l}.',
      },
      FROM,
    );

    assert.equal(file.match(/title:/g)?.length, 1);
    assert.ok(file.includes('servings: 3'));
    assert.ok(file.includes('time: 40 minutes'));
    assert.ok(file.endsWith('.\n'));
  });

  it('titles a recipe that came back without front matter', async () => {
    const file = remixFile({ title: 'Vegan Tomato Soup', recipe: 'Boil @water{1%l}.' }, FROM);
    assert.equal((await parseRecipeDocument(file)).title, 'Vegan Tomato Soup');
  });

  it('signs the recipe as a model wrote it, and says what it came from', async () => {
    const file = remixFile({ title: 'Vegan Tomato Soup', recipe: 'Boil @water{1%l}.' }, FROM);
    const document = await parseRecipeDocument(file);

    assert.equal(document.authorship, 'llm');
    assert.ok(file.includes('authored_by: llm'));
    assert.ok(file.includes('remixed_from: tomato-soup.cook'));
    assert.match(file, /author: Claude \(claude-sonnet-5\)/);
  });

  it('does not let the model claim a person wrote it', () => {
    const file = remixFile(
      {
        title: 'Vegan Tomato Soup',
        recipe: [
          '---',
          'title: Vegan Tomato Soup',
          'author: Grandma',
          'authored_by: human',
          'remixed_from: somewhere-else.cook',
          'servings: 3',
          '---',
          '',
          'Boil @water{1%l}.',
        ].join('\n'),
      },
      FROM,
    );

    assert.ok(!file.includes('Grandma'));
    assert.ok(!file.includes('authored_by: human'));
    assert.ok(!file.includes('somewhere-else.cook'));
    // The fields it had no business writing are the only ones taken back.
    assert.ok(file.includes('servings: 3'));
    assert.equal(file.match(/authored_by:/g)?.length, 1);
  });

  it('drops a multi-line value along with the key it belongs to', () => {
    const file = remixFile(
      {
        title: 'Vegan Tomato Soup',
        recipe: '---\nauthor:\n  name: Grandma\nservings: 3\n---\n\nBoil @water{1%l}.',
      },
      FROM,
    );

    assert.ok(!file.includes('Grandma'));
    assert.ok(file.includes('servings: 3'));
  });
});

describe('authorship', () => {
  const authorshipOf = async (front: string): Promise<string> =>
    (await parseRecipeDocument(`---\ntitle: X\n${front}---\n\nBoil @water{1%l}.\n`)).authorship;

  it('reads the two values it defines', async () => {
    assert.equal(await authorshipOf('authored_by: llm\n'), 'llm');
    assert.equal(await authorshipOf('authored_by: human\n'), 'human');
  });

  it('treats a recipe that says nothing as unknown rather than as human', async () => {
    assert.equal(await authorshipOf(''), 'unknown');
  });

  it('does not guess at a value nobody defined', async () => {
    assert.equal(await authorshipOf('authored_by: probably a robot\n'), 'unknown');
    assert.equal(await authorshipOf('authored_by:\n'), 'unknown');
  });

  it('reads it however the key was typed by hand', async () => {
    assert.equal(await authorshipOf('Authored-By: LLM\n'), 'llm');
    assert.equal(await authorshipOf('authored_by:   human  \n'), 'human');
  });

  it('keeps it out of the metadata rows, which show it a second time', async () => {
    const document = await parseRecipeDocument(
      '---\ntitle: X\nauthored_by: llm\nservings: 2\n---\n\nBoil @water{1%l}.\n',
    );
    assert.deepEqual(
      document.metadata.map((entry) => entry.key),
      ['Servings'],
    );
  });
});

describe('saveRemix', () => {
  const directory = (): Promise<string> => mkdtemp(join(tmpdir(), 'cooklanger-remix-'));

  it('writes the recipe under a name taken from its title', async () => {
    const into = await directory();
    const path = await saveRemix(
      into,
      { title: 'Vegan Tomato Soup', recipe: 'Boil @water{1%l}.' },
      FROM,
    );

    assert.equal(path, join(into, 'vegan-tomato-soup.cook'));
    assert.ok((await readFile(path, 'utf8')).includes('Boil @water{1%l}.'));
  });

  it('never overwrites a recipe that is already there', async () => {
    const into = await directory();
    const taken = join(into, 'vegan-tomato-soup.cook');
    await writeFile(taken, 'The original.\n', 'utf8');

    const path = await saveRemix(
      into,
      { title: 'Vegan Tomato Soup', recipe: 'Boil @water{1%l}.' },
      FROM,
    );

    assert.equal(path, join(into, 'vegan-tomato-soup-2.cook'));
    assert.equal(await readFile(taken, 'utf8'), 'The original.\n');
  });
});

describe('parseEnv', () => {
  it('reads a key', () => {
    assert.deepEqual(parseEnv('ANTHROPIC_API_KEY=sk-ant-123'), {
      ANTHROPIC_API_KEY: 'sk-ant-123',
    });
  });

  it('ignores blank lines and comments', () => {
    assert.deepEqual(parseEnv('\n# a comment\nA=1\n'), { A: '1' });
  });

  it('takes a quoted or exported value as written', () => {
    assert.deepEqual(parseEnv('export A="one"\nB=\'two\''), { A: 'one', B: 'two' });
  });

  it('keeps an equals sign inside a value', () => {
    assert.deepEqual(parseEnv('A=one=two'), { A: 'one=two' });
  });
});
