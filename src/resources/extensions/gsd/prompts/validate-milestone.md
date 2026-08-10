# Milestone Validation - Parallel Review

You are the validation orchestrator for **{{milestoneId}} - {{milestoneTitle}}**.

## Working Directory

Work in `{{workingDirectory}}`. All reads, writes, and shell commands MUST stay relative to it. Do NOT `cd` elsewhere.

## Mission

Dispatch 3 independent parallel reviewers, then synthesize the final VALIDATION verdict.

Remediation round: {{remediationRound}}. Round 0 is the first pass; later rounds must verify remediation slices resolved prior findings.

## Context

Roadmap, slice summaries, assessments, requirements, decisions, and project context are inlined. Start immediately.

{{inlinedContext}}

{{gatesToEvaluate}}

## Execution Protocol

### Step 1 - Capture Verification Evidence

Do this FIRST, before dispatching reviewers. `gsd_validate_milestone` refuses a
call whose planned verification classes are backed only by prose:

> planned <class> verification requires current structured database evidence;
> verificationClasses prose cannot authorize Milestone validation

Authorization comes from `verificationEvidence` — a structured array, not the
`verificationClasses` table. For every non-empty class in
`Verification Classes (from planning)`, run its check now and record one entry:

Every field below is REQUIRED unless marked optional, and the tool rejects any
key not listed here. Omitting one, or adding a `summary`/`notes` field of your
own, fails the whole call.

| Field | Value |
| --- | --- |
| `verificationClass` | exactly `Contract`, `Integration`, `Operational`, or `UAT` |
| `evidenceClass` | exactly `command`, `runtime`, `browser`, or `artifact`; one value per verification class |
| `rationale` | why this check authorizes that class |
| `commandOrTool` | the exact command or tool invoked |
| `workingDirectory` | the directory it ran in |
| `startedAt` | when the check started (ISO-8601) |
| `endedAt` | when it finished (ISO-8601) |
| `observation` | exactly `passed`, `failed`, or `inconclusive` |
| `durableOutputRef` | where the retained output lives (path or ref) |
| `testedSourceRevision` | the source revision the check ran against |
| `environment` | object of environment facts; must have at least one key |
| `sliceId` | optional; REQUIRED when the evidence satisfies a browser-required Slice |
| `exitCode` | optional; the process exit code |

```json
[{ "verificationClass": "Contract", "evidenceClass": "command",
   "rationale": "Contract suite covers every published entry point",
   "commandOrTool": "pnpm run test:contracts",
   "workingDirectory": "{{workingDirectory}}",
   "startedAt": "2026-01-01T10:00:00Z", "endedAt": "2026-01-01T10:02:11Z",
   "observation": "passed", "exitCode": 0,
   "durableOutputRef": ".gsd/evidence/contract-run.log",
   "testedSourceRevision": "<current revision>",
   "environment": { "os": "linux", "node": "22.18.0" } }]
```

Two rules the tool enforces, both of which fail the call outright:

- All entries for one `verificationClass` must share a single `evidenceClass`.
- Every `testedSourceRevision` must equal the CURRENT source revision. This is
  why evidence is captured before the reviewers run rather than after: a
  revision recorded before a long reviewer pass is still current when the tool
  compares it, and one recorded after intervening commits is not.

If a planned class cannot be checked, do not invent an entry. Carry the gap into
the verdict as NEEDS-ATTENTION or FAIL.

### Step 2 - Dispatch Parallel Reviewers

The Inlined Context above already preloads the evidence reviewers need — the roadmap, per-slice SUMMARY/ASSESSMENT excerpts, requirements, and verification classes. **Embed the relevant preloaded evidence directly into each reviewer's task prompt** so reviewers work from it instead of re-reading the same artifacts from disk. Each reviewer should read a full file only when its excerpt is missing, truncated, or internally inconsistent — never as a routine first step. When a reviewer needs a full artifact, use only explicit file paths from the On-demand Validation Artifacts / On-demand Milestone Context blocks or discover files with `find .gsd -type f`; never pass a phase, slice, `tasks/`, or `slices/` directory to `read` or `readFileSync`. This avoids three reviewers independently re-surveying artifacts the orchestrator already holds.

Call `subagent` with `tasks: [...]` containing ALL THREE reviewers simultaneously:

**Reviewer A - Requirements Coverage**
Prompt: "Review milestone {{milestoneId}} requirements coverage. Working directory: {{workingDirectory}}. Use the preloaded requirements and slice SUMMARY evidence embedded in this task — do not re-read them from disk. For each requirement, mark COVERED, PARTIAL, or MISSING against that evidence. Read a full SUMMARY only from an explicit file path in the On-demand Validation Artifacts list, or discover candidates with `find .gsd -type f -name '*-SUMMARY.md'`; never read a directory path. Output table: Requirement | Status | Evidence. End with one-line verdict: PASS if all covered, NEEDS-ATTENTION if partials exist, FAIL if any missing."

