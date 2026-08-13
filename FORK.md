# Maintaining this fork

How this fork is built, how the global `gsd` command reaches it, and how to move
it onto a new upstream release tag.

For *what* each patch fixes, see [PATCHES.md](PATCHES.md). This file is only
about the mechanics.

- [Layout](#layout)
- [How the global `gsd` command is linked](#how-the-global-gsd-command-is-linked)
- [Rebuilding](#rebuilding)
- [The Claude Agent SDK bump](#the-claude-agent-sdk-bump)
- [Rebasing onto a new upstream tag](#rebasing-onto-a-new-upstream-tag)
- [When a patch redefines a shared value](#when-a-patch-redefines-a-shared-value)
- [Expected test failures](#expected-test-failures)

## Layout

| | |
| --- | --- |
| Working branch | `LayZeeDK/dev` -- the patches, one dependency bump, and `docs:`/`chore:` commits, with `PATCHES.md` last |
| Base | an upstream release tag, currently **`v1.15.0`** (`95f8c3fb`) |
| Remotes | `origin` = `LayZeeDK/open-gsd__gsd-pi`, `upstream` = `open-gsd/gsd-pi` |
| `main` | tracks upstream; not where the patches live |

`main` is not the base on purpose: it is a moving branch, and basing on the tag
keeps the fork pinned to a released version. At the v1.15.0 rebase `main` and
`v1.15.0` happened to be the same commit, so the distinction cost nothing that
time -- do not read that coincidence as a reason to base on `main` next time.

Find the current base at any time:

```bash
git describe --tags --abbrev=0 $(git merge-base LayZeeDK/dev upstream/main)
```

## How the global `gsd` command is linked

`gsd` is **not** an installed copy. `npm link` puts a symlink in the npm global
prefix that points at this working tree, so the branch you have checked out is
the `gsd` you run.

```
C:\Users\<you>\.local\bin\gsd            <- shim (also gsd.cmd, gsd.ps1)
        `-> node_modules\@opengsd\gsd-pi <- SYMLINK to this repo
                `-> dist\loader.js       <- the "gsd" bin entry, built output
```

Two consequences worth internalising:

- **Switching branches switches your `gsd`.** There is no separate install to
  update.
- **The shim runs `dist/`, not `src/`.** Editing TypeScript changes nothing until
  you rebuild. This is the single most common way to be confused by a change that
  "did not take effect".

Verify the link:

```bash
npm ls -g --depth=0 | rg opengsd     # expect: @opengsd/gsd-pi@... -> ...\open-gsd__gsd-pi
gsd --version
```

Set it up once (only needed on a fresh machine, or after an `npm uninstall -g`):

```bash
npm uninstall -g @opengsd/gsd-pi     # remove any published copy first
npm link                             # from this repo root
```

Leave the separate global `@opengsd/gsd-browser` install alone -- it is a real
package, not part of this fork.

To go back to the published package: `npm uninstall -g @opengsd/gsd-pi && npm install -g @opengsd/gsd-pi`.
Note that on win32-arm64 the published package has the problems this fork exists
to fix, so expect the old symptoms back.

## Rebuilding

### After changing TypeScript

```bash
pnpm run build:core
```

This is the one you want almost always. It builds the workspace packages, runs
`tsc`, and copies resources into `dist/`. `pnpm run build` additionally builds
the web UI, which the CLI does not need.

### After changing Rust, or on a fresh clone

```bash
pnpm run build:native
```

Writes `native/addon/gsd_engine.<platform>.node` -- on this host,
`gsd_engine.win32-arm64.node`. **This is why the fork needs no cached native
addon:** npm publishes no `@opengsd/engine-win32-arm64-msvc`, so an installed
copy has no arm64 engine, while a local build simply produces one.

### Running the test suite un-links the native addon

**Symptom.** The linked `gsd` prints `Native addon not available for win32-arm64.
Falling back to JS implementations (slower)` and lists only `darwin-*`,
`linux-*`, `win32-x64` as supported -- even though
`native/addon/gsd_engine.win32-arm64.node` exists and loads fine when `require`d
directly.

**Cause.** `pnpm run test:compile` -- which `test:unit` and therefore `verify:pr`
both run -- repoints every `node_modules/@gsd/*` symlink at
`dist-test/packages/*`. `packages/native/src/native.ts` computes

```js
const addonDir = path.resolve(_dirname, "..", "..", "..", "native", "addon")
```

which is correct from `packages/native/dist/` (three levels up is the repo root)
but resolves to a nonexistent `dist-test/native/addon` once the package is
reached through the mirrored tree. The local-build load silently fails, no
`@opengsd/engine-win32-arm64-msvc` exists to fall back to, and the loader returns
the throw-on-call proxy.

**Fix.** Re-run the project's own linker, which relinks any symlink whose target
is wrong and is safe to run repeatedly:

```bash
node scripts/link-workspace-packages.cjs     # "Linked 10 workspace packages"
```

**Do NOT reach for `pnpm install` to fix this.** On win32-arm64 it aborts on the
`@opengsd/gsd-browser` postinstall (`unsupported platform win32-arm64`) and dies
*before* repairing the links, leaving them exactly as broken as it found them.

**Run the linker after any `test:unit` / `verify:pr` / `test:compile`**, or the
`gsd` you go on to use is silently running JS fallbacks. The JS fallback is
functional -- stateful commands still work, contradicting the older claim here
that they fail with `native directory durability is unavailable` -- so nothing
crashes to tell you. What *is* lost is the native projection lock, so anything
depending on it (patch 12's `os error 32`) cannot reproduce until you relink.

### Full setup from a fresh clone

```bash
git switch LayZeeDK/dev
pnpm install --frozen-lockfile
pnpm run secret-scan:install-hook    # CONTRIBUTING one-time setup
pnpm run build:native
pnpm run build:core
npm link
```

`dist/`, `dist-test/`, `packages/*/dist/` and `native/addon/` are all gitignored,
so a fresh clone has none of them.

### Running tests

Whole-package suites:

```bash
pnpm --filter @opengsd/mcp-server run test
```

A single extension test, without a full compile:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test src/resources/extensions/gsd/tests/<name>.test.ts
```

Gate before pushing:

```bash
pnpm run verify:pr        # build:core + typecheck:extensions + test:unit + lifecycle gate
```

> `pnpm run typecheck:extensions` requires a completed `build:core` first.
> Run it on a tree that has never been built and it reports hundreds of
> `Cannot find module '@gsd/*'` errors that are not real.

> **After running any test target, re-run `node scripts/link-workspace-packages.cjs`.**
> `test:compile` repoints `node_modules/@gsd/*` into `dist-test/`, which silently
> costs the linked `gsd` its native addon. See
> [Running the test suite un-links the native addon](#running-the-test-suite-un-links-the-native-addon).

> **`verify:pr` does not pass on this host, and did not before the fork.** See
> [Expected test failures](#expected-test-failures) -- treat it as a comparison
> against a measured baseline, not a pass/fail gate.

## The Claude Agent SDK bump

This branch pins `@anthropic-ai/claude-agent-sdk` at **`0.3.229`**, up from
upstream's exact `0.2.83`. Why, and the measurements behind it, are in
[PATCHES.md](PATCHES.md#the-sdk-bump-0283---03229). The mechanics that affect
day-to-day work here:

### Installing

`pnpm install` aborts on the `@opengsd/gsd-browser` postinstall
(`unsupported platform win32-arm64`) *before* it repairs anything, so:

```bash
pnpm install --ignore-scripts
node scripts/link-workspace-packages.cjs
```

`--ignore-scripts` is the shape `verify:fast` already uses, and it does not
affect the platform binary -- the SDK packages declare no `scripts` and the
platform packages are pure payload.

Validate the lockfile the way CI does before pushing, with the regenerated
lockfile staged:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

`.github/workflows/ci.yml` uses `--frozen-lockfile` in four jobs and `verify:fast`
uses it too. A plain install *regenerates* rather than validates, so a stale or
unstaged lockfile passes locally and then fails every CI job with
`ERR_PNPM_OUTDATED_LOCKFILE`.

### The install got much bigger, everywhere

0.3.x ships no `cli.js`. The CLI is a platform `optionalDependency` -- on this
host `@anthropic-ai/claude-agent-sdk-win32-arm64`, whose `claude.exe` is
**296,566,432 bytes** (~283 MiB) at 0.3.229. Re-measure it at each bump rather
than carrying the figure forward; it was 286,900,384 at 0.3.227. An arm64 build exists, unlike `@opengsd/gsd-browser`.

**This is not a this-host-only cost.** The platform package is a transitive
optional dependency, so the matching linux-x64 build also lands on every CI
runner and inside the Docker image (`Dockerfile`), regardless of whether
`pathToClaudeCodeExecutable` is passed.

### Which `claude` binary actually runs

The SDK's own, version-locked -- **not** the one on your PATH. `stream-adapter.ts`
no longer passes `pathToClaudeCodeExecutable`; the SDK resolves the platform
package itself. That is deliberate: it is what makes elicitation behaviour
deterministic instead of a function of whatever `claude` version the developer
happens to have installed.

Two things follow:

- **`--omit=optional` installs have no fallback.** They used to degrade to
  `claude.cmd` from PATH; now they get
  `Native CLI binary for <platform>-<arch> not found. Reinstall
  @anthropic-ai/claude-agent-sdk without --omit=optional, or set
  options.pathToClaudeCodeExecutable.`
- **`readiness.ts` is still about your PATH `claude`**, and that is correct --
  install and auth state is a separate question from which binary the SDK
  executes. Do not "fix" the apparent inconsistency.

Auth is unaffected either way: it comes from `~/.claude` credentials, not the
binary.

### Re-run the options diff at every SDK bump

`buildSdkOptions` returns `Record<string, unknown>`, so a renamed or dropped
`query` option fails **silently** -- the unit tests assert on the object gsd-pi
*builds*, not on what the SDK consumes, and nothing else covers it. Diff the
`Options` type in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` against
the keys `buildSdkOptions` sets, and record the result in the commit message.

At 0.3.229 all **15** keys `buildSdkOptions` sets are present in the 64-key
`Options` type; 0 removed, 0 renamed. The type is byte-identical to 0.3.227's.

> **Count the keys from the code, not from this file.** An earlier revision of
> both this doc and the bump's commit message claimed "all 28 keys". The return
> literal sets 15 static keys plus the caller-supplied `...sdkExtraOptions`
> passthrough, whose members are not statically knowable; 28 was never
> reproducible. When you re-run the diff, extract the keys from the `return {`
> literal in `buildSdkOptions` -- including the SHORTHAND members
> (`permissionMode,` `settingSources,` `disallowedTools,`) and the conditional
> spreads, which a naive `key:` scan misses -- rather than trusting the number
> recorded here.

### Verifying the client advertises elicitation

The whole point of the bump. Measure it on the wire rather than trusting the
version number, and never by asserting the *absence* of a new
`elicitation-failed` line in `~/.gsd/diagnostics.jsonl` -- that is also what a
silently-failed bump looks like.

Point a stub stdio MCP server that records the `initialize` params it receives at
an isolated `CLAUDE_CONFIG_DIR`, then run `claude mcp list`: the health check
performs a real handshake with no model and no tokens. Expect

```json
{"protocolVersion":"2025-11-25",
 "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
 "clientInfo":{"name":"claude-code","version":"2.1.229", ...}}
```

Under 0.2.83 the same probe yields `{"roots":{}}` -- no elicitation key at all.

Two mechanics the probe needs, both learned by getting them wrong first:

- **`claude mcp list` has no `--mcp-config` flag** (`error: unknown option`).
  Register the stub with `claude mcp add probe --scope user -- node <stub>` under
  the isolated `CLAUDE_CONFIG_DIR`, then run `claude mcp list`.
- **Probe the SDK's OWN binary**, not the one on PATH:
  `node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe`. That is
  what `stream-adapter.ts` actually executes, and it is the whole point of the
  bump. A PATH `claude` that happens to match the version proves nothing.

## Rebasing onto a new upstream tag

Patches are written to be cherry-pickable, so a rebase is the normal way to move
forward. The convention that matters: **`PATCHES.md` stays the last commit**, so
cherry-picking a patch upstream never drags a fork-only file with it.

### 1. Fetch and pick the target

```bash
git fetch upstream --tags
git tag -l 'v*' --sort=-v:refname | head -5
```

### 2. Replay the branch

```bash
git switch LayZeeDK/dev
git branch backup/pre-<newtag> LayZeeDK/dev        # cheap escape hatch
git rebase --onto <newtag> <current-base-tag> LayZeeDK/dev
```

`--onto` is deliberate: it replays only the fork's own commits onto the new tag,
rather than trying to merge two histories.

If a rebase leaves you on a detached HEAD (it can, when the branch ref is not
updated automatically), reattach before doing anything else:

```bash
git branch -f LayZeeDK/dev HEAD && git switch LayZeeDK/dev
```

### 3. Resolve conflicts by re-deriving, not by re-applying

Every patch targets code upstream is actively changing. When a hunk conflicts,
read the new upstream code and ask whether the defect still exists, rather than
forcing the old diff back in. Three outcomes, all normal:

- **Still broken** -- re-derive the fix against the new code, keep the test.
- **Fixed upstream** -- drop the commit and record it in `PATCHES.md`. This has
  already happened once: `detectStaleRenders` was stubbed in v1.13.0 and was
  fixed by v1.14.0.
- **Restructured** -- the defect moved. Follow it; the test tells you when you
  have it right.

**A fourth outcome, and the one that costs most to miss: the defect is gone but
the patch still applies.** A hunk that merges cleanly is not evidence it is still
needed. At the v1.15.0 rebase, half of patch 4 replayed without a murmur while
upstream had quietly (a) closed the writer the patch blamed, (b) added a test
asserting the OPPOSITE contract, and (c) added two new consumers that assumed the
old semantics. The clean merge is exactly why nobody looked. See
[When a patch redefines a shared value](#when-a-patch-redefines-a-shared-value).

Known churn to expect at the next rebase:

- **Patch 12** touches `task-completion-compatibility-adapter.ts`. The v1.14.0
  edition of this list predicted churn there from `63254779`, `2e4ca77f` and
  `3037a37c`; **it did not materialise** -- that file and
  `packages/mcp-server/src/server.ts` were byte-identical across v1.14.0..v1.15.0
  and patch 12's rewrite landed clean. Treat the prediction as still open rather
  than as a standing fact.
- **The projection family is the live churn.** v1.15.0 restructured
  `markdown-renderer.ts` (sha computation moved from flush time to write time),
  renamed `detectExternalMarkdownEdit` to `observeExternalMarkdownEdits`, and
  added `projection-observation.ts`, `projection-mutation-guard.ts`,
  `projection-content-hash.ts` and `projection-worker.ts`. Anything touching
  projection shas or the compat marker will keep meeting new consumers here.
- **`database-maintenance-fence.ts`** -- upstream rewrote `projectionDatabasePath`
  once already (hoisting `basename(...)` into `const name`, adding a `.planning`
  branch). Patch 3 inserts into that exact gap.
- **The SDK bump is not a patch and does not rebase like one.** If the new
  upstream tag already pins a `0.3.x` agent SDK, drop the bump commit and keep
  only whatever `stream-adapter.ts` change is still needed; if upstream is still
  on `0.2.x`, re-derive the version rather than replaying the old
  `pnpm-lock.yaml` diff. Re-run the options diff either way.
- **Re-check the SDK dist-tags at the moment you rebase, not from the plan.** The
  v1.15.0 plan specified `0.3.228` because `0.3.229` was `next`; by execution day
  `0.3.229` had been promoted to `latest` and the recorded rationale was stale.

### rerere will answer conflicts for you, and it can be wrong

`rerere.enabled` is `true` in this repo, so a conflict resolved in a trial rebase
is replayed silently in the real one -- the only trace is a
`Resolved '<file>' using previous resolution.` line in the rebase output. It is a
genuine time-saver across the five conflicts this fork hits, but **the replayed
resolution is not reviewed by anything**. At the v1.15.0 rebase it dropped a
five-line explanatory comment from patch 3's hunk while producing otherwise
correct code, which no test could have caught.

Read every rerere-resolved hunk against `git show <original-commit> -- <file>`
before staging it.

To drop a commit during the rebase, `git rebase --skip`. To drop one afterwards:

```bash
git rebase --onto <commit-before-it> <the-commit-to-drop> LayZeeDK/dev
```

### 4. Rebuild and re-verify

```bash
pnpm install --frozen-lockfile   # upstream may have changed dependencies
pnpm run build:native            # only if native/ changed upstream
pnpm run build:core
pnpm --filter @opengsd/mcp-server run test
pnpm run verify:pr
```

Then re-run each patch's own tests. They are the actual acceptance criteria for
the rebase -- a patch whose test passes on the new base survived the move:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test \
     src/resources/extensions/gsd/tests/milestone-id-utils.test.ts \
     src/resources/extensions/gsd/tests/external-state-projection-root.test.ts \
     src/resources/extensions/gsd/tests/external-markdown-edit.test.ts \
     src/resources/extensions/gsd/tests/compat-health-line.test.ts \
     src/resources/extensions/gsd/tests/projection-cleanup.test.ts \
     src/resources/extensions/gsd/tests/verification-gate.test.ts \
     src/resources/extensions/gsd/tests/normalize-ask-user-questions.test.ts \
     src/resources/extensions/gsd/tests/validate-milestone-prompt-contract.test.ts \
     src/resources/extensions/gsd/tests/worktree-root.test.ts \
     src/resources/extensions/gsd/tests/doctor-scope-db-unavailable.test.ts \
     src/resources/extensions/gsd/tests/task-completion-compatibility-adapter.test.ts \
     src/resources/extensions/gsd/tests/error-utils.test.ts \
     src/resources/extensions/gsd/tests/register-hooks-gate-rollback.test.ts \
     src/resources/extensions/gsd/tests/write-gate-seam.test.ts \
     src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts \
     src/resources/extensions/gsd/tests/plan-milestone-artifact-verification.test.ts \
     src/tests/headless-doctor-args.test.ts \
     src/resources/extensions/gsd/tests/derive-state-db.test.ts \
     src/resources/extensions/gsd/tests/state-projection-scoped-write.test.ts \
     src/resources/extensions/gsd/tests/safety-evidence-block-recovery-1641.test.ts \
     src/resources/extensions/gsd/tests/recovery-policy.test.ts \
     src/resources/extensions/gsd/tests/auto-recovery.test.ts \
     src/resources/extensions/gsd/tests/task-recovery-resume-diagnosis.test.ts
```

> The last four arrived with patches 18 and 19. Patch 18 redefines a shared
> value -- the recovery `action` an evidence contradiction routes -- so per
> [When a patch redefines a shared value](#when-a-patch-redefines-a-shared-value)
> the list carries the upstream suites that exercise it, not just the fork's own
> tests. `auto-recovery.test.ts` is on the list for exactly that reason: patch 18
> changes what `readTerminalTaskRecoveryAbort` returns on a first strike, which
> is a second subsystem the patch does not otherwise touch. It also carries one
> pre-existing failure on this host, `plan-slice artifact resolution handles
> lowercase unit IDs against uppercase paths` -- measured 86 of 89 on both the
> patched tree and a clean one.
>
> Also worth running after any change to this family, though not on the list:
> `auto-loop.test.ts` (121 of 129 on this host, identical clean and patched),
> `auto-task-execution-cutover.test.ts`, `auto-verification.test.ts` and
> `custom-task-host-verification.test.ts` (all clean).

Patch 15 also lands a case in the `claude-code-cli` tree, which the
`resolve-ts.mjs` hook resolves fine despite shipping under `gsd/tests/`:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test \
     src/resources/extensions/claude-code-cli/tests/stream-adapter.test.ts
```

> That suite carries one pre-existing failure on this host,
> `buildSdkOptions prefers workflow MCP question tools over native
> AskUserQuestion`, asserting `/tmp/project` against `C:\tmp\project`. Baseline
> it; 1 of 205 is the expected shape.

Patch 14 also lands cases in `packages/mcp-server/src/mcp-server.test.ts`, which
that package's own suite runs:

```bash
pnpm --filter @opengsd/mcp-server run test
```

> That script runs a **hardcoded** `node --test dist/...` file list in
> `packages/mcp-server/package.json`. A new test file not added to that list
> silently never runs, and the command still goes green.

The linked global `gsd` needs nothing after a rebase -- the symlink points at the
tree, not at a commit -- but it *does* need the rebuild above, or you will be
running the previous base's `dist/`.

### 5. Update the record

Rewrite `PATCHES.md`: the base tag at the top, the commit hashes in the table
(they all change in a rebase), and anything that turned out to be fixed upstream.
Amend the tip commit rather than adding a new one, so the doc stays last.

### House rules that survive a rebase

- Conventional Commits; types `feat fix docs chore refactor test infra ci perf build revert`.
- **Never bump version surfaces** -- `package.json`, `native/Cargo.toml`,
  `native/npm/*/package.json`. CONTRIBUTING reserves those for releases.
- `node:test` + `node:assert/strict` only; no new Vitest or Jest.
- No source-grep tests. CI enforces this via `scripts/check-source-grep-tests.sh`.
- One commit per patch, its tests included. Two standing exceptions: the
  elicitation work is split across a `test(mcp-server):` commit and its `feat:`
  commit, and the `docs:`/`chore:` commits are interleaved rather than all last
  -- only `PATCHES.md` is guaranteed to be the final commit.

## When a patch redefines a shared value

The most expensive class of fork patch is the one that changes what a value
*means* rather than fixing a computation. Patch 4 is the worked example: it made
the `.gsd` compat-marker sha mean "sha of the STRIPPED bytes" where upstream
means "sha of the exact rendered bytes".

Such a patch is only as correct as the set of consumers it updates, and **that
set grows upstream between rebases, silently and without conflicts**. At v1.15.0
patch 4 replayed with one ordinary conflict, and was nonetheless wrong in three
new places that did not exist at v1.14.0:

| new at v1.15.0 | consequence of the redefinition |
| --- | --- |
| `projection-observation.ts:161` | re-read guard mismatched, so a hand-edited stamped projection was **never quarantined** -- silent data loss on the `/gsd sync` path |
| `projection-mutation-guard.ts:95` | "matches baseline" short-circuit never fired, so **every** managed `.gsd` write dropped a quarantine copy nothing prunes |
| `gsd-rebuild.test.ts` "projection baselines retain the exact rendered intent" | upstream test asserting the raw contract outright |

Procedure when you carry, or are tempted to write, a patch of this shape:

1. **Enumerate the consumers on the NEW base, not from the patch's own notes.**
   `git grep -n` the value's producer and every reader. The patch's site list was
   accurate for the base it was written on and is not evidence about this one.
2. **Ask whether the defect still exists before re-deriving the fix.** For patch 4
   it did not: `stampProjectionContent` and `recordProjectionWrite` are each
   called from exactly one place, both inside `writeAndStore`, on the same bytes,
   so nothing can produce a stamp-only mismatch. The surviving PLAN.md drift is a
   **content** difference between two renderers (measured: 170 bytes against 366),
   which stripping never addressed -- the health line reports it either way.
3. **An upstream test asserting the opposite contract is a decision point, not a
   nuisance.** Editing it makes the fork carry a test delta forever and every
   future consumer breaks again. Prefer withdrawing the redefinition.
4. **Measure both directions before choosing.** Drive the real functions under
   each variant and compare; do not reason it. The reasoned prediction here
   ("reverting re-opens phantom PLAN.md drift") was measured and found FALSE.

The v1.15.0 outcome: patch 4 kept the two read-side comparisons that are still
justified (`formatCompatHealthLine`, `removeOwnedPlanProjection` -- the latter
proven by measurement: reverting it strands plan files) and withdrew the two that
redefined the shared value. `markdown-renderer.ts` and `external-markdown-edit.ts`
are byte-identical to upstream again.

**Corollary for the acceptance list.** It gates the patches, not the code they
touch. All three defects above sat outside it, and `gsd-rebuild.test.ts` -- which
pins the contract patch 4 changes -- was never on it. When a patch redefines a
shared value, add the upstream suites that exercise that value to the list.

## Expected test failures

This tree carries failures that predate the fork. Baseline them before treating
a red test as something you broke.

**Every count below was measured 2026-08-13 on win32-arm64, on the v1.15.0 base
at patch 17 with the SDK at 0.3.229.** The whole section was re-measured for that
rebase; no figure is carried forward from the v1.14.0 edition.

### Per-patch acceptance suites

The 19-suite list runs **418** cases. Over four consecutive runs with no code
change: **417 / 414 / 414 / 415**, i.e. 1 to 4 failures varying with nothing but
the run.

Exactly one failure is deterministic -- the `chmodSync` ROADMAP-divergence test
named below. Everything else is projection-lock contention, which moves between
`task-completion-compatibility-adapter.test.ts` and
`workflow-tool-executors.test.ts` depending on process co-scheduling. Measured
alone, both go green: `task-completion-compatibility-adapter.test.ts` at 36/36,
35/36, 36/36 over three runs, and `workflow-tool-executors.test.ts` clean.

**A single red run of this list proves nothing -- repeat it**, and re-run a suspect
suite alone before attributing anything to your change.

| target | result |
| --- | --- |
| 19-suite acceptance list | 417 / 414 / 414 / 415 of **418** |
| `claude-code-cli/tests/stream-adapter.test.ts` | **204 of 205** |
| `pnpm --filter @opengsd/mcp-server run test` | **250 of 250** (2 skipped) |
| `gsd-rebuild.test.ts` | **10 of 11** |

The stream-adapter failure is the long-standing
`buildSdkOptions prefers workflow MCP question tools over native AskUserQuestion`,
asserting `/tmp/project` against `C:\tmp\project`.

`gsd-rebuild.test.ts` is **not** on the acceptance list but is worth running after
any projection change -- it pins the compat-marker contract (see
[When a patch redefines a shared value](#when-a-patch-redefines-a-shared-value)).
Its one failure, `trusted marker baselines do not misclassify pending DB renders`,
is pre-existing: it fails identically with patch 4's write-side hunks applied and
reverted, so it is not the fork's.

> The count moved 396 -> 418 across the v1.15.0 rebase: **+14** from upstream's
> own additions to these suites, **-1** for the obsolete
> `detect ignores a stamp-only difference against the marker baseline` withdrawn
> with patch 4's write-side hunks, and **+9** from patch 7 pinning the full
> verificationEvidence field set (its parameterised loop went 4 -> 12 fields,
> plus one new standalone case). 396 + 14 - 1 + 9 = 418, so every delta is
> accounted for rather than inferred.
>
> An intermediate reading of **411** appears in this session's notes; it is not a
> waypoint in that arithmetic. It was measured while a compat-health-line case
> existed that was later withdrawn with the same write-side hunks, so the file is
> back to its pre-rebase 9 cases. Reconcile against the tree, not against a
> number recorded mid-flight.

### Whole suite (`test:unit`, what `verify:pr` runs)

Both rows measured on one tree in one sitting, differing only by reverting the
fork's `src/` and `packages/` files to `v1.15.0`:

| tree | passed | failed | skipped |
| --- | --- | --- | --- |
| `v1.15.0` source, fork files reverted | 2927 | **1126** | 13 |
| `LayZeeDK/dev` at patch 17 + SDK 0.3.229 | 2950 | **1128** | 13 |

**Treat this column as nearly useless for judging new work on this host.** Under
`test:unit:compiled` the overwhelming majority of suites fail wholesale on one
pre-existing loader problem:

```
ERR_UNSUPPORTED_ESM_URL_SCHEME
Only URLs with a scheme in: file, data, and node are supported by the default
ESM loader. On Windows, absolute paths must be valid file:// URLs.
Received protocol 'd:'
```

Because those suites never execute, the totals barely respond to real changes:
the v1.15.0 rebase removed two tests, added nine, and rewrote two comparison
sites, and the patched row did not move at all. Judge new tests with the
strip-types runner instead.

**`verify:pr` cannot be used as a pass/fail gate on this host** -- upstream
`v1.15.0` alone fails 1126. Compare against the measured baseline row, and
re-measure both rows after every rebase.

> **Do not record a projected baseline, and do not treat an un-remeasured one as
> fact.** A previous revision carried a *projected* ~2932 against a measured
> 2924, and chasing the gap cost real time. Measure both rows on one tree, in one
> sitting, or record nothing.

### Path and projection suites

The `worktree|paths|projection|doctor|markdown-renderer|external-state` family,
measured with the strip-types runner on source:

| tree | suites | tests | failed |
| --- | --- | --- | --- |
| upstream `v1.15.0` | 126 | 855 | **142** |
| `LayZeeDK/dev` | 129 | 874 | **90** |

The fork repairs 52 of these, almost all from patch 9's Windows path-comparison
fix. This is the one column where the fork's effect is legible.

### Per-suite

Known-bad tests worth naming so they are not re-diagnosed:

- **`checkEngineHealth retains ROADMAP divergence when projection repair remains
  stale`** cannot pass on Windows. It forces a stale flush with
  `chmodSync(dir, 0o555)`, and Windows ignores POSIX mode bits on directories, so
  the flush succeeds and clears the divergence the test expects to survive. A
  test-design limitation, not a product defect. Fails on upstream too.
- **`checkEngineHealth keeps PLAN checkbox divergence after stale projection
  flush`** is intermittently flaky. Re-run before investigating.
- **`task-completion-compatibility-adapter.test.ts` is flaky when the native
  addon is ACTIVE**, and the failing case differs from run to run -- observed on
  at least five different cases. It does not reproduce under the JS fallback,
  which is why it only appears once the workspace links are repaired. Measured
  36/36, 35/36, 36/36 alone. **A single red run proves nothing.**
- **`trusted marker baselines do not misclassify pending DB renders`**
  (`gsd-rebuild.test.ts`) is pre-existing; attributed by measurement, above.

### The procedure, and its limit

```bash
git stash push --include-untracked
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test <suite>
git stash pop
```

For a committed patch, revert its files instead. The strip-types runner reads
source directly, so a targeted comparison needs no compile at all:

```bash
git checkout v1.15.0 -- <the patch's files>
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test <suite>
git checkout HEAD -- src packages
```

Only reach for `pnpm run test:compile && pnpm run test:unit:compiled` when you
need the whole-suite row. For a whole-tree revert, note that
`git checkout <tag> -- src packages` restores modified files but does **not**
delete fork-added ones; enumerate those separately with
`git diff --diff-filter=A --name-only v1.15.0 HEAD -- src packages` and remove
them, or they inflate the "unpatched" row.

**Baseline to avoid misattributing a failure, not to avoid investigating one.**
Patch 9 is the cautionary tale: the 143-failure baseline had been recorded and
worked around long enough that it read as normal, while the underlying bug was
writing real artifacts into the developer's global `~/.gsd`. If a "pre-existing"
failure sits in code your current patch touches, read it before accepting it --
that is exactly how patch 9 was found, from a fixture that could not render.

**And a green suite is not evidence either.** Patch 4's site 3 had two suites
that passed identically with and without the fix, because both built their
fixtures past the code under test. Before trusting a test you just wrote or just
repaired, break the source deliberately and confirm the test goes red.
