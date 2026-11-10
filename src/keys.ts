/**
 * Decodes raw terminal input into named keys.
 *
 * Only the sequences the browser reacts to are named; anything else comes back
 * as `{ name: 'char', value }` so callers can bind plain letters.
 */

const ESC = '\x1b';

export interface Key {
  name:
    | 'up'
    | 'down'
    | 'pageUp'
    | 'pageDown'
    | 'home'
    | 'end'
    | 'tab'
    | 'shiftTab'
    | 'enter'
    | 'backspace'
    | 'escape'
    | 'char';
  /** The literal character, for `char` keys. */
  value?: string;
}

/** Escape sequence bodies (the part after ESC), longest first. */
const SEQUENCES: ReadonlyArray<readonly [string, Key['name']]> = [
  ['[5~', 'pageUp'],
  ['[6~', 'pageDown'],
  ['[1~', 'home'],
  ['[4~', 'end'],
  ['[7~', 'home'],
  ['[8~', 'end'],
  ['[Z', 'shiftTab'],
  ['[A', 'up'],
  ['[B', 'down'],
  ['[H', 'home'],
  ['[F', 'end'],
  ['OA', 'up'],
  ['OB', 'down'],
  ['OH', 'home'],
  ['OF', 'end'],
];

/** Any CSI/SS3 sequence, used to swallow the ones we do not bind. */
const UNKNOWN_SEQUENCE = /^[[O][\d;]*[A-Za-z~]/;

export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  let at = 0;

  while (at < input.length) {
    const char = input[at] as string;

    if (char === ESC) {
      const body = input.slice(at + 1);
      const known = SEQUENCES.find(([sequence]) => body.startsWith(sequence));
      if (known) {
        keys.push({ name: known[1] });
        at += 1 + known[0].length;
        continue;
      }

      // Unbound sequences are dropped so their tail is not read as letters.
      const unknown = UNKNOWN_SEQUENCE.exec(body);
      if (unknown) {
        at += 1 + unknown[0].length;
        continue;
      }

      keys.push({ name: 'escape' });
      at += 1;
      continue;
    }

    if (char === '\t') {
      keys.push({ name: 'tab' });
      at += 1;
      continue;
    }

    // Terminals send either carriage return or newline for Return, and either
    // DEL or backspace for Backspace, depending on how they are configured.
    if (char === '\r' || char === '\n') {
      keys.push({ name: 'enter' });
      at += 1;
      continue;
    }

    if (char === '\x7f' || char === '\b') {
      keys.push({ name: 'backspace' });
      at += 1;
      continue;
    }

    keys.push({ name: 'char', value: char });
    at += 1;
  }

  return keys;
}
