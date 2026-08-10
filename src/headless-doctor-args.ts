/**
 * Argument policy for `gsd headless doctor`.
 *
 * `parseHeadlessArgs` collects everything after the subcommand into
 * `commandArgs` — positionals directly, unrecognized flags through the
 * passthrough branch. The headless `doctor` branch only ever read `--json` from
 * that array, so every other argument was silently discarded: `gsd headless
 * doctor resolve-evidence --action=preserve` ran a plain scan and exited 1,
 * indistinguishable from "issues detected". Same for `fix`, `heal`, `audit`, a
 * scope, `--dry-run`, `--fix`, `--build` and `--test`, all of which the
 * interactive `/gsd doctor` accepts.
 *
 * Refusing is the correct answer rather than honouring them: this entrypoint is
 * a read-only diagnostic, and the alternative is a second mutating doctor
 * outside a TTY.
 *
 * Deliberately zero-import. `src/tests/headless-cli-surface.test.ts` documents
 * why it mirrors `parseHeadlessArgs` instead of importing it — `headless.ts`
 * pulls a transitive `@gsd/native` import that breaks under the test loader — so
 * this predicate lives on its own to be testable directly rather than becoming a
 * fourth mirrored copy. Mirrors the `headless-recover.ts` split, where the
 * behaviour is tested against the extracted module and the one-line dispatcher
 * if-block is covered by `build:core`.
 */

/** The only arguments `gsd headless doctor` can actually honour. */
const SUPPORTED_HEADLESS_DOCTOR_ARGS = new Set(['--json'])

/**
 * Arguments the headless doctor cannot honour, in the order they were given.
 * Empty means the invocation is fully supported.
 */
export function unsupportedHeadlessDoctorArgs(commandArgs: string[]): string[] {
  return commandArgs.filter(arg => !SUPPORTED_HEADLESS_DOCTOR_ARGS.has(arg))
}
