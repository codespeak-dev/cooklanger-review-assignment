import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripNotes } from './notes.js';

export const DIETS_DIRECTORY = '.cooklanger';
export const DIETS_FILENAME = 'diets.json';
export const CHECKS_FILENAME = 'diet-checks.json';

export interface DietProfile {
  name: string;
  restrictions: string;
  builtIn: boolean;
}

export const PRESET_DIETS: readonly DietProfile[] = [
  {
    name: 'vegetarian',
    restrictions:
      'No meat, poultry, fish or seafood, and nothing made from them — meat or fish stock, gelatine, lard, suet, anchovies, fish sauce, animal rennet. Eggs, dairy and honey are fine.',
  },
  {
    name: 'vegan',
    restrictions:
      'No animal products at all: no meat, poultry, fish or seafood, no eggs, no dairy (milk, butter, cream, cheese, yoghurt, ghee), no honey, and nothing made from any of them — stock, gelatine, lard, fish sauce, whey.',
  },
  {
    name: 'pescatarian',
    restrictions:
      'No meat or poultry, and nothing made from them — meat or chicken stock, gelatine, lard, suet, bacon fat. Fish, seafood, eggs and dairy are fine.',
  },
  {
    name: 'nut-free',
    restrictions:
      'A nut allergy: no tree nuts (almonds, walnuts, hazelnuts, cashews, pistachios, pecans, macadamias, brazil nuts, pine nuts) and no peanuts, nor anything made from them — nut butters, nut milks, nut oils, marzipan, praline, nut flours, pesto made with nuts.',
  },
  {
    name: 'gluten-free',
    restrictions:
      'Coeliac: no wheat, barley, rye or spelt, nor anything made from them — ordinary flour, bread, breadcrumbs, pasta, couscous, bulgur, semolina, malt, beer, soy sauce brewed with wheat. Oats only when sold as gluten-free.',
  },
  {
    name: 'dairy-free',
    restrictions:
      'No milk from any animal, nor anything made from it — butter, cream, cheese, yoghurt, ghee, whey, casein, milk chocolate. Eggs are fine.',
  },
  {
    name: 'egg-free',
    restrictions:
      'An egg allergy: no eggs of any kind, nor anything made with them — mayonnaise, aioli, fresh egg pasta, meringue, egg glaze.',
  },
  {
    name: 'shellfish-free',
    restrictions:
      'A shellfish allergy: no crustaceans (prawns, shrimp, crab, lobster, crayfish, langoustine) and no molluscs (mussels, clams, oysters, scallops, squid, octopus), nor anything made from them — shrimp paste, oyster sauce, shellfish stock.',
  },
].map((diet) => ({ ...diet, builtIn: true }));

export function dietKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function dietsPath(root: string): string {
  return join(root, DIETS_DIRECTORY, DIETS_FILENAME);
}

export function checksPath(root: string): string {
  return join(root, DIETS_DIRECTORY, CHECKS_FILENAME);
}

export async function readUserDiets(root: string): Promise<DietProfile[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(dietsPath(root), 'utf8'));
  } catch {
    return [];
  }

  const listed = (parsed as { diets?: unknown } | null)?.diets;
  if (!Array.isArray(listed)) return [];

  const seen = new Set<string>();
  const diets: DietProfile[] = [];
  for (const entry of listed as { name?: unknown; restrictions?: unknown }[]) {
    if (typeof entry?.name !== 'string' || typeof entry.restrictions !== 'string') continue;
    const name = entry.name.trim();
    const restrictions = entry.restrictions.trim();
    if (!name || !restrictions || seen.has(dietKey(name))) continue;
    seen.add(dietKey(name));
    diets.push({ name, restrictions, builtIn: false });
  }
  return diets;
}

export async function writeUserDiets(root: string, diets: readonly DietProfile[]): Promise<void> {
  const listed = diets
    .filter((diet) => !diet.builtIn)
    .map(({ name, restrictions }) => ({ name, restrictions }));

  await mkdir(join(root, DIETS_DIRECTORY), { recursive: true });
  await writeFile(dietsPath(root), `${JSON.stringify({ diets: listed }, null, 2)}\n`, 'utf8');
}

export function allDiets(user: readonly DietProfile[]): DietProfile[] {
  const own = new Map(user.map((diet) => [dietKey(diet.name), diet]));
  const presets = PRESET_DIETS.map((preset) => {
    const override = own.get(dietKey(preset.name));
    if (override) own.delete(dietKey(preset.name));
    return override ?? preset;
  });
  return [...presets, ...own.values()];
}

