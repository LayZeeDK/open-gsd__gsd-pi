# Fork-local patches

Fork-local fixes carried on top of upstream `open-gsd/gsd-pi`, on branch
`LayZeeDK/dev`, based on tag **`v1.15.0`** (`95f8c3fb`).

Every patch is one commit containing its own tests, written to be cherry-pickable
into an upstream PR. Nothing here is machine-specific: paths are discovered or
injected, never hardcoded.

This file is fork-only, and it is deliberately the last commit so cherry-picking a
patch never drags it along. The other fork-only files (`FORK.md`, `CLAUDE.md`,
`AGENTS.md`, the `docs/dev/` reports and `plans/`) are likewise added by `docs:`
or `chore:` commits, never by a patch commit -- that separation, not scarcity, is
what keeps every patch cherry-pickable.

## Why this branch exists

These fixes previously lived outside the codebase, as a Claude skill
(`pai-gsd-pi-update`) that rewrote compiled `dist/*.js` inside the global npm
install. That arrangement was untested, unversioned, wiped by every
`npm install -g`, and had to be re-applied to two separate trees. Moving them
here makes them tested TypeScript with a path upstream.

## Build and install

The global `gsd` is an `npm link` symlink into this working tree, so the branch
you have checked out is the `gsd` you run -- and `dist/` is what actually runs, so
a source change needs `pnpm run build:core` before it takes effect.

Full build, link and rebase procedure: **[FORK.md](FORK.md)**.

## Patches

| # | Commit | Area | Upstream status |
| --- | --- | --- | --- |
| 1 | `1139ab47` | MCP server PID verification on Windows | not filed |
| 2 | `61bd64c8` | flat-phase milestone ids | not filed |
| 3 | `418081ef` | external-state projection root | not filed |
| 4 | `bab24536` | unstamped projections in drift comparisons | not filed |
| 5 | `50665ce9` | POSIX verification shell on Windows | not filed |
| 6 | `7b0fd7db` | non-array `ask_user_questions` payloads | not filed |
| 7 | `e4928ce2` | validate-milestone prompt contract | not filed |
| 8 | `c6ecf27e` | record client capabilities on elicitation failure | not filed |
| 9 | `eab6712a` | short path components in worktree guards | not filed |
| 10 | `25dde61e` | read-only engine health checks | not filed |
| 11 | `301e8271` | prose-suffixed `Verify:` lines with a flag | not filed |
| 12 | `5356a387` | `error.cause` in re-wrapped projection failures | not filed |
| 13 | `780a66c7` | headless doctor argument refusal (**breaking**) | not filed |
| 14 | `3b8cb835` | depth-gate arming paired with a delivery rollback | not filed |
| 15 | `0636a3d8` | milestone-lease reentrancy across the process split | not filed |
| 16 | `190a2a99` | DB-authoritative plan-milestone verification | not filed |
| 17 | `fc4a46bb` | milestone-scoped derivation vs. out-of-scope dependencies | not filed |
| 18 | `51c5e914` | first-strike abort for evidence cross-reference contradictions | not filed |
| 19 | `05dc2e05` | per-condition diagnosis for a refused recovery resume | not filed |
| 20 | `e1403e03` | relaunch resumes a standing task recovery abort | not filed |
| 21 | `5f7512c9` | a corrected re-run supersedes the failure it replaced | not filed |
| 22 | `b75d2f63` | verification output truncation kept the head, not the error | not filed |
| 23 | `9e07c897` | an interactive submit that loses the streaming race | not filed |
| 24 | `ddf5adf7` | read back the task contract `gsd_replan_task` demands | not filed |
| 25 | `a9f89297` | answer tool calls an aborted tool batch leaves unresolved | not filed |
| 26 | `3f50b6a9` | a failure-context fence that swallows the retry prompt | not filed |
| 27 | `344cb25c` | a Windows control-file race is retried where it happens | not filed |
| 28 | `fec23b83` | steering never reached a query already in flight | not filed |

Patch 8 spans **two** commits: `d44f1275` (`test(mcp-server): pin elicitation
behaviour across client capability shapes`) lands `elicitation-capability.test.ts`
characterising the SDK's actual behaviour, and `c6ecf27e` adds the diagnostic on
top. They are separate because the first is a pure characterisation of upstream
code and stands alone; cherry-pick both, in that order.

