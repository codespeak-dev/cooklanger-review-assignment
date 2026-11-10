/**
 * Pure geometry and text layout for the two-pane browser.
 *
 * Nothing here touches the terminal: every function maps sizes and state to
 * strings, so the whole screen can be asserted on in tests.
 */

export interface Size {
  columns: number;
  rows: number;
}

export interface Layout {
  /** Inner width of the recipe list pane, excluding borders. */
  listWidth: number;
  /** Inner width of the preview pane, excluding borders. */
  previewWidth: number;
  /** Inner width of a screen that is one pane wide, excluding borders. */
  panelWidth: number;
  /** Rows of content in each pane, excluding borders. */
  contentHeight: number;
}

/** Below these the panes stop shrinking and the frame overflows instead. */
const MIN_COLUMNS = 30;
const MIN_ROWS = 6;
const MIN_PANE_WIDTH = 8;

/** The list pane takes about a third of the width, within these bounds. */
const LIST_SHARE = 0.34;
const LIST_MIN_WIDTH = 16;
const LIST_MAX_WIDTH = 40;

export function computeLayout(size: Size): Layout {
  const columns = Math.max(size.columns, MIN_COLUMNS);
  const rows = Math.max(size.rows, MIN_ROWS);

  // Three columns go to the left edge, the divider, and the right edge.
  const inner = columns - 3;
  const share = Math.round(inner * LIST_SHARE);
  const listWidth = Math.max(
    MIN_PANE_WIDTH,
    Math.min(Math.max(share, LIST_MIN_WIDTH), LIST_MAX_WIDTH, inner - MIN_PANE_WIDTH),
  );

  return {
    listWidth,
    previewWidth: Math.max(inner - listWidth, MIN_PANE_WIDTH),
    // One pane takes the two side edges instead of a divider as well.
    panelWidth: columns - 2,
    // Two rows go to the top and bottom borders, one to the status line.
    contentHeight: Math.max(rows - 3, 1),
  };
}

/** Cuts `text` to `width`, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** Cuts or space-pads `text` so it occupies exactly `width` columns. */
export function fit(text: string, width: number): string {
  return truncate(text, width).padEnd(Math.max(width, 0), ' ');
}

/**
 * What a run of preview text means, which is what gives it its colour.
 *
 * The renderer marks meaning rather than colour, so the palette lives in one
 * place and a monochrome terminal can drop it entirely.
 */
export type SpanStyle =
  | 'text'
  | 'title'
  | 'description'
  | 'metaKey'
  | 'metaValue'
  | 'heading'
  | 'section'
  | 'stepNumber'
  | 'ingredient'
  | 'quantity'
  | 'cookware'
  | 'timer'
  | 'note'
  | 'problem';

/** A run of text sharing one meaning. */
export interface Span {
  text: string;
  style: SpanStyle;
}

/** One logical line of preview content, before it is wrapped or padded. */
export type StyledLine = readonly Span[];

export function span(text: string, style: SpanStyle = 'text'): Span {
  return { text, style };
}

/** A whole line in one style — the common case, and what tests read best. */
export function styled(text: string, style: SpanStyle = 'text'): StyledLine {
  return [{ text, style }];
}

export function plainText(line: StyledLine): string {
  return line.map((part) => part.text).join('');
}

/** One display cell, so wrapping can cut a line without losing its styles. */
interface Cell {
  char: string;
  style: SpanStyle;
}

function toCells(line: StyledLine): Cell[] {
  const cells: Cell[] = [];
  for (const part of line) {
    for (const char of part.text.replace(/\t/g, '    ')) cells.push({ char, style: part.style });
  }
  return cells;
}

/** Rebuilds spans from cells, merging neighbours that share a style. */
function toSpans(cells: readonly Cell[]): StyledLine {
  const spans: Span[] = [];
  for (const cell of cells) {
    const last = spans.at(-1);
    if (last && last.style === cell.style) last.text += cell.char;
    else spans.push({ text: cell.char, style: cell.style });
  }
  return spans;
}

function trimCells(cells: readonly Cell[], side: 'start' | 'end' | 'both'): Cell[] {
  let start = 0;
  let end = cells.length;
  if (side !== 'end') while (start < end && cells[start]!.char === ' ') start += 1;
  if (side !== 'start') while (end > start && cells[end - 1]!.char === ' ') end -= 1;
  return cells.slice(start, end);
}

