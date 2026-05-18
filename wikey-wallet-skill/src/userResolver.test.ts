import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProfile,
  extractUsersFromProfile,
  extractGroupsFromProfile,
  resolveCreateUserTarget,
  resolveDeleteUserTarget,
} from './userResolver.js';

const sampleGroups = [
  { id: 'Primary', name: 'Primary' },
  { id: '7f3c-uuid', name: 'Engineering' },
  { id: 'a9b1-uuid', name: 'Ops' },
];

const sampleUsers = [
  { id: 'u-1', public_key: 'omnistar1alice', parentGroup: 'Primary', SIGNATURE: 'SIG-1' },
  { id: 'u-2', public_key: 'omnistar1bob', parentGroup: '7f3c-uuid', SIGNATURE: 'SIG-2' },
  { id: 'u-3', public_key: 'omnistar1bob', parentGroup: 'a9b1-uuid', SIGNATURE: 'SIG-3' },
];

// ─── parseProfile ─────────────────────────────────────────────────────────────

test('parseProfile accepts {data:{profile}} wrapper', () => {
  const raw = JSON.stringify({
    success: true,
    data: { address: 'omnistar1safe', profile: { users: sampleUsers, groups: sampleGroups } },
  });
  const p = parseProfile(raw);
  assert.equal(p.users.length, 3);
  assert.equal(p.groups.length, 3);
});

test('parseProfile accepts flat {profile} wrapper', () => {
  const raw = JSON.stringify({ profile: { users: sampleUsers, groups: sampleGroups } });
  const p = parseProfile(raw);
  assert.equal(p.users.length, 3);
  assert.equal(p.groups.length, 3);
});

test('parseProfile accepts bare profile object', () => {
  const raw = JSON.stringify({ users: sampleUsers, groups: sampleGroups });
  const p = parseProfile(raw);
  assert.equal(p.users.length, 3);
  assert.equal(p.groups.length, 3);
});

test('parseProfile missing users/groups returns empty arrays', () => {
  const raw = JSON.stringify({ profile: { name: 'somebody' } });
  const p = parseProfile(raw);
  assert.deepEqual(p.users, []);
  assert.deepEqual(p.groups, []);
});

test('parseProfile malformed JSON throws', () => {
  assert.throws(() => parseProfile('not-json'), /failed to parse profile JSON/);
});

// ─── extractors ───────────────────────────────────────────────────────────────

test('extractGroupsFromProfile returns {id, name}[]', () => {
  const p = parseProfile(JSON.stringify({ profile: { groups: sampleGroups, users: [] } }));
  const g = extractGroupsFromProfile(p);
  assert.deepEqual(g, sampleGroups);
});

test('extractUsersFromProfile returns {id, public_key, parentGroup, SIGNATURE}[]', () => {
  const p = parseProfile(JSON.stringify({ profile: { users: sampleUsers, groups: [] } }));
  const u = extractUsersFromProfile(p);
  assert.deepEqual(u, sampleUsers);
});

// ─── resolveCreateUserTarget ─────────────────────────────────────────────────

test('createUser: 1 group, no group arg → returns its id', () => {
  const id = resolveCreateUserTarget({
    destination: 'omnistar1safe',
    groups: [{ id: 'only-uuid', name: 'OnlyGroup' }],
  });
  assert.equal(id, 'only-uuid');
});

test('createUser: 0 groups, no group arg → returns "Primary"', () => {
  const id = resolveCreateUserTarget({ destination: 'omnistar1safe', groups: [] });
  assert.equal(id, 'Primary');
});

test('createUser: group="Primary" literal passes through', () => {
  const id = resolveCreateUserTarget({
    destination: 'omnistar1safe',
    group: 'Primary',
    groups: sampleGroups,
  });
  assert.equal(id, 'Primary');
});

