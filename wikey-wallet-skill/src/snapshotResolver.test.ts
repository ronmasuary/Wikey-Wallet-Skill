import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSnapshot,
  findSafe,
  extractGroupsFromSafe,
  resolveCreateUserTarget,
  resolveUserDeletion,
  resolvePolicyDeletion,
  type SafeEntry,
} from './snapshotResolver.js';

// ─── synthetic snapshot ─────────────────────────────────────────────────────

function makeSafe(): SafeEntry {
  return {
    address: 'omnistar1safe',
    name: 'test.safe',
    groups: [
      {
        id: 'Primary',
        name: 'Primary',
        isDeleted: false,
        nestedObjects: [
          {
            class: 'user',
            id: 'u-live',
            isDeleted: false,
            object: { SIGNATURE: 'SIG-LIVE', parentGroup: 'Primary' },
          },
          {
            class: 'user',
            id: 'u-dead',
            isDeleted: true,
            object: { SIGNATURE: 'SIG-DEAD', parentGroup: 'Primary' },
          },
          {
            class: 'policy',
            id: 'p-live',
            isDeleted: false,
            object: { SIGNATURE: 'PSIG-LIVE', parentGroup: 'Primary' },
          },
          {
            class: 'policy',
            id: 'p-dead',
            isDeleted: true,
            object: { SIGNATURE: 'PSIG-DEAD', parentGroup: 'Primary' },
          },
        ],
      },
      {
        id: '7f3c-uuid',
        name: 'Engineering',
        isDeleted: false,
        nestedObjects: [
          {
            class: 'user',
            id: 'u-eng',
            isDeleted: false,
            object: { SIGNATURE: 'SIG-ENG', parentGroup: '7f3c-uuid' },
          },
        ],
      },
      {
        id: 'a9b1-uuid',
        name: 'Archived',
        isDeleted: true,
        nestedObjects: [],
      },
    ],
  };
}

function wrap(safe: SafeEntry): string {
  return JSON.stringify({ success: true, data: { address: 'omnistar1prof', snapshot: [safe] } });
}

// ─── parseSnapshot ────────────────────────────────────────────────────────────

test('parseSnapshot accepts {success,data:{snapshot}} wrapper', () => {
  const p = parseSnapshot(wrap(makeSafe()));
  assert.equal(p.safes.length, 1);
  assert.equal(p.safes[0].address, 'omnistar1safe');
  assert.equal(p.safes[0].groups.length, 3);
});

test('parseSnapshot accepts bare array variant', () => {
  const p = parseSnapshot(JSON.stringify([makeSafe()]));
  assert.equal(p.safes.length, 1);
  assert.equal(p.safes[0].name, 'test.safe');
});

test('parseSnapshot strips leading URL line on stdout', () => {
  const raw = 'https://reverse-proxy.example/snapshot?x=1\n' + wrap(makeSafe());
  const p = parseSnapshot(raw);
  assert.equal(p.safes.length, 1);
  assert.equal(p.safes[0].address, 'omnistar1safe');
});

test('parseSnapshot malformed JSON throws', () => {
  assert.throws(() => parseSnapshot('not-json-at-all'), /failed to parse snapshot JSON/);
});

// ─── findSafe ───────────────────────────────────────────────────────────────

test('findSafe matches by address', () => {
  const p = parseSnapshot(wrap(makeSafe()));
  const safe = findSafe(p, 'omnistar1safe');
  assert.equal(safe.name, 'test.safe');
});

test('findSafe not-found lists available safes', () => {
  const p = parseSnapshot(wrap(makeSafe()));
  let err: Error | null = null;
  try {
    findSafe(p, 'omnistar1ghost');
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err);
  assert.match(err!.message, /not in profile snapshot/);
  assert.match(err!.message, /omnistar1safe \(test\.safe\)/);
});

// ─── extractGroupsFromSafe ──────────────────────────────────────────────────

test('extractGroupsFromSafe returns live groups only', () => {
  const safe = makeSafe();
  const groups = extractGroupsFromSafe(safe);
  assert.deepEqual(groups, [
    { id: 'Primary', name: 'Primary' },
    { id: '7f3c-uuid', name: 'Engineering' },
  ]);
});

// ─── resolveCreateUserTarget (ported) ────────────────────────────────────────

test('createUser: 1 group, no group arg → returns its id', () => {
  assert.equal(
    resolveCreateUserTarget({ destination: 'omnistar1safe', groups: [{ id: 'only', name: 'Only' }] }),
    'only',
  );
});

test('createUser: 0 groups, no group arg → returns "Primary"', () => {
  assert.equal(resolveCreateUserTarget({ destination: 'omnistar1safe', groups: [] }), 'Primary');
});

test('createUser: group="Primary" literal passes through', () => {
  const groups = extractGroupsFromSafe(makeSafe());
  assert.equal(resolveCreateUserTarget({ destination: 'omnistar1safe', group: 'Primary', groups }), 'Primary');
});

test('createUser: group=<uuid> matches an id → passes through', () => {
  const groups = extractGroupsFromSafe(makeSafe());
  assert.equal(
    resolveCreateUserTarget({ destination: 'omnistar1safe', group: '7f3c-uuid', groups }),
    '7f3c-uuid',
  );
});

