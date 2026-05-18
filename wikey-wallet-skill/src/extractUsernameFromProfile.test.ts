import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsernameFromProfile } from './index.js';

test('wrapped JSON with data.profile.name → returns name', () => {
  const raw = JSON.stringify({ data: { address: 'omnistar1abc', profile: { name: 'alice' } } });
  assert.equal(extractUsernameFromProfile(raw), 'alice');
});

test('flat JSON with profile.name → returns name', () => {
  const raw = JSON.stringify({ profile: { name: 'bob' } });
  assert.equal(extractUsernameFromProfile(raw), 'bob');
});

test('missing profile → throws', () => {
  const raw = JSON.stringify({ data: { address: 'omnistar1abc' } });
  assert.throws(() => extractUsernameFromProfile(raw), /profile\.name not found/);
});

test('profile present but empty name → throws', () => {
  const raw = JSON.stringify({ data: { profile: { name: '' } } });
  assert.throws(() => extractUsernameFromProfile(raw), /profile\.name not found/);
});

test('malformed JSON → throws with raw tail', () => {
  const raw = 'not-json-at-all';
  assert.throws(() => extractUsernameFromProfile(raw), /failed to parse profile JSON/);
});
