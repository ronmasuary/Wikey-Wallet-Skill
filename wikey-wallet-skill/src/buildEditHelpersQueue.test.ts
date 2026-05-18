import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEditHelpersQueue } from './index.js';

test('add 2 helpers, no removes → queue: y, addr1, y, addr2, n, n(remove), threshold', () => {
  const build = buildEditHelpersQueue(['alice', 'bob'], [], 3);
  const q = build('');

  assert.equal(q.length, 7);
  assert.equal(q[0].match, 'Would you like to add a helper?');
  assert.equal(q[0].respond(), 'y\n');
  assert.equal(q[1].match, 'Enter helper address or username');
  assert.equal(q[1].respond(), 'alice\n');
  assert.equal(q[2].match, 'Would you like to add another helper?');
  assert.equal(q[2].respond(), 'y\n');
  assert.equal(q[3].respond(), 'bob\n');
  assert.equal(q[4].respond(), 'n\n');
  assert.equal(q[5].match, 'Would you like to remove a helper?');
  assert.equal(q[5].respond(), 'n\n');
  assert.equal(q[6].match, 'Enter threshold (number of helpers required,');
  assert.equal(q[6].respond(), '3\n');
});

test('remove 1 helper from numbered list → index lookup against `all`', () => {
  const build = buildEditHelpersQueue([], ['carol'], 1);
  const fakeStderr = '1) alice (omnistar1abc)\n2) carol (omnistar1xyz)\n3) bob (omnistar1def)\n';
  const q = build(fakeStderr);

  assert.equal(q[0].match, 'Would you like to add a helper?');
  assert.equal(q[0].respond(), 'n\n');
  assert.equal(q[1].match, 'Would you like to remove a helper?');
  assert.equal(q[1].respond(), 'y\n');
  assert.equal(q[2].match, 'Enter the number of the helper to remove');
  assert.equal(q[2].respond(), '2\n');
  assert.equal(q[3].respond(), 'n\n');
  assert.equal(q[4].respond(), '1\n');
});

test('remove target not in list → throws helpful error', () => {
  const build = buildEditHelpersQueue([], ['ghost'], 1);
  const fakeStderr = '1. alice\n2. bob\n';
  const q = build(fakeStderr);
  const enterRemove = q.find(s => s.match === 'Enter the number of the helper to remove')!;
  assert.throws(() => enterRemove.respond(), /helper not found in list: "ghost"/);
});

test('no adds and no removes → 3 steps: add-no, remove-no, threshold', () => {
  const build = buildEditHelpersQueue([], [], 2);
  const q = build('');
  assert.equal(q.length, 3);
  assert.equal(q[0].respond(), 'n\n');
  assert.equal(q[1].respond(), 'n\n');
  assert.equal(q[2].respond(), '2\n');
});
