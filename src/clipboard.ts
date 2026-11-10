import { spawn } from 'node:child_process';

/**
 * Copies text to the system clipboard.
 *
 * A native helper is tried first, since it is what the desktop actually reads.
 * When none exists — a bare container, or an SSH session where the clipboard
 * lives on the *other* machine — we fall back to OSC 52, which asks the
 * terminal emulator itself to do the copy.
 */

interface Helper {
  command: string;
  args: string[];
}

function helpersFor(platform: NodeJS.Platform): Helper[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip', args: [] }];
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

/** Resolves false when the helper is missing or exits non-zero. */
function runHelper(helper: Helper, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(helper.command, helper.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    // A closed pipe surfaces as an 'error' on the child; ignore it here.
    child.stdin.on('error', () => finish(false));
    child.stdin.end(text, 'utf8');
  });
}

/**
 * Terminals commonly cap OSC 52 payloads, and the sequence has to survive the
 * terminal's input buffer, so oversized recipes are not worth attempting.
 */
const OSC52_LIMIT = 100_000;

function copyViaTerminal(text: string, out: NodeJS.WriteStream): boolean {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  if (encoded.length > OSC52_LIMIT) return false;
  out.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

export interface CopyResult {
  copied: boolean;
  /** Which mechanism did it, for the status line. */
  via?: 'helper' | 'terminal';
}

export async function copyToClipboard(
  text: string,
  options: { platform?: NodeJS.Platform; out?: NodeJS.WriteStream } = {},
): Promise<CopyResult> {
  const platform = options.platform ?? process.platform;
  const out = options.out ?? process.stdout;

  for (const helper of helpersFor(platform)) {
    if (await runHelper(helper, text)) return { copied: true, via: 'helper' };
  }

  if (copyViaTerminal(text, out)) return { copied: true, via: 'terminal' };
  return { copied: false };
}
