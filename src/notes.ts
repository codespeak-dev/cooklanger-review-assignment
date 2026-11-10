/**
 * Writing notes back into a Cooklang file.
 *
 * A note is a line starting with `>`: Cooklang keeps it beside the steps rather
 * than as one of them, which is exactly what a remark jotted down while cooking
 * is. Notes go at the end of the file, so the method the author wrote is never
 * rearranged underneath them.
 */

import { readFile, writeFile } from 'node:fs/promises';

/** What makes a line a note rather than a step. */
const NOTE_MARKER = '> ';

/**
 * Backslashes what Cooklang would otherwise swallow.
 *
 * Two or more dashes in a row start a comment, so every dash in such a run is
 * escaped — which also defuses the `[-` that opens a block comment. A lone dash
 * ("2-3 cloves") is left as it was typed, so the file stays easy to read.
 */
function escapeNote(text: string): string {
  return text.replace(/-{2,}/g, (run) => run.replace(/-/g, '\\-'));
}

/** One note line, with the text flattened onto it. */
export function noteLine(text: string): string {
  return NOTE_MARKER + escapeNote(text.replace(/\s+/g, ' ').trim());
}

/**
 * Returns `source` with `text` appended as a note.
 *
 * The blank line before it is not cosmetic: a `>` line directly under a step is
 * read as more of that step, so without it the note would vanish into the
 * method instead of standing beside it.
 */
export function appendNote(source: string, text: string): string {
  const line = noteLine(text);
  const body = source.replace(/\s+$/, '');
  return body === '' ? `${line}\n` : `${body}\n\n${line}\n`;
}

/** Where the YAML front matter ends, or -1 when the file has none. */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') return index;
  }
  return -1;
}

/**
 * Returns `source` without its note lines.
 *
 * Front matter is left alone: a `>` there belongs to YAML, not to the cook.
 * Blank runs left behind by a removed note are collapsed, so a file that ended
 * in notes does not end in a stack of empty lines.
 */
export function stripNotes(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const end = frontMatterEnd(lines);

  const kept = lines.filter(
    (line, index) => index <= end || !line.trimStart().startsWith('>'),
  );

  return `${kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

/**
 * Appends a note to the file at `path`, returning the source as it now stands.
 *
 * The file is re-read rather than taken from any cached copy, so a recipe edited
 * elsewhere since it was last shown does not lose those edits to this note.
 */
export async function appendNoteToFile(path: string, text: string): Promise<string> {
  const updated = appendNote(await readFile(path, 'utf8'), text);
  await writeFile(path, updated, 'utf8');
  return updated;
}
