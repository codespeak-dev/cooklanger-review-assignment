import { readFile, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  lookupNutrition,
  missingNeeds,
  neededProducts,
  readRegistry,
  withProducts,
  writeRegistry,
  type Registry,
} from './registry.js';
import { copyToClipboard } from './clipboard.js';
import {
  allDiets,
  checkKey,
  checkRecipe,
  dietKey,
  readChecks,
  readUserDiets,
  withDiet,
  withoutDiet,
  writeChecks,
  writeUserDiets,
  type DietProfile,
  type Verdict,
} from './diets.js';
import { anthropicApiKey } from './env.js';
import {
  isFavourite,
  NO_FAVOURITES,
  toggleFavourite,
  withoutFavourite,
  writeFavourites,
  type Favourites,
} from './favourites.js';
import { parseKeys, type Key } from './keys.js';
import {
  clampOffset,
  computeLayout,
  renderPanel,
  renderScreen,
  scrollToVisible,
  styled,
  wrapStyled,
  type OverlayViewModel,
  type Pane,
  type PickerViewModel,
  type Size,
  type StyledLine,
  type ViewModel,
} from './layout.js';
import { appendNoteToFile } from './notes.js';
import { recipeNutrition, type Nutrition } from './nutrition.js';
import {
  parseRecipeDocument,
  toPersons,
  type PortionedRecipe,
  type RecipeDocument,
} from './parser.js';
import { RemixError, requestRemix, saveRemix } from './remix.js';
import { recipeText, renderRecipe, renderShoppingList } from './render.js';
import {
  comparingRecipes,
  DEFAULT_SORT_ORDER,
  describeOrder,
  loadRecipe,
  type Recipe,
  type SortOrder,
} from './recipes.js';
import {
  buildShoppingList,
  scaleFor,
  shoppingText,
  withEntry,
  type ShoppingEntry,
} from './shopping.js';

/** How long a copy confirmation stays in the status line. */
const STATUS_TIMEOUT_MS = 2500;

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_TO_LINE_END = '\x1b[K';
const CLEAR_BELOW = '\x1b[J';

const CTRL_C = '\x03';
const CTRL_D = '\x04';

export interface BrowserStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export interface BrowserOptions {
  /** Directory label for the list pane title. */
  directory: string;
  /** The scanned directory itself, which new recipes are named relative to. */
  root: string;
  recipes: readonly Recipe[];
  /** Which way the list starts out sorted. Defaults to A→Z. */
  order?: SortOrder;
  /** The marks read from `.cooklanger`, which `recipes` is already sorted by. */
  favourites?: Favourites;
  streams?: BrowserStreams;
}

/**
 * What the preview knows about one recipe file.
 *
 * A file that cannot be read has only a problem; one that cannot be parsed
 * keeps its source too, so it can still be read and copied as it was written.
 */
interface Preview {
  /**
   * The recipe as its author wrote it, which every other scale comes from.
   *
   * The shopping list works from this rather than from what is on screen: a
   * recipe put on the list for four people has to be scaled from the author's
   * amounts, not from the single person's worth being read.
   */
  document?: RecipeDocument;
  /**
   * The same recipe with its amounts brought to the count being read at.
   *
   * May be for a count the cook has since moved off; `rescale` brings it back
   * in line when the recipe is next on screen.
   */
  shown?: PortionedRecipe;
  source?: string;
  problem?: string;
  /**
   * Figures from the product registry as it stood when this was last worked out.
   *
   * Never written to the recipe file: it is a reading of the registry, and it is
   * recomputed whenever the registry learns something new.
   */
  nutrition?: Nutrition;
}

interface Rendered {
  width: number;
  lines: StyledLine[];
}

/** Which screen the browser is showing. */
type Mode = 'recipes' | 'shopping';

/** An unanswered question in the status line: how many people to cook for. */
interface PersonsPrompt {
  recipe: Recipe;
  /** What has been typed so far; empty means the default still stands. */
  typed: string;
  /** Used when Return is pressed on an empty prompt. */
  fallback: number;
}

/** The most people one recipe can sensibly be scaled for. */
const MAX_PERSONS = 999;

/**
 * A recipe about to be deleted, waiting on a yes.
 *
 * Deleting is asked about rather than just done: the file goes for good, and one
 * stray keystroke should not be able to take a recipe with it.
 */
interface DeleteConfirm {
  recipe: Recipe;
}

/**
 * Text being typed over the panes, and what it is for.
 *
 * A note goes into the recipe as it stands; a remix asks a model for a new
 * recipe based on it. Both are one line typed into the same overlay.
 */
interface Draft {
  kind: 'note' | 'remix';
  recipe: Recipe;
  /** What has been typed so far. */
  typed: string;
}

type DietDraft = { kind: 'dietName'; typed: string } | { kind: 'dietRules'; name: string; typed: string };

/** Longer than any remark worth jotting down mid-cook. */
const MAX_DRAFT_LENGTH = 500;
const MAX_DIET_LENGTH = 1000;
const MAX_DIET_NAME_LENGTH = 40;

type PickerEntry = { kind: 'none' } | { kind: 'diet'; diet: DietProfile } | { kind: 'new' };

interface DietPicker {
  entries: PickerEntry[];
  selected: number;
  confirmDelete?: boolean;
}

const CHECK_CONCURRENCY = 4;

interface CheckJob {
  recipe: Recipe;
  source: string;
  key: string;
  diet: DietProfile;
  generation: number;
  apiKey: string;
}

/** Control characters, which are keys rather than text. */
const CONTROL_CHAR = /^[\x00-\x1f\x7f]$/;

export function supportsInteractive(streams: BrowserStreams): boolean {
  return Boolean(streams.input.isTTY && streams.output.isTTY);
}

/**
 * Runs the two-pane recipe browser until the user quits.
 *
 * Resolves once the terminal has been restored; the caller owns the exit code.
 */
