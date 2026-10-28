import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionRefused, resultJson } from '../src/automation.js';

describe('connectionRefused', () => {
  it('finds ECONNREFUSED in the error or its causes', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9100'), { code: 'ECONNREFUSED' });
    assert.equal(connectionRefused(refused), true);
    assert.equal(connectionRefused(new TypeError('fetch failed', { cause: refused })), true);
  });

  it('is false for errors from a call that reached the editor', () => {
    assert.equal(connectionRefused(new Error('MCP error -32001: Request timed out')), false);
    assert.equal(connectionRefused(undefined), false);
  });
});

describe('resultJson', () => {
  it('parses JSON text and passes other text through', () => {
    assert.deepEqual(resultJson({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
    assert.equal(resultJson({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
    assert.equal(resultJson({ content: [{ type: 'image', data: '', mimeType: 'image/png' }] }), undefined);
  });
});