/** Index of the last space at or before `limit`, or -1 if there is none. */
function lastSpace(cells: readonly Cell[], limit: number): number {
  for (let index = Math.min(limit, cells.length - 1); index >= 0; index -= 1) {
    if (cells[index]!.char === ' ') return index;
  }
  return -1;
}

/**
 * Breaks one styled line to `width`, preferring to break at spaces.
 *
 * Continuation lines are indented by `hanging` columns, which is how a step
 * body stays aligned under its number instead of running back to the margin.
 * An empty line stays a single empty line, so blank lines in a recipe survive.
 */
export function wrapStyled(line: StyledLine, width: number, hanging = 0): StyledLine[] {
  if (width < 1) return [line];

  const indent = Math.min(Math.max(hanging, 0), width - 1);
  const pad: Cell[] = Array.from({ length: indent }, () => ({ char: ' ', style: 'text' }));

  const chunks: Cell[][] = [];
  let rest = trimCells(toCells(line), 'end');
  for (;;) {
    const limit = chunks.length === 0 ? width : width - indent;
    if (rest.length <= limit) {
      // A line that ends exactly on a break adds nothing but a padded blank.
      if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
      break;
    }

    // Break after the last space that still fits; mid-word if there is none.
    const space = lastSpace(rest, limit);
    const cut = space > 0 ? space : limit;
    chunks.push(trimCells(rest.slice(0, cut), 'end'));
    rest = trimCells(rest.slice(cut), 'start');
  }

  return chunks.map((chunk, index) => toSpans(index === 0 ? chunk : [...pad, ...chunk]));
}

/** Cuts or space-pads a styled line so it occupies exactly `width` columns. */
export function fitStyled(line: StyledLine, width: number): StyledLine {
  if (width <= 0) return [];

  const cells = toCells(line);
  if (cells.length <= width) {
    const pad: Cell[] = Array.from({ length: width - cells.length }, () => ({
      char: ' ',
      style: 'text',
    }));
    return toSpans([...cells, ...pad]);
  }

  const kept = width === 1 ? [] : cells.slice(0, width - 1);
  return toSpans([...kept, { char: '…', style: kept.at(-1)?.style ?? 'text' }]);
}

/** Scrolls the window as little as possible to bring `index` into view. */
export function scrollToVisible(
  offset: number,
  index: number,
  height: number,
  total: number,
): number {
  const maxOffset = Math.max(total - height, 0);
  let next = Math.min(Math.max(offset, 0), maxOffset);
  if (index < next) next = index;
  if (index >= next + height) next = index - height + 1;
  return Math.min(Math.max(next, 0), maxOffset);
}

/** Keeps a free-scrolling offset inside the scrollable range. */
export function clampOffset(offset: number, height: number, total: number): number {
  return Math.min(Math.max(offset, 0), Math.max(total - height, 0));
}

export type Pane = 'list' | 'preview';

export interface RecipeRow {
  name: string;
  relativePath: string;
  /** `llm` earns a mark in the gutter; the other two are left unmarked. */
  authorship?: 'llm' | 'human' | 'unknown';
  /** One of the cook's own, which earns a star and a place at the top. */
  favourite?: boolean;
}

/**
 * The badge on a recipe a model wrote.
 *
 * Only `llm` is badged. A recipe that says a person wrote it and one that says
 * nothing are both left blank — claiming to tell them apart at a glance would
 * be claiming more than the files do.
 *
 * It sits at the right edge of the row, so the names keep the left margin they
 * are read down, and the badge survives a name too long for the pane.
 */
const LLM_BADGE = '[AI]';

/**
 * The mark on one of the cook's own recipes.
 *
 * It sits in the left gutter, beside the selection arrow, because favourites
 * are pinned to the top: a column of stars down the start of the list is the
 * same shape as the block they occupy, and reads as one thing rather than as a
 * badge to be looked for on each row.
 */
const FAVOURITE_MARK = '★';

/** What the list pane says when it is showing nothing at all. */
const EMPTY_LIST = 'no recipes';
const EMPTY_FAVOURITES = 'no favourites';

/** The pane title while only favourites are listed, in place of the folder. */
const FAVOURITES_TITLE = 'favourites';

/** A single-line text input drawn on top of both panes. */
export interface OverlayViewModel {
  /** Inlaid in the overlay's top border. */
  title: string;
  /** What has been typed so far; the cursor sits at its end. */
  typed: string;
  /** Shown under the input, dimmed, to say how to leave it. */
  hint: string;
}

