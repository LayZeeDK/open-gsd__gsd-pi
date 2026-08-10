/**
 * Extract a human-readable message from an unknown caught value.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Flatten an error and its `cause` chain into a single message.
 *
 * Re-wrapping a caught error with only `.message` silently discards every
 * deeper layer, and the deepest layer is routinely the only actionable one --
 * the native projection lock throws `new Error("native projection root identity
 * locking failed", { cause })` where the cause carries the OS detail (`os error
 * 32 at createInitialProjectionDirectory`). Attach the original as `cause` AND
 * format with this, so the string a human reads and the chain a program walks
 * both stay intact.
 *
 * Generalizes the one-level `recoveryErrorMessage` in headless-recover.ts.
 *
 * `maxDepth` bounds an accidentally deep chain; `seen` stops a cyclic one, which
 * is reachable because `cause` is an ordinary writable property.
 */
export function getErrorMessageChain(err: unknown, maxDepth = 8): string {
  const layers: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < maxDepth; depth++) {
    if (current === null || current === undefined || seen.has(current)) {
      break;
    }

    seen.add(current);
    const message = getErrorMessage(current);
    if (message) {
      layers.push(message);
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return layers.join(": ");
}