export function withDiet(user: readonly DietProfile[], diet: DietProfile): DietProfile[] {
  const own = { ...diet, builtIn: false };
  const index = user.findIndex((entry) => dietKey(entry.name) === dietKey(diet.name));
  if (index < 0) return [...user, own];
  return user.map((entry, at) => (at === index ? own : entry));
}

export function withoutDiet(user: readonly DietProfile[], name: string): DietProfile[] {
  return user.filter((entry) => dietKey(entry.name) !== dietKey(name));
}

export type Verdict = 'pass' | 'fail';

export type Checks = ReadonlyMap<string, Verdict>;

const CHECK_VERSION = 1;

export function checkKey(diet: DietProfile, source: string): string {
  return createHash('sha256')
    .update(JSON.stringify([CHECK_VERSION, diet.restrictions.trim(), stripNotes(source).trim()]))
    .digest('hex');
}

export async function readChecks(root: string): Promise<Map<string, Verdict>> {
  const checks = new Map<string, Verdict>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(checksPath(root), 'utf8'));
  } catch {
    return checks;
  }

  const listed = (parsed as { checks?: unknown } | null)?.checks;
  if (typeof listed !== 'object' || listed === null) return checks;

  for (const [key, value] of Object.entries(listed as Record<string, unknown>)) {
    if (value === 'pass' || value === 'fail') checks.set(key, value);
  }
  return checks;
}

export async function writeChecks(root: string, checks: Checks): Promise<void> {
  const listed: Record<string, Verdict> = {};
  for (const key of [...checks.keys()].sort()) listed[key] = checks.get(key)!;

  await mkdir(join(root, DIETS_DIRECTORY), { recursive: true });
  await writeFile(checksPath(root), `${JSON.stringify({ checks: listed }, null, 2)}\n`, 'utf8');
}

const MODEL = 'claude-haiku-5-5';

const MAX_TOKENS = 4000;

const SYSTEM_PROMPT = `You check whether a recipe keeps to someone's diet.

You are given a recipe written in Cooklang — ingredients are marked \`@name{amount}\`, and the steps are plain text around them — and the diet, described in the person's own words. Decide whether the recipe, cooked as written, keeps to that diet. Judge the ingredients it actually lists, not the ones a dish of that name usually has.

Read every ingredient, and the steps too, since an ingredient can be named only in a step ("finish with a splash of fish sauce"). Judge each one as it is ordinarily bought. Some names settle the question by themselves — "vegetable stock" is not meat, "olive oil" is not a nut — and those keep to the diet. Others commonly hide something the diet forbids even though their name does not say so: "stock" of no stated kind, Worcestershire sauce, pesto, curry paste, chocolate, ready-made pastry.

Doubt counts against the recipe. If an ingredient commonly contains something the diet forbids, or whether it does depends on the brand or the kind bought, the recipe does not pass. These are often allergies, and passing a recipe wrongly is the mistake that matters. But doubt means a real reason to suspect an ingredient, not a remote possibility: a factory's "may contain traces" counts only when the diet itself asks about traces.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description:
        'Brief: each ingredient the recipe actually lists, and whether it keeps to the diet.',
    },
    passes: {
      type: 'boolean',
      description: 'True only if the recipe certainly keeps to the diet.',
    },
  },
  required: ['reasoning', 'passes'],
  additionalProperties: false,
} as const;

export class DietCheckError extends Error {}

export function checkPrompt(diet: DietProfile, source: string): string {
  return [
    `The diet is called “${diet.name}”:`,
    '',
    '<diet>',
    diet.restrictions.trim(),
    '</diet>',
    '',
    'The recipe:',
    '',
    '<recipe>',
    stripNotes(source).trimEnd(),
    '</recipe>',
  ].join('\n');
}

export function parseVerdict(text: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DietCheckError('the diet check came back unreadable');
  }

  const passes = (parsed as { passes?: unknown } | null)?.passes;
  if (typeof passes !== 'boolean') throw new DietCheckError('the diet check came back unreadable');
  return passes ? 'pass' : 'fail';
}

export async function checkRecipe(
  diet: DietProfile,
  source: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Verdict> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: 'user', content: checkPrompt(diet, source) }],
    },
    { signal },
  );

  if (message.stop_reason === 'refusal') {
    throw new DietCheckError('the model declined to check this recipe');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new DietCheckError('the diet check came back cut off');
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseVerdict(text);
}