Plus one fork-local dependency decision that is deliberately **not** a
cherry-pickable patch -- see [The SDK bump](#the-sdk-bump-0283---03229).

One further patch was written and then **withdrawn** -- see
[Investigated and rejected](#investigated-and-rejected).

Six of these were hardened after a review pass over the whole branch -- see
[Review pass](#review-pass) for what was found, and what was rejected. Patches 15
and 16 got their own pass, and so did 17 -- see
[Review pass -- patches 15 and 16](#review-pass----patches-15-and-16) and
[Review pass -- patch 17](#review-pass----patch-17).

---

### 1. Verify existing MCP server PID on Windows -- `1139ab47`

**Symptom.** `Fatal: failed to start -- refusing to start: existing MCP server PID could not be verified`

**Cause.** Two independent Windows bugs in `packages/mcp-server/src/pid-registry.ts`:
the PEB `CurrentDirectory` always ends with a separator (`D:\proj\`) while
`projectDir` never does, and `normalizeProcessCwd` stripped only the `\\?\`
prefix; and the cwd probe assigned the target pid to `$pid`, a **read-only**
PowerShell automatic variable, so the swallowed error left the probe reading
PowerShell's own cwd.

**Tests.** `pid-registry.test.ts` -- trailing separator, extended-length path,
root-path guard, plus a live child-process probe. The probe test reproduced the
`$pid` bug directly: it returned the repo directory instead of the child's.

**Retires** `pai-gsd-pi-update` step 9b, and the cross-reference in
`gsd-recover-aborted-task` step 4.

### 2. Map flat-phase directories to milestone ids -- `61bd64c8`

**Symptom.** `Error: Milestone M003 does not exist. Available: 01-requirements, 03-architecture-guardrails-directive-first`

**Cause.** `findMilestoneIds` matched only `milestones/M001-slug/`. For a
flat-phase project `milestonesDir()` returns `phases/`, so raw directory names
leaked out as milestone ids.

**Note.** The sibling `milestone-ids.ts` already handled flat-phase and is
untouched. Only `commands/handlers/auto.ts` consumes the patched function.

**Bounded and deduplicated.** The phase-number match is `\d{1,3}`, not `\d+`:
`MILESTONE_ID_RE` accepts exactly three digits, so a `0001-x` directory would
otherwise be rewritten into an `M0001` that fails the very regex every consumer
validates against. The result is also de-duplicated, because two directories can
share a number (`01-a` and `1-b` both yield `M001`) and a duplicate would be
listed twice in "Available:" and make `files.ts` `sorted.indexOf(mid)` resolve to
whichever came first.

**Retires** `pai-gsd-pi-update` step 9d.

### 3. Keep external-state stores from escaping to the gsd home -- `418081ef`

**Symptom.** `could not lock projection root identity: ... os error 32 at createInitialProjectionDirectory`, plus a second, silent failure.

**Cause.** Both projection-root walks look for a path segment named `.gsd`. In
the external-state layout the project's `.gsd` is a link into
`<GSD_STATE_DIR|~/.gsd>/projects/<hash>/` and projections are addressed by their
resolved physical path, so neither walk matches and both climb to the global gsd
home. `managedProjectionTarget` then took the **user profile** as `targetRoot`
(deterministic, not a race -- the profile always has open handles), and
`projectionDatabasePath` returned `<gsdHome>/gsd.db` as the fence key, silently
guarding the wrong database and collapsing every project onto one claim key.

**Design note.** `repo-meta.json` is advisory: the recovered project root is
accepted only if `<gitRoot>/.gsd` resolves back to the same store, so a moved or
copied repo yields `null` rather than misdirecting writes. The boundary is
anchored on the resolved projects root, not the basename `projects`.

**Tests.** `external-state-projection-root.test.ts`, including negative controls
for an impostor `projects/` directory and a store whose meta no longer
round-trips. Proven load-bearing by disabling the boundary and re-running.

**Retires** `pai-gsd-pi-update` step 9c and its `verify-projection-root-patch.mjs`;
`gsd-recover-aborted-task` steps 5b, 9, 10.

**See also** patch 9, which fixes the *same class* of escape (a walk reaching the
global `~/.gsd` and adopting the user profile) arriving by a different route: a
comparison form that did not expand Windows 8.3 short components.

### 4. Tolerate unstamped projections in drift comparisons -- `bab24536`

**Symptom.** `gsd doctor` reporting `N file(s) drifted -- run /gsd sync` on a
repository with no content drift, and `removeOwnedPlanProjection` refusing to
delete plan files it owned, stranding them on disk.

**Cause.** `writeAndStore()` appends a `<!-- gsd:state-version=... -->` line and
mints both the artifact row and the `.compat.json` baseline from those stamped
bytes. A projection that is on disk UNSTAMPED against a stamped baseline
therefore compares unequal to itself, and two comparison sites hashed raw bytes
on both sides.

**Migration tolerance, not a live-writer fix -- and this took three tries to state
correctly.** The stamp arrived in `v1.13.0`, so the mismatch comes from a disk
copy rendered before that, or one left at a legacy path by a layout migration
while the artifact was re-rendered at the new one. **No current writer produces
an unstamped managed projection.** Earlier editions of this section, and of the
commit message, blamed `workflow-projections.ts renderPlanProjection()` -- which
has had no production caller since before `v1.14.0` (see **B8**) -- and
`renderSummaryProjection()`, which now routes through `writeTaskSummaryProjection`
and therefore stamps and records. Both citations were inherited, never checked,
and wrong.

**Scope, and what was withdrawn at the v1.15.0 rebase.** This patch now changes
only the two READ sites: `formatCompatHealthLine` and `removeOwnedPlanProjection`.
It originally also normalized the WRITE side -- minting the marker sha and the
detector's `actualSha` from stripped bytes -- which redefined what the shared
value *means*. v1.15.0 made that untenable and, on measurement, unnecessary:

- Nothing can produce a stamp-only mismatch. `stampProjectionContent` and
  `recordProjectionWrite` are each called from exactly one place, both inside
  `writeAndStore`, on the same bytes.
- The one scenario that looked like a live cause -- `renderPlanProjection`
  overwriting a plan -- is unreachable dead code, and its output differs by
  **content** anyway (170 bytes against 366), which no amount of stamp-stripping
  reconciles. Closed as **B8**.
- Upstream added `gsd-rebuild.test.ts` "projection baselines retain the exact
  rendered intent", asserting the raw contract outright.
- Two new upstream consumers assumed raw: a stripped baseline made
  `projection-mutation-guard.ts` quarantine a copy on **every** managed `.gsd`
  write, and a stripped `actualSha` made `projection-observation.ts` drop the
  quarantine copy for a genuinely hand-edited projection -- silent data loss on
  the path `/gsd sync` and `/gsd recover` exist to protect.

Measured on the real functions: with the write side stripped, an external edit to
a stamped projection yields 0 preserved entries and no quarantine directory; with
it raw, 1 entry and the directory present. Site 2 is load-bearing in the other
direction -- reverting it strands the legacy unstamped plan file. See
[FORK.md](FORK.md#when-a-patch-redefines-a-shared-value).

**Deliberately excluded.** `.planning` projections are never stamped and their
sha is read raw everywhere else, so the `.gsd` map opts in explicitly. A test
pins that.

**Why the health line accepts either form.** Raw is the ordinary match for a
projection written and baselined by `writeAndStore`; stripped covers the
unstamped-on-disk case. Accepting both cannot mask real drift -- edited content
matches the baseline neither stripped nor raw, and a test pins that.

**Retires** `pai-gsd-pi-update` step 9e and `verify-stamp-insensitive-drift.mjs`.

### 5. Run verification commands in a POSIX shell on Windows -- `50665ce9`

**Symptom.** `post-unit-finalize-end` with `reason: "verification-abort"`
immediately after a clean `unit-end` -- the task passed, the gate failed it.

**Cause.** Verify lines are POSIX commands; Windows handed them to `cmd.exe`.

**How this differs from the skill's patch.** The skill hardcoded
`C:\PROGRA~1\Git\usr\bin\bash.exe` and a matching PATH prefix. This resolves a
shell instead: `GSD_VERIFICATION_SHELL`, then Git for Windows under
ProgramFiles / ProgramW6432 / ProgramFiles(x86) / LOCALAPPDATA, then **falls back
to `cmd`** so hosts without Git for Windows keep today's behaviour. The PATH
prefix is derived from the resolved bash path. Candidates are always explicit
paths -- a bare `bash` is never one, because PATH commonly resolves it to the WSL
launcher stub.

**The override may name a shell that is not bash.** `-o pipefail` is a bashism,
and only the Git for Windows candidates are known to be bash -- while `sh.exe`
ships in the same `usr/bin`, so it is a natural thing to point
`GSD_VERIFICATION_SHELL` at. Handing it bash's argv would fail *every* check with
`Illegal option -o pipefail`, from a variable the operator set to make
verification work. Anything not named bash gets the portable argv this module
already uses off win32, which re-execs bash when it is on PATH and runs `sh`
otherwise.

**Measured.** With a minimal PATH, `cmd` runs neither `test -f` nor `grep -q`
while the resolved shell runs both. The second case passes only because of the
PATH prefix.

**Retires** `pai-gsd-pi-update` step 9a; `gsd-recover-aborted-task` step 6.

### 6. Tolerate non-array `ask_user_questions` payloads -- `7b0fd7db`

**Symptom.** `Extension ".../gsd/index.js" error: questions.find is not a function`, aborting the whole `/gsd` workflow.

**Cause.** Both readers guarded `questions` with `?? []`, which catches nullish
only. Not platform-specific.

**Beyond the skill's version.** The reported stack trace comes from the
`event.args` call site (the external-engine relay path), but the gate-result
reader consulted only `event.input` and `details`; it now reads `event.args` too.
That closed a pre-existing gap -- `register-hooks returns hard blocker when depth
question is cancelled` was failing before this change and passes after. The
skill's diagnostic `questions-shape.log` write is deliberately dropped.

**The three candidates are normalized individually.** `??`-ing the raw values
first and normalizing once is the obvious form and is wrong for the same reason
the original bug was: `??` skips nullish only, so a present-but-non-array
`event.input.questions` -- precisely the shape this patch exists for -- would
short-circuit the remaining candidates and then normalize to `[]`, discarding a
perfectly good `event.args` or gate-details payload. `selectAskUserQuestions`
returns the first candidate that yields questions.

**Adopts** the previously-unapplied `patch-questions-normalizer.mjs`.

### 7. Make the validate-milestone prompt match the tool contract -- `e4928ce2`

**Symptom.** `planned <class> verification requires current structured database evidence; verificationClasses prose cannot authorize Milestone validation`

**Cause.** The prompt told the agent to supply a markdown table under
`verificationClasses` -- exactly what `tools/validate-milestone.ts:213` rejects.
Authorization needs `verificationEvidence[]` with a matching
`testedSourceRevision`, and the prompt named neither field.

**Also fixed.** Evidence capture is now Step 1, before reviewer dispatch: the
recorded revision must still be current when the tool compares it. The
`<paste Reviewer X output>` placeholders are replaced with synthesis
instructions, because pasting three transcripts drove the agent into a
zero-tool-call retry and `MAX_ZERO_TOOL_RETRIES = 1` makes that terminal.

**Completed at the v1.15.0 rebase.** The first cut documented four fields. The
entry schema in `bootstrap/db-tools.ts` requires **eleven** and is
`additionalProperties: false`, so a partial list fails a correctly-followed run
just as hard as no list at all -- it only moves the rejection to a different
field. Worse, the fourth documented field was `summary`, which the schema has
never accepted. The prompt now carries every required field plus the two optional
ones, a JSON example, and an explicit statement that unlisted keys are rejected.

**Test caveat.** This is a contract test between the shipped prompt and the
tool's accepted payload -- it renders the prompt through the real loader and
asserts the required fields are documented. It cannot verify the prompt reads
well, only that the two artifacts agree.

It now asserts **both** directions -- every non-Optional field is named, and the
JSON example introduces no key the schema would reject -- and its field list is
pinned to the schema rather than to a chosen subset. Naming only some required
fields is precisely how the prompt and the schema drifted apart while a green
test said otherwise; a contract test that checks one end of the contract is not
a contract test.

**Adopts** the previously-unapplied `apply-validate-milestone-evidence-prompt.mjs`.

---

### 8. Record client capabilities when elicitation fails -- `c6ecf27e`

**Why.** The withdrawn patch below was built on the client's **raw** initialize
params, which do not show what the SDK server concluded. This records the
deciding fact at the moment it matters, so the next reproduction is diagnosable
instead of guesswork.

**What it does.** On a failed elicitation attempt, appends one JSON line to
`<GSD_HOME|~/.gsd>/diagnostics.jsonl`:

```json
{"at":"2026-08-10T21:58:03.114Z","kind":"elicitation-failed",
 "error":"Client does not support form elicitation.",
 "capabilities":{"roots":{"listChanged":true}},
 "clientInfo":{"name":"claude-code","version":"2.1.223"}}
```

`capabilities` is the object **as the server resolved it**, recorded verbatim
rather than as a derived boolean -- the open question is the exact shape, and a
summary throws away the detail that matters.

**How to use it.** After a session where a question failed to reach you:

```bash
rg -o '\{.*\}' ~/.gsd/diagnostics.jsonl | tail -5
```

If `capabilities.elicitation` is absent, the client advertised none. If it is
present but has no `form` key, that is the non-empty-without-form case the SDK
preprocess does not cover -- the one shape that could still justify a shim.

**Scope.** Failure path only, so it costs nothing in normal operation. Every
step is best-effort: unreadable accessors, an unwritable destination, or a
non-Error rejection must never turn a diagnostic into the reason a tool call
fails. Tests cover each of those.

**Note.** Takes effect after `pnpm run build:core`, since the linked global
`gsd` runs the built output.

---

### 9. Expand short path components in worktree guard comparisons -- `eab6712a`

**The most consequential patch on this branch, and it was not on the backlog.**
It was found while re-verifying B1, because B1's own fixture could not render.

**Symptom.** Two distinct ones, which is why it went unnoticed for so long:

- Running the extension suites wrote real artifacts into the developer's global
  `~/.gsd` -- ROADMAP, PLAN, SUMMARY, CONTEXT-DRAFT and DISCUSSION files under
  `~/.gsd/phases/`, plus a milestone row in `~/.gsd/gsd.db`.
- 143 failures across the 109 path/projection suites, which
  [FORK.md](FORK.md#expected-test-failures) had recorded as "failures that
  predate the fork" and therefore as something to baseline around rather than
  investigate.

**Cause.** `normalizeWorktreePathForCompare` (`worktree-root.ts`) resolved through
the plain `realpathSync`, which on Windows does **not** expand 8.3 short
components. Every `~/.gsd` escape guard in that module compares a walked-up
directory against `gsdHome()`, which derives from `homedir()` -- the LONG spelling,
via USERPROFILE -- while the walk itself commonly starts from an `os.tmpdir()`
path carrying the SHORT one (`C:\Users\LARSGY~1\AppData\Local\Temp`). The two
spellings of one directory never compare equal, so the guards in
`resolveNearestBootstrappedGsdRoot` and `resolveGitWorkingTreeRoot` miss, the walk
climbs past the home, finds its bootstrapped `.gsd` via `PREFERENCES.md`, and
returns the user's HOME as the project root. `gsdProjectionRoot` then resolves to
the global `~/.gsd` and writes there.

`c:/users/larsgy~1/...` vs `c:/users/larsgyrupbrinknielse/...` is the whole bug.

**Fix.** `realpathSync.native`, matching the sibling guards already spelled that
way -- `repo-identity` `normalizeForGuard`, `external-state-store`
`isSameFilesystemPath`, and `managed-projection-history` `logicalProjectionPath`,
whose comment documents this exact trap.

**Why upstream CI never saw it.** POSIX `/tmp` is not under `$HOME`, so the walk
never reaches a bootstrapped `.gsd`. It needs a host where the temp directory
lives under the home directory AND is spelled with an 8.3 component -- the Windows
default.

**Verified against `main`, not just the fork base.** `worktree-root.ts` is
byte-identical on `v1.14.0`, `main` and this branch (the fork never touched it),
and the defect reproduces on each, so this is an upstream defect and the patch
cherry-picks directly.

| 109 path/projection suites | pass | fail |
| --- | --- | --- |
| `main`, unpatched | 633 | 143 |
| `main`, patched | 706 | **70** |
| fork tip, unpatched | 638 | 143 |
| fork tip, patched | 711 | **70** |

Identical delta on both branches, with no test regressing. Relocating `%TEMP%`
off the home directory produces the same result as the patch (30/31 on
`doctor-scope-db-unavailable`), which is what confirms the mechanism rather than
merely correlating with it.

**Four suites FORK.md listed as carrying pre-fork failures are repaired by this
patch alone:** `state-reconciliation-drift` 21 -> 1, `markdown-renderer` 15 -> 0,
`register-hooks-*` 3 -> 0, `auto-prompts-fallback` 1 -> 0. The table in FORK.md
has been rewritten accordingly.

**Tests.** Capability-gated rather than platform-gated: they derive a long
spelling with `realpathSync.native` and skip when the host offers no divergence
(POSIX, or NTFS with 8.3 creation disabled) instead of asserting something the
platform cannot express. One pins the comparison form directly; one drives
`resolveWorktreeProjectRoot` with `GSD_HOME` set to the long spelling and the walk
starting from the short one -- the real asymmetry. The fix also repaired two
pre-existing failures in that same suite.

**Confirmed in production** after `build:core`: in a directory reached by the
short temp path, with a `.gsd/` but no `.git`, `gsd headless doctor --json`
reports that directory as `basePath` rather than `C:\Users\<user>`.

### 10. Keep engine health checks read-only without repair -- `25dde61e` (B1)

**Symptom.** `gsd headless doctor` re-rendered projections and printed
`Fixes applied:` from what the operator asked to be a diagnostic.

**Cause.** `checkEngineHealth` takes `options?: { repair?: boolean }` and honours
it at three sites, but the projection-drift block gated its
`flushWorkflowProjections` re-render on `isDbAvailable()` alone. The re-render
writes, so every caller that omits options mutated projections:

- `headless.ts` calls `runGSDDoctor(process.cwd())` with no options.
- `forensics.ts` calls `runGSDDoctor(basePath, { scope: undefined })`, so a
  post-mortem mutated the state it was investigating.
- The interactive `/gsd doctor` computes `fix: false` unless fix/heal/`--fix`/
  `--dry-run` is given, so a plain scan re-rendered too.

`doctor.ts` already passes `{ repair: fix && !dryRun }` and `auto.ts` passes
`{ fix: true }`, so `--fix`, `--dry-run`, `fix`, `heal` and the auto-mode repair
are unchanged. The narrowing also removes an unrequested projection writer, one
of the paths that manufactures the stamp drift patch 4 exists to tolerate.

**Tests.** Three existing tests gained `{ repair: true }`; their subject is what
survives or follows a flush, not whether an ungated diagnostic performs one. A
new paired test pins the gate itself on a byte-identical fixture: no options must
report no fixes, must leave the `artifact_file_missing` diagnostic standing, and
must not create the projection file. Neither half is load-bearing alone -- a change
that merely disabled the re-render would keep the new test green and break its
`{ repair: true }` twin.

**Retires** `gsd-recover-aborted-task`'s warning that a diagnostic doctor run
mutates state.

### 11. Reject prose-suffixed verify lines that carry a flag -- `301e8271` (B2)

**Symptom.** A `Verify:` line that is plainly a sentence was handed to the shell,
failing a task whose substance had already passed.

**Cause.** Two independent holes in `readsAsProseAfterCommandWord`:

- It bailed on `tokens.some(t => t.startsWith("-"))`, so ONE flag anywhere
  disabled prose detection for the whole line. `git grep -n "Theming" README.md
  confirms the section exists` reached `isLikelyCommand` as `true`.
- `exits` was missing from `PROSE_MARKER_WORDS` (only `exists` was there), so
  `nx test mypkg exits 0` -- no flags at all -- found no marker and ran.

**Fix.** A two-branch rule keyed on the marker's position. No flags: the line is
bare words and a marker settles it. Flags present: only a trailing run of bare
English words counts as a prose suffix, so a real operand keeps the line runnable.

**The `tokens.length < 4` guard is load-bearing, not incidental.** With it, the
no-flags branch is exactly the previous rule rewritten around `markerIndex` --
anything it now calls prose it already called prose -- so the only behaviour that
changes is the flags-present path, which previously always returned `false`.
Without the guard that branch genuinely widens and `grep exists f.txt` would flip.

**Known trade-off.** An unquoted marker word as the FINAL operand
(`git grep -n the`) now reads as prose and is skipped rather than run. Skipping
is the fail-safe direction -- a skipped check reports as unverified, whereas an
executed sentence fails a task that succeeded -- and the surrounding heuristic
already makes this class of trade. It is a real narrowing, not a free win.

All ~40 pre-existing `isLikelyCommand` assertions still hold, none touched.
Verified against the built `dist/` as well as source.

**Retires** the `gsd-recover-aborted-task` step for a prose `Verify:` line
executed as a shell command. Reproduces on every platform, unlike patch 5.

### 12. Keep `error.cause` in re-wrapped projection failures -- `5356a387` (B5)

**Symptom.** `Task completion PLAN projection failed: native projection root
identity locking failed` -- with the actionable `os error 32` nowhere in sight.

**Cause.** The cause is attached correctly at the source: the native lock throws
`new Error("native projection root identity locking failed", { cause: error })`
carrying the Rust text. Two re-wraps in the task-completion adapter then took
`.message` only and dropped the chain, so the operator had to go find, by hand,
the `os error 32` that had already been thrown and discarded -- which is exactly
why the recovery runbook needs a separate dig-out step for this failure.

Because `classifyFailure` derives both the auto-mode banner text and the failure
kind from that same message, flattening the chain at the wrap point repairs the
message and the banner together.

**Fix.** `getErrorMessageChain` in `error-utils.ts`, generalizing the one-level
`recoveryErrorMessage` in `headless-recover.ts` to the full chain with a depth cap
and a cycle guard -- `cause` is an ordinary writable property, so a cyclic chain is
reachable. Both wrap sites also keep `{ cause: error }`, so programmatic consumers
retain the chain rather than trading one lossy representation for another.

**Deliberately not touched.** The bare `if (!summaryPath) throw` between the two
wraps is not a third re-wrap -- it has no upstream error to carry. And
`errorMessage()` in `recovery-classification.ts`: widening THAT would feed cause
text into `inferFailureKind`'s regexes for every failure in the system and could
silently reclassify unrelated errors. Fixing the wrap point gets the same operator
outcome with none of that blast radius.

**Tests.** The adapter test drives the real publish path -- staging deliberately
does not render PLAN, so `publishVerifiedTaskCompletion` is the only route to that
wrap -- and asserts both layers reach the message AND that `.cause` survives. It
was red on exactly the documented string before the change. Separate unit tests
cover the depth cap and the cycle directly.

**Verified end-to-end with a real native `os error 32`.** The reproduction is
deterministic, and worth recording because the skill's step 5 calls this failure
hard to stage. `open_windows_root_directory` requests `DELETE_ACCESS` with a
`share_mode` of `FILE_SHARE_READ | FILE_SHARE_WRITE` -- **no
`FILE_SHARE_DELETE`** -- so any other handle on the directory that does not permit
delete sharing causes a sharing violation. A process whose **current working
directory** is the projection root holds exactly such a handle. That is also the
real explanation for patch 3's "the profile always has open handles".

Spawn a child with `cwd` set to the root, then attempt the lock:

```
.message : native projection root identity locking failed
.cause   : could not lock projection root identity: GenericFailure, projection
           root operation failed: \\?\C:\...\gsd-e2e-lock-hp6Y4f: <localized
           sharing-violation text> (os error 32)
```

Run through the **built** `dist/` formatter, not the source:

| | surfaced message |
| --- | --- |
| before | `Task completion PLAN projection failed: native projection root identity locking failed` |
| after | `... failed: native projection root identity locking failed: could not lock projection root identity: ... (os error 32)` |

**Two traps this uncovered.** First, `acquireProjectionRootIdentityLock` already
wraps the Rust error, so the operative text is on `.cause` and never on
`.message` -- checking the wrong layer makes a correct patch look broken. Second,
**the OS text is localized** -- this host reports the sharing violation in Danish,
not English -- so `(os error 32)` is the only stable token to match on. Never
assert on the English wording. (The localized string is left out of this file
deliberately: it is non-ASCII, and Windows cp1252 pipelines mangle it.)

The committed unit test still injects a synthetic cause at the same boundary, so
it stays hermetic and platform-independent; this check confirms the synthetic
shape matches the real one.

**Retires** the `gsd-recover-aborted-task` step 5-vs-5b dance, whose whole purpose
was recovering the discarded cause by hand.

### 13. Refuse headless doctor args that cannot be honoured -- `780a66c7` (B6)

**BREAKING.** See below.

**Symptom.** `gsd headless doctor resolve-evidence --action=preserve` ran a plain
scan and exited 1 -- indistinguishable from "issues detected".

**Cause.** `parseHeadlessArgs` was not the bug: it collects `resolve-evidence` as
a positional and `--action=preserve` through the unrecognized-flag passthrough,
both into `options.commandArgs`. The `doctor` branch then read `commandArgs` only
for `--json`. Every other argument the interactive `/gsd doctor` accepts (`fix`,
`heal`, `audit`, a scope, `--dry-run`, `--fix`, `--build`, `--test`) vanished the
same way. **The skill recorded this as "headless drops trailing argv", which is
the wrong cause** -- the argv arrives intact and the branch ignores it.

**Fix.** Refuse anything but `--json`, naming the working invocations. This
entrypoint is a read-only diagnostic; honouring those arguments would mean a
second mutating doctor outside a TTY. Exit 1 via `EXIT_ERROR`, matching the
`[headless] Error:` convention `parseHeadlessArgs` already uses.

```
[headless] Error: gsd headless doctor does not support 'resolve-evidence
--action=preserve'. It is a read-only diagnostic; only --json is accepted.
Use the interactive /gsd doctor for fix / heal / audit / resolve-evidence.
```

**BREAKING CHANGE.** The branch previously exited `report.ok ? 0 : 1` regardless
of the extra arguments, so `gsd headless doctor fix` on a **healthy** repo exited
**0** while honouring nothing at all. It now exits 1 unconditionally. Any CI step
or script passing `fix` / `--fix` / `--dry-run` / a scope flips from pass to fail
-- which is the point, since none of it was ever honoured, but it is a hard break
rather than a silent tightening. Callers that want the scan drop the extra
arguments. There is deliberately no second exit code for "refused": that would
re-hide the misuse this patch exists to surface.

**Testability constraint that shaped this.** The predicate lives in a new
zero-import `headless-doctor-args.ts` rather than inline, because
`src/tests/headless-cli-surface.test.ts` re-implements `parseHeadlessArgs` instead
of importing it -- `headless.ts` pulls a transitive `@gsd/native` import that
breaks under the test loader -- and a test for this must not become a fourth
mirrored copy of the parser. Follows the `headless-recover.ts` precedent:
behaviour tested against the extracted module, the one-line dispatcher if-block
covered by `build:core`.

**Verified end-to-end** on the linked global `gsd`: the refusal prints on stderr
with no doctor report and exit 1, `gsd headless doctor fix` is refused, and
`gsd headless doctor --json` still emits JSON.

**Retires** the `gsd-recover-aborted-task` step that has the operator quote the
subcommand to work around the dropped argv.

### 14. Pair depth-gate arming with a delivery rollback -- `3b8cb835`

**Symptom.** Saving a milestone `CONTEXT` was impossible from a client without
form elicitation, and the *first* failed attempt bricked the whole session --
`CONTEXT-DRAFT` too, and all bash. Reported against consumer project
`ngx-foundation-sites`, milestone `M002`
(blocker report kept out of the repo).

**Cause.** Not "the wrong error is returned". The gate is armed *before* delivery
is attempted and nothing rolls it back when delivery fails. With `pendingGateId`
set, `enforceWorkflowWriteGate` refuses every workflow tool -- including
`CONTEXT-DRAFT`, which `shouldBlockContextArtifactSaveInSnapshot` otherwise lets
through on its `artifactType !== "CONTEXT"` line -- and
`shouldBlockPendingGateBashInSnapshot` refuses all bash. The only tool
`GATE_SAFE_TOOLS` still permits is `ask_user_questions`, which fails identically.
That is reproduction step 3.

Worse than a stuck flag: `armPendingGate` deletes `verifiedApprovalGates[gateId]`
and `verifiedDepthMilestones[milestoneId]`. Revoking on a genuine re-ask is
intended; revoking on a delivery that never happened leaves state **strictly
worse than before the call**, silently costing a previously human-verified
milestone its verification.

**There are two arming sites, not one.** This is the fact that shapes the fix:

| Site | Process |
| --- | --- |
| `server.ts` `recordAskUserQuestionsPendingGate` | MCP child |
| `register-hooks.ts` `tool_execution_start` | extension host -- `UNIVERSAL_TOOL_HOOKS`, so **every** engine |

A child-side fix alone leaves the host arm intact and the session still bricked
on the claude-code-cli engine path, which is the path in the report.

**Fix, two mechanisms.**

*Capability pre-check (child).* When the client's resolved capabilities lack
`elicitation.form` **and** no remote channel is configured, return one accurate
error and arm nothing. Keyed on `elicitation.form` because that is the exact
field the SDK's own `elicitInput` asserts on
(`server/index.js`: `if (!this._clientCapabilities?.elicitation?.form) throw`),
read *after* the `ElicitationCapabilitySchema` preprocess -- reasoning from raw
initialize params produced a wrong fix once already (see the withdrawn patch).

*Capture-and-restore rollback (both sides).* The load-bearing half.
`armPendingGateForDelivery` captures what the arm revoked plus the gate it
displaced; `applyPendingGateRollback` restores all three in **one** mutation, so
no interleaved reader sees a half-rolled-back state. The child restores in a
`finally`; the host captures per `toolCallId` and restores at
`tool_execution_end` on an errored result.

**A `finally`, deliberately not a predicate on the error message.** A predicate
keyed on the capability wording covers only the one failure mode the pre-check
already prevents. `server.ts` rethrows past `isLocalElicitFallbackError` for
transport and serialization failures, and **the remote-configured path is not
exempt**: it throws with the gate still armed when the remote fallback fails, and
that throw is not a capability assertion. An expired Discord token -- the exact
case that code path's comment was written for -- plus a non-elicitation client
was a full brick.

**Delivered is not the same as answered.** Answered, declined, cancelled, timed
out, or any remote round all count as delivered and keep the gate armed: those
are genuine re-asks, and the existing `timed_out` / `cancelled` handling depends
on it. Only a question that never reached anyone is rolled back.

**Two traps this uncovered.**

- The pre-check returns before `server.server.elicitInput`, which is the only
  place `recordElicitationDiagnostic` is reached -- so it silently deleted patch
  8's diagnostics record. `elicitation-capability.test.ts` caught it. The refusal
  now writes its own entry.
- `getClientCapabilities()` returning nothing means "not connected / not known",
  **not** "elicitation absent". Treating the two alike refused every elicitation
  on an unconnected server, breaking a test that drives the registered tool
  directly. Only a capability set that *was* resolved and lacks
  `elicitation.form` is a knowable refusal.

**Deliberately out of scope.** `activateDeferredApprovalGate` (`agent_end`) arms
for a *future* question rather than around a delivery attempt, so it has no
delivery to pair with; rolling it back would defeat it. And `secure_env_collect`
elicits too but has no gate, so it errors rather than deadlocks.

**Tests.** Eight handler cases, three write-gate seam cases, five host cases.
Proven load-bearing: disabling the host rollback turns two of them red on exactly
the documented assertion. The seam tests cover the displaced-previous-gate case
that nothing else reaches, and the host tests pin the deliverable directly --
after a failed ask, `CONTEXT-DRAFT` and bash work again while `CONTEXT` stays
refused.

**What this delivers, and what it does not.** Reproduction step 3 disappears:
authored context is persisted rather than lost, and every other tool keeps
working. Final `CONTEXT` stays blocked and the milestone parks in
`needs-discussion` -- nobody confirmed anything, and the rollback must not become
the bypass. Making final `CONTEXT` reachable *without* elicitation is deferred; a
local non-elicitation answer channel is what that would take.

**Note on the report's "no documented workaround".** Not quite right:
`askUserQuestionsHandler` already falls back to the remote-questions channel
(Discord/Slack/Telegram) when configured, and answering there verifies the gate.
Undocumented, not absent.

**Rejected on the merits, recorded so it is not re-raised.** The report's second
suggestion -- a plain-text confirmation phrase passed as a `gsd_summary_save`
argument. The model fills tool arguments, so that is the model self-approving a
gate whose entire purpose is that the model cannot approve it.

Also rejected: a self-expiring gate (needs a new field through
`normalizeWriteGateSnapshot`, `mergeSnapshotIntoState` and both adapters, to fail
*open* on a timer -- wrong direction for a consent gate); widening
`GATE_SAFE_TOOLS` (contradicts its documented intent and weakens the gate for
every client to fix one); a terminal-sounding error with no state change (relies
on model compliance, which is exactly what a mechanical gate exists not to rely
on). Deleting `.gsd/runtime/write-gate-state.json` remains the documented
stopgap; it was already the supported reset.

### 15. Make the milestone-lease reentrancy check survive the process split -- `0636a3d8`

**Commit order is load-bearing: 15 before 16, and 16 must not be cherry-picked
upstream without 15.** Patch 16 alone converts today's false success into three
retry turns plus a pause on every auto-mode plan-milestone, because the tool is
still lease-blocked.

**Symptom.** A milestone that reaches `plan-milestone` inside `/gsd auto` can
never be planned by that run. Every nested `gsd_plan_milestone` is rejected as a
conflict against its own orchestrator's lease. Reported against consumer project
`ngx-foundation-sites`, milestone `M002`
(incident report kept out of the repo).

**Cause.** `executePlanMilestone` proved reentrancy with in-process state
(`isAutoActive()`, `autoSession.workerId`) and `holder.pid === process.pid`. The
orchestrator spawns a child `claude`, which spawns the workflow MCP server, so
neither can ever hold. `claimMilestoneLease`'s takeover `EXISTS` clause carries
the same assumption in SQL, requiring equal host **and** pid **and** project
root, so the one-shot claim would reject the call a second time.

`/gsd next` is the same machinery -- `startAutoDetached(..., { step: true,
milestoneLock })`, a fire-and-forget promise in the *same* process -- so it
registers a worker, claims the lease, and hit the identical deadlock.

**Fix.** Carry the orchestrator's worker id to the descendant that serves the
tool call over the per-turn env channel GSD already uses for the
milestone-status observation token.
`injectMilestoneStatusObservationToken` becomes `injectWorkflowChildEnvTokens`
and applies the same delete-then-set-if-present treatment to
`GSD_AUTO_WORKER_ID`. Extending the one existing call rather than adding a second
is deliberate: it assigns `sdkOptions.env` wholesale, so a second call would
clobber the first key.

**Both halves of that helper are needed.** `stream-adapter.ts` removes the
workflow server from the SDK-injected `mcpServers` when the project already
declares it in `.mcp.json` -- which the reported project does -- in which case
the `claude` CLI launches the server itself and plain inheritance from
`sdkOptions.env` is the only channel.

The SQL is deliberately **not** edited. Relaxing a shared takeover predicate
would change every lease claimant; instead the reentrant peer skips the claim
entirely. That leaves `workerId`/`acquiredToken` null, so the `finally` releases
nothing and the orchestrator keeps owning and refreshing its own lease -- no
mid-plan expiry window opens.

**Per-dispatch, never a global env var.** Because the value is injected per
dispatch and deleted when no worker is active, the orchestrator's own
`process.env` is never mutated. That removes the whole class of mirroring bugs a
global would have introduced: no cleanup-site enumeration to get wrong (there
are five places `s.workerId` is nulled, including a plan-milestone-specific
setup-race pause), no survival past a SIGTERM handler that nulls the worker
without exiting, no inheritance by parallel workers that spread `...process.env`,
and no stale id left behind when `registerAutoWorker` throws on an unavailable
DB. No `auto.ts`, `auto/session.ts` or `verification-gate.ts` change is needed.

**Deliberately not compared: `project_root_realpath`.** The orchestrator
registers with `scope.workspace.projectRoot` while the MCP server's root comes
from `GSD_WORKFLOW_PROJECT_ROOT`; requiring equality would re-wedge worktree
sessions, and the per-dispatch channel already means the id only reaches this
orchestrator's own descendants. The positive test therefore registers its holder
against the fixture base rather than reusing the conflict fixture's
`other-project` root -- reusing that would assert a cross-project lease bypass,
locking in the one comparison this patch drops.

**An inviting wrong turn: `buildWorkflowLaunchEnv`.** Its output is written
verbatim into the project's `.mcp.json` by `ensureProjectWorkflowMcpConfig`, so a
per-session id threaded there would be **persisted to disk and go stale**. That
is the reason the in-memory seam is the right one.

**The inherited id is trusted only when auto is NOT active in this process.**
`ourAutoWorkerId` is `activeAutoWorkerId ?? (isAutoActive() ? null :
inheritedAutoWorkerId)`. A plain `??` fallback reads better and is wrong: with
auto active and the worker row detached by the setup-race pause, an inherited id
matching the holder made `isOurAutoLease` true, which skips the whole
`holder?.status === "active" && !isOurAutoLease` block -- *including* its
documented "active auto without a worker row cannot reclaim here. Fail closed
instead of planning against a lease we do not own" return. The nested dispatch
then planned against a lease it did not own, claimed nothing, and released
nothing. In the workflow MCP server -- the entire point of the env hop --
`isAutoActive()` is always false, so gating on it costs the fix nothing.

**`status = 'active'` is not liveness, so the inherited-id path checks the
holder's process.** Only `stopAuto` and the janitors ever clear that column, so a
SIGKILLed or suspended orchestrator leaves an `active` worker row *and* a held
lease for up to `LEASE_TTL_SECONDS` (60). Trusting the column alone let a
descendant plan with no live lease owner -- and the workflow MCP server is a
*grandchild* (SDK -> `claude` -> server), which Windows does not reliably reap, so
it can outlive the orchestrator. If the operator restarted `gsd auto` after the
lease expired, two planners could overlap. Before this patch that path returned a
conflict, so the window is one this patch opened.

The guard is the same mechanism as `isDeadLocalLeaseHolder` (`auto/loop.ts`) --
`process.kill(pid, 0)`, with `EPERM` meaning alive-but-not-signallable -- minus
that helper's `project_root_realpath` comparison, which is precisely what this
patch must not require. It is only meaningful because the same conjunct already
requires `holder.host === hostname()`. **PID reuse can still read as alive**,
exactly as in that helper; the DB write is additionally guarded by the
`workflow.milestone.plan` domain-operation ledger.

The in-process path is untouched: `activeAutoWorkerId !== null` short-circuits
ahead of it, so this only ever constrains an inherited id.

**Accepted limitation, with the trust boundary stated accurately.** Two parts,
and the second was overclaimed in the first draft of this section:

- The worker id is echoed verbatim to every blocked caller by
  `milestoneLeaseConflictResult`, so it is not a secret: anyone who can set env
  vars on a process that reaches the DB can assert it.
- `sdkOptions.env` is inherited by the child `claude` and therefore by
  **everything that child spawns**, including Bash-tool subprocesses -- not only
  the workflow MCP server. An earlier wording here ("the per-dispatch channel
  already means the id only reaches this orchestrator's own descendants") is
  literally true but was used to argue a narrow boundary; "descendant of the
  dispatch" is much wider than "the process serving the tool call". A `gsd`
  invoked from a Bash tool call inside the turn does inherit the id and can then
  satisfy the predicate.

Neither is a regression. The milestone lease is single-host advisory coordination
between the user's own sessions ([COORDINATION](src/resources/extensions/gsd/docs/COORDINATION.md)), and any
actor with shell access can already write the DB directly. A per-session nonce in
the runtime KV would be equally readable, so it buys nothing. Narrowing the
inherited-id path by comparing the canonical milestone root was considered and
rejected for the same reason `project_root_realpath` is not compared: it
re-wedges worktree sessions, which is the defect this patch exists to fix.

**Proving the env hop, and how not to.** Nothing in the tree proved the id
reaches the process serving the tool call; the observation-token test simulates
propagation in-process. Two probe channels that do **not** work from the MCP
server: `logWarning` (its `appendNotification` returns early while `_basePath` is
null, and that process never calls `initNotificationStore`), and `debugLog`
(no-op unless `GSD_DEBUG`/`--debug` armed that process). Read it from the DB
instead -- it is unambiguous and needs no probe at all:

| | value |
| --- | --- |
| lease held by | `auto-LGBN-Surface-25664-54c89fae`, pid 25664, heartbeat 11:30:43 |
| held from / to | 11:24:43.067Z / 11:31:43.172Z |
| `gsd_plan_milestone` returned success | **11:31:05.984Z** -- inside that window |
| lease afterwards | same worker, **no takeover row** |

Before the patch the same milestone was blocked across four conflicting calls
over 15 minutes; after it, the first call persisted five real slice rows.

**Tests.** Two `workflow-tool-executors` cases (plans through its own
orchestrator's lease without stealing it or bumping the fencing token; still
refuses an unrelated inherited id) plus the pre-existing env-unset conflict case,
and one `stream-adapter` case asserting both env channels carry the id when auto
is active and that a stale inherited value is deleted when it is not. Proven
load-bearing: dropping the `!reentrantAutoLease` guard turns the positive case
red.

---

### 16. Make plan-milestone verification DB-authoritative -- `190a2a99`

**Symptom.** The same reported unit finalized `completed` /
`artifactVerified: true` with nothing durable written. `renderRoadmapFromDb`
logged `skipped unplanned milestone M002 (zero slices, empty vision) -- refusing
to write a stub ROADMAP` **1.8 s after** the `unit-end`.

**Cause.** `artifactVerified: true` was computed honestly from a real file.
Blocked on the lease for 15 minutes, the agent hand-wrote `02-ROADMAP.md` against
its own prompt (`prompts/plan-milestone.md` step 5: "Do **not** write
`{{outputPath}}`, `ROADMAP.md`, or other planning artifacts manually; the tool
owns rendering and persistence"), nothing enforced that instruction, and
file-only verification accepted the forgery. Reconciliation later removed the
unbacked projection, which is why a post-hoc `ls` found nothing and the mechanism
looked unpinnable.

`persistMilestonePlan` already states the contract in `renderPlanArtifacts`'
catch -- "the DB is the authority and ROADMAP.md is only a projection" -- and
commits slice rows before the render. Verification simply never consulted it, so
any file that parses as a roadmap counted as proof of planning: a hand-written
one, a stale one, a leftover from a failed render.

**Fix.** `hasPlannedMilestoneSliceRows` runs before the existing projection and
slice-count checks, so **both authorities must agree**.

- *Refresh-on-negative.* The orchestrator's long-lived handle can be stale with
  respect to rows the workflow MCP server just committed -- `db/engine.ts`
  documents that exact scenario, and the plan-slice branch guards its own
  cross-process read the same way. Only a zero-row read can be a false negative,
  so it reconnects only to confirm one.
- *Fail-soft on every failure*, matching plan-slice, which falls back to parsing
  the file when the refresh fails. A wedged `/gsd next` is the worse outcome, and
  the projection check still runs either way. (Rejected: failing closed to match
  the `validate-milestone` and `execute-task` tails. Those fail closed because
  they have no file evidence to fall back on; plan-milestone does.)
- *A `base` guard, because the DB handle is process-global.* The predicate reads
  whichever handle is open, and every caller has a base path, but nothing
  confirmed the two agree. Without the guard, a handle belonging to a *different*
  project returns zero rows and that is a hard block -- the documented fail-soft
  covered only "no DB open" and "throws". So it now returns `true` when the open
  path is not this base's. The sibling DB branches in `verifyExpectedArtifact`
  (`parallel-research`, `execute-task`, `validate-milestone`, `plan-slice`) all
  read the global handle keyed on milestone id alone and two of them fail
  *closed*, so a cross-project read there is worse; they are left alone as
  pre-existing, out-of-scope behaviour.

**The `base` guard has a trap that made three tests lie, worth reading before
touching it.** Compare the two paths with a bare `!==` and it reports a mismatch
for the *same file*: `expectedWorkflowDbPathForBase` resolves through `gsdRoot`
(realpath, long form) while `getWorkflowDatabasePath` returns the raw path it was
opened with, which under `mkdtempSync` is the 8.3 short form
(`C:\Users\LARSGY~1\...`). The guard then always fell soft and **silently
disabled this entire patch**, turning the three "must reject" cases green. This is
patch 9's bug class exactly. Measured on a throwaway fixture:

| | value |
| --- | --- |
| opened / `getWorkflowDatabasePath()` | `C:\Users\LARSGY~1\...\.gsd\gsd.db` |
| `expectedWorkflowDbPathForBase(base)` | `C:\Users\LarsGyrupBrinkNielse\...\.gsd\gsd.db` |
| bare `===` | **false** -- same file |
| normalized | **true**, and a foreign base still differs |

The comparison is `isSameFilesystemPath` (`external-state-store.ts`), not two
`normalizeRealPath` calls: it realpaths, unifies separators **and** case-folds on
win32, its own doc comment is about this exact trap, and it is deliberately
dependency-light because the projection-write fence already sits on it. It also
keeps the two sides comparable on its `resolve()` fallback, which matters because
`probeGsdRoot`'s last step returns `join(rawBasePath, ".gsd")` un-realpathed -- so
when `.gsd` is unresolvable the two sides otherwise carry different shapes and
fail open.

The failure direction is what makes this dangerous: a false mismatch fails
*open*. **And the obvious test does not catch it portably.** The three
reject/pass cases only go red under a bare `===` because `tmpdir()` on this host
is an 8.3 path; on Linux/macOS CI there is no short-name divergence, so a
de-normalized compare still matches and the bug ships green. The pin for that is a
separate case that opens the DB through an equivalent-but-textually-different path
(a redundant `.` segment, built by concatenation because `join`/`resolve` collapse
it), which diverges on every OS.

**The refresh must not be the bare `refreshWorkflowDatabaseFromDisk`.** That
function is a close-then-reopen (`db/engine.ts`), and a failed reopen leaves the
process-global handle `null` **for the rest of the process**. Failing soft on that
hides a dead handle from every later caller -- and `doctor --fix` deletes every
completed-unit key whose artifact does not verify, while the sibling branches fail
*closed* on `!isDbAvailable()`. So one zero-row plan-milestone whose reopen loses
a race (an `EBUSY` against the workflow MCP server mid-`wal_checkpoint`) could
cascade into pruning completion records for units that are genuinely complete,
inside a bare `catch {}` that surfaces nothing. `ensureWorkflowDbForBase(base,
{ refresh: true })` reopens by path when the refresh fails, so the handle is
repaired rather than abandoned, and it returns false when the DB file is absent.

**Excluding the fabricated `S00-blocker` row closes a hole rather than opening
one.** The #4378 escape hatch does not run through artifact verification:
`writeBlockerPlaceholder` writes a stub roadmap with zero slice entries, which
the projection check already rejects, and the hatch works by letting
`deriveState` see `activeMilestoneSlices.length > 0`. Counting the row would
instead mean that after any blocker placeholder, a later hand-written
slices-bearing `ROADMAP.md` verifies as "planned" forever -- precisely the
incident. The sentinel is now one exported constant used by both the writer and
the check, so they cannot drift.

**The retry prompt had to name the DB, not the file.** Without this the patch's
stated outcome is false. `artifactValidationKind` returns `null` for
`plan-milestone`, so `describeArtifactVerificationFailure` fell through to
"`<path>` exists but did not satisfy the plan-milestone completion contract". That
string is the only thing the agent sees; the DB reason goes to a `logWarning`,
i.e. notifications. Pointed at the file it had just written, the
highest-probability repair is to rewrite it -- re-forging the same forgery. The
new message names the DB and `gsd_plan_milestone`, worded clear of the four
`isDeterministicPolicyError` marker phrases for the same reason the write-gate
block below is rejected.

> **Correction, from the review pass.** An earlier version of this paragraph said
> the agent would re-forge the file "three times
> (`MAX_ARTIFACT_VERIFICATION_RETRIES`), then pausing". That constant is not the
> operative budget. `decideVerificationRetry`
> (`auto/verification-retry-policy.ts`) hashes `failureContext` and returns
> `pause` / `duplicate-failure-context` as soon as a retry repeats the previous
> hash, so a **constant** message buys exactly one re-dispatch and then pauses
> auto-mode. Both the old and the new message are constant, so both pause on
> attempt 2 -- the change does not reduce a retry count, and claiming it did
> overstated the harm. The message change stands on its own merit: one
> re-dispatch pointed at the DB and `gsd_plan_milestone` can succeed, whereas one
> re-dispatch pointed at the file it just wrote cannot. No test covers the
> pause-on-duplicate interaction for this message.

**`verifyScopedPlanMilestoneArtifact` gets the same check.** It has no production
callers yet -- only `validator-scope-parity.test.ts` -- but `guided-flow.ts`
names its wrapper as the migration target, so leaving the inner helper divergent
just plants the same bug for its first caller.

**Behaviour change worth naming.** `doctor-runtime-checks.ts`
(`orphaned_completed_units`) calls `verifyExpectedArtifact` and is
`fixable: true`; its fix deletes the completed-unit key. Any project with a
roadmap-on-disk / zero-rows milestone therefore gains a warning, and
`gsd doctor --fix` will drop its `plan-milestone` completed key so auto
re-dispatches planning. That is the correct diagnosis, but it is a change in the
command used during wedge recovery.

**Rejected: a write-gate HARD BLOCK on hand-written `ROADMAP.md`.** Blocking the
raw `Write` at source looks like the obvious third patch and is a trap.
`shouldRecordToolInvocationError` classifies by message *shape*, not by tool, so a
refusal worded like the neighbouring CONTEXT gate ("HARD BLOCK: ... This is a
mechanical gate") is recorded as `s.lastToolInvocationError`, matches
`isDeterministicPolicyError`, and drives `writeBlockerPlaceholder` -- which for
`plan-milestone` writes the stub roadmap `renderRoadmapFromDb` refuses to write,
inserts a fabricated `S00-blocker` slice with status `complete`, and advances the
pipeline. Worse than the reported bug: the milestone becomes permanently
"planned" with one fake complete slice and auto-mode executes a milestone with no
plan. Dodging all four marker phrases avoids the fabrication but leaves a
landmine for the next maintainer who normalises the message to house style, in a
file upstream changes often, and buys nothing this patch does not deliver.

**Two adjacent facts, both out of scope.** That fabrication path is reachable
today for any deterministic policy error raised during a `plan-milestone` unit.
And the fabrication is skipped entirely when `hasAdoptedMilestoneHistory(mid)`,
so in the adopted-history branch a plan-milestone unit can never verify -- before
or after this patch.

**Tests.** Four new DB cases in `plan-milestone-artifact-verification.test.ts`
(roadmap + real rows -> true; roadmap + zero rows -> false, the incident; roadmap
+ only an `S00-blocker` row -> false; zero-slice roadmap + real rows -> false,
the projection check still bites), each closing the database in `t.after` so the
four pre-existing no-DB cases stay order-independent. One diagnostic case via the
`_describeArtifactVerificationFailureForTest` seam. Two
`recovery-verify-logs.test.ts` cases passed only because they were declared
before the DB-opening cases in the same file; they now close the database
explicitly rather than depending on declaration order.

**End to end.** In the reported project, `gsd doctor` went from one ERROR
(`M002: Milestone M002 is missing its ROADMAP.md file`) to none, with **no**
`orphaned_completed_units` warning -- because M002's planning is now genuinely
backed by slice rows. `gsd headless query` shows M002 `active`, five slices, no
blockers, next dispatch `research-slice M002/S01`.

---

### 17. Judge milestone dependencies against all milestones under a scope lock -- `fc4a46bb`

**Symptom.** A `queued`/`planned` milestone could not be reached from any menu.
`/gsd auto M002` and `/gsd next M002` both rendered the idle three-option menu --
"Create next milestone" / "Quick task" / "Not yet" -- above the line "Resolve
milestone dependencies before proceeding.", and the only forward action mints a
*new* milestone ID. Naming `M002` on the command line appeared to have no effect.
Reproduced twice in `ngx-foundation-sites-gsd-pi`, at 0 slices and again at
`planned` with 5 slices and 17 tasks, so it is not specific to an empty milestone
(incident report kept out of the repo).

**Cause.** Not the menu. Naming a milestone exports `GSD_MILESTONE_LOCK`
(`commands/handlers/auto.ts` -> `auto.ts:441`), and `deriveStateFromDb` filters the
milestone list down to the locked ID -- correct, that is the point of the lock --
then built `completeMilestoneIds` **from that filtered list**. M001 was not in it,
so M002's satisfied `depends_on: ["M001"]` read as unmet, M002 was registered
`pending` rather than promoted, nothing became active, and phase fell to `blocked`.
`guided-flow.ts` shows the idle menu precisely because `activeMilestone == null`.
So passing the milestone ID is what *caused* the dead end, which is why it read as
an unrelated menu gap.

The live fixture, with the dependency plainly satisfied:

```
M001|complete|[]
M002|planned|["M001"]
M003|complete|[]
```

**Fix.** `buildCompletenessSet` reads the unfiltered list while
`buildRegistryAndFindActive` keeps the scoped one. Completeness is a whole-project
fact; the registry scoping is the contract and is unchanged. `parkedMilestoneIds`
widens with it and is inert -- the registry loop only visits scoped rows.

This also **closes a divergence rather than inventing a rule.**
`getActiveMilestoneId` (`state.ts`) already implements the intended lock
semantics: under a lock it returns the locked milestone if it is neither closed nor
parked, with no dependency check at all. Pre-patch, one process had
`getActiveMilestoneId` answering `M002` and `deriveStateFromDb` answering `null`.

**Two further defects on the same path.**

- *`handleNoActiveMilestone` inferred "unmet deps" from an entry merely having
  `dependsOn`.* The `queued-shell` push attaches deps on a branch only reachable
  once `depsUnmet` was already false, so a content-less shell with *satisfied* deps
  reported "Resolve milestone dependencies before proceeding." instead of the #1524
  orphan-row guidance and its `/gsd doctor fix` recovery path. Fixed at the
  inference, not the data: blanking `dependsOn` from the push would leave the wrong
  heuristic in place, and `registry[].dependsOn` is a shared surface --
  `guided-flow-queue.ts` maps it into the queue-reorder UI, where `liveDeps` drives
  redundant-dep detection and removal.
- *The blocker named every dep, not the unmet ones.* `M003 depends_on
  ['M001','M002']` with M001 complete emitted "waiting on unmet deps: M001, M002",
  sending the user after a milestone that needs nothing. Pre-existing, and exactly
  the same presence-is-not-unmetness confusion one level down. The #1524 message
  likewise now reads "no unmet dependencies": with the filter fixed, a shell whose
  deps are all complete reaches that branch for the first time.

**The corruption was durable, and that is the larger half of the patch.**
`guided-flow.ts` rebuilds the project's global `.gsd/STATE.md` from the scoped
derivation before every dispatch, which is why the fixture's STATE.md listed one
milestone and a false blocker -- and later sessions and agents bootstrap from that
file. New `saveStateProjection` (doctor.ts) declines the write, and **four** writer
families route through a guard, not the one the report implicated:

| writer | reached under a lock by |
| --- | --- |
| `rebuildState` | seven call sites: auto post-unit / pre-dispatch / resume, `doctor-proactive`, `gsd_skip_slice` |
| `updateStateFile` | `runGSDDoctor(fix:true)` at `auto.ts:2975`, after `captureMilestoneLockEnv` |
| `guided-flow.ts` x2 | the pre-dispatch rebuild that corrupted the fixture, plus the discuss path |
| `renderStateProjection` | `complete-task` / `complete-slice`, every unit, via `renderMilestoneShellProjections` |
| `doctor-runtime-checks` staleness repair | same `runGSDDoctor(fix:true)` path |

`rebuildState` is guarded **inside the function**, not at its call sites -- there
are seven and the list grows. The last two are not in the plan for this patch and
were added because without them its own acceptance criterion ("after a scoped run
STATE.md still lists M001, M002 and M003") is false: the doctor one would report a
false `state_file_stale` under a lock and then repair it *into* the truncated
projection, and `renderStateProjection` fires on every completed unit.

**The guard is exists-conditional, not lock-only, and that distinction is
load-bearing.** A lock-only guard reads as obviously correct and is wrong: an
*absent* STATE.md holds nothing worth protecting, two callers exist purely to
create it (doctor's `state_file_missing` fix, `doctor-proactive`'s pre-dispatch
rebuild), and worktree teardown (`clearProjectRootStateFiles`) deletes the
project-root copy under a lock. Declining there would leave the file missing for a
whole scoped run -- dropping the STATE section from every dispatched prompt via
`inlineGsdRootFile` -- while `doctor-proactive` still pushed "rebuilt missing
STATE.md before dispatch" into `fixesApplied` and notified the operator of a repair
that never happened, on every unit. So `rebuildState` now returns whether the write
happened and `doctor-proactive` honours it. For the same reason
`state_file_missing` **detection** stays unguarded: existence is a scope-independent
fact, staleness is not.

Skipping rather than re-deriving unscoped leaves STATE.md stale for the duration of
a scoped run. Stale-but-true beats fresh-but-wrong, and the next unscoped `/gsd` or
`gsd doctor` rewrites it. The upgrade path, if staleness ever bites, is to
re-derive with the lock env temporarily cleared, the way
`capture`/`restoreMilestoneLockEnv` already does at session boundaries.

**The legacy markdown path carries the same two derivation defects and is
deliberately untouched.** `_deriveStateImpl` truncates `milestoneIds` to the lock,
builds its own `completeMilestoneIds` from the truncated list, evaluates `depsUnmet`
against it, and repeats the dependsOn-presence heuristic. It is unreachable from
the live derive seam (which fails closed to `buildDbUnavailableState`) and its
deletion is the timebox-gated task T022. Named here so the next rebaser does not
read it as a missed hunk.

**Deliberately not built: the reported fix shape.** The report proposed a "Resume
queued milestone `<id>`" menu action in both idle-menu blocks. With
`activeMilestone` non-null the idle menu is never reached, so no menu action is
needed. One boundary remains, and it is the promotion policy rather than this
patch: for a genuinely *phantom* queued row -- no draft context, absent from the
PROJECT.md sequence -- `/gsd auto M002` still lands on the idle menu. What changed
there is the top line, from a false dependency blocker to the #1524
`/gsd doctor fix` guidance.

**Tests.** Five DB cases in `derive-state-db.test.ts` (locked out-of-scope dep
resolves; the unscoped derivation is unchanged, which guards against "fixing" the
first by widening the scope filter itself; a genuinely unmet dep still blocks; a
met-deps queued shell is not a dependency block; a blocker names only the unmet
subset). Six in a new `state-projection-scoped-write.test.ts` covering both guarded
writers, including the absent-file and no-lock counterparts. Four of the eleven go
red on the pre-patch source, verified by reverting the two source files; the rest
pass on it, which is what a regression guard should do.

**One test in that new file was vacuous on the first pass, worth naming.** The
`renderStateProjection` case originally ran with no database open -- so the
pre-patch code returned early at `!isDbAvailable()` and wrote nothing either, and
the "STATE.md is byte-identical" assertion passed with or without the fix. Only the
`{stale: false}` flag was load-bearing. It now opens an in-memory DB with milestone
and slice rows, which is what makes the write suppression actually measurable. Same
class as patch 16's `base`-guard trap: an assertion that cannot fail proves
nothing, and a green suite is not evidence that the mechanism is pinned.

---

### 26. A failure-context fence that swallows the retry prompt

`formatFailureContext` (`verification-gate.ts`) builds fenced markdown blocks
that `auto/unit-phase.ts` injects into a verification-retry prompt, appending
`\n\n---\n\n${finalPrompt}` after them. A code fence left open swallows the
instructions the retry exists to deliver: they reach the model as inert code
inside a block. **Three** independent ways it was left open, all pre-existing.

**A fence in the check's own output.** Blocks used exactly three backticks, so a
fence in the output -- a markdown linter, a doc test echoing a snippet, a
formatter over `.md` -- closed the block early, the rest leaked as prose, and the
block's own closing delimiter OPENED a new one. Fixed by sizing each delimiter
past the longest backtick run in the output, the standard fenced-block rule.

**A newline in `check.command`.** A `###` heading is one line. Measured, 3 of 6
command shapes escaped the block this way. Not theoretical: `discoverCommands`
splits and validates task-plan verify lines, but preference commands are neither
split nor validated (`verification-gate.ts:228-234`), and "prose executed as a
shell command" is a documented GSD failure mode. Fixed by flattening whitespace
in the heading, which repairs the broken heading at the same time.

**The total cap slicing mid-block.** `MAX_FAILURE_CONTEXT_CHARS` sliced the
joined body at a character offset, which lands anywhere. The cap is now spent per
block while assembling, so the body ends at a block boundary.

**Block-granular capping regresses the cap to unbounded on its own**, which is
why two companions are not optional. The first block is kept unconditionally so
at least one failure survives, and `check.command` was itself unbounded -- a
failing `node -e "<40 KB script>"` produced a measured 40,196-char body against a
10,000 cap, because the per-check cap covers the OUTPUT, not the command. So the
command is bounded too, cut on code points (the sibling `truncate` cuts on
character boundaries for the same reason and cannot be reused: its marker carries
a newline, which a heading cannot). The old hard slice stays as a backstop.

**The backstop is unreachable, and the invariant that keeps it so is recorded on
the constant.** Measured worst single block: **6,383** chars against the 10,000
cap, peaking at 2,034 backticks of stderr -- the largest input `truncate` still
returns unchanged. The intuitive `output + command + overhead` formula gives
2,460, a **3x** underestimate, because `fenceFor` sizes each delimiter past the
output's longest backtick run and emits it twice. That matters: a maintainer
raising `MAX_FAILURE_OUTPUT_PER_CHECK` on the naive reading would see 3,000 as
obviously safe when the true worst becomes ~9,300, and 3,300 would take the
backstop live silently. The docblock on `MAX_FAILURE_CONTEXT_CHARS` now carries
the real formula and names the OUTPUT cap -- not the command cap -- as the term
that sizes the delimiter line.

**Counting fences to balance them was tried inside patch 22 and withdrawn.**
Backtick-run parity cannot distinguish this function's own delimiters from a
fence inside a check's output, so one stray content fence flips the parity and a
body that really does end mid-block reads as closed -- defeating the guard in
exactly the case it exists for.

**Tests** (6 in `verification-gate.test.ts`) assert balance by *rendering shape*,
via a `fencesBalanced` helper following the CommonMark closing rule, rather than
by counting -- a check's own fences legitimately appear. Every production hunk
reddens exactly one test. Two traps worth naming:

- **The block-boundary test needed a per-check end marker to bite at all.** With
  uniform filler a mid-block slice leaves no trace, and the backstop's re-close
  hides it from a balance check. Written without the marker, it passed with the
  per-block cap deleted.
- **"an under-cap body is returned unchanged" survives every mutation** of this
  patch's hunks. It is a golden characterization pin, not a fifth mutation check;
  what it does catch is the `Math.max(3, ...)` floor in `fenceFor`.

---

### 27. A Windows control-file race is retried where it happens

A projection write publishes a control file through a Windows-safe dance -- write
`.intent.prepared`, rename to `.intent`, swap the target, clean up. The module
calls `persistMutation` from 21 sites, six times in one real write flow, always
over the same few filenames, so a single write is a burst of
create/rename/delete on one logical path. Anything holding a freshly created file
for a few milliseconds -- real-time antivirus on a scanned volume -- lands inside
that burst and escapes as a hard failure that can wedge a Task completion.
`gsd-recover-aborted-task` lists the resulting
`Task completion PLAN projection failed: native projection root identity locking failed`
among the stuck states operators hit.

Two codes observed, both on `.json.intent`: **5** `ERROR_ACCESS_DENIED` (a
delete-pending file) and **183** `ERROR_ALREADY_EXISTS`. The 183 mechanism is
**not** established -- a Rust `create_new` open of an existing file yields
`ERROR_FILE_EXISTS` (80), so the obvious "CREATE_NEW found a leftover" story is
probably wrong. The fix depends on neither story, which is why it matches no
paths.

**Retry, do not reclassify.** The race is millisecond-scale and the module
already has a bounded `[5,10,20,40]` ms ladder sized for it. Routing it to the
Task recovery budget instead would re-dispatch the entire Task at model cost, up
to twice, to absorb a file race -- and would have widened the wrong predicate.
There are two: `isTransientProjectionLockError` (`projection-root-errors.ts`)
drives the recovery classifier, `isTransientProjectionRootLockError` drives the
in-process ladder. Only the second is widened. The classifier is the backstop for
failures that survive the retry and deserves its own decision.

**The ladder covered one acquisition and no writes.** `withManagedProjectionRoot`
calls `openManagedProjectionRoot` bare; exactly 1 of 11 acquisition sites goes
through the ladder, and nothing covered a write made while the lock is already
HELD -- which is what the observed failure is. So the wrap is added at
`persistMutation`, the only site observed failing.

**Placement replaces pattern-matching.** At the call site we already know we are
inside the control-file dance, so the predicate never has to answer "is this
error ours" -- which it could not: `rename_windows_handle`,
`delete_windows_handle`, `sync_windows_control_parent` and the writes in
`write_windows_control_intent` all map through `projection_error` with no path, so
a message-scoped rule would refuse the same race landing one syscall over and
present as "fixed but still flaky".

**Safe to retry, verified against the Rust rather than assumed.**
`write_windows_file` runs `recover_windows_control_publication` at the head of
every call (`projection_root_identity_lock.rs:1715`), so an attempt takes the
same path a process restart would. A leftover it cannot reconcile surfaces as
`control publication intents conflict`, which is not transient-shaped and so is
not retried.

Two details in the predicate:

- **Match the `os error N` token, never the prose.** The human-readable half is
  OS-localized; the captured failures are Danish. An English substring would pass
  a test on an English host and never match in production on this one -- the same
  class of bug as the one being fixed.
- **`(?![0-9])` on every code.** A bare `os error 5` also matches `os error 53`
  (`ERROR_BAD_NETPATH`), `55` and `59`; `os error 183` matches `1832`; the
  pre-existing `os error 32` clause had the same latent hazard against `321`.

**Known limits, recorded so the next rebase does not rediscover them:**

- **Sibling `handle.removeFile` calls are unwrapped.** They run the same recovery
  head over the same `.gsd-control-*` filenames in the same burst. Recurrence one
  syscall over is the predicted outcome, not a surprise; this is a scope decision
  on the evidence, not a claim they are safe.
- **The retry multiplies exposure to a pre-existing permanent-wedge window.**
  `encode_windows_control_intent` hardcodes `sequence: 1`, and a failure landing
  between the second prepared-intent write and the current intent's deletion
  leaves both at sequence 1, which recovery rejects forever as
  `control publication intents conflict`. Not a regression -- a process restart
  wedges identically -- but five attempts means up to five passes through it, and
  the operator-visible error text changes from `os error 5` to the conflict
  message.
- **Cost is per retried operation, not per failure.** A recovery pass calls
  `persistMutation` once per stale journal entry, so a genuinely denied directory
  with N entries costs a multiple of ~75 ms, synchronously, since the default
  `wait` is `Atomics.wait` on the main thread.
- **Not Windows-only.** Rust renders errno the same way everywhere, so
  `os error 5` is `EIO` on Linux/macOS and a real I/O error there now retries four
  times before surfacing.
- **Two predicates now disagree about code 5**, with upstream tests pinning the
  other side. See FORK.md's acceptance list, which carries
  `projection-root-errors.test.ts` and `runtime-invariant-modules.test.ts` for
  exactly this reason.

**Tests** (7 in `managed-projection-root-retry.test.ts`), each mutation-checked.
`os error 32` needed a **constructed** fixture to be pinned at all: the captured
messages for it also carry the English "sharing violation" token, which the
predicate matches on its own, so the numeric branch for the code this ladder was
originally built for was otherwise dead. Deliberately **not** asserted: that every
attempt writes identical bytes -- `path` and `content` are consts pushed by
reference, so any such check compares a value to itself and holds even if they
were recomputed. The property is real and load-bearing, but structural; a test
that cannot fail is worse than no test.

**The flaky suite is not an acceptance test for this patch.**
`custom-task-host-verification.test.ts` fails roughly one run in three, so neither
a green run nor a red one proves anything. FORK.md's claim that it was "all clean"
is corrected in the same pass.

---

### 28. Steering never reached a query already in flight

`steer` did not redirect work in flight: a message typed mid-unit surfaced only
when the unit ended, indistinguishable from `followUp`. `stream-adapter.ts` calls
`query()` **once per GSD unit** and the SDK runs Claude Code's whole agent loop
inside it, while `buildSdkQueryPrompt` handed that call either a plain string or
an iterable that yielded once and completed -- shutting the input side before the
turn began, so there was nothing for a steer to reach.

**Measured before any code was written**, per the plan's own gate. A scratchpad
harness drove `query()` in streaming-input mode against the SDK's own binary with
a five-tool prompt, pushing a message the instant the first `tool_use` appeared:

| priority | outcome | turns | cost |
| --- | --- | --- | --- |
| unset | steer acted on after **1 of 5** tool calls | 2 | $0.641 |
| `'now'` | steer never delivered; query ended after the first tool result | 2 | $0.033 |

So a multi-tool unit is NOT one long CLI turn, and this buys a tool round rather
than a unit. `priority` is declared on `SDKUserMessage` with no doc comment and
the one run that set it lost the message and abandoned the work, so it is left
unset. Both n=1.

**The seam already existed, and finding it is what kept the patch to one file.**
`agent-loop.ts` spreads the whole `AgentLoopConfig` into the options it hands the
provider, and `getSteeringMessages` is a member of it -- so the drain callback has
been arriving at `streamViaClaudeCode` all along, absent only from the
`SimpleStreamOptions` TYPE. Declaring it on the adapter's own
`ClaudeCodeStreamOptions` consumes it with no upstream contract change, no new
cross-package dependency and no module-level global. A review round had already
concluded the patch was BLOCKED for want of exactly this seam, having traced the
queue forward and the contract backward without ever reading the call site. The
plan keeps that mistake on the record: **reading types is not reading code.**

**Draining bounds delivery to at-MOST-once, and that asymmetry is the sharp
edge.** Draining removes the message from the agent's queue, so a drain that
cannot deliver destroys user input rather than delaying it -- strictly worse than
the bug being fixed. Review found three such windows; the drain is now guarded by
whether the channel can still deliver (not on the terminal `result`, not once
`options.signal` is aborted, not once the attempt controller has been aborted for
a retry), leaving the steer in the queue for the agent loop instead. One window
is not closeable from here: the SDK's `streamInput` checks its abort flag AFTER
pulling a message and before writing it.

**`interrupt()` is deliberately refused** even though streaming mode makes it
available and it would land a steer immediately. A GSD tool call is frequently a
durable mutation, and an aborted tool resolves synthetically while the real work
continues in the background -- the mutation completes with nobody recording its
result. That is the corruption the fork's projection-lock and dispatch-ledger
patches exist to prevent.

Two more things review found, both silent-data-loss shaped:

- **The queue is not user-steers-only.** `sendCustomMessage` enqueues role
  `custom` records carrying customType/display/details; re-emitting one as a
  plain SDK user message would mangle it and drop it from the transcript. Only
  role `user` is taken.
- **Steer images were being dropped.** `queueSteer` accepts them and the RPC mode
  passes them, and because the message is drained here it never reaches the agent
  loop either -- so dropping them lost them outright. They are carried through.

**Known limits.** A steer delivered this way never enters the pi transcript, so
it is not rendered, not persisted, absent from the next unit's prompt, and the
queued-message badge does not decrement until the next prompt or session change
-- closing any of that needs a `gsd-agent-core` change. A steer pushed to a failed
attempt is not replayed. And CLI teardown changes shape for every unit: the SDK
sets `isSingleUserTurn` from `typeof prompt === "string"` and no longer calls
`transport.endInput()` on a result, so CLI-side on-EOF work now runs under a
parent-initiated close. Argv is identical and cleanup flushes before a bounded
wait, so no orphan -- but the probe measured delivery, not teardown.

**Two test traps worth naming**, both the same class the fork keeps meeting:

- **The wiring test passed for the wrong reason.** Its fake query never iterated
  `args.prompt`; draining the channel after the stream settled measured whatever
  was stranded at close -- the bug itself -- and would have passed in a world
  where the SDK never read the channel. It now consumes the channel from inside
  the fake, concurrently with the turn.
- **A hang is not a failure.** The waiter list must release EVERY parked reader,
  since the channel is re-iterated per retry attempt. The test pinning that was
  unbounded at first, so under mutation a stranded reader killed the whole run
  and the battery reported "nothing reddened". It is `{ timeout }`-bounded now.

The terminal-drain guard is pinned by counting queue READS rather than
deliveries, because the delivered count is 1 either way.

## The SDK bump 0.2.83 -> 0.3.229

Not a patch: a fork-local dependency decision, so it is listed separately and is
not written to be cherry-picked. Commit `04752ca8`.

**This closes the open question below** under *Investigated and rejected -- Flat
elicitation capability*: "something produced the error, re-measure the next time
it reproduces." It reproduced, and this is the cause.

`package.json` pinned `@anthropic-ai/claude-agent-sdk` at exactly `0.2.83`. The
CLI bundled in that release (claude-code **2.1.83**) builds its MCP client as
`{capabilities:{roots:{}, ...j ? {elicitation:{form:{},url:{}}} : {}}}` where
`j = m8("tengu_mcp_elicitation", !1)` -- a client feature flag defaulting to
**off**. It therefore advertises `{"roots":{}}` verbatim, which is exactly what
patch 8's diagnostics recorded four times:

```
{"kind":"elicitation-failed","error":"Client does not support form elicitation.",
 "capabilities":{"roots":{}},"clientInfo":{"name":"claude-code","version":"2.1.83"}}
```

**Measured on the wire, not inferred.** The bundled 2.1.229 binary's capability
factory reads `{roots:{listChanged:!0}, elicitation:{}, ...}` -- unconditional;
the flag name survives only in the `tengu_mcp_elicitation_shown` /
`_response` telemetry events. Confirmed against a stub MCP server that records
the `initialize` params it is sent, driven by `claude mcp list` (a health check,
so no model and no tokens):

| | advertised capabilities | client version |
| --- | --- | --- |
| before | `{"roots":{}}` | 2.1.83 |
| after | `{"roots":{"listChanged":true},"elicitation":{}}` | 2.1.229 |

`elicitation: {}` is the flat shape the MCP SDK's `ElicitationCapabilitySchema`
preprocess upgrades to `{ form: {} }`, which `elicitation-capability.test.ts`
already pins end-to-end over a real transport with real negotiation.

**Peer floors.** `@anthropic-ai/sdk` to `^0.93.0` (the SDK peers `>=0.93.0`) and
`@modelcontextprotocol/sdk` to `^1.29.0`. Each workspace package declares its own
range, so `packages/mcp-server` -- the package that actually elicits -- is raised
too; bumping only the root leaves the floor unraised where it matters. (The
v1.14.0 edition also raised `packages/cloud-mcp-gateway`; upstream **deleted**
that package, along with `packages/gsd-cloud`, before v1.15.0, so the bump now
touches only the root and `packages/mcp-server`.) `packages/pi-ai` and
`packages/daemon` keep their
own `@anthropic-ai/sdk` pins: neither imports the agent SDK, and nothing under
the root `src/` imports `@anthropic-ai/sdk` at all.

**The packaging change, and the Windows path it broke.** 0.3.x no longer ships
`cli.js` in the main package -- the CLI moved to platform
`optionalDependencies`. That deletes the file `resolveBundledClaudeCliPath()`
looked for, and the whole PATH-lookup block in `stream-adapter.ts` existed only
because the SDK treats a non-`.js` path as a native binary and chokes on npm
`.cmd` shims, with `cli.js` as the Windows escape hatch. With no `cli.js` left to
normalize onto, the block is gone and `pathToClaudeCodeExecutable` is no longer
passed: the SDK resolves its own version-locked binary when the option is
omitted, and throws `Native CLI binary for <platform>-<arch> not found. Reinstall
@anthropic-ai/claude-agent-sdk without --omit=optional, or set
options.pathToClaudeCodeExecutable.` otherwise.

`readiness.ts` is untouched and must stay -- probing the PATH `claude` for install
and auth state is a separate question from which binary the SDK executes. The
`cli.js` reference in `referencesClaudeCodeExecutable` also stays: it feeds
`findConcurrentClaudeCodeProcesses`, which detects *other* Claude Code processes,
and bumping this repo's SDK does not stop 0.2.x-based tools from spawning
`cli.js`.

**Three consequences, stated rather than buried.**

- **Which binary runs changes**, from the user's PATH install to the bundled
  version-locked one. This is what makes the elicitation fix deterministic --
  otherwise whether the bug is fixed depends on the user's PATH `claude`. Auth is
  unaffected; it comes from `~/.claude` credentials, not the binary.
- **`--omit=optional` installs lose their fallback.** They previously degraded to
  `claude.cmd` from PATH; now they get the SDK's error. Keeping `getClaudePath()`
  as a *fallback* (bundled first, PATH second) is the alternative if that ever
  becomes unacceptable.
- **The platform package is not a this-host-only cost.** It is a transitive
  optional dependency of the SDK, so the matching build (~90 MB packed /
  ~274 MB unpacked; here `claude.exe` at 287 MB) also lands on every linux-x64 CI
  runner and inside the Docker image, whether or not
  `pathToClaudeCodeExecutable` was ever passed.

**Typed API risk measured, not assumed.** `buildSdkOptions` returns
`Record<string, unknown>`, so a renamed or dropped option fails **silently** --
the unit tests assert on the object gsd-pi *builds*, not on what the SDK
consumes, and no existing check covers it. Diffing the `query` `Options` type:
**0 keys removed, 0 renamed**, and all **15** keys `buildSdkOptions` sets are
present in the 64-key type at 0.3.229 -- `model`, `includePartialMessages`,
`persistSession`, `cwd`, `permissionMode`, `allowDangerouslySkipPermissions`,
`settingSources`, `systemPrompt`, `disallowedTools`, `allowedTools`,
`mcpServers`, `strictMcpConfig`, `betas`, `thinking`, `effort`. The type is
byte-identical between 0.3.227 and 0.3.229. Re-run this diff at every SDK bump.

> **The "28 keys" in earlier editions of this file was never reproducible.** The
> `return {` literal sets 15 static keys plus the caller-supplied
> `...sdkExtraOptions` passthrough, whose members are not statically knowable.
> When re-running, extract from the return literal itself and include the
> SHORTHAND members (`permissionMode,` `settingSources,` `disallowedTools,`) and
> the conditional spreads -- a naive `key:` scan finds only 9 of the 15.

**Installing on this host.** `pnpm install` aborts on the `@opengsd/gsd-browser`
postinstall, so use `--ignore-scripts` and then re-run
`node scripts/link-workspace-packages.cjs` -- see
[FORK.md](FORK.md#the-claude-agent-sdk-bump). `--ignore-scripts` does not affect
the platform binary: the SDK packages declare no `scripts` and the platform
packages are pure payload.

## Review pass -- patch 17

Two reviews over patch 17, run in parallel from the same commit -- one **blind**
(diff and codebase only, forbidden from reading the plan or the bug report) and one
**informed** (given the plan, the report, and this file, and asked to judge
fidelity). Seven findings between them, six of which both reached independently.
All are folded into the patch commit.

| Finding | Reached by | Outcome |
| --- | --- | --- |
| A lock-only guard suppresses *creation*, so a caller reports a repair that never happened | both | **fixed** -- exists-conditional guard |
| `rebuildState` discards the declined-write signal | both | **fixed** -- returns `boolean`, `doctor-proactive` honours it |
| The doctor guard also suppressed `state_file_missing` **detection** | both | **fixed** -- guard moved onto the staleness branch |
| The blocker names met deps as unmet | both | **fixed** -- unmet subset only |
| #1524 message says "no dependencies" on a branch now reachable with deps | blind | **fixed** -- "no unmet dependencies" |
| The `renderStateProjection` test was vacuous (no DB, so nothing to suppress) | blind | **fixed** -- in-memory DB + rows |
| "the lock is always set in auto mode" is false -- plain `/gsd auto` sets none | blind | **fixed** -- comment and commit message corrected |

**The most valuable finding is the one that says the obvious guard is wrong.** Both
reviewers converged on it from opposite directions: skip-if-locked reads as
self-evidently safe, and it silently degrades "do not overwrite the truth" into "do
not write at all". The reachable path is concrete -- `.gsd/STATE.md` is gitignored,
so a fresh worktree has none, and `clearProjectRootStateFiles` deletes the
project-root copy at teardown; under a lock, nothing else could then create it,
because this patch had just guarded every other writer. `doctor-proactive` would
have notified "rebuilt missing STATE.md before dispatch" on every unit of a run in
which STATE.md never existed. **A guard that makes a state unreachable must be
checked against the callers whose entire purpose is to reach it.**

**Guarding a check and guarding a repair are different decisions.** The doctor guard
was first placed on the outer condition, which suppressed the `state_file_missing`
*diagnostic* along with the write -- so the one surface that would have told the
operator the projection was gone reported clean. Existence is scope-independent;
staleness is not. Only the scope-dependent judgement may be skipped.

**Two findings are the patch's own thesis applied one level down.** It exists
because "has `dependsOn`" was mistaken for "deps are unmet" -- and it then printed
every dep in the blocker, and told the user a milestone had "no dependencies" when
it had satisfied ones. Neither was a regression; both were the untouched remainder
of the same defect, and neither reviewer let the "pre-existing" label settle it.

**The blind/informed split earned its cost.** The informed reviewer verified
fidelity and confirmed the plan's disagreement with the bug report (tracing
`parseMilestoneTarget` -> `GSD_MILESTONE_LOCK` -> scope filter -> `depsUnmet` ->
idle menu), and cleared the guard's blast radius across every STATE.md reader. The
blind reviewer, with no plan to anchor on, produced the two findings the plan could
not have contained -- the vacuous test and the false comment -- because it had no
document telling it what the code was supposed to do.

## Review pass -- patches 15 and 16

Three rounds of review over patches 15 and 16 -- one informed, then one dedicated
code-reviewer per patch -- raised nine findings. All nine were real and are folded
into the patch commit they belong to, so each patch stays independently
cherry-pickable; two were accepted only as corrections to this document. As with
the earlier pass, the reasoning is recorded because it is what stops the wrong
version being re-introduced.

| Finding | Patch | Outcome |
| --- | --- | --- |
| Bare `refresh` can strand a null DB handle -> `doctor --fix` prunes live records | 16 | **fixed** -- `ensureWorkflowDbForBase` |
| `status='active'` trusted as liveness -- dead holder, no lease owner | 15 | **fixed** -- `kill(pid, 0)` guard |
| Inherited worker id bypasses a documented fail-closed return | 15 | **fixed** -- gated on `isAutoActive()` |
| `hasPlannedMilestoneSliceRows` reads a process-global DB with no base check | 16 | **fixed** -- `base` guard, fail soft |
| Path guard fails open when `.gsd` is unresolvable | 16 | **fixed** -- `isSameFilesystemPath` |
| The conjunct restricting an inherited id had no test at all | 15 | **fixed** -- two cases added |
| Normalization only pinned by a Windows accident; green on Linux CI | 16 | **fixed** -- portable pin added |
| Retry budget for a constant message is 1, not 3 | 16 | **docs corrected** |
| Trust boundary wider than claimed: every descendant inherits the env var | 15 | **docs corrected**; code change rejected |

**Three of patch 15's four are the same underlying mistake: trusting the inherited
id too much.** The env hop makes the id available; it does not make it evidence. The
holder row must be present, `active`, on this host, *and* its process alive before
the id means anything, and none of that may substitute for in-process ownership
when auto is active in this very process.

**Three were invisible to the tests as first written, in three different ways.**
Both of patch 15's original cases run with `isAutoActive()` false, so neither could
see a regression on the in-process path. Deleting patch 15's entire restricting
conjunct left every test green, because the id comparison alone carried them. And
patch 16's normalization was pinned only by a host accident -- the same assertion
that catches it here would have passed on Linux CI. Each fix now has a case that
goes red when that fix alone is disabled, verified one fix at a time rather than as
a batch.

**The worst finding was not in the patch's own logic but in what it amplified.**
`refreshWorkflowDatabaseFromDisk` was already a close-then-reopen with a
process-wide failure mode, and the plan-slice branch already called it; patch 16
moved that call onto plan-milestone and ahead of every file check, which is what
put it in `doctor --fix`'s deletion loop. The lesson worth keeping: adding a
DB-authoritative check to a verification function also enrolls it in every caller
that *acts* on the result, and one of them deletes state.

**Two review claims were checked and did not hold.** `forensics.ts` was described
as calling `verifyExpectedArtifact` once per root to *discriminate* project root
from worktree; it is an `||` over both roots, and `gsdRoot` short-circuits on a
worktree contract and returns the project `.gsd`, so both resolve to the same DB
and the OR is unaffected. The related worry that a worktree base would mismatch
the new path guard fails for the same reason.

**The base-guard fix was nearly worse than the bug it fixed.** The guard is right,
but the obvious implementation -- a bare `!==` between the two paths -- silently
disables patch 16 on this host and made three "must reject" tests go green. See the
measured table in patch 16 above. Accepted only with `isSameFilesystemPath`, plus a
portable pin, plus the `ensureWorkflowDbForBase` change that keeps a failed reopen
from stranding a null handle.

**Accepted as prose only.** The fact is correct: `sdkOptions.env`
reaches every descendant of the dispatch, including Bash-tool subprocesses, not
just the workflow MCP server, and the original wording in patch 15 used
"descendants" to argue a narrower boundary than it earns. That section now states
it plainly. The proposed code change -- compare the canonical milestone root --
was rejected for the same reason `project_root_realpath` is not compared: it
re-wedges worktree sessions, which is the defect patch 15 exists to fix.

## Review pass

A review over every patch on the branch raised eight findings. Six were real and
are folded into the patch commits they belong to -- there is no separate
"review fixes" commit, so each patch stays independently cherry-pickable. Two
were rejected, and both are recorded here because the reasoning is what stops
them being re-raised.

| Finding | Patch | Outcome |
| --- | --- | --- |
| `<check> && echo <marker>` classified as prose | 11 | **fixed** -- regression |
| Legacy stamped baseline reports false drift | 4 | **fixed** |
| `GSD_VERIFICATION_SHELL` given bash-only argv | 5 | **fixed** |
| `??` chain resolves before normalization | 6 | **fixed** |
| Flat-phase ids not deduped, digits unbounded | 2 | **fixed** |
| Unbounded `diagnostics.jsonl` | 8 | **fixed** |
| Marker word as a bare operand reads as prose | 11 | **known trade-off**, wording widened |
| Fence disagrees with `managedProjectionTarget` | 3 | **rejected** -- premise wrong |

**The one real regression was patch 11's.** `test -f dist/index.js && echo
exists` -- the canonical verify idiom -- flipped from command to prose, because
the marker is the last token, so the "trailing run of bare English words" was the
single word `exists` and satisfied `every` vacuously. The check was then skipped
as unverified. Neither the patch's tests nor its documented trade-off covered a
shell operator, which is what let it through: every test case was a single
segment. The two guards added in response can only move a line from prose back to
command, and only inside the flags-present branch, so neither can newly call
anything prose.

**Rejected: the fence does not need `managedProjectionTarget`'s home guard.** The
review noted that patch 3 gave `managedProjectionTarget` an
`isSameFilesystemPath(current, gsdHome())` guard but gave `projectionDatabasePath`
only the external-store boundary, and read the asymmetry as the fence guarding the
wrong database for a path under the global `~/.gsd`. The two functions want
different things. `managedProjectionTarget` returns `null` there because it needs
`dirname(.gsd)` as a **lockable** `targetRoot`, and that is the user profile,
which can never be locked exclusively on Windows. `projectionDatabasePath` only
names a database, and for a file genuinely under `~/.gsd` the governing database
*is* `~/.gsd/gsd.db`. Nor does the claim reach the profile: `projectionClaimPath`
is a lock **file** beside the database (`<db>.projection.lock`), so OS error 32 on
the profile directory never enters into it. Symmetry here would be a bug, not a
fix.

**Trade-off widened, not narrowed.** Patch 11's known trade-off was recorded as
an unquoted marker word in the FINAL operand position (`git grep -n the`). It is
broader than that: any trailing run of bare-word operands starting at a marker
reads as prose, so `grep -rn contains src` is skipped too. The behaviour is
unchanged and still the fail-safe direction -- a quoted marker, or one carrying a
path separator, dot or uppercase, is unaffected -- but the wording understated the
reach and now says so.

## Investigated and rejected

### Flat elicitation capability -- withdrawn, premise falsified

**Reported symptom (real).** `Client does not support form elicitation.` -- no
dialog appears, the model prints the options as prose the user cannot answer,
and an approval gate with no remote channel becomes unanswerable. Observed
twice on 2026-08-10.

**Hypothesis (wrong).** Claude Code negotiates protocol `2025-11-25` but
advertises the older flat `elicitation: {}`; the MCP SDK requires
`elicitation.form`, so it refuses the request server-side. A capability probe
recorded the flat shape:

```json
{"protocolVersion":"2025-11-25","clientInfo":{"name":"claude-code","version":"2.1.223"},
 "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
 "hasElicitation":true,"hasElicitationForm":false}
```

A shim was written to issue `elicitation/create` directly for such clients,
since that method asserts only the flat capability.

**Why it was withdrawn.** The SDK already does this itself.
`ElicitationCapabilitySchema` carries a backwards-compatibility `z.preprocess`
that rewrites an **empty** elicitation object to `{ form: {} }`:

```js
const ElicitationCapabilitySchema = z.preprocess(value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) { return { form: {} }; }
  }
  return value;
}, /* ... */);
```

Verified present in **1.27.1, 1.29.0 and 1.30.0** -- the whole range this package
can resolve from `^1.27.1`. Confirmed end-to-end: a raw JSON-RPC client sending
`elicitation: {}` verbatim is seen by the server as `{ form: {} }`, and
`ask_user_questions` completes normally. The shim's branch was unreachable.

Two traps worth recording, because both produce a test that passes for the
wrong reason:

- The SDK **client** also normalizes the capability before sending, so a test
  built on the SDK `Client` cannot reproduce the flat shape at all.
- The probe's `hasElicitationForm: false` was read from **raw** initialize
  params, before schema parsing. It does not show what the SDK server concluded.

**ANSWERED -- what produced the error.** It reproduced on 2026-08-11 and patch
8's diagnostics named the cause on the first look: the client advertised
`{"roots":{}}`, i.e. **no elicitation capability at all**, not a non-empty one
missing `form`. The `tengu_mcp_elicitation` client feature flag in claude-code
2.1.83 defaults to off, so the preprocess had nothing to upgrade -- it only
rewrites an *empty* elicitation object, and there was no elicitation key. Fixed
by [the SDK bump](#the-sdk-bump-0283---03229); patch 14 is what makes the failure
recoverable for any client that still cannot elicit.

So the hypothesis was wrong in a specific, useful way: the shape was not
`elicitation: {}` (which works fine), it was *absent*. The probe that recorded
`elicitation:{}` was reading its own SDK client's normalized output, not what
claude-code 2.1.83 sent -- which is the second trap below, and why the raw-params
reading was misleading in both directions.

Still unmeasured, and left alone: a client advertising a **non-empty** elicitation
capability without `form` (say `{ url: {} }`) would still be refused, and the
preprocess does not cover it. No client is known to do that. Patch 14's
pre-check now reports that case accurately instead of deadlocking on it, which is
a better answer than a shim.

`elicitation-capability.test.ts` remains as the regression guard: it pins the
SDK's upgrade behaviour, so if a future SDK drops the preprocess that assertion
fails first and names the cause.

Two earlier attempts at this symptom, from a prior session, were also built and
deliberately reverted and should not be retried: faking `.form` (the client then
answers `cancel`, which maps to `waiting` and orders the model to re-ask -- an
infinite retry), and classifying the capability error as `timed_out` (the gate
stays armed). The approval gate failing closed is correct behaviour.

## Backlog

Defects documented by the `gsd-recover-aborted-task` skill that are not fixed
here. That skill was validated against **v1.13.0**, so every claim needs
re-checking against the current tree first.

B1, B2, B5 and B6 are now patches 10-13. Re-verifying them against v1.14.0
changed the diagnosis twice, which is the argument for re-checking rather than
porting. B3, B4 and B7 were each re-confirmed still open at **v1.15.0**:

- **B5** was recorded as "lock failures discard `error.cause`". The cause is in
  fact *created* correctly at the native throw site; two re-wrap sites drop it.
- **B6** was recorded as "headless drops trailing argv". `parseHeadlessArgs`
  collects the argv fine; the `doctor` branch ignores it.

**Verified still open at v1.15.0, and deliberately deferred:**

- **B3 -- `checkbox_db_status_divergence` is hardcoded `fixable: false`**
  (`doctor-engine-checks.ts:92`), so `doctor fix` and `doctor heal` skip it.
  This is a **policy** question, not a one-line fix. Making it fixable means
  re-rendering PLAN markdown over a human's manual edit, and the existing test
  `checkEngineHealth keeps PLAN checkbox divergence after stale projection flush`
  deliberately pins that PLAN task divergence *survives* the flush. Changing that
  needs a decision, not a patch.
- **B4 -- `recoveryActionId` is surfaced by no tool**, the only reason the runbook
  needs raw `sqlite3`. The id does exist in the MCP surface as a *required input*
  to `gsd_task_recovery_resume` (`packages/mcp-server/src/workflow-tools.ts`) and
  is produced at `artifact-verification.ts`; what is missing is a *read* path. A
  new query tool is a feature, and belongs in an upstream discussion rather than a
  fork patch.
- **B7 -- a timeout-clipped `rebuild markdown` reverts PLAN files.** Confirmed
  non-atomic: `rebuildMarkdownProjectionsFromDb` (`projection-worker.ts:73`;
  `commands-maintenance.ts` only re-exports it)
  quarantines, then calls `renderAllFromDb`, which walks files sequentially.
  Cross-file atomicity is a design change, and an honest test needs a mid-loop
  kill. The most dangerous item on the list and the least suited to being rushed
  in behind four others. **Citation corrected at the v1.15.0 rebase** -- earlier
  editions cited `commands-maintenance.ts`, which now only re-exports it.
**Planned, then shipped or withdrawn (2026-08-15):**

- **Steering never reaches a running query** -- a message typed mid-unit surfaces
  only when the unit ends. `stream-adapter.ts` calls the Agent SDK's `query()`
  once per GSD unit, and `buildSdkQueryPrompt` hands it either a plain string or
  an iterable that yields one message and completes, so there is no open input
  channel for the whole unit.

  **The mechanism was measured on 2026-08-15 and it works.** Driving `query()` in
  streaming-input mode against the SDK's own binary with a five-tool prompt, a
  message pushed during the first tool call was delivered and acted on after that
  single tool round -- the remaining four never ran. So a multi-tool GSD unit is
  **not** one long CLI turn, and steering latency would drop from one unit to one
  tool round without touching `interrupt()`. A second run with
  `priority: 'now'` (declared on `SDKUserMessage` with no doc comment) was a
  warning rather than a feature: the message was never delivered, the query
  returned after the first tool result having emitted no text, and the work was
  abandoned. Do not set `priority`.

  **SHIPPED as patch 28.** A review round concluded this was blocked for want of
  a seam to route the steer through, having traced the steering queue forward and
  the provider contract backward without reading the one line where the loop calls
  the provider -- `agent-loop.ts` spreads the whole `AgentLoopConfig` into the
  options, so `getSteeringMessages` was already arriving. Full record in the plan file.

- **Plumbing the failure text into the durable recovery record** -- WITHDRAWN
  before implementation. Three review rounds each falsified a premise it was built
  on: the `replan-task` prompt it was written for is unreachable by construction,
  and the `remediate` re-dispatch it was re-aimed at *already* carries the failing
  command and output via `auto/unit-phase.ts`. The residual scope is the
  `abort` -> `resume` path and four rarer ones, against a patch that touches three
  files, adds a `LEFT JOIN` to a hot query, and moves up to ~10 KB of unbudgeted
  text into every recovery dispatch. Poor trade. Two corrections it established
  are kept in plan 049's record.

**Investigated and CLOSED -- not a defect:**

- **B8 -- `renderPlanProjection` writes a different, unstamped document.**
  Raised while re-deriving patch 4, then **closed on evidence**.
  `workflow-projections.ts:106 renderPlanProjection()` renders through
  `renderPlanContent` and ends in a bare unstamped `atomicWriteSync`, refreshing
  neither the DB row nor the marker, while `renderPlanFromDb` renders through
  `renderSlicePlanMarkdown` and `writeAndStore`. The two outputs are not the same
  document -- measured at 170 bytes against 366, diverging at line 2 -- and in a
  legacy-layout project they resolve to the same file.

  **It is unreachable.** `renderPlanProjection` has no production caller, and had
  none at `v1.14.0` either; the only callers in the tree are tests.
  `renderAllProjections` is forbidden from calling it by the #3651 regression
  test (`tests/projection-no-plan-overwrite.test.ts`) precisely because it
  overwrote the authoritative PLAN.md with a simplified render that dropped
  Must-Haves / Verification / Files Likely Touched and corrupted multi-line task
  descriptions. Missing-file recovery calls `renderPlanFromDb`. Upstream's own
  `docs/dev/M003-S05-OVERENGINEERING-REVIEW.html` reaches the same conclusion and
  recommends deleting `renderPlanProjection` and `renderPlanContent` outright.

  **Do not patch this in the fork.** The correct disposition is upstream deletion
  of dead code, not a fork-local rewrite of a function nothing calls. Recorded
  here only so the next reader does not re-derive the same false lead -- as three
  successive editions of patch 4's own rationale did.

**Already fixed upstream -- do not port:**

- `detectStaleRenders` is no longer stubbed. It has a real implementation in
  `markdown-renderer.ts` and a live consumer in
  `state-reconciliation/drift/stale-render.ts`.
- The `task-completion-compatibility-adapter` failure `verified publication
  atomically closes only its task gates from durable Attempt evidence` was
  recorded against the **v1.14.0** base as failing there while passing on `main`,
  fixed by upstream `63254779` ("fix(gsd): classify staged task summaries
  consistently") plus `2e4ca77f` and `3037a37c`. The fork never touched that
  file. **Resolved by the v1.15.0 rebase**, which carries those commits; that
  base-versus-`main` distinction no longer exists, since `v1.15.0` and `main` are
  the same commit.

  The same entry predicted that **patch 12 would need re-deriving because
  upstream had moved the file**. It did not: `task-completion-compatibility-adapter.ts`
  is byte-identical across `v1.14.0..v1.15.0` and patch 12 replayed clean. Treat
  the prediction as open, not as fact.

## Maintenance

**Adding a patch:** write the failing test first and confirm it fails for the
documented reason; apply the fix; confirm it passes *because of* the fix; commit
test and fix together as one Conventional Commit. Then amend this file's commit
at the branch tip so it stays last.

**Fixing an existing patch:** fold the fix into that patch's own commit -- one
commit per patch is what keeps each independently cherry-pickable, and a separate
"review fixes" commit would break that. Commit the fix and its test as
`git commit --fixup=<patch sha>`, then `GIT_SEQUENCE_EDITOR=true git rebase
--autosquash <base tag>`. Verify the fold changed no content with
`git diff <pre-rebase ref> HEAD`, which must be empty. Two patches touching one
file is fine as long as their regions differ -- commit each fixup before editing
the file for the next, so each carries only its own delta. If the fix changes the
*shape* of the rule the commit message describes, reword that message too rather
than leaving a message that documents a narrower fix than the code performs.

**Always baseline before blaming yourself.** This tree carries test failures that
predate the fork. Stash and re-run before treating a red test as a regression --
counts and the procedure are in [FORK.md](FORK.md#expected-test-failures).

Patch 9 is the cautionary tale for that habit's *limit*: the baseline had been
recorded and worked around for long enough that 143 failures and a polluted
global `~/.gsd` read as normal. Baseline to avoid **misattributing** a failure,
not to avoid investigating one -- if a "pre-existing" failure sits in code the
current patch touches, read it before accepting it.

Rebuilding, rebasing onto a new upstream tag, and the house rules that survive a
rebase: **[FORK.md](FORK.md)**.