export interface ViewModel {
  /** Directory being browsed, already formatted for display. */
  directory: string;
  recipes: readonly RecipeRow[];
  selected: number;
  listOffset: number;
  /** Preview content, already wrapped to the preview width. */
  previewLines: readonly StyledLine[];
  previewOffset: number;
  focus: Pane;
  /** Transient message shown in place of the key hints. */
  status?: string;
  /** An open text input, which takes the middle of the screen while it lasts. */
  overlay?: OverlayViewModel;
  /** Whether `recipes` is the whole folder or only the cook's favourites. */
  filtered?: boolean;
}

/**
 * Wraps text in an SGR pair.
 *
 * Styled runs are never nested: a reset would drop the enclosing colour for
 * everything after it, so callers concatenate independently styled pieces.
 */
type Style = (text: string) => string;

const plain: Style = (text) => text;
const sgr =
  (code: string): Style =>
  (text) =>
    `\x1b[${code}m${text}\x1b[0m`;

interface Styles {
  border: Style;
  focusedBorder: Style;
  title: Style;
  selected: Style;
  unfocusedSelected: Style;
  dim: Style;
}

const PLAIN: Styles = {
  border: plain,
  focusedBorder: plain,
  title: plain,
  selected: plain,
  unfocusedSelected: plain,
  dim: plain,
};

const COLORED: Styles = {
  border: sgr('90'),
  focusedBorder: sgr('36'),
  title: sgr('1'),
  selected: sgr('7'),
  unfocusedSelected: sgr('100'),
  dim: sgr('2'),
};

/**
 * The colour each kind of preview span is painted in.
 *
 * Only the eight basic colours are used, so the palette follows whatever theme
 * the terminal is set to instead of fighting it. An empty code means the
 * terminal's own foreground colour.
 */
const SPAN_SGR: Record<SpanStyle, string> = {
  text: '',
  title: '1',
  description: '2;3',
  metaKey: '2',
  metaValue: '',
  heading: '1;4',
  section: '1;36',
  stepNumber: '2',
  ingredient: '32',
  quantity: '33',
  cookware: '35',
  timer: '36',
  // Italic and grey: an aside the cook wrote, not part of the recipe proper.
  note: '3;90',
  problem: '31',
};

function paint(line: StyledLine, color: boolean): string {
  if (!color) return plainText(line);
  return line
    .map((part) => {
      const code = SPAN_SGR[part.style];
      return code ? `\x1b[${code}m${part.text}\x1b[0m` : part.text;
    })
    .join('');
}

/**
 * Builds a horizontal border run of exactly `width` cells with `title` inlaid.
 *
 * The dashes and the label are styled separately and concatenated, so the
 * label's reset cannot leak into the rest of the border.
 */
function titledBorder(title: string, width: number, edge: Style, styles: Styles): string {
  const label = ` ${truncate(title, Math.max(width - 4, 0))} `;
  if (label.length + 2 > width) return edge('─'.repeat(Math.max(width, 0)));
  return edge('─') + styles.title(label) + edge('─'.repeat(width - label.length - 1));
}

function listRows(view: ViewModel, layout: Layout, styles: Styles): string[] {
  // Room for either mark is held only when the list has something to mark, so a
  // collection with nothing machine-written and nothing starred reads exactly as
  // it did before either existed.
  const badgeWidth = view.recipes.some((recipe) => recipe.authorship === 'llm')
    ? LLM_BADGE.length + 1
    : 0;
  const markWidth = view.recipes.some((recipe) => recipe.favourite)
    ? FAVOURITE_MARK.length + 1
    : 0;
  const nameWidth = Math.max(layout.listWidth - badgeWidth, 1);
  const empty = view.filtered ? EMPTY_FAVOURITES : EMPTY_LIST;

  const rows: string[] = [];
  for (let row = 0; row < layout.contentHeight; row += 1) {
    const index = view.listOffset + row;
    const recipe = view.recipes[index];
    if (!recipe) {
      // A pane holding nothing says so on its first row, rather than reading as
      // a list still loading: a filter that matches no recipe is a state the
      // cook can put themselves in, and it should explain itself.
      rows.push(
        row === 0 && view.recipes.length === 0
          ? styles.dim(fit(`  ${empty}`, layout.listWidth))
          : ' '.repeat(layout.listWidth),
      );
      continue;
    }

    const isSelected = index === view.selected;
    const badge =
      badgeWidth === 0
        ? ''
        : recipe.authorship === 'llm'
          ? ` ${LLM_BADGE}`
          : ' '.repeat(badgeWidth);
    const mark =
      markWidth === 0 ? '' : recipe.favourite ? `${FAVOURITE_MARK} ` : ' '.repeat(markWidth);
    const text = fit(`${isSelected ? '›' : ' '} ${mark}${recipe.name}`, nameWidth) + badge;
    if (!isSelected) {
      rows.push(text);
    } else {
      rows.push(view.focus === 'list' ? styles.selected(text) : styles.unfocusedSelected(text));
    }
  }
  return rows;
}