test('createUser: group="Engineering" (name, not id) → throws', () => {
  const groups = extractGroupsFromSafe(makeSafe());
  assert.throws(
    () => resolveCreateUserTarget({ destination: 'omnistar1safe', group: 'Engineering', groups }),
    /group "Engineering" not a valid group id/,
  );
});

test('createUser: 2+ groups, no group → ambiguity with id (name) bullets', () => {
  const groups = extractGroupsFromSafe(makeSafe());
  let err: Error | null = null;
  try {
    resolveCreateUserTarget({ destination: 'omnistar1safe', groups });
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err);
  assert.match(err!.message, /group ambiguous/);
  assert.match(err!.message, /Primary/);
  assert.match(err!.message, /7f3c-uuid \(Engineering\)/);
});

test('createUser: group not in safe → throws not-found', () => {
  const groups = extractGroupsFromSafe(makeSafe());
  assert.throws(
    () => resolveCreateUserTarget({ destination: 'omnistar1safe', group: 'ghost', groups }),
    /group "ghost" not a valid group id/,
  );
});

// ─── resolveUserDeletion ──────────────────────────────────────────────────────

test('resolveUserDeletion: live match returns sig + parentGroup', () => {
  const safe = makeSafe();
  assert.deepEqual(resolveUserDeletion({ destination: 'omnistar1safe', userId: 'u-live', safe }), {
    signature: 'SIG-LIVE',
    parentGroup: 'Primary',
  });
});

test('resolveUserDeletion: deleted match throws "already deleted"', () => {
  const safe = makeSafe();
  assert.throws(
    () => resolveUserDeletion({ destination: 'omnistar1safe', userId: 'u-dead', safe }),
    /userId u-dead is already deleted in safe omnistar1safe, refusing/,
  );
});

test('resolveUserDeletion: no match lists live user ids (not policy ids)', () => {
  const safe = makeSafe();
  let err: Error | null = null;
  try {
    resolveUserDeletion({ destination: 'omnistar1safe', userId: 'p-live', safe });
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err);
  assert.match(err!.message, /userId p-live not found in safe omnistar1safe — available users/);
  assert.match(err!.message, /u-live \(Primary\)/);
  assert.match(err!.message, /u-eng \(7f3c-uuid \(Engineering\)\)/);
  // policy ids must NOT appear; deleted user must NOT appear
  assert.doesNotMatch(err!.message, /p-live \(/);
  assert.doesNotMatch(err!.message, /u-dead/);
});

// ─── resolvePolicyDeletion ────────────────────────────────────────────────────

test('resolvePolicyDeletion: live match returns sig + parentGroup', () => {
  const safe = makeSafe();
  assert.deepEqual(resolvePolicyDeletion({ destination: 'omnistar1safe', policyId: 'p-live', safe }), {
    signature: 'PSIG-LIVE',
    parentGroup: 'Primary',
  });
});

test('resolvePolicyDeletion: deleted match throws "already deleted"', () => {
  const safe = makeSafe();
  assert.throws(
    () => resolvePolicyDeletion({ destination: 'omnistar1safe', policyId: 'p-dead', safe }),
    /policyId p-dead is already deleted in safe omnistar1safe, refusing/,
  );
});

test('resolvePolicyDeletion: no match lists live policy ids (not user ids)', () => {
  const safe = makeSafe();
  let err: Error | null = null;
  try {
    resolvePolicyDeletion({ destination: 'omnistar1safe', policyId: 'u-live', safe });
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err);
  assert.match(err!.message, /policyId u-live not found in safe omnistar1safe — available policies/);
  assert.match(err!.message, /p-live \(Primary\)/);
  assert.doesNotMatch(err!.message, /u-live \(/);
});

// ─── end-to-end against committed fixture ─────────────────────────────────────
// fragile: refresh when snapshot-fixture.json is regenerated

test('e2e: resolveUserDeletion against snapshot-fixture.json known live user', () => {
  const raw = readFileSync(new URL('./snapshot-fixture.json', import.meta.url), 'utf8');
  const snap = parseSnapshot(raw);
  const safe = findSafe(snap, 'omnistar1lveyec7dqdt7ypad3fxj0y8wxsyjdjx7vq70n2');
  const r = resolveUserDeletion({
    destination: 'omnistar1lveyec7dqdt7ypad3fxj0y8wxsyjdjx7vq70n2',
    userId: 'a6c3dccb-bfe5-4f08-835b-72437b3bf4da',
    safe,
  });
  assert.equal(r.signature, '41F0435AD59584393F916033A845BDE374EC928ECB9B44597E932475D35F3686');
  assert.equal(r.parentGroup, 'Primary');
});

test('e2e: resolveUserDeletion against fixture deleted user throws', () => {
  const raw = readFileSync(new URL('./snapshot-fixture.json', import.meta.url), 'utf8');
  const snap = parseSnapshot(raw);
  const safe = findSafe(snap, 'omnistar1lveyec7dqdt7ypad3fxj0y8wxsyjdjx7vq70n2');
  assert.throws(
    () =>
      resolveUserDeletion({
        destination: 'omnistar1lveyec7dqdt7ypad3fxj0y8wxsyjdjx7vq70n2',
        userId: '1b95e3e7-ca38-4446-8426-e3b8176679aa',
        safe,
      }),
    /already deleted/,
  );
});
