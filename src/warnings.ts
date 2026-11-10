/**
 * Silences the `ExperimentalWarning` Node emits when the Cooklang parser's WASM
 * module is imported. It is noise the user can do nothing about, and it would
 * otherwise appear on stderr on every single run.
 *
 * This module must be evaluated *before* anything imports `@cooklang/cooklang`,
 * so the parser is reached through a dynamic import (see `parser.ts`).
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const first = rest[0] as string | { type?: string } | undefined;
  const type = typeof first === 'string' ? first : first?.type;
  const message = typeof warning === 'string' ? warning : warning.message;
  if (type === 'ExperimentalWarning' && message.includes('WebAssembly')) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
