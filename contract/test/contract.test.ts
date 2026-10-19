/**
 * Language-neutral contract tests: the JSON Schema in `schemas/` must accept
 * both the static fixtures and the payloads the two packages actually produce.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { dshMeta, eventNotification, frameNotification, initializeMeta, updateMeta } from '../../packages/dsh-acp-plus/src/meta.js';
import { questionRequestFromDsh } from '../../packages/paseo-provider/server/mapping.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '..');

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schema = JSON.parse(await readFile(join(contractDir, 'schemas', 'dsh-meta.schema.json'), 'utf8'));
ajv.addSchema(schema);
const fixtures = JSON.parse(await readFile(join(contractDir, 'fixtures', 'dsh-meta.json'), 'utf8'));

const metaEnvelope = ajv.compile({ $ref: `${schema.$id}#/$defs/metaEnvelope` });
const eventSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/eventNotification` });
const frameSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/frameNotification` });
const questionsRequestSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/questionsRequest` });
const questionsResponseSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/questionsResponse` });
const forkRequestSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/forkRequest` });
const forkResponseSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/forkResponse` });

function check(validate: (value: unknown) => boolean, value: unknown) {
  const ok = validate(value);
  expect(ok, JSON.stringify(validate.errors ?? [], null, 1)).toBe(true);
}

describe('lossless ACP contract', () => {
  it('accepts every static fixture', () => {
    check(metaEnvelope, fixtures.meta.dsh);
    check(eventSchema, fixtures.event);
    check(frameSchema, fixtures.frame);
    check(questionsRequestSchema, fixtures.questionsRequest);
    check(questionsResponseSchema, fixtures.questionsResponse);
    check(forkRequestSchema, fixtures.forkRequest);
    check(forkResponseSchema, fixtures.forkResponse);
  });

  it('accepts the envelopes the DSH bridge actually produces', () => {
    const event = { type: 'tool/call', seq: 42, time: 1, data: { callId: 'c1' } };
    check(metaEnvelope, dshMeta('session-new', { cwd: '/tmp' }).dsh);
    check(metaEnvelope, updateMeta('tool_call', event, { callId: 'c1' }).dsh);
    check(metaEnvelope, initializeMeta({ version: '0.1.0', image: true, fork: true, loadSession: true }).dsh);
    check(eventSchema, eventNotification('s1', event));
    check(frameSchema, frameNotification('s1', { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }));
  });

  it('never lets extras shadow the envelope version or kind', () => {
    const envelope = dshMeta('update.command_done', { kind: 'success', v: 99 }).dsh;
    expect(envelope).toMatchObject({ v: 1, kind: 'update.command_done' });
    check(metaEnvelope, envelope);
  });

  it('accepts the question request the Paseo provider derives from a DSH payload', () => {
    const { request } = questionRequestFromDsh(
      {
        v: 1,
        requestId: 'question-1',
        sessionId: 's1',
        timeoutMs: 660_000,
        questions: [{ id: 'q1', header: 'Target', question: 'Where?', options: [{ label: 'a' }], multiSelect: false }],
      },
      'question-1',
    );
    check(metaEnvelope, { v: 1, kind: 'permission-request', native: request.input });
    check(questionsRequestSchema, {
      v: 1,
      requestId: request.id,
      sessionId: 's1',
      timeoutMs: 660_000,
      questions: [{ id: 'q1', header: 'Target', question: 'Where?' }],
    });
    check(questionsResponseSchema, { answers: [{ id: 'q1', selected: ['a'] }] });
  });

  it('rejects payloads that would break a strict client', () => {
    expect(metaEnvelope({ kind: 'x' })).toBe(false);
    expect(metaEnvelope({ v: 2, kind: 'x' })).toBe(false);
    expect(eventSchema({ v: 1, sessionId: 's1' })).toBe(false);
    expect(questionsRequestSchema({ v: 1, requestId: 'r', sessionId: 's', questions: [] })).toBe(false);
    expect(questionsResponseSchema({ answers: [{ id: 'q1' }] })).toBe(false);
    expect(forkResponseSchema({})).toBe(false);
  });
});