function previewRows(view: ViewModel, layout: Layout, color: boolean): string[] {
  const rows: string[] = [];
  for (let row = 0; row < layout.contentHeight; row += 1) {
    const line = view.previewLines[view.previewOffset + row] ?? [];
    rows.push(paint(fitStyled(line, layout.previewWidth), color));
  }
  return rows;
}

/** The overlay is inset from the panes, and no wider than this. */
const OVERLAY_MAX_WIDTH = 60;
const OVERLAY_MARGIN = 4;
const MIN_OVERLAY_WIDTH = 14;
/** Rows of typed text kept on screen; past this the earliest ones scroll off. */
const OVERLAY_TEXT_ROWS = 4;
/** Stands in for the terminal cursor, which stays hidden while the TUI runs. */
const CURSOR = '█';

/**
 * Lays the overlay over the content rows it covers, keyed by row index.
 *
 * Each covered row is rebuilt whole, from the left pane edge to the right one,
 * rather than spliced into the painted panes underneath — a splice would have to
 * cut a string mid-escape-sequence and would bleed one row's colour into the box.
 */
function overlayRows(
  overlay: OverlayViewModel,
  layout: Layout,
  styles: Styles,
): Map<number, string> {
  // The divider column belongs to the overlay too, so the box can sit astride it.
  const inner = layout.listWidth + layout.previewWidth + 1;
  const width = Math.min(
    Math.max(inner - OVERLAY_MARGIN * 2, MIN_OVERLAY_WIDTH),
    OVERLAY_MAX_WIDTH,
    inner,
  );
  // Two border columns and a space of padding on each side.
  const textWidth = Math.max(width - 4, 1);

  // The cursor rides at the end of the text, so it also wraps with it — and it
  // keeps a trailing space the user typed from being trimmed away.
  const typed = wrapStyled(styled(`${overlay.typed}${CURSOR}`), textWidth).slice(-OVERLAY_TEXT_ROWS);
  const body = [
    ...typed.map((line) => fit(plainText(line), textWidth)),
    styles.dim(fit(overlay.hint, textWidth)),
  ];

  const edge = styles.focusedBorder;
  const box = [
    edge('┌') + titledBorder(overlay.title, width - 2, edge, styles) + edge('┐'),
    ...body.map((line) => `${edge('│')} ${line} ${edge('│')}`),
    edge('└') + edge('─'.repeat(width - 2)) + edge('┘'),
  ];

  const top = Math.max(Math.floor((layout.contentHeight - box.length) / 2), 0);
  const left = Math.max(Math.floor((inner - width) / 2), 0);
  const pad = (count: number): string => ' '.repeat(Math.max(count, 0));

  const covered = new Map<number, string>();
  box.forEach((row, index) => {
    // A terminal too short for the whole box shows as much of it as fits.
    if (top + index < layout.contentHeight) {
      covered.set(top + index, pad(left) + row + pad(inner - left - width));
    }
  });
  return covered;
}

/**
 * Key hints from fullest to sparsest; the first set that fits is the one shown.
 *
 * There are more keys than a narrow terminal has room for, and a truncated line
 * loses whichever hints come last — including how to quit. So instead of one
 * string that gets cut, each set drops the keys a cook is least likely to need
 * spelled out, and the last one is short enough for anything sane.
 */
const KEY_HINTS = [
  '↑↓ move · tab pane · -/+ persons · n note · r remix · d delete · a add · s list · o sort · f fav · F only · c copy · q quit',
  '↑↓ move · tab · -/+ persons · n note · r remix · d del · a add · s list · o sort · f fav · F only · c copy · q quit',
  '↑↓ move · tab · n note · r remix · d del · a add · s list · o sort · f fav · F only · c copy · q quit',
  '↑↓ move · n note · r remix · d del · c copy · q quit',
  '↑↓ move · n note · d del · q quit',
];