export async function runBrowser(options: BrowserOptions): Promise<void> {
  const input = options.streams?.input ?? process.stdin;
  const output = options.streams?.output ?? process.stdout;
  // Remixing adds to the list while the browser is open, so this is a copy.
  const recipes: Recipe[] = [...options.recipes];
  const useColor = !process.env.NO_COLOR;

  /** What each visited recipe file turned out to hold, by path. */
  const previews = new Map<string, Preview>();
  /** Last render of each recipe, so re-draws at a steady width are free. */
  const renderCache = new Map<string, Rendered>();

  let selected = 0;
  /** Which way the list runs; the cook turns it round with `o`. */
  let order: SortOrder = options.order ?? DEFAULT_SORT_ORDER;
  /** The cook's marks, kept current in memory and saved on every change. */
  let favourites: Favourites = options.favourites ?? NO_FAVOURITES;
  /**
   * How many people every recipe is read at; the cook changes it with `-`/`+`.
   *
   * One count for the whole session rather than one per recipe, so two recipes
   * side by side still answer the same question.
   */
  let persons = 1;
  /**
   * Whether the cook has set the count with `-`/`+`, rather than left it at one.
   *
   * A count the cook picked is already the answer to "how many people", so `a`
   * uses it instead of asking; the default one was never an answer to anything.
   */
  let personsChosen = false;
  /** Whether the list is held down to favourites; the cook turns it on with `F`. */
  let onlyFavourites = false;
  /**
   * The rows the list is actually showing, which `selected` indexes.
   *
   * Held as its own array rather than filtered afresh on each draw, because the
   * selection has to survive between keystrokes: a row that vanished from under
   * the cook still has to leave the arrow somewhere sensible.
   */
  let visible: Recipe[] = recipes;
  let listOffset = 0;
  let previewOffset = 0;
  let focus: Pane = 'list';
  let status: string | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  /** Work in flight, which stays in the status line until it finishes. */
  let pending: string | undefined;
  /** Work nobody asked for, mentioned but never allowed to block anything. */
  let background: string | undefined;
  let finished = false;

  /** The product registry, read on first need and kept current in memory. */
  let registry: Registry | undefined;
  /** Recipes whose products have been looked up, so each is asked about once. */
  const pricedRecipes = new Set<string>();
  /** Lookups run one at a time, so two of them cannot both rewrite the file. */
  let lookups: Promise<void> = Promise.resolve();

  let diet: DietProfile | undefined;
  let onlyFitting = false;
  let userDiets: DietProfile[] = [];
  let picker: DietPicker | undefined;
  let verdicts = new Map<string, Verdict>();
  let checks: Map<string, Verdict> | undefined;
  let checksLoading: Promise<Map<string, Verdict>> | undefined;
  let dietGeneration = 0;
  let checkAborter = new AbortController();
  let checkQueue: CheckJob[] = [];
  let checkingPaths = new Set<string>();
  let checksRunning = 0;
  let checkFailureShown = false;
  let checksSaving: Promise<void> = Promise.resolve();
  let checksSaveQueued = false;

  let mode: Mode = 'recipes';
  let prompt: PersonsPrompt | undefined;
  let confirm: DeleteConfirm | undefined;
  let draft: Draft | DietDraft | undefined;
  /** Recipes on the shopping list, each already scaled for its own count. */
  let entries: ShoppingEntry[] = [];
  let shoppingOffset = 0;
  /** Last render of the shopping list, dropped whenever the list changes. */
  let shoppingRender: Rendered | undefined;

  const currentSize = (): Size => ({
    columns: output.columns ?? 80,
    rows: output.rows ?? 24,
  });

  const setStatus = (message: string): void => {
    status = message;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status = undefined;
      statusTimer = undefined;
      draw();
    }, STATUS_TIMEOUT_MS);
  };

  /**
   * What a recipe comes to against the registry, if there is one to read yet.
   *
   * Worked out from the amounts being shown, so the figures answer the same
   * question for every recipe in the collection.
   */
  const nutritionFor = (shown: PortionedRecipe): Nutrition | undefined =>
    registry ? recipeNutrition(shown.document.ingredients, registry) : undefined;

  /**
   * Works the figures out again for every recipe already read.
   *
   * A lookup done for one recipe often completes another — two recipes share
   * flour and butter — so the whole set is redone rather than just the one that
   * asked, and the rendered lines are dropped so the new figures are drawn.
   */
  const refreshNutrition = (): void => {
    for (const [path, preview] of previews) {
      if (!preview.shown) continue;
      preview.nutrition = nutritionFor(preview.shown);
      renderCache.delete(path);
    }
  };

  /**
   * Fills the registry with whatever this recipe's products are still missing.
   *
   * Runs quietly: no API key, or a model that would not answer, leaves the
   * recipe without figures rather than putting an error in the cook's way. The
   * registry is saved as soon as it learns something, so the answers survive
   * even if the next lookup fails.
   */
  const priceRecipe = async (recipe: Recipe): Promise<void> => {
    // The author's own amounts, since the products are the same either way and
    // this is the reading that will still be right if the scaling changes.
    const { document } = await loadPreview(recipe);
    if (!document || document.ingredients.length === 0) return;

    if (!registry) {
      registry = await readRegistry(options.root);
      refreshNutrition();
      draw();
    }

    const missing = missingNeeds(registry, neededProducts(document.ingredients));
    if (missing.length === 0) return;

    const apiKey = await anthropicApiKey(options.root);
    if (!apiKey) return;

    background = `Looking up nutrition for “${recipe.name}”…`;
    draw();

    try {
      const learned = await lookupNutrition(missing, apiKey);
      if (learned.length > 0) {
        registry = withProducts(registry, learned);
        await writeRegistry(options.root, registry);
        refreshNutrition();
      }
    } finally {
      background = undefined;
      draw();
    }
  };

  /**
   * Asks about a recipe's products, once, behind whatever is already running.
   *
   * The recipe is marked as asked about before the work starts, so scrolling
   * back and forth over a recipe whose products the model could not name does
   * not queue the same question again.
   */
  const ensureNutrition = (recipe: Recipe): void => {
    if (pricedRecipes.has(recipe.path)) return;
    pricedRecipes.add(recipe.path);
    lookups = lookups.then(() => priceRecipe(recipe)).catch(() => {});
  };

  /** Reads and parses a recipe once, caching whatever came of it. */
  const loadPreview = async (recipe: Recipe): Promise<Preview> => {
    const cached = previews.get(recipe.path);
    if (cached) return cached;

    const describe = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    let preview: Preview;
    try {
      const source = await readFile(recipe.path, 'utf8');
      try {
        const document = await parseRecipeDocument(source);
        const shown = await toPersons(source, document, persons);
        preview = { source, document, shown, nutrition: nutritionFor(shown) };
      } catch (error) {
        preview = { source, problem: `Could not read this recipe: ${describe(error)}` };
      }
    } catch (error) {
      preview = { problem: `Could not open this file: ${describe(error)}` };
    }

    previews.set(recipe.path, preview);
    return preview;
  };

  /**
   * Reads an already loaded recipe again at the current count, if it is not.
   *
   * Only ever the recipe on screen: the others catch up when they are next
   * selected, so a run of `+` presses parses one recipe per press, not all of
   * them.
   */
  const rescale = async (recipe: Recipe): Promise<void> => {
    const preview = previews.get(recipe.path);
    if (!preview?.source || !preview.document || !preview.shown) return;
    if (preview.shown.persons === persons) return;

    const shown = await toPersons(preview.source, preview.document, persons);
    // Another press may have landed while this one was parsing.
    if (shown.persons !== persons || previews.get(recipe.path) !== preview) return;
    preview.shown = shown;
    preview.nutrition = nutritionFor(shown);
    renderCache.delete(recipe.path);
    if (visible[selected]?.path === recipe.path) draw();
  };

  /** Reads every recipe at one more or one fewer person, within bounds. */
  const changePersons = (delta: number): void => {
    const next = Math.min(Math.max(persons + delta, 1), MAX_PERSONS);
    const recipe = visible[selected];
    const shown = recipe && previews.get(recipe.path)?.shown;
    // The count still changes, for the recipes that can be scaled, but the one
    // on screen would otherwise look like the key did nothing.
    if (shown && !shown.scaled) {
      setStatus(
        shown.writtenFor === undefined
          ? `“${recipe.name}” does not say how many it serves, so it cannot be scaled`
          : `“${recipe.name}” could not be scaled`,
      );
    }
    if (next === persons) return;
    persons = next;
    personsChosen = true;
    if (recipe) void rescale(recipe);
  };

  /** The unparsable case: the problem, then the file as the author wrote it. */
  const sourceLines = (preview: Preview, width: number): StyledLine[] => {
    const lines: StyledLine[] = wrapStyled(styled(preview.problem ?? '', 'problem'), width);
    if (preview.source === undefined) return lines;

    lines.push([]);
    for (const line of preview.source.replace(/\r\n/g, '\n').split('\n')) {
      lines.push(...wrapStyled(styled(line), width));
    }
    return lines;
  };

  const previewLines = (recipe: Recipe | undefined, width: number): StyledLine[] => {
    if (!recipe) return [];
    const preview = previews.get(recipe.path);
    if (!preview) return [styled('Loading…', 'note')];

    const cached = renderCache.get(recipe.path);
    if (cached && cached.width === width) return cached.lines;

    const lines = preview.shown
      ? renderRecipe(preview.shown.document, width, {
          name: recipe.name,
          nutrition: preview.nutrition,
          portion: preview.shown,
        })
      : sourceLines(preview, width);
    renderCache.set(recipe.path, { width, lines });
    return lines;
  };

  /** The shopping list content, rendered once per width. */
  const shoppingLines = (width: number): StyledLine[] => {
    if (shoppingRender && shoppingRender.width === width) return shoppingRender.lines;

    const lines = renderShoppingList(buildShoppingList(entries), entries, width);
    shoppingRender = { width, lines };
    return lines;
  };

  /** The overlay's chrome, which says which of the two drafts is open. */
  const overlayFor = (open: Draft | DietDraft): OverlayViewModel => {
    switch (open.kind) {
      case 'note':
        return {
          title: `note on ${open.recipe.name}`,
          typed: open.typed,
          hint: 'return saves · esc cancels',
        };
      case 'remix':
        return {
          title: diet ? `remix ${open.recipe.name} · ${diet.name}` : `remix ${open.recipe.name}`,
          typed: open.typed,
          hint: 'return asks Claude · esc cancels',
        };
      case 'dietName':
        return {
          title: 'new diet: its name',
          typed: open.typed,
          hint: 'return goes on to what it rules out · esc cancels',
        };
      case 'dietRules':
        return {
          title: `diet ${open.name}: what it rules out`,
          typed: open.typed,
          hint: 'in plain words, as you would tell a cook · return saves · esc cancels',
        };
    }
  };

  const pickerView = (open: DietPicker): PickerViewModel => {
    const entry = open.entries[open.selected];
    const own = entry?.kind === 'diet' && !entry.diet.builtIn;
    return {
      title: 'diet',
      items: open.entries.map((item) => {
        if (item.kind === 'none') return { label: 'none', tag: diet ? undefined : 'on' };
        if (item.kind === 'new') return { label: 'new…' };
        const on = diet !== undefined && dietKey(diet.name) === dietKey(item.diet.name);
        return { label: item.diet.name, tag: on ? 'on' : item.diet.builtIn ? undefined : 'yours' };
      }),
      selected: open.selected,
      hint:
        open.confirmDelete && entry?.kind === 'diet'
          ? `Delete “${entry.diet.name}”? y deletes, anything else keeps it`
          : own
            ? 'return picks · d deletes · esc cancels'
            : 'return picks · esc cancels',
    };
  };

  /** The prompt as the status line shows it, with a block for the cursor. */
  const promptLine = (): string =>
    `Persons for “${prompt?.recipe.name}” [${prompt?.fallback}]: ${prompt?.typed ?? ''}█` +
    '  (0 removes it, esc cancels)';

  /** The question asked before a recipe is deleted. */
  const confirmLine = (): string =>
    `Delete “${confirm?.recipe.name}” for good?  (y deletes, anything else cancels)`;

  const drawShopping = (): void => {
    const size = currentSize();
    const layout = computeLayout(size);
    const lines = shoppingLines(layout.panelWidth);
    shoppingOffset = clampOffset(shoppingOffset, layout.contentHeight, lines.length);

    const frame = renderPanel(
      {
        title: 'shopping list',
        lines,
        offset: shoppingOffset,
        status: status ?? pending ?? background ?? checking(),
      },
      size,
      useColor,
    )
      .map((line) => `${line}${CLEAR_TO_LINE_END}`)
      .join('\n');
    output.write(`${CURSOR_HOME}${frame}${CLEAR_BELOW}`);
  };

  const draw = (): void => {
    if (finished) return;
    if (mode === 'shopping') {
      drawShopping();
      return;
    }

    const size = currentSize();
    const layout = computeLayout(size);
    const recipe = visible[selected];

    listOffset = scrollToVisible(listOffset, selected, layout.contentHeight, visible.length);
    const preview = previewLines(recipe, layout.previewWidth);
    previewOffset = clampOffset(previewOffset, layout.contentHeight, preview.length);

    const view: ViewModel = {
      directory: options.directory,
      recipes: visible.map((entry) => ({
        ...entry,
        favourite: isFavourite(favourites, entry.relativePath),
        diet: diet ? (verdicts.get(entry.path) ?? 'pending') : undefined,
      })),
      filtered: onlyFavourites,
      diet: diet?.name,
      dietFilter: diet && onlyFitting ? diet.name : undefined,
      selected,
      listOffset,
      previewLines: preview,
      previewOffset,
      focus,
      // An open question outranks a passing confirmation, which in turn
      // outranks the standing message of whatever is still running — and work
      // the cook asked for outranks work that started on its own.
      status: prompt
        ? promptLine()
        : confirm
          ? confirmLine()
          : (status ?? pending ?? background ?? checking()),
      overlay: draft ? overlayFor(draft) : undefined,
      picker: picker ? pickerView(picker) : undefined,
    };

    // Repaint in place rather than clearing first, so the screen never flashes.
    const frame = renderScreen(view, size, useColor)
      .map((line) => `${line}${CLEAR_TO_LINE_END}`)
      .join('\n');
    output.write(`${CURSOR_HOME}${frame}${CLEAR_BELOW}`);
  };

  /** Loads the selected recipe if needed, redrawing when it lands. */
  const ensureSelectionLoaded = (): void => {
    const recipe = visible[selected];
    if (!recipe) return;

    if (!previews.has(recipe.path)) {
      void loadPreview(recipe).then(() => {
        // The user may have moved on while the read was in flight.
        if (visible[selected]?.path === recipe.path) draw();
      });
    } else {
      // Read at an earlier count, before the cook pressed `-` or `+`.
      void rescale(recipe);
    }

    // A recipe being looked at is a recipe worth having figures for, and the
    // products it introduces are worth having in the registry either way.
    ensureNutrition(recipe);
  };

  /**
   * Works out which rows the list is showing, and where the arrow sits.
   *
   * `keep` is the recipe worth staying on — the cook is looking at a recipe, not
   * at row seven — and it is found again wherever it has moved to. A `keep` that
   * is no longer on the list at all, because it was just unfavourited out of a
   * filtered one or deleted, leaves the arrow on the row that slid up into its
   * place.
   */
  const refreshVisible = (keep?: Recipe): void => {
    visible =
      onlyFavourites || onlyFitting
        ? recipes.filter(
            (recipe) =>
              (!onlyFavourites || isFavourite(favourites, recipe.relativePath)) &&
              (!onlyFitting || verdicts.get(recipe.path) !== 'fail'),
          )
        : recipes;

    const index = keep ? visible.findIndex((entry) => entry.path === keep.path) : -1;
    if (index >= 0) selected = index;
    selected = Math.min(Math.max(selected, 0), Math.max(visible.length - 1, 0));
  };

  const select = (index: number): void => {
    const next = Math.min(Math.max(index, 0), Math.max(visible.length - 1, 0));
    if (next === selected) return;
    selected = next;
    // A new recipe is shown from its top rather than the old scroll position.
    previewOffset = 0;
    ensureSelectionLoaded();
  };

  /**
   * Turns the list round, A→Z to Z→A and back.
   *
   * The favourites stay on top either way, so what turns round is the run of
   * names inside each of the two groups.
   */
  const toggleOrder = (): void => {
    order = order === 'az' ? 'za' : 'az';
    const current = visible[selected];
    recipes.sort(comparingRecipes(order, favourites));
    refreshVisible(current);
    setStatus(`Sorted ${describeOrder(order)}`);
  };

  /**
   * Marks the selected recipe as one of the cook's own, or unmarks it.
   *
   * Saved before the screen changes, so a star on the list is a star on disk:
   * the marks are small enough to write on every keystroke, and a mark that
   * quietly failed to persist would be worse than one that never appeared.
   *
   * The list is re-sorted afterwards, because a favourite belongs at the top —
   * and while the filter is on, unmarking takes the recipe off the list there
   * and then.
   */
  const toggleSelectedFavourite = async (): Promise<void> => {
    const recipe = visible[selected];
    if (!recipe) return;

    const marked = isFavourite(favourites, recipe.relativePath);
    const next = toggleFavourite(favourites, recipe.relativePath);
    try {
      await writeFavourites(options.root, next);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not save the favourite — ${why}`);
      draw();
      return;
    }

    favourites = next;
    recipes.sort(comparingRecipes(order, favourites));
    refreshVisible(recipe);
    // Only a selection that actually moved earns a fresh scroll position.
    if (visible[selected]?.path !== recipe.path) {
      previewOffset = 0;
      ensureSelectionLoaded();
    }

    setStatus(marked ? `Unfavourited “${recipe.name}”` : `Favourited “${recipe.name}”`);
    draw();
  };

  /**
   * Holds the list down to favourites, or lets the rest of it back in.
   *
   * The selected recipe is kept wherever it can be kept: turning the filter on
   * from a favourite stays on it, and turning it off again finds it in the whole
   * list rather than starting from the top.
   */
  const toggleFilter = (): void => {
    const current = visible[selected];
    onlyFavourites = !onlyFavourites;
    refreshVisible(current);

    if (visible[selected]?.path !== current?.path) {
      previewOffset = 0;
      ensureSelectionLoaded();
    }

    setStatus(
      !onlyFavourites
        ? 'Showing every recipe'
        : visible.length === 0
          ? 'No favourites yet — press f to mark one'
          : 'Showing favourites only',
    );
  };

  const checking = (): string | undefined => {
    if (!diet) return undefined;
    const left = checkingPaths.size;
    if (left === 0) return undefined;
    return `Checking ${left} ${left === 1 ? 'recipe' : 'recipes'} against ${diet.name}…`;
  };

  const applyVerdicts = (): void => {
    const current = visible[selected];
    refreshVisible(current);
    if (visible[selected]?.path !== current?.path) {
      previewOffset = 0;
      ensureSelectionLoaded();
    }
    draw();
  };

  const saveChecks = (): void => {
    if (checksSaveQueued) return;
    checksSaveQueued = true;
    checksSaving = checksSaving
      .then(async () => {
        checksSaveQueued = false;
        if (checks) await writeChecks(options.root, checks);
      })
      .catch(() => {});
  };

  const pumpChecks = (): void => {
    while (checksRunning < CHECK_CONCURRENCY && checkQueue.length > 0) {
      const job = checkQueue.shift()!;
      checksRunning += 1;
      void runCheck(job).finally(() => {
        checksRunning -= 1;
        if (job.generation === dietGeneration) checkingPaths.delete(job.recipe.path);
        if (!finished) pumpChecks();
        draw();
      });
    }
  };

  const runCheck = async (job: CheckJob): Promise<void> => {
    if (job.generation !== dietGeneration) return;
    try {
      const verdict = await checkRecipe(job.diet, job.source, job.apiKey, checkAborter.signal);
      checks?.set(job.key, verdict);
      saveChecks();
      if (job.generation !== dietGeneration) return;
      verdicts.set(job.recipe.path, verdict);
      applyVerdicts();
    } catch (error) {
      if (job.generation !== dietGeneration || checkFailureShown) return;
      checkFailureShown = true;
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not check “${job.recipe.name}” against ${job.diet.name} — ${why}`);
    }
  };

  const sourceOf = async (recipe: Recipe): Promise<string | undefined> => {
    const cached = previews.get(recipe.path)?.source;
    if (cached !== undefined) return cached;
    try {
      return await readFile(recipe.path, 'utf8');
    } catch {
      return undefined;
    }
  };

  const checkRecipes = async (targets: readonly Recipe[]): Promise<void> => {
    const profile = diet;
    if (!profile) return;
    const generation = dietGeneration;

    checksLoading ??= readChecks(options.root).then((read) => (checks = read));
    const cache = await checksLoading;
    const apiKey = await anthropicApiKey(options.root);
    if (generation !== dietGeneration) return;

    let answered = false;
    let unanswered = 0;
    for (const recipe of targets) {
      const source = await sourceOf(recipe);
      if (generation !== dietGeneration) return;
      if (source === undefined) continue;

      const key = checkKey(profile, source);
      const cached = cache.get(key);
      if (cached) {
        verdicts.set(recipe.path, cached);
        answered = true;
        continue;
      }
      if (verdicts.delete(recipe.path)) answered = true;
      if (checkingPaths.has(recipe.path)) continue;
      if (!apiKey) {
        unanswered += 1;
        continue;
      }
      checkingPaths.add(recipe.path);
      checkQueue.push({ recipe, source, key, diet: profile, generation, apiKey });
    }

    if (unanswered > 0 && !checkFailureShown) {
      checkFailureShown = true;
      setStatus(`Could not check recipes against ${profile.name} — no ANTHROPIC_API_KEY in .env`);
    }
    if (answered) applyVerdicts();
    pumpChecks();
    draw();
  };

  const setDiet = (next: DietProfile | undefined): void => {
    const current = visible[selected];

    diet = next;
    dietGeneration += 1;
    checkAborter.abort();
    checkAborter = new AbortController();
    verdicts = new Map();
    checkQueue = [];
    checkingPaths = new Set();
    checkFailureShown = false;
    if (!diet) onlyFitting = false;

    refreshVisible(current);
    if (visible[selected]?.path !== current?.path) {
      previewOffset = 0;
      ensureSelectionLoaded();
    }

    setStatus(diet ? `Checking recipes against ${diet.name}` : 'No diet on');
    if (diet) void checkRecipes(recipes);
    draw();
  };

  const openPicker = async (): Promise<void> => {
    userDiets = await readUserDiets(options.root);
    const entries: PickerEntry[] = [
      { kind: 'none' },
      ...allDiets(userDiets).map((entry): PickerEntry => ({ kind: 'diet', diet: entry })),
      { kind: 'new' },
    ];
    const on = diet
      ? entries.findIndex(
          (entry) => entry.kind === 'diet' && dietKey(entry.diet.name) === dietKey(diet!.name),
        )
      : 0;
    picker = { entries, selected: Math.max(on, 0) };
    draw();
  };

  const choosePicked = (open: DietPicker): void => {
    const entry = open.entries[open.selected];
    picker = undefined;
    if (!entry) return;
    if (entry.kind === 'new') {
      draft = { kind: 'dietName', typed: '' };
      draw();
      return;
    }
    setDiet(entry.kind === 'diet' ? entry.diet : undefined);
  };

  const deleteDiet = async (gone: DietProfile): Promise<void> => {
    const next = withoutDiet(userDiets, gone.name);
    try {
      await writeUserDiets(options.root, next);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not delete the diet “${gone.name}” — ${why}`);
      draw();
      return;
    }

    userDiets = next;
    if (diet && dietKey(diet.name) === dietKey(gone.name)) setDiet(undefined);
    await openPicker();
    setStatus(`Deleted the diet “${gone.name}”`);
    draw();
  };

  const handlePickerKey = (key: Key, open: DietPicker): void => {
    const entry = open.entries[open.selected];
    const move = (index: number): void => {
      open.selected = Math.min(Math.max(index, 0), open.entries.length - 1);
    };

    if (open.confirmDelete) {
      open.confirmDelete = false;
      if ((key.value === 'y' || key.value === 'Y') && entry?.kind === 'diet') {
        void deleteDiet(entry.diet);
        return;
      }
      draw();
      return;
    }

    const char = key.name === 'char' ? key.value : undefined;
    if (key.name === 'escape' || char === 'q') {
      picker = undefined;
    } else if (key.name === 'enter') {
      choosePicked(open);
      return;
    } else if (key.name === 'up' || char === 'k') {
      move(open.selected - 1);
    } else if (key.name === 'down' || char === 'j') {
      move(open.selected + 1);
    } else if (key.name === 'home' || char === 'g') {
      move(0);
    } else if (key.name === 'end' || char === 'G') {
      move(open.entries.length - 1);
    } else if (char === 'd' && entry?.kind === 'diet' && !entry.diet.builtIn) {
      open.confirmDelete = true;
    } else {
      return;
    }
    draw();
  };

  const nameDiet = (name: string): void => {
    const existing = allDiets(userDiets).find((entry) => dietKey(entry.name) === dietKey(name));
    draft = {
      kind: 'dietRules',
      name: existing?.name ?? name,
      typed: existing?.restrictions ?? '',
    };
    draw();
  };

  const saveDiet = async (name: string, restrictions: string): Promise<void> => {
    const written: DietProfile = { name, restrictions: restrictions.trim(), builtIn: false };
    const next = withDiet(userDiets, written);
    try {
      await writeUserDiets(options.root, next);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not save the diet “${name}” — ${why}`);
      draw();
      return;
    }

    userDiets = next;
    setDiet(written);
    setStatus(`Saved the diet “${name}” — checking recipes against it`);
    draw();
  };

  const toggleFitting = (): void => {
    if (!diet) {
      void openPicker();
      return;
    }

    const current = visible[selected];
    onlyFitting = !onlyFitting;
    refreshVisible(current);
    if (visible[selected]?.path !== current?.path) {
      previewOffset = 0;
      ensureSelectionLoaded();
    }

    setStatus(onlyFitting ? `Hiding recipes that break ${diet.name}` : 'Showing every recipe');
  };

  const dietRemix = (): void => {
    if (!diet) {
      void openPicker();
      return;
    }
    const recipe = visible[selected];
    if (!recipe) return;

    if (verdicts.get(recipe.path) === 'pass') {
      setStatus(`“${recipe.name}” already fits ${diet.name} — r remixes it with a note`);
      draw();
      return;
    }
    void remix({ kind: 'remix', recipe, typed: '' });
  };

  const scrollPreview = (delta: number): void => {
    const layout = computeLayout(currentSize());
    const total = previewLines(visible[selected], layout.previewWidth).length;
    previewOffset = clampOffset(previewOffset + delta, layout.contentHeight, total);
  };

  const copySelection = async (): Promise<void> => {
    const recipe = visible[selected];
    if (!recipe) return;

    // At the count on screen, so the rest of the copy agrees with the preview.
    await rescale(recipe);
    const { source, shown } = await loadPreview(recipe);
    if (source === undefined) {
      setStatus(`Could not copy “${recipe.name}” — the file could not be read`);
      draw();
      return;
    }

    // A recipe that would not parse has no reading to copy, so it goes as written.
    const text = shown ? recipeText(shown.document, recipe.name) : source;
    const result = await copyToClipboard(text, { out: output });
    if (!result.copied) {
      setStatus(`Could not copy “${recipe.name}” — no clipboard available`);
    } else if (result.via === 'terminal') {
      setStatus(`Copied “${recipe.name}” via the terminal clipboard`);
    } else {
      setStatus(`Copied “${recipe.name}” to the clipboard`);
    }
    draw();
  };

  /** Opens the overlay over the selected recipe, for a note or a remix. */
  const openDraft = (kind: Draft['kind']): void => {
    const recipe = visible[selected];
    if (!recipe) return;
    draft = { kind, recipe, typed: '' };
    draw();
  };

  /**
   * Writes the drafted note into its recipe file and shows it straight away.
   *
   * The cached parse and render are dropped so the preview is rebuilt from the
   * file as it now stands, and the preview jumps to the end, where the new note
   * has landed.
   */
  const saveNote = async (open: Draft): Promise<void> => {
    const { recipe } = open;
    try {
      await appendNoteToFile(recipe.path, open.typed);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not write the note to “${recipe.name}” — ${why}`);
      draw();
      return;
    }

    previews.delete(recipe.path);
    renderCache.delete(recipe.path);
    await loadPreview(recipe);

    if (visible[selected]?.path === recipe.path) {
      // Clamped on the next draw, so this simply means "as far down as it goes".
      previewOffset = Number.MAX_SAFE_INTEGER;
    }
    setStatus(`Added a note to “${recipe.name}”`);
    void checkRecipes([recipe]);
    draw();
  };

  /** Text, Return and Backspace while the overlay is open. */
  const handleDraftKey = (key: Key, open: Draft | DietDraft): void => {
    const what = open.kind === 'note' ? 'Note' : open.kind === 'remix' ? 'Remix' : 'Diet';
    const limit =
      open.kind === 'dietName'
        ? MAX_DIET_NAME_LENGTH
        : open.kind === 'dietRules'
          ? MAX_DIET_LENGTH
          : MAX_DRAFT_LENGTH;

    if (key.name === 'escape') {
      draft = undefined;
      setStatus(`${what} discarded`);
    } else if (key.name === 'enter') {
      draft = undefined;
      const typed = open.typed.trim();
      if (typed === '') {
        setStatus(`${what} discarded — nothing was typed`);
      } else {
        switch (open.kind) {
          case 'note':
            void saveNote(open);
            return;
          case 'remix':
            void remix(open);
            return;
          case 'dietName':
            nameDiet(typed);
            return;
          case 'dietRules':
            void saveDiet(open.name, typed);
            return;
        }
      }
    } else if (key.name === 'backspace') {
      open.typed = open.typed.slice(0, -1);
    } else if (key.name === 'char' && key.value && !CONTROL_CHAR.test(key.value)) {
      if (open.typed.length < limit) open.typed += key.value;
    } else {
      // Arrows and the like do nothing rather than scrolling what is behind.
      return;
    }

    draw();
  };

  /**
   * Puts a freshly written recipe into the list and shows it.
   *
   * It arrives unmarked, whatever the recipe it was remixed from was: a
   * favourite is something the cook decided about a dish they cooked, and a
   * model's adaptation of it is a different dish nobody has cooked yet. So with
   * the filter on, a remix is saved but not shown, and the status line is what
   * says it landed.
   */
  const adopt = async (path: string): Promise<void> => {
    const { recipe } = await loadRecipe(path, options.root);
    recipes.push(recipe);
    recipes.sort(comparingRecipes(order, favourites));

    // Not `select`, which would do nothing if the new recipe happened to sort
    // into the position already selected.
    const before = visible[selected];
    refreshVisible(recipe);
    if (visible[selected]?.path !== before?.path) previewOffset = 0;

    await loadPreview(recipe);
    // A recipe the model just wrote is the newest thing in the collection, and
    // whatever it invented its way into needs pricing like anything else.
    ensureNutrition(recipe);
    void checkRecipes([recipe]);
  };

  /**
   * Asks a model to adapt the drafted recipe, and saves what comes back.
   *
   * One remix at a time: the answer takes long enough that a second request
   * running alongside it would only be a way to lose track of the first.
   */
  const remix = async (open: Draft): Promise<void> => {
    const { recipe } = open;

    if (pending) {
      setStatus('A remix is already running');
      draw();
      return;
    }

    const { source } = await loadPreview(recipe);
    if (source === undefined) {
      setStatus(`Could not remix “${recipe.name}” — the file could not be read`);
      draw();
      return;
    }

    const apiKey = await anthropicApiKey(options.root);
    if (!apiKey) {
      setStatus('Could not remix — no ANTHROPIC_API_KEY in .env');
      draw();
      return;
    }

    const keepTo = diet;
    pending = keepTo
      ? `Remixing “${recipe.name}” to fit ${keepTo.name}…`
      : `Remixing “${recipe.name}”…`;
    draw();

    try {
      const result = await requestRemix({
        source,
        note: open.typed,
        name: recipe.name,
        diet: keepTo,
        apiKey,
      });
      const path = await saveRemix(dirname(recipe.path), result, {
        parent: basename(recipe.path),
      });
      pending = undefined;
      await adopt(path);
      setStatus(`Saved “${result.title}”`);
    } catch (error) {
      pending = undefined;
      // A RemixError says something the cook can act on; anything else is the
      // API's own complaint, which is still better than a bare failure.
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not remix “${recipe.name}” — ${why}`);
    }

    draw();
  };

  /** Asks whether the selected recipe should really go. */
  const askDelete = (): void => {
    const recipe = visible[selected];
    if (!recipe) return;
    confirm = { recipe };
    draw();
  };

  /**
   * Deletes a recipe's file, and everything the browser remembered about it.
   *
   * Its shopping list entry goes too: removing one means answering the persons
   * prompt with a zero, which there would no longer be any recipe to open. So
   * does its favourite mark — a mark is a pointer at a recipe, and one pointing
   * at nothing would come back to life the day something else is written to the
   * same path.
   */
  const deleteRecipe = async (recipe: Recipe): Promise<void> => {
    try {
      await unlink(recipe.path);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      setStatus(`Could not delete “${recipe.name}” — ${why}`);
      draw();
      return;
    }

    const index = recipes.findIndex((entry) => entry.path === recipe.path);
    if (index >= 0) recipes.splice(index, 1);
    previews.delete(recipe.path);
    renderCache.delete(recipe.path);
    verdicts.delete(recipe.path);

    if (isFavourite(favourites, recipe.relativePath)) {
      favourites = withoutFavourite(favourites, recipe.relativePath);
      // The recipe is already gone, so a write that fails is not worth putting
      // in the way of the delete: the mark is out of memory either way, and the
      // next mark the cook makes writes the file without it.
      await writeFavourites(options.root, favourites).catch(() => {});
    }

    if (entries.some((entry) => entry.path === recipe.path)) {
      const { path, name } = recipe;
      entries = withEntry(entries, { path, name, persons: 0, ingredients: [] });
      shoppingRender = undefined;
    }

    // The row that slid up into the deleted one's place is the one to be on, so
    // the selection only moves at all when the last recipe was the one deleted.
    refreshVisible();
    previewOffset = 0;
    ensureSelectionLoaded();

    setStatus(`Deleted “${recipe.name}”`);
    draw();
  };

  /** Asks how many people the selected recipe is for. */
  const askPersons = async (): Promise<void> => {
    const recipe = visible[selected];
    if (!recipe) return;

    const { document, problem, shown } = await loadPreview(recipe);
    if (!document) {
      const why = problem ?? 'the recipe could not be read';
      setStatus(`Could not add “${recipe.name}” — ${why}`);
      draw();
      return;
    }

    // The count already on the list is what the cook most likely wants to
    // correct; otherwise the recipe's own yield is the natural offer.
    const listed = entries.find((entry) => entry.path === recipe.path);

    // A recipe the cook has scaled on screen goes on the list at that count
    // without a question. Unless it is already there at that count: then the
    // prompt is the only way to change or remove it, so it is asked after all.
    if (personsChosen && shown?.scaled && listed?.persons !== persons) {
      await addToShoppingList(recipe, persons);
      return;
    }

    prompt = {
      recipe,
      typed: '',
      fallback: listed?.persons ?? Math.round(document.servings ?? 1),
    };
    draw();
  };

  /** Puts the prompted recipe on the list, scaled for `persons`. */
  const addToShoppingList = async (recipe: Recipe, persons: number): Promise<void> => {
    if (persons <= 0) {
      const { path, name } = recipe;
      entries = withEntry(entries, { path, name, persons: 0, ingredients: [] });
      shoppingRender = undefined;
      setStatus(`Removed “${recipe.name}” from the shopping list`);
      draw();
      return;
    }

    const { source, document } = await loadPreview(recipe);
    if (source === undefined || !document) {
      setStatus(`Could not add “${recipe.name}” — the recipe could not be read`);
      draw();
      return;
    }

    // A recipe that cannot be scaled still goes on the list, with the amounts
    // the author wrote and a note saying so, rather than being refused.
    const scale = scaleFor(persons, document.servings);
    let ingredients = document.ingredients;
    let unscaled = scale === undefined;
    if (scale !== undefined && scale !== 1) {
      try {
        ingredients = (await parseRecipeDocument(source, scale)).ingredients;
      } catch {
        unscaled = true;
      }
    }

    entries = withEntry(entries, {
      path: recipe.path,
      name: recipe.name,
      persons,
      ingredients,
      unscaled: unscaled || undefined,
    });
    shoppingRender = undefined;

    const people = `${persons} ${persons === 1 ? 'person' : 'persons'}`;
    const why = scale === undefined ? 'no servings given' : 'it could not be scaled';
    setStatus(
      unscaled
        ? `Added “${recipe.name}” for ${people} — ${why}, amounts as written`
        : `Added “${recipe.name}” for ${people} to the shopping list`,
    );
    draw();
  };

  /** Digits, Return and Backspace while the persons prompt is open. */
  const handlePromptKey = (key: Key, open: PersonsPrompt): void => {
    if (key.name === 'escape') {
      prompt = undefined;
      setStatus('Cancelled');
    } else if (key.name === 'enter') {
      prompt = undefined;
      const persons = open.typed === '' ? open.fallback : Number.parseInt(open.typed, 10);
      void addToShoppingList(open.recipe, Math.min(persons, MAX_PERSONS));
      return;
    } else if (key.name === 'backspace') {
      open.typed = open.typed.slice(0, -1);
    } else if (key.name === 'char' && key.value && /^\d$/.test(key.value)) {
      // Only digits are taken, so the prompt cannot end up unanswerable.
      if (open.typed.length < String(MAX_PERSONS).length) open.typed += key.value;
    } else {
      return;
    }

    draw();
  };

  const copyShoppingList = async (): Promise<void> => {
    const products = buildShoppingList(entries);
    if (products.length === 0) {
      setStatus('The shopping list is empty');
      draw();
      return;
    }

    const result = await copyToClipboard(shoppingText(products), { out: output });
    setStatus(
      result.copied
        ? 'Copied the shopping list to the clipboard'
        : 'Could not copy the shopping list — no clipboard available',
    );
    draw();
  };

  const handleShoppingKey = (key: Key): void => {
    const layout = computeLayout(currentSize());
    const page = Math.max(layout.contentHeight - 1, 1);
    const total = shoppingLines(layout.panelWidth).length;
    const scroll = (delta: number): void => {
      shoppingOffset = clampOffset(shoppingOffset + delta, layout.contentHeight, total);
    };

    switch (key.name) {
      case 'up':
        scroll(-1);
        break;
      case 'down':
        scroll(1);
        break;
      case 'pageUp':
        scroll(-page);
        break;
      case 'pageDown':
        scroll(page);
        break;
      case 'home':
        scroll(-Number.MAX_SAFE_INTEGER);
        break;
      case 'end':
        scroll(Number.MAX_SAFE_INTEGER);
        break;
      case 'char':
        switch (key.value) {
          case 'k':
            scroll(-1);
            break;
          case 'j':
            scroll(1);
            break;
          case 'g':
            scroll(-Number.MAX_SAFE_INTEGER);
            break;
          case 'G':
            scroll(Number.MAX_SAFE_INTEGER);
            break;
          case 's':
          case 'a':
            mode = 'recipes';
            break;
          case 'c':
          case 'y':
            void copyShoppingList();
            return;
          default:
            return;
        }
        break;
      default:
        return;
    }

    draw();
  };

  const handleKey = (key: Key): void => {
    const layout = computeLayout(currentSize());
    const page = Math.max(layout.contentHeight - 1, 1);
    const char = key.value;

    // Only the interrupts get through while a question is open: everything else
    // is either an answer to it or nothing at all.
    if (char === CTRL_C || char === CTRL_D) {
      quit();
      return;
    }
    if (prompt) {
      handlePromptKey(key, prompt);
      return;
    }
    // Only "y" goes through with it; every other key is a no, so a cook who
    // did not mean to press "d" cannot lose a recipe by pressing on.
    if (confirm) {
      const { recipe } = confirm;
      confirm = undefined;
      if (key.value === 'y' || key.value === 'Y') {
        void deleteRecipe(recipe);
      } else {
        setStatus('Cancelled');
        draw();
      }
      return;
    }
    // Every letter is draft text while the overlay is open, "q" included.
    if (draft) {
      handleDraftKey(key, draft);
      return;
    }
    if (picker) {
      handlePickerKey(key, picker);
      return;
    }

    if (char === 'q' || key.name === 'escape') {
      // Escape leaves the shopping list rather than the whole browser, which is
      // what a mode one keystroke deep should do.
      if (mode === 'shopping' && key.name === 'escape') {
        mode = 'recipes';
        draw();
        return;
      }
      quit();
      return;
    }

    if (mode === 'shopping') {
      handleShoppingKey(key);
      return;
    }

    switch (key.name) {
      case 'tab':
      case 'shiftTab':
        focus = focus === 'list' ? 'preview' : 'list';
        break;
      case 'up':
        focus === 'list' ? select(selected - 1) : scrollPreview(-1);
        break;
      case 'down':
        focus === 'list' ? select(selected + 1) : scrollPreview(1);
        break;
      case 'pageUp':
        focus === 'list' ? select(selected - page) : scrollPreview(-page);
        break;
      case 'pageDown':
        focus === 'list' ? select(selected + page) : scrollPreview(page);
        break;
      case 'home':
        focus === 'list' ? select(0) : scrollPreview(-Number.MAX_SAFE_INTEGER);
        break;
      case 'end':
        focus === 'list' ? select(visible.length - 1) : scrollPreview(Number.MAX_SAFE_INTEGER);
        break;
      case 'char':
        switch (char) {
          case 'k':
            focus === 'list' ? select(selected - 1) : scrollPreview(-1);
            break;
          case 'j':
            focus === 'list' ? select(selected + 1) : scrollPreview(1);
            break;
          case 'g':
            focus === 'list' ? select(0) : scrollPreview(-Number.MAX_SAFE_INTEGER);
            break;
          case 'G':
            focus === 'list' ? select(visible.length - 1) : scrollPreview(Number.MAX_SAFE_INTEGER);
            break;
          case 'a':
            void askPersons();
            return;
          case 'n':
            openDraft('note');
            return;
          case 'r':
            openDraft('remix');
            return;
          case 'd':
            askDelete();
            return;
          case 'o':
            toggleOrder();
            break;
          case 'f':
            void toggleSelectedFavourite();
            return;
          case 'F':
            toggleFilter();
            break;
          case 'D':
            void openPicker();
            return;
          case 'R':
            dietRemix();
            return;
          case 'V':
            toggleFitting();
            break;
          case '+':
          case '=':
            changePersons(1);
            break;
          case '-':
          case '_':
            changePersons(-1);
            break;
          case 's':
            mode = 'shopping';
            break;
          case 'c':
          case 'y':
            void copySelection();
            return;
          default:
            return;
        }
        break;
      default:
        return;
    }

    draw();
  };

  const onData = (chunk: string): void => {
    for (const key of parseKeys(chunk)) {
      if (finished) return;
      handleKey(key);
    }
  };

  const wasRaw = input.isRaw === true;
  const previousEncoding = input.readableEncoding;

  /** Ends the session; assigned once the run promise exists. */
  let quit = (): void => {};

  const teardown = (): void => {
    if (finished) return;
    finished = true;

    if (statusTimer) clearTimeout(statusTimer);
    dietGeneration += 1;
    checkQueue = [];
    checkAborter.abort();
    input.off('data', onData);
    input.off('end', quit);
    output.off('resize', draw);
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
    if (previousEncoding) input.setEncoding(previousEncoding);
    output.write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  };

  output.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();

  ensureSelectionLoaded();
  draw();

  try {
    await new Promise<void>((resolve) => {
      quit = () => {
        teardown();
        resolve();
      };
      input.on('data', onData);
      output.on('resize', draw);
      // Losing stdin (a closed pipe, a detached terminal) ends the session.
      input.once('end', quit);
      process.once('SIGINT', quit);
      process.once('SIGTERM', quit);
    });
  } finally {
    // Restores the terminal even if a draw threw: teardown is idempotent and
    // unhooks every listener it registered.
    teardown();
  }
}
