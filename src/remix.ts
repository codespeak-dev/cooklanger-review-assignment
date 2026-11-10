/**
 * Remixing a recipe with an Anthropic model.
 *
 * The cook says what they want changed; the model rewrites the recipe in
 * Cooklang and names it. What comes back is saved as a new file rather than
 * over the original, so the recipe the cook already trusts is never edited by
 * a machine.
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DietProfile } from './diets.js';
import { stripNotes } from './notes.js';
import { AUTHORED_BY_KEY, normalizeKey } from './parser.js';
import { RECIPE_EXTENSION } from './recipes.js';

/** Sonnet-level: a rewrite of one page of text, not a research problem. */
const MODEL = 'claude-sonnet-5';

/** What goes in the `author` field of a recipe a model wrote. */
const AUTHOR = `Claude (${MODEL})`;

/**
 * The metadata fields cooklanger writes itself.
 *
 * A model does not get to sign its own work as a person's, so whatever it wrote
 * in these is dropped and replaced. Everything else it put in the front matter
 * is kept as it wrote it.
 */
const PROVENANCE_KEYS = new Set(['author', AUTHORED_BY_KEY, 'remixed_from']);

/** Generous: front matter, steps and thinking all come out of this budget. */
const MAX_TOKENS = 16000;

/**
 * What the model is told about the job.
 *
 * The Cooklang primer is here rather than in the user turn because it is the
 * same for every remix, and because the markup is the one part of the answer
 * that has to be exactly right.
 */
const SYSTEM_PROMPT = `You adapt recipes written in Cooklang.

Cooklang is plain text with the ingredients, cookware and timings marked up in place:

- \`@salt{1%tsp}\` is an ingredient with an amount and a unit. Multi-word names close with braces: \`@olive oil{3%tbsp}\`. An amount can have no unit (\`@eggs{2}\`), be written out (\`@basil{1 handful}\`), or be left out entirely (\`@pepper{}\`).
- \`#pot{}\` is a piece of cookware; multi-word again closes with braces: \`#baking tray{}\`.
- \`~{35%minutes}\` is a timer, and \`~rest{10%minutes}\` a named one.
- YAML front matter between \`---\` lines carries the metadata: \`title\`, \`servings\`, \`time\`.
- Each paragraph is one step, separated by a blank line. Prose outside the markup is ordinary text.
- \`--\` starts a comment and \`[- ... -]\` is a block comment. A line beginning with \`>\` is a note beside the steps.

You are given a recipe and what the chef wants changed about it. Return the adapted recipe, whole, along with a title for it.

Sometimes you are also given a diet the chef keeps, in their own words. The adapted recipe must keep to it completely: no ingredient it forbids, and nothing made from one — check the stock, the sauces and anything bought ready-made. Where an ingredient might or might not keep to it depending on what is bought, choose one that certainly does and name it plainly ("vegetable stock", "gluten-free soy sauce"). When the diet is the only thing asked for, change what the diet requires and whatever that change knocks loose, and keep the rest of the dish as it was.

What you are after is a recipe of its own, and one worth cooking — not the old one with a word swapped. Be inventive about how you get there. A change rarely stays where it lands: swap one ingredient and the amounts around it, the seasoning, the liquid, the fat, the temperature, the timings and sometimes a whole step have to move with it. Work through the recipe looking for what the change has knocked loose, and fix it there rather than leaving the chef to find it at the stove. Then read the result as a cook would — does it balance, does the texture come out right, does every step still earn its place.

Stay close to the spirit of the original: the dish it is, the way it is cooked, whatever the chef already likes about it. You are remixing this recipe, not writing a different one in its place.

Keep it a recipe someone can actually cook from: every ingredient, tool and timing marked up as above, and the steps in the order they happen. Give it a title that says what it now is. Write no \`>\` notes and no commentary — the recipe itself is the answer.`;

/** The shape the model answers in, so nothing has to be parsed out of prose. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The name of the adapted recipe, as it would head a page.',
    },
    recipe: {
      type: 'string',
      description: 'The whole adapted recipe in Cooklang, front matter included.',
    },
  },
  required: ['title', 'recipe'],
  additionalProperties: false,
} as const;

export interface RemixRequest {
  /** The recipe as it stands on disk. */
  source: string;
  /** What the cook wants changed. */
  note: string;
  diet?: DietProfile;
  /** Display name of the recipe being remixed, for the model's bearings. */
  name: string;
  apiKey: string;
}

export interface Remix {
  title: string;
  /** Cooklang source, ready to be written to a file. */
  recipe: string;
}

/** A problem the browser can put in front of the cook as it is. */
export class RemixError extends Error {}

const DIET_ONLY_REQUEST = 'Make it keep to my diet.';

