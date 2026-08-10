# Maintaining this fork

How this fork is built, how the global `gsd` command reaches it, and how to move
it onto a new upstream release tag.

For *what* each patch fixes, see [PATCHES.md](PATCHES.md). This file is only
about the mechanics.

- [Layout](#layout)
- [How the global `gsd` command is linked](#how-the-global-gsd-command-is-linked)
- [Rebuilding](#rebuilding)
- [Rebasing onto a new upstream tag](#rebasing-onto-a-new-upstream-tag)
- [Expected test failures](#expected-test-failures)

## Layout

| | |
| --- | --- |
| Working branch | `LayZeeDK/dev` -- the patches, plus `PATCHES.md` as the last commit |
| Base | an upstream release tag, currently **`v1.14.0`** (`aa8789b4`) |
| Remotes | `origin` = `LayZeeDK/open-gsd__gsd-pi`, `upstream` = `open-gsd/gsd-pi` |
| `main` | tracks upstream; not where the patches live |

`main` is not the base on purpose: it was already 13 commits past `v1.14.0` when
this branch was cut, so basing on the tag keeps the fork pinned to a released
version rather than to a moving branch.

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

Known churn to expect at the next rebase: **patch 12** touches
`task-completion-compatibility-adapter.ts`, which upstream has already changed
past `v1.14.0` (`63254779`, `2e4ca77f`, `3037a37c`).

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
     src/tests/headless-doctor-args.test.ts
```

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
- One commit per patch, its tests included.

## Expected test failures

This tree carries failures that predate the fork. Baseline them before treating
a red test as something you broke.

**All counts below measured 2026-08-11 on win32-arm64, at patch 13.**

> **The whole-suite counts predate the review pass** ([PATCHES.md](PATCHES.md#review-pass)),
> which added 10 tests across five suites and changed no pre-existing assertion.
> Expect the passing column to be 10 higher; the failing column should be
> unchanged. Re-measure both rows before treating either as current. The 13
> per-patch acceptance suites were re-run after the pass and stand at **245 of
> 246**, the one failure being the `chmodSync` test named below.

### Whole suite (`test:unit`, what `verify:pr` runs)

Measured by reverting the fork's 13 changed files to the base and re-running, so
the two rows differ only by this branch's patches:

| tree | passed | failed | skipped |
| --- | --- | --- | --- |
| base `32d2528c`, fork files reverted | 2905 | **1124** | 13 |
| `LayZeeDK/dev` at patch 13 | 2922 | **1120** | 13 |

The fork is **+17 passing, -4 failing**: it regresses nothing and repairs four
pre-existing failures. **`verify:pr` therefore cannot be used as a pass/fail
gate on this host** -- it was already failing 1124 before any fork patch existed.
Compare against the baseline row instead, and re-measure the baseline after every
rebase.

Most of the 1120 are Windows-host artefacts rather than upstream breakage -- the
visible ones assert POSIX path separators (`/fake/package/src/a.ts` vs
`\fake\package\src\a.ts` in `windows-portability.test.js`). They have not been
triaged; **they are not known to be harmless, only known not to be ours.**

### Path and projection suites

The 109 `worktree|paths|projection|doctor|markdown-renderer|external-state`
suites sit at **70 failures**, on this branch and on `main` alike. Before patch 9
both were at 143.

### Per-suite

The table that used to live here listed four suites as carrying 21/15/3/1
pre-fork failures. **Patch 9 repaired almost all of them** -- they were one
Windows path-comparison bug, not upstream breakage:

| Suite | Was recorded | Now |
| --- | --- | --- |
| `state-reconciliation-drift.test.ts` | 21 of 68 | **1** of 68 |
| `markdown-renderer.test.ts` | 15 of 36 | **0** of 36 |
| `register-hooks-*.test.ts` (3 suites) | 3 of 31 | **0** of 31 |
| `auto-prompts-fallback.test.ts` | 1 of 10 | **0** of 10 |
| `doctor-scope-db-unavailable.test.ts` | not recorded | **1** of 32 |

Two known-bad tests worth naming so they are not re-diagnosed:

- **`checkEngineHealth retains ROADMAP divergence when projection repair remains
  stale`** cannot pass on Windows. It forces a stale flush with
  `chmodSync(dir, 0o555)`, and Windows ignores POSIX mode bits on directories, so
  the flush succeeds and clears the divergence the test expects to survive. A
  test-design limitation, not a product defect. Fails on `main` too.
- **`checkEngineHealth keeps PLAN checkbox divergence after stale projection
  flush`** is intermittently flaky -- observed failing once in four consecutive
  runs, asserting `['M001/S01', 'M001/S01/T01']` against an expected
  `['M001/S01/T01']`. Re-run before investigating.
- **`task-completion-compatibility-adapter.test.ts` is flaky when the native
  addon is ACTIVE**, and the failing test differs from run to run -- observed on
  `verified publication rejects a passing verdict when verify is no longer the
  current Kernel head`, `... rejects tracked source mutation after host
  verification`, `exact stage and publication replay repair projections without
  duplicate facts`, and `staging normalizes a pending legacy Task ...`. Measured
  at 1 failure in 4 runs on the **unpatched** base, so it predates this fork.
  Suspected races around the real projection lock; it does not reproduce under
  the JS fallback, which is why it only appears once the links are repaired.
  **A single red run here proves nothing -- repeat it before attributing.**

### The procedure, and its limit

```bash
git stash push --include-untracked
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test <suite>
git stash pop
```

For a committed patch, revert its files instead and recompile:

```bash
git checkout <base> -- <the patch's files>
pnpm run test:compile && pnpm run test:unit:compiled
git checkout HEAD -- src/
```

**Baseline to avoid misattributing a failure, not to avoid investigating one.**
Patch 9 is the cautionary tale: the 143-failure baseline had been recorded and
worked around long enough that it read as normal, while the underlying bug was
writing real artifacts into the developer's global `~/.gsd`. If a "pre-existing"
failure sits in code your current patch touches, read it before accepting it --
that is exactly how patch 9 was found, from a fixture that could not render.