/** The shopping list is the only one-pane screen, so it owns the panel hints. */
const SHOPPING_KEY_HINTS = '↑↓ scroll · s recipes · c copy · q quit';

/** The fullest hints that fit in `width` columns, else the sparsest set. */
function keyHints(width: number): string {
  return KEY_HINTS.find((hints) => hints.length <= width) ?? KEY_HINTS.at(-1)!;
}

/** The bottom row: hints or a message on the left, a position on the right. */
function statusRow(text: string, position: string, width: number, styles: Styles): string {
  const left = fit(` ${text}`, Math.max(width - position.length - 1, 0));
  return styles.dim(left) + styles.dim(position) + ' ';
}

function statusLine(view: ViewModel, layout: Layout, styles: Styles): string {
  const total = view.recipes.length;
  const position = total > 0 ? `${view.selected + 1}/${total}` : '0/0';
  const width = layout.listWidth + layout.previewWidth + 3;

  // What `statusRow` will leave for the text, minus the space it prefixes.
  const room = width - position.length - 2;
  return statusRow(view.status ?? keyHints(room), position, width, styles);
}

/** A screen that is one full-width pane, such as the shopping list. */
export interface PanelViewModel {
  /** Inlaid in the top border. */
  title: string;
  /** Content, already wrapped to the panel width. */
  lines: readonly StyledLine[];
  offset: number;
  /** Transient message shown in place of the key hints. */
  status?: string;
}

/** Renders a one-pane screen as one line per terminal row. */
export function renderPanel(view: PanelViewModel, size: Size, color = true): string[] {
  const layout = computeLayout(size);
  const styles = color ? COLORED : PLAIN;
  const edge = styles.focusedBorder;

  const lines: string[] = [];
  lines.push(edge('┌') + titledBorder(view.title, layout.panelWidth, edge, styles) + edge('┐'));

  for (let row = 0; row < layout.contentHeight; row += 1) {
    const line = view.lines[view.offset + row] ?? [];
    lines.push(edge('│') + paint(fitStyled(line, layout.panelWidth), color) + edge('│'));
  }

  lines.push(edge('└') + edge('─'.repeat(layout.panelWidth)) + edge('┘'));

  // How far down the content the view has reached, only once it scrolls at all.
  const total = view.lines.length;
  const shown = Math.min(view.offset + layout.contentHeight, total);
  const position = total > layout.contentHeight ? `${shown}/${total}` : '';
  const hints = view.status ?? SHOPPING_KEY_HINTS;
  lines.push(statusRow(hints, position, layout.panelWidth + 2, styles));

  return lines;
}

/** Renders the whole screen as one line per terminal row. */
export function renderScreen(view: ViewModel, size: Size, color = true): string[] {
  const layout = computeLayout(size);
  const styles = color ? COLORED : PLAIN;
  const edge = (pane: Pane): Style =>
    view.focus === pane ? styles.focusedBorder : styles.border;

  const selected = view.recipes[view.selected];
  const listEdge = edge('list');
  const previewEdge = edge('preview');

  const lines: string[] = [];
  lines.push(
    listEdge('┌') +
      // Just the directory: the list pane is narrow, and a longer label would
      // be truncated away on a normal terminal. A filtered list says so here
      // instead, since which folder it came from matters less than the fact
      // that most of it is being held back.
      titledBorder(
        view.filtered ? FAVOURITES_TITLE : view.directory,
        layout.listWidth,
        listEdge,
        styles,
      ) +
      previewEdge('┬') +
      titledBorder(selected?.relativePath ?? 'no recipe', layout.previewWidth, previewEdge, styles) +
      previewEdge('┐'),
  );

  const left = listRows(view, layout, styles);
  const right = previewRows(view, layout, color);
  const overlay = view.overlay ? overlayRows(view.overlay, layout, styles) : undefined;
  for (let row = 0; row < layout.contentHeight; row += 1) {
    const covered = overlay?.get(row);
    lines.push(
      covered !== undefined
        ? listEdge('│') + covered + previewEdge('│')
        : listEdge('│') +
            (left[row] ?? '') +
            previewEdge('│') +
            (right[row] ?? '') +
            previewEdge('│'),
    );
  }

  lines.push(
    listEdge('└') +
      listEdge('─'.repeat(layout.listWidth)) +
      previewEdge('┴') +
      previewEdge('─'.repeat(layout.previewWidth)) +
      previewEdge('┘'),
  );
  lines.push(statusLine(view, layout, styles));

  return lines;
}