/** The user turn: the recipe, then the request, each clearly fenced. */
export function remixPrompt(request: RemixRequest): string {
  const note = request.note.trim() || DIET_ONLY_REQUEST;
  const diet = request.diet
    ? [
        '',
        `The diet I keep, “${request.diet.name}” — the result must keep to it:`,
        '',
        '<diet>',
        request.diet.restrictions.trim(),
        '</diet>',
      ]
    : [];

  return [
    `The recipe is called “${request.name}”. Here it is:`,
    '',
    '<recipe>',
    // The cook's own notes are dropped: they are remarks on the recipe as it
    // was, and would otherwise read as instructions for the new one.
    stripNotes(request.source).trimEnd(),
    '</recipe>',
    '',
    'What I want changed:',
    '',
    '<request>',
    note,
    '</request>',
    ...diet,
  ].join('\n');
}

/** Reads the model's answer, which structured output guarantees is JSON. */
function parseRemix(text: string): Remix {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RemixError('the model did not answer with a recipe');
  }

  const { title, recipe } = (parsed ?? {}) as { title?: unknown; recipe?: unknown };
  if (typeof title !== 'string' || typeof recipe !== 'string' || recipe.trim() === '') {
    throw new RemixError('the model did not answer with a recipe');
  }

  return { title: title.trim(), recipe };
}

/**
 * Asks the model to adapt one recipe.
 *
 * Rejects with a `RemixError` whose message is fit to show the cook; anything
 * else that goes wrong is the SDK's own error, passed along untouched.
 */
export async function requestRemix(request: RemixRequest): Promise<Remix> {
  const client = new Anthropic({ apiKey: request.apiKey });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: remixPrompt(request) }],
  });

  if (message.stop_reason === 'refusal') {
    throw new RemixError('the model declined this request');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new RemixError('the recipe came back cut off');
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseRemix(text);
}

/** The most files that may share one slug before the name is given up on. */
const MAX_SLUG_ATTEMPTS = 100;

/**
 * A filename stem for a recipe title.
 *
 * Letters and digits in any script are kept, so a title that is not in English
 * still yields a readable filename; everything else becomes a single hyphen.
 */
export function slugForTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'remix' : slug;
}

/** Splits a recipe into its front matter lines and the body after them. */
function splitFrontMatter(source: string): { front: string[]; body: string } {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return { front: [], body: source };

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      return { front: lines.slice(1, index), body: lines.slice(index + 1).join('\n') };
    }
  }
  // An opening `---` with no close is not front matter at all.
  return { front: [], body: source };
}

/**
 * The metadata key a front matter line declares, if it declares one.
 *
 * A key may contain spaces ("prep time") but cannot start with one: an indented
 * line belongs to the key above it, and must not read as a key of its own.
 */
function keyOf(line: string): string | undefined {
  const match = /^([A-Za-z0-9_.][A-Za-z0-9_.\- ]*?)\s*:/.exec(line);
  return match ? normalizeKey(match[1]!) : undefined;
}

/** The front matter with the fields cooklanger owns taken back out of it. */
function withoutProvenance(front: readonly string[]): string[] {
  const kept: string[] = [];
  let dropping = false;

  for (const line of front) {
    const key = keyOf(line);
    if (key) dropping = PROVENANCE_KEYS.has(key);
    // An indented line continues whichever key came before it.
    else if (!/^\s/.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }

  while (kept.at(-1)?.trim() === '') kept.pop();
  return kept;
}

export interface RemixProvenance {
  /** Filename of the recipe this was adapted from. */
  parent: string;
}

/**
 * The remix as it should be written to disk.
 *
 * The front matter comes back carrying who wrote it: `author` and `authored_by`
 * so a cook reading the file, or any other Cooklang tool, can tell a machine's
 * recipe from a person's, and `remixed_from` so the one it came from is not
 * lost. A model that answered without front matter also gets its title put in,
 * since it would otherwise show up in the list under its filename.
 */
export function remixFile(remix: Remix, provenance: RemixProvenance): string {
  const source = remix.recipe.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const { front, body } = splitFrontMatter(source);

  const kept = withoutProvenance(front);
  if (!kept.some((line) => keyOf(line) === 'title')) kept.unshift(`title: ${remix.title}`);

  const credits = [
    `author: ${AUTHOR}`,
    `${AUTHORED_BY_KEY}: llm`,
    `remixed_from: ${provenance.parent}`,
  ];

  return `---\n${[...kept, ...credits].join('\n')}\n---\n\n${body.replace(/^\s+/, '')}\n`;
}

/**
 * Writes a remix into `directory` under a name taken from its title.
 *
 * Never overwrites: the file is created exclusively, and a taken name gets a
 * number until a free one is found. Returns the path it landed on.
 */
export async function saveRemix(
  directory: string,
  remix: Remix,
  provenance: RemixProvenance,
): Promise<string> {
  const slug = slugForTitle(remix.title);
  const contents = remixFile(remix, provenance);

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const path = join(directory, `${slug}${suffix}${RECIPE_EXTENSION}`);
    try {
      await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  throw new RemixError(`there are already too many recipes called “${remix.title}”`);
}
