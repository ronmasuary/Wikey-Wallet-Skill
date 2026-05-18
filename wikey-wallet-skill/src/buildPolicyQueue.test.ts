import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyQueue } from './index.js';

test('applyOn=transaction with voting+amount+symbols → full queue', () => {
  const q = buildPolicyQueue({
    applyOn: 'transaction',
    conditions: [
      { type: 'voting', votingQty: 60 },
      { type: 'amount', minAmount: 1, maxAmount: 100 },
      { type: 'symbols', symbols: ['BTC', 'ETH'] },
    ],
    name: 'p1',
    description: 'desc',
  });

  assert.equal(q.length, 7);
  assert.equal(q[0].match, 'Your selection');
  assert.equal(q[0].respond(), '1,2,3\n');
  assert.equal(q[1].match, 'Enter voting quantity');
  assert.equal(q[1].respond(), '60\n');
  assert.equal(q[2].match, 'Enter minimum amount');
  assert.equal(q[2].respond(), '1\n');
  assert.equal(q[3].match, 'Enter maximum amount');
  assert.equal(q[3].respond(), '100\n');
  assert.equal(q[4].match, 'Enter symbols (comma-separated');
  assert.equal(q[4].respond(), 'BTC,ETH\n');
  assert.equal(q[5].match, 'Enter policy name (optional');
  assert.equal(q[5].respond(), 'p1\n');
  assert.equal(q[6].match, 'Enter policy description (optional');
  assert.equal(q[6].respond(), 'desc\n');
});

test('applyOn=group with voting only → selection=1', () => {
  const q = buildPolicyQueue({
    applyOn: 'group',
    conditions: [{ type: 'voting', votingQty: 100 }],
  });

  assert.equal(q.length, 4);
  assert.equal(q[0].respond(), '1\n');
  assert.equal(q[1].match, 'Enter voting quantity');
  assert.equal(q[1].respond(), '100\n');
  assert.equal(q[2].respond(), '\n');
  assert.equal(q[3].respond(), '\n');
});

test('applyOn=profile drops amount/symbols conditions', () => {
  const q = buildPolicyQueue({
    applyOn: 'profile',
    conditions: [
      { type: 'voting', votingQty: 50 },
      { type: 'amount', minAmount: 1, maxAmount: 2 },
      { type: 'symbols', symbols: ['BTC'] },
    ],
  });

  assert.equal(q.length, 4);
  assert.equal(q[0].respond(), '1\n');
  assert.equal(q[1].match, 'Enter voting quantity');
});

test('mixed applyOn (transaction,group) drops amount/symbols', () => {
  const q = buildPolicyQueue({
    applyOn: 'transaction,group',
    conditions: [
      { type: 'voting', votingQty: 50 },
      { type: 'amount', minAmount: 1, maxAmount: 2 },
    ],
  });

  assert.equal(q.length, 4);
  assert.equal(q[0].respond(), '1\n');
});

test('empty name/description responds with newline only', () => {
  const q = buildPolicyQueue({
    applyOn: 'group',
    conditions: [{ type: 'voting', votingQty: 100 }],
  });
  assert.equal(q[2].respond(), '\n');
  assert.equal(q[3].respond(), '\n');
});
