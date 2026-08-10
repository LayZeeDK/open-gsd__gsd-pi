# Fork-local patches

Fork-local fixes carried on top of upstream `open-gsd/gsd-pi`, on branch
`LayZeeDK/dev`, based on tag **`v1.14.0`** (`aa8789b4`).

Every patch is one commit containing its own tests, written to be cherry-pickable
into an upstream PR. Nothing here is machine-specific: paths are discovered or
injected, never hardcoded.

This file is the only fork-only artifact on the branch, and it is deliberately the
last commit so cherry-picking a patch never drags it along.

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
| 1 | `cf3658a1` | MCP server PID verification on Windows | not filed |
| 2 | `9b8d4839` | flat-phase milestone ids | not filed |
| 3 | `3debdeb8` | external-state projection root | not filed |
| 4 | `d38bf763` | stamp-insensitive projection drift | not filed |
| 5 | `b1cb71c2` | POSIX verification shell on Windows | not filed |
| 6 | `310690f4` | non-array `ask_user_questions` payloads | not filed |
| 7 | `7925ba85` | validate-milestone prompt contract | not filed |
| 8 | `8c39929f` | record client capabilities on elicitation failure | not filed |
| 9 | `ab2d9e6e` | short path components in worktree guards | not filed |
| 10 | `301a21a3` | read-only engine health checks | not filed |
| 11 | `da4c30d7` | prose-suffixed `Verify:` lines with a flag | not filed |
| 12 | `d2f6b378` | `error.cause` in re-wrapped projection failures | not filed |
| 13 | `358f40db` | headless doctor argument refusal (**breaking**) | not filed |

One further patch was written and then **withdrawn** -- see
[Investigated and rejected](#investigated-and-rejected).

Six of these were hardened after a review pass over the whole branch -- see
[Review pass](#review-pass) for what was found, and what was rejected.

---

### 1. Verify existing MCP server PID on Windows -- `cf3658a1`

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

### 2. Map flat-phase directories to milestone ids -- `9b8d4839`

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

### 3. Keep external-state stores from escaping to the gsd home -- `3debdeb8`

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

### 4. Compare projections without the state-version stamp -- `d38bf763`

**Symptom.** `External modeled edit detected` hard-pausing `gsd auto` on work gsd
had produced itself.

**Cause.** `writeAndStore()` appends a `<!-- gsd:state-version=... -->` line and
stores the stamped bytes, while `workflow-projections.ts` writes the same logical
content unstamped and refreshes neither the DB row nor the marker. Four
comparison sites hashed raw bytes. `markdown-renderer.ts` already documented the
intended contract -- this restores it rather than changing policy.

**Deliberately excluded.** `.planning` projections are never stamped and their
sha is read raw everywhere else, so the `.gsd` map opts in explicitly. A test
pins that.

**Legacy baselines, and why no migration.** A marker baseline written *before*
this change stores a sha of stamped bytes, which stripping can never reproduce.
The reconcile detector heals itself -- `external-markdown-edit.ts` falls back to
`dbProjectionMatches` -- but the doctor compat-health line has no DB to fall back
to, so it would report every stamped projection as `N file(s) drifted -- run
/gsd sync` on a healthy repo immediately after upgrading, until something
re-rendered.

`countDrifted` therefore accepts the **raw** sha as well as the stripped one for
the `.gsd` map. That cannot mask real drift -- edited content matches the
baseline neither stripped nor raw, and a test pins that -- and it makes the
skill's one-time `.compat.json` migration unnecessary rather than merely
un-ported.

**Retires** `pai-gsd-pi-update` step 9e and `verify-stamp-insensitive-drift.mjs`.

### 5. Run verification commands in a POSIX shell on Windows -- `b1cb71c2`

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

### 6. Tolerate non-array `ask_user_questions` payloads -- `310690f4`

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

### 7. Make the validate-milestone prompt match the tool contract -- `7925ba85`

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

**Test caveat.** This is a contract test between the shipped prompt and the
tool's accepted payload -- it renders the prompt through the real loader and
asserts the required fields are documented. It cannot verify the prompt reads
well, only that the two artifacts agree.

**Adopts** the previously-unapplied `apply-validate-milestone-evidence-prompt.mjs`.

---

### 8. Record client capabilities when elicitation fails -- `8c39929f`

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

### 9. Expand short path components in worktree guard comparisons -- `ab2d9e6e`

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

### 10. Keep engine health checks read-only without repair -- `301a21a3` (B1)

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

### 11. Reject prose-suffixed verify lines that carry a flag -- `da4c30d7` (B2)

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

### 12. Keep `error.cause` in re-wrapped projection failures -- `d2f6b378` (B5)

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

### 13. Refuse headless doctor args that cannot be honoured -- `358f40db` (B6)

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

**What is still unexplained.** The error itself was real, so something produced
it. The preprocess only rewrites an *empty* object, so a client advertising a
non-empty elicitation capability without `form` (say `{ url: {} }`) would still
be refused. No client is known to do that, and guessing at a workaround is what
produced the withdrawn patch. Re-measure `getClientCapabilities()` **as the
server sees it** -- not the raw params -- the next time it reproduces.

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
porting:

- **B5** was recorded as "lock failures discard `error.cause`". The cause is in
  fact *created* correctly at the native throw site; two re-wrap sites drop it.
- **B6** was recorded as "headless drops trailing argv". `parseHeadlessArgs`
  collects the argv fine; the `doctor` branch ignores it.

**Verified still open in v1.14.0, and deliberately deferred:**

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
  non-atomic: `rebuildMarkdownProjectionsFromDb` (`commands-maintenance.ts`)
  quarantines, then calls `renderAllFromDb`, which walks files sequentially.
  Cross-file atomicity is a design change, and an honest test needs a mid-loop
  kill. The most dangerous item on the list and the least suited to being rushed
  in behind four others.

**Already fixed upstream -- do not port:**

- `detectStaleRenders` is no longer stubbed. It has a real implementation in
  `markdown-renderer.ts` and a live consumer in
  `state-reconciliation/drift/stale-render.ts`.
- The `task-completion-compatibility-adapter` failure `verified publication
  atomically closes only its task gates from durable Attempt evidence` fails on
  this v1.14.0 base but passes on `main`, fixed by upstream `63254779`
  ("fix(gsd): classify staged task summaries consistently") plus `2e4ca77f` and
  `3037a37c`. The fork never touched that file. Patch 9 also happens to repair it
  on this base. Note for the next rebase: **patch 12 touches a file upstream has
  already moved**, so expect to re-derive rather than re-apply.

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
