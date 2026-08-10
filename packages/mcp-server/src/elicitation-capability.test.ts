// End-to-end elicitation behaviour for `ask_user_questions`, driven against a
// real `createMcpServer` over a real transport with real capability
// negotiation.
//
// Motivated by a reported failure: "Client does not support form elicitation."
// with no dialog shown, leaving an approval gate unanswerable. The suspected
// cause was Claude Code advertising the older flat `elicitation: {}` under
// protocol 2025-11-25 while the SDK requires `elicitation.form`. Measured from
// its initialize params:
//
//   {"protocolVersion":"2025-11-25","clientInfo":{"name":"claude-code",...},
//    "capabilities":{"roots":{"listChanged":true},"elicitation":{}}}
//
// That cause does NOT hold. Every SDK version this package can resolve
// (checked 1.27.1, 1.29.0, 1.30.0 against a range of ^1.27.1) carries a
// backwards-compatibility preprocess in ElicitationCapabilitySchema that
// rewrites an EMPTY elicitation object to `{ form: {} }`, so a flat-capability
// client is treated as form-capable and the request goes through. These tests
// pin that, so a regression -- in the SDK or in our own wiring -- is caught
// rather than rediscovered from a user report.
//
// The tests speak raw JSON-RPC rather than using the SDK `Client`, because the
// client ALSO normalizes the capability before sending; a test built on it
// cannot distinguish the two behaviours.
//
// Note the preprocess only rewrites an EMPTY object. A client advertising a
// non-empty elicitation capability without `form` (say `{ url: {} }`) would
// still be refused. No such client is known, so that case is left alone rather
// than pre-emptively worked around.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';

const PROTOCOL_VERSION = '2025-11-25';
const GATE_ID = 'depth_verification_project_confirm';
const QUESTIONS = [
  {
    id: GATE_ID,
    header: 'PROJECT.md',
    question: 'Approve saving the corrected PROJECT.md content?',
    options: [
      { label: 'Yes, save it', description: 'Persist the corrected content.' },
      { label: 'No, revise', description: 'Keep the current file.' },
    ],
  },
];

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A minimal MCP client that sends exactly the capabilities it is given, with
 * no SDK-side normalization, and records every elicitation request it receives.
 */
class RawClient {
  readonly elicitations: Array<Record<string, unknown>> = [];
  private nextId = 1;
  private pending = new Map<number | string, (message: JsonRpcMessage) => void>();

  constructor(
    private readonly transport: InMemoryTransport,
    private readonly elicitationAnswer: unknown,
  ) {
    transport.onmessage = (message: unknown) => this.handle(message as JsonRpcMessage);
  }

  private handle(message: JsonRpcMessage): void {
    if (message.method === 'elicitation/create') {
      this.elicitations.push(message.params ?? {});
      void this.transport.send({
        jsonrpc: '2.0',
        id: message.id,
        result: this.elicitationAnswer,
      } as never);

      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)!(message);
      this.pending.delete(message.id);
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      void this.transport.send({ jsonrpc: '2.0', id, method, params } as never);
    });
  }

  notify(method: string): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method } as never) as Promise<void>;
  }
}

async function connect(capabilities: Record<string, unknown>, elicitationAnswer: unknown) {
  const { server } = await createMcpServer(new SessionManager(), { includeWorkflowTools: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new RawClient(clientTransport, elicitationAnswer);
  await (server as unknown as { connect(t: unknown): Promise<void> }).connect(serverTransport);
  await clientTransport.start();

  await client.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
    clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.223' },
  });
  await client.notify('notifications/initialized');

  return {
    client,
    capabilitiesSeen: (server as unknown as {
      server: { getClientCapabilities(): unknown };
    }).server.getClientCapabilities(),
    close: () => clientTransport.close(),
  };
}

const ACCEPT = { action: 'accept', content: { [GATE_ID]: 'Yes, save it' } };

describe('ask_user_questions elicitation over a raw client connection', () => {
  it('reaches a client that advertises only the flat elicitation capability', async () => {
    const { client, capabilitiesSeen, close } = await connect(
      { roots: { listChanged: true }, elicitation: {} },
      ACCEPT,
    );

    try {
      // The SDK's own backwards-compatibility preprocess upgrades the flat
      // capability on the way in. Pinned here because it is the entire reason
      // the reported failure cannot be reproduced from this client shape: if a
      // future SDK drops it, this assertion fails first and explains why.
      assert.deepEqual(
        capabilitiesSeen,
        { elicitation: { form: {} }, roots: { listChanged: true } },
        'the SDK must keep upgrading a flat elicitation capability to form',
      );

      const response = await client.request('tools/call', {
        name: 'ask_user_questions',
        arguments: { questions: QUESTIONS },
      });

      assert.equal(
        client.elicitations.length,
        1,
        'the elicitation request must reach a flat-capability client instead of being refused server-side',
      );
      const result = response.result as { isError?: boolean; structuredContent?: { cancelled?: boolean } };
      assert.notEqual(result?.isError, true, `ask_user_questions must not error: ${JSON.stringify(result)}`);
      assert.equal(result?.structuredContent?.cancelled, false);
    } finally {
      await close();
    }
  });

  it('still reaches a client that advertises the form capability', async () => {
    const { client, close } = await connect({ elicitation: { form: {} } }, ACCEPT);

    try {
      const response = await client.request('tools/call', {
        name: 'ask_user_questions',
        arguments: { questions: QUESTIONS },
      });

      assert.equal(client.elicitations.length, 1);
      assert.notEqual((response.result as { isError?: boolean })?.isError, true);
    } finally {
      await close();
    }
  });

  // A client with no elicitation capability must NOT be handed the request: the
  // refusal is what makes the handler fall through to a configured remote
  // questions channel rather than waiting on a host that cannot ask anything.
  //
  // It is also the one path that reproduces the reported failure, so it doubles
  // as the end-to-end check that the diagnostic is actually wired in: the
  // handler swallows the refusal, and without this record nothing would say
  // which capabilities the server had resolved.
  it('does not send elicitation to a client that advertises none, and records why', async () => {
    const gsdHome = mkdtempSync(join(tmpdir(), 'gsd-elicit-wiring-'));
    const previousHome = process.env['GSD_HOME'];
    process.env['GSD_HOME'] = gsdHome;

    const { client, close } = await connect({ roots: { listChanged: true } }, ACCEPT);

    try {
      await client.request('tools/call', {
        name: 'ask_user_questions',
        arguments: { questions: QUESTIONS },
      });

      assert.equal(client.elicitations.length, 0, 'a client without elicitation must never receive the request');

      const entries = readFileSync(join(gsdHome, 'diagnostics.jsonl'), 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(entries.length, 1, 'the refusal must leave exactly one diagnostic record');
      assert.deepEqual(
        entries[0]!['capabilities'],
        { roots: { listChanged: true } },
        'the record must carry the capabilities as the SERVER resolved them',
      );
      assert.match(String(entries[0]!['error']), /elicitation/i);
    } finally {
      await close();
      if (previousHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = previousHome;
      rmSync(gsdHome, { recursive: true, force: true });
    }
  });
});