**Reviewer B - Cross-Slice Integration**
Prompt: "Review milestone {{milestoneId}} cross-slice integration. Working directory: {{workingDirectory}}. Use the preloaded roadmap and slice SUMMARY evidence embedded in this task — do not re-read them from disk. Find the boundary map (produces/consumes contracts) in the roadmap. For each boundary, confirm producer SUMMARY produced the artifact and consumer SUMMARY consumed it. Read `{{roadmapPath}}` or a full SUMMARY from the On-demand Validation Artifacts list only if the preloaded evidence is missing, truncated, or inconsistent; never read a directory path. Output table: Boundary | Producer Summary | Consumer Summary | Status. End with one-line verdict: PASS if all boundaries honored, NEEDS-ATTENTION if any gaps."

**Reviewer C - Assessment & Acceptance Criteria**
Prompt: "Review milestone {{milestoneId}} assessment evidence and acceptance criteria. Working directory: {{workingDirectory}}. Use the preloaded milestone context, slice SUMMARY, and ASSESSMENT evidence embedded in this task — do not re-read them from disk. Read the milestone context from the On-demand Milestone Context file path, and read full SUMMARY or ASSESSMENT files only from explicit paths in the On-demand Validation Artifacts list, if the preloaded excerpt is missing, truncated, or inconsistent. UAT files are specs, not evidence. Verify each criterion maps to passing evidence. Then review the inlined `Verification Classes (from planning)` table. For every planned row in that table, output a `Verification Classes` table with columns `Class | Planned Check | Evidence | Verdict`. Preserve every planned non-empty class row; do not summarize, rename, combine, or omit planned classes. The first cell of each row must be exactly `Contract`, `Integration`, `Operational`, or `UAT` when that class is present in planning. If a planned class lacks evidence, still include its canonical row and mark the verdict NEEDS-ATTENTION or FAIL. If a planned browser/UAT class has no ASSESSMENT with browser/runtime actions and assertions, return NEEDS-ATTENTION. If no verification classes were planned, say that explicitly. Output sections `Acceptance Criteria` with checklist `[ ] Criterion | Evidence`, and `Verification Classes` with the table. End with one-line verdict: PASS if all criteria and classes are covered by evidence, NEEDS-ATTENTION if gaps exist."

### Step 3 - Synthesize Findings

Aggregate reviewer verdicts:
- ALL PASS -> `pass`
- Any NEEDS-ATTENTION -> `needs-attention`
- Any FAIL -> `needs-remediation`

### Step 4 - Persist Validation

Prepare validation content for `gsd_validate_milestone`. Do **not** manually write `{{validationPath}}` - the DB-backed tool is the canonical write path and renders the file.

```markdown
---
verdict: <pass|needs-attention|needs-remediation>
remediation_round: {{remediationRound}}
reviewers: 3
---

# Milestone Validation: {{milestoneId}}

## Reviewer A — Requirements Coverage
<Reviewer A's requirement table and verdict, condensed to the rows that carry the finding>

## Reviewer B — Cross-Slice Integration
<Reviewer B's boundary table and verdict, condensed to the rows that carry the finding>

## Reviewer C — Assessment & Acceptance Criteria
<Reviewer C's acceptance-criteria checklist and the full Verification Classes table, plus the verdict>

## Synthesis
<2-3 sentence verdict rationale>

## Remediation Plan
<if verdict is not pass: specific actions required>
```

Call `gsd_validate_milestone` with the camelCase fields `milestoneId`, `verdict`, `remediationRound`, `successCriteriaChecklist`, `sliceDeliveryAudit`, `crossSliceIntegration`, `requirementCoverage`, `verdictRationale`, and `remediationPlan` when needed.

If planning included verification classes, pass BOTH of these — they are not interchangeable:

- `verificationEvidence`: the structured array captured in Step 1. This is what authorizes the validation. Omit it, or let any `testedSourceRevision` fall behind the current source revision, and the call is rejected.
- `verificationClasses`: the narrative `Verification Classes` table from Reviewer C. It accompanies the evidence and never substitutes for it.

Set `verificationClasses` to the `Verification Classes` subsection from Reviewer C. It must include one canonical row for every non-empty planned class from `Verification Classes (from planning)`: `Contract`, `Integration`, `Operational`, and/or `UAT`. If Reviewer C omitted a planned class, reconstruct the missing row from the planning table, set Evidence to the gap, and use NEEDS-ATTENTION or FAIL. Do not call `gsd_validate_milestone` with a partial `verificationClasses` table.

**DB access safety:** Do NOT query `.gsd/gsd.db` directly via `sqlite3` or `node -e require('better-sqlite3')` - the engine owns the WAL connection. Use `gsd_milestone_status` for milestone and slice state. Data is already inlined or available via `gsd_*` tools. Direct DB access risks WAL corruption and bypasses validation.

If verdict is `needs-remediation`:
- First call `gsd_validate_milestone` to persist this failed validation verdict.
- Then use `gsd_reassess_roadmap` to add remediation slices instead of editing `{{roadmapPath}}` manually.
- Those slices will be planned and executed before validation re-runs.

**You MUST call `gsd_validate_milestone` before finishing. Do not manually write `{{validationPath}}`.**

**File system safety:** When scanning milestone directories, use `find .gsd -type f` first and read only files. In flat-phase projects, `.gsd/phases/<NN>-<slug>/` is a directory, not an artifact. Never pass a directory path such as a phase directory, `tasks/`, or `slices/` directly to `read`, `readFile`, or `readFileSync`.

When done, say: "Milestone {{milestoneId}} validation complete — verdict: <verdict>." Say this exactly once — if you already said it in a prior message, do not repeat it.