test('createUser: group=<uuid> matches an id → passes through', () => {
  const id = resolveCreateUserTarget({
    destination: 'omnistar1safe',
    group: '7f3c-uuid',
    groups: sampleGroups,
  });
  assert.equal(id, '7f3c-uuid');
});

test('createUser: group="Engineering" (name, not id) → throws', () => {
  assert.throws(
    () =>
      resolveCreateUserTarget({
        destination: 'omnistar1safe',
        group: 'Engineering',
        groups: sampleGroups,
      }),
    /group "Engineering" not a valid group id/,
  );
});

test('createUser: 2+ groups, no group → throws ambiguity with id (name) bullets', () => {
  let err: Error | null = null;
  try {
    resolveCreateUserTarget({ destination: 'omnistar1safe', groups: sampleGroups });
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err);
  assert.match(err!.message, /group ambiguous/);
  assert.match(err!.message, /Primary/);
  assert.match(err!.message, /7f3c-uuid \(Engineering\)/);
  assert.match(err!.message, /a9b1-uuid \(Ops\)/);
});

test('createUser: group not in profile → throws not-found', () => {
  assert.throws(
    () =>
      resolveCreateUserTarget({
        destination: 'omnistar1safe',
        group: 'ghost-uuid',
        groups: sampleGroups,
      }),
    /group "ghost-uuid" not a valid group id/,
  );
});

// ─── resolveDeleteUserTarget ─────────────────────────────────────────────────

test('deleteUser: single match → returns {userId, signature, parentGroup}', () => {
  const r = resolveDeleteUserTarget({
    destination: 'omnistar1safe',
    user: 'omnistar1alice',
    users: sampleUsers,
    groups: sampleGroups,
  });
  assert.deepEqual(r, { userId: 'u-1', signature: 'SIG-1', parentGroup: 'Primary' });
});

test('deleteUser: user not in safe → throws not-found', () => {
  assert.throws(
    () =>
      resolveDeleteUserTarget({
        destination: 'omnistar1safe',
        user: 'omnistar1ghost',
        users: sampleUsers,
        groups: sampleGroups,
      }),
    /user omnistar1ghost not found in safe/,
  );
});

test('deleteUser: same address in 2 groups, no group → throws ambiguity listing both', () => {
  let err: Error | null = null;
  try {
    resolveDeleteUserTarget({
      destination: 'omnistar1safe',
      user: 'omnistar1bob',
      users: sampleUsers,
      groups: sampleGroups,
    });
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err);
  assert.match(err!.message, /appears in multiple groups/);
  assert.match(err!.message, /7f3c-uuid \(Engineering\)/);
  assert.match(err!.message, /a9b1-uuid \(Ops\)/);
  assert.match(err!.message, /userId: u-2/);
  assert.match(err!.message, /userId: u-3/);
});

test('deleteUser: same address in 2 groups, group matches one (by id) → returns that match', () => {
  const r = resolveDeleteUserTarget({
    destination: 'omnistar1safe',
    user: 'omnistar1bob',
    group: '7f3c-uuid',
    users: sampleUsers,
    groups: sampleGroups,
  });
  assert.deepEqual(r, { userId: 'u-2', signature: 'SIG-2', parentGroup: '7f3c-uuid' });
});

test('deleteUser: group supplied as a name → throws name-rejected error', () => {
  assert.throws(
    () =>
      resolveDeleteUserTarget({
        destination: 'omnistar1safe',
        user: 'omnistar1bob',
        group: 'Engineering',
        users: sampleUsers,
        groups: sampleGroups,
      }),
    /group "Engineering" not a valid group id/,
  );
});

test('deleteUser: user exists but not in supplied (valid) group → throws not-found with group hint', () => {
  assert.throws(
    () =>
      resolveDeleteUserTarget({
        destination: 'omnistar1safe',
        user: 'omnistar1alice',
        group: '7f3c-uuid',
        users: sampleUsers,
        groups: sampleGroups,
      }),
    /not found in safe omnistar1safe in group 7f3c-uuid/,
  );
});
