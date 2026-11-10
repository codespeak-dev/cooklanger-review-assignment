import './warnings.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  allDiets,
  checkKey,
  checkPrompt,
  checksPath,
  dietsPath,
  DietCheckError,
  parseVerdict,
  PRESET_DIETS,
  readChecks,
  readUserDiets,
  withDiet,
  withoutDiet,
  writeChecks,
  writeUserDiets,
  type DietProfile,
} from './diets.js';
import { appendNote } from './notes.js';

const RECIPE = `---
title: Tomato Soup
servings: 2
---

Soften @onion{1} in @butter{20%g}, then add @chicken stock{500%ml}.
`;

const OWN: DietProfile = {
  name: 'low fodmap',
  restrictions: 'No onion, garlic, wheat or honey.',
  builtIn: false,
};

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cooklanger-diets-'));
});

beforeEach(async () => {
  await rm(join(root, '.cooklanger'), { recursive: true, force: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRaw(path: string, contents: string): Promise<void> {
  await mkdir(join(root, '.cooklanger'), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

describe('preset diets', () => {
  it('ships the diets and allergies the cook asked for', () => {
    assert.deepEqual(
      PRESET_DIETS.map((diet) => diet.name),
      [
        'vegetarian',
        'vegan',
        'pescatarian',
        'nut-free',
        'gluten-free',
        'dairy-free',
        'egg-free',
        'shellfish-free',
      ],
    );
    for (const diet of PRESET_DIETS) {
      assert.ok(diet.builtIn);
      assert.ok(diet.restrictions.length > 20, diet.name);
    }
  });
});

describe('the cook’s own diets', () => {
  it('reads nothing when none has been written', async () => {
    assert.deepEqual(await readUserDiets(root), []);
  });

  it('reads back what was written, as the cook’s own', async () => {
    await writeUserDiets(root, [OWN]);
    assert.deepEqual(await readUserDiets(root), [OWN]);
  });

  it('never writes a preset into the file', async () => {
    await writeUserDiets(root, [PRESET_DIETS[0]!, OWN]);
    const written = JSON.parse(await readFile(dietsPath(root), 'utf8'));
    assert.deepEqual(written, { diets: [{ name: OWN.name, restrictions: OWN.restrictions }] });
  });

  it('reads a corrupt file as an empty one', async () => {
    await writeRaw(dietsPath(root), '{ not json');
    assert.deepEqual(await readUserDiets(root), []);
  });

  it('drops entries without a name or restrictions, and repeats of a name', async () => {
    await writeRaw(
      dietsPath(root),
      JSON.stringify({
        diets: [
          { name: 'Keto', restrictions: 'No sugar or starch.' },
          { name: '', restrictions: 'No name.' },
          { name: 'blank', restrictions: '  ' },
          { name: 'keto ', restrictions: 'A second keto.' },
          7,
        ],
      }),
    );
    assert.deepEqual(await readUserDiets(root), [
      { name: 'Keto', restrictions: 'No sugar or starch.', builtIn: false },
    ]);
  });
});

describe('allDiets', () => {
  it('lists the presets, then the cook’s own', () => {
    const names = allDiets([OWN]).map((diet) => diet.name);
    assert.equal(names[0], 'vegetarian');
    assert.equal(names.at(-1), 'low fodmap');
    assert.equal(names.length, PRESET_DIETS.length + 1);
  });

  it('puts one of the cook’s own in the place of a preset it shares a name with', () => {
    const tweaked: DietProfile = {
      name: 'Vegetarian',
      restrictions: 'No meat or fish; eggs are fine but no cheese made with rennet.',
      builtIn: false,
    };
    const diets = allDiets([tweaked]);
    assert.equal(diets.length, PRESET_DIETS.length);
    assert.equal(diets[0], tweaked);
  });
});

describe('withDiet and withoutDiet', () => {
  it('adds a new diet and replaces one with the same name', () => {
    const added = withDiet([], OWN);
    assert.deepEqual(added, [OWN]);

    const changed = withDiet(added, { ...OWN, name: 'Low FODMAP', restrictions: 'Less.' });
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.restrictions, 'Less.');
  });

  it('takes a diet away by name, whatever its case', () => {
    assert.deepEqual(withoutDiet([OWN], 'LOW FODMAP'), []);
  });
});

describe('checkKey', () => {
  const vegan = PRESET_DIETS.find((diet) => diet.name === 'vegan')!;

  it('is the same for the same recipe and the same diet', () => {
    assert.equal(checkKey(vegan, RECIPE), checkKey(vegan, RECIPE));
  });

  it('ignores the cook’s notes', () => {
    assert.equal(checkKey(vegan, appendNote(RECIPE, 'Too salty')), checkKey(vegan, RECIPE));
  });

  it('changes when the recipe does', () => {
    const edited = RECIPE.replace('chicken stock', 'vegetable stock');
    assert.notEqual(checkKey(vegan, edited), checkKey(vegan, RECIPE));
  });

  it('changes when what the diet rules out does, but not when it is renamed', () => {
    assert.notEqual(checkKey({ ...vegan, restrictions: 'Nothing.' }, RECIPE), checkKey(vegan, RECIPE));
    assert.equal(checkKey({ ...vegan, name: 'plant-based' }, RECIPE), checkKey(vegan, RECIPE));
  });
});

describe('the verdict cache', () => {
  it('reads back what was written', async () => {
    await writeChecks(root, new Map([['abc', 'pass'], ['def', 'fail']]));
    const checks = await readChecks(root);
    assert.equal(checks.get('abc'), 'pass');
    assert.equal(checks.get('def'), 'fail');
  });

  it('reads a corrupt cache as an empty one, and skips verdicts it does not know', async () => {
    await writeRaw(checksPath(root), '[');
    assert.equal((await readChecks(root)).size, 0);

    await writeRaw(checksPath(root), JSON.stringify({ checks: { a: 'pass', b: 'maybe', c: 1 } }));
    assert.deepEqual([...(await readChecks(root))], [['a', 'pass']]);
  });
});

describe('checkPrompt', () => {
  it('fences the diet and the recipe, without the cook’s notes', () => {
    const prompt = checkPrompt(OWN, appendNote(RECIPE, 'Add MORE pepper'));
    assert.match(prompt, /<diet>\nNo onion, garlic, wheat or honey\.\n<\/diet>/);
    assert.match(prompt, /<recipe>[\s\S]*chicken stock[\s\S]*<\/recipe>/);
    assert.ok(!prompt.includes('Add MORE pepper'));
  });
});

describe('parseVerdict', () => {
  it('reads a pass and a fail', () => {
    assert.equal(parseVerdict('{"passes":true}'), 'pass');
    assert.equal(parseVerdict('{"passes":false}'), 'fail');
  });

  it('refuses an answer that is not a verdict', () => {
    assert.throws(() => parseVerdict('yes'), DietCheckError);
    assert.throws(() => parseVerdict('{"passes":"no"}'), DietCheckError);
  });
});
