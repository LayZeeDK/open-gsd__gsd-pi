/**
 * `gsd headless doctor` argument policy.
 *
 * The defect: `parseHeadlessArgs` collected trailing argv correctly, but the
 * headless `doctor` branch read only `--json` from it and dropped the rest, so
 * `gsd headless doctor resolve-evidence --action=preserve` ran a plain scan and
 * exited 1 — a silent wrong action reported as "issues detected".
 *
 * Tested against the extracted predicate rather than a mirrored parser copy;
 * see the header of headless-doctor-args.ts. The dispatcher if-block that
 * consumes it is covered by `build:core`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { unsupportedHeadlessDoctorArgs } from '../headless-doctor-args.js'

test('no arguments is a supported invocation', () => {
  assert.deepEqual(unsupportedHeadlessDoctorArgs([]), [])
})

test('--json is the one supported argument', () => {
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['--json']), [])
})

test('the reported invocation is refused, preserving argv order', () => {
  assert.deepEqual(
    unsupportedHeadlessDoctorArgs(['resolve-evidence', '--action=preserve']),
    ['resolve-evidence', '--action=preserve'],
  )
})

test('mutating subcommands and flags the headless doctor never honoured are refused', () => {
  // Each of these is accepted by the interactive /gsd doctor and was silently
  // discarded here, which is the whole point of refusing rather than ignoring.
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['fix']), ['fix'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['heal']), ['heal'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['audit']), ['audit'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['--fix']), ['--fix'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['--dry-run']), ['--dry-run'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['--build']), ['--build'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['--test']), ['--test'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['M001']), ['M001'])
})

test('a supported argument does not excuse an unsupported one alongside it', () => {
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['--json', 'fix']), ['fix'])
  assert.deepEqual(unsupportedHeadlessDoctorArgs(['fix', '--json']), ['fix'])
})
