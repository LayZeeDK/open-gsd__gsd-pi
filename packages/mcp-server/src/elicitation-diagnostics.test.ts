// When elicitation fails there is currently no record of WHY, and the one fact
// that decides it -- the client capabilities as the SERVER resolved them, after
// the SDK's schema preprocess -- is not written anywhere.
//
// That gap already cost a wrong fix: a patch was built and withdrawn because the
// available evidence was the client's RAW initialize params, which do not show
// what the server concluded. These tests pin the record that closes it.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordElicitationDiagnostic } from './elicitation-diagnostics.js';

let gsdHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  gsdHome = mkdtempSync(join(tmpdir(), 'gsd-elicit-diag-'));
  previousHome = process.env['GSD_HOME'];
  process.env['GSD_HOME'] = gsdHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['GSD_HOME'];
  else process.env['GSD_HOME'] = previousHome;
  rmSync(gsdHome, { recursive: true, force: true });
});

const readEntries = (): Array<Record<string, unknown>> =>
  readFileSync(join(gsdHome, 'diagnostics.jsonl'), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function makeServer(capabilities: unknown, clientInfo: unknown) {
  return {
    getClientCapabilities: () => capabilities as never,
    getClientVersion: () => clientInfo as never,
  };
}

describe('recordElicitationDiagnostic', () => {
  it('records the capabilities as the server resolved them', () => {
    recordElicitationDiagnostic(
      makeServer({ roots: { listChanged: true }, elicitation: { form: {} } }, { name: 'claude-code', version: '2.1.223' }),
      new Error('Client does not support form elicitation.'),
    );

    const entries = readEntries();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!['capabilities'], { roots: { listChanged: true }, elicitation: { form: {} } });
    assert.deepEqual(entries[0]!['clientInfo'], { name: 'claude-code', version: '2.1.223' });
    assert.equal(entries[0]!['error'], 'Client does not support form elicitation.');
    assert.equal(typeof entries[0]!['at'], 'string');
  });

  // The distinction the withdrawn patch turned on: whether `elicitation` arrived
  // flat or was upgraded to `{ form: {} }`. Recording it verbatim is the point.
  it('records a capability object that carries no form key', () => {
    recordElicitationDiagnostic(
      makeServer({ elicitation: { url: {} } }, { name: 'some-client', version: '9' }),
      new Error('Client does not support form elicitation.'),
    );

    assert.deepEqual(readEntries()[0]!['capabilities'], { elicitation: { url: {} } });
  });

  it('records an absent capability set rather than dropping the entry', () => {
    recordElicitationDiagnostic(makeServer(undefined, undefined), new Error('boom'));

    const entry = readEntries()[0]!;
    assert.equal(entry['capabilities'], null);
    assert.equal(entry['clientInfo'], null);
  });

  it('appends rather than overwriting', () => {
    const server = makeServer({ elicitation: {} }, { name: 'c', version: '1' });
    recordElicitationDiagnostic(server, new Error('first'));
    recordElicitationDiagnostic(server, new Error('second'));

    assert.deepEqual(readEntries().map((entry) => entry['error']), ['first', 'second']);
  });

  it('accepts a non-Error rejection value', () => {
    recordElicitationDiagnostic(makeServer({}, {}), 'plain string rejection');

    assert.equal(readEntries()[0]!['error'], 'plain string rejection');
  });

  // A client that supports no elicitation fails EVERY ask_user_questions call,
  // and each failure appends a full capabilities dump. Unbounded, that grows for
  // the lifetime of the install in the shared global gsd home.
  it('rotates the log instead of growing without bound', () => {
    const path = join(gsdHome, 'diagnostics.jsonl');
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1), 'utf-8');

    recordElicitationDiagnostic(makeServer({}, {}), new Error('boom'));

    // The oversized generation moved aside, and the live file holds only the
    // new entry rather than the megabyte that preceded it.
    assert.equal(statSync(`${path}.1`).size, 1024 * 1024 + 1);
    assert.equal(readEntries().length, 1);
    assert.ok(statSync(path).size < 1024, 'the live log must start fresh after rotation');
  });

  it('does not rotate a log that is still under the cap', () => {
    recordElicitationDiagnostic(makeServer({}, {}), new Error('first'));
    recordElicitationDiagnostic(makeServer({}, {}), new Error('second'));

    assert.equal(readEntries().length, 2);
    assert.throws(() => statSync(join(gsdHome, 'diagnostics.jsonl.1')));
  });

  // Diagnostics must never become the reason a tool call fails.
  it('never throws when the destination cannot be written', () => {
    // A file where the directory must go: mkdir and append both fail.
    rmSync(gsdHome, { recursive: true, force: true });
    writeFileSync(gsdHome, 'not a directory');

    assert.doesNotThrow(() =>
      recordElicitationDiagnostic(makeServer({}, {}), new Error('boom')),
    );
  });

  it('never throws when the server accessors themselves throw', () => {
    const hostile = {
      getClientCapabilities: () => { throw new Error('not connected'); },
      getClientVersion: () => { throw new Error('not connected'); },
    };

    assert.doesNotThrow(() => recordElicitationDiagnostic(hostile, new Error('boom')));
  });
});

void chmodSync;
