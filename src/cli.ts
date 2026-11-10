#!/usr/bin/env node
// Must be first: installs a warning filter before the parser's WASM is loaded.
import './warnings.js';

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { runBrowser, supportsInteractive } from './browser.js';
import { readFavourites } from './favourites.js';
import {
  DEFAULT_SORT_ORDER,
  describeDirectory,
  RECIPE_EXTENSION,
  scanRecipes,
  type SortOrder,
} from './recipes.js';

interface CliOptions {
  recursive: boolean;
  /** Print the names and exit instead of opening the browser. */
  list: boolean;
  /** Which way to sort the names: `az` or `za`. */
  sort: SortOrder;
}

/** Resolves and validates the directory to scan, or reports why it cannot. */
async function resolveDirectory(pathArgument: string): Promise<string | undefined> {
  const directory = resolve(process.cwd(), pathArgument);

  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      process.stderr.write(`cooklanger: not a directory: ${directory}\n`);
      return undefined;
    }
  } catch {
    process.stderr.write(`cooklanger: no such directory: ${directory}\n`);
    return undefined;
  }

  return directory;
}

async function run(pathArgument: string, options: CliOptions): Promise<number> {
  const directory = await resolveDirectory(pathArgument);
  if (!directory) return 1;

  // The marks decide the order, so they are read before the scan sorts anything.
  const favourites = await readFavourites(directory);
  const { recipes, problems } = await scanRecipes(directory, {
    recursive: options.recursive,
    order: options.sort,
    favourites,
  });
  const where = describeDirectory(directory, process.cwd());

  const streams = { input: process.stdin, output: process.stdout };
  // The browser needs a real terminal; piping or `--list` gets plain names.
  const interactive = !options.list && recipes.length > 0 && supportsInteractive(streams);

  if (interactive) {
    await runBrowser({
      directory: where,
      root: directory,
      recipes,
      order: options.sort,
      favourites,
      streams,
    });
    // Problems are reported after the alt screen is gone, so they stay visible.
    for (const problem of problems) {
      process.stderr.write(`cooklanger: could not read ${problem.path}: ${problem.message}\n`);
    }
    return 0;
  }

  // Names go to stdout so the list stays pipeable — favourites come first, as
  // they do in the browser, but they carry no star: a mark in piped output would
  // be something the next command has to strip off every line.
  for (const recipe of recipes) {
    process.stdout.write(`${recipe.name}\n`);
  }

  if (recipes.length === 0) {
    process.stderr.write(`No ${RECIPE_EXTENSION} files found in ${where}\n`);
  }
  for (const problem of problems) {
    process.stderr.write(`cooklanger: could not read ${problem.path}: ${problem.message}\n`);
  }

  return 0;
}

const program = new Command();

program
  .name('cooklanger')
  .description('Browse the Cooklang recipes in a directory.')
  .version('0.1.0')
  .argument('[path]', 'directory to scan', '.')
  .option('--no-recursive', 'only scan the given directory, not subdirectories')
  .option('-l, --list', 'print recipe names instead of opening the browser')
  .addOption(
    new Option('--sort <order>', 'list order: az for A→Z, za for Z→A')
      .choices(['az', 'za'])
      .default(DEFAULT_SORT_ORDER),
  )
  .action(async (pathArgument: string, options: CliOptions) => {
    process.exitCode = await run(pathArgument, options);
  });

await program.parseAsync(process.argv);
