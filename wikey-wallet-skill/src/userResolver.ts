export interface ProfileUser {
  id: string;
  public_key: string;
  parentGroup: string;
  SIGNATURE: string;
}

export interface ProfileGroup {
  id: string;
  name: string;
}

export interface ParsedProfile {
  users: ProfileUser[];
  groups: ProfileGroup[];
}

function unwrapProfile(parsed: unknown): Record<string, unknown> {
  const root = parsed as { data?: { profile?: unknown }; profile?: unknown };
  if (root && typeof root === 'object') {
    if (root.data && typeof root.data === 'object') {
      const dp = (root.data as { profile?: unknown }).profile;
      if (dp && typeof dp === 'object') return dp as Record<string, unknown>;
    }
    if (root.profile && typeof root.profile === 'object') {
      return root.profile as Record<string, unknown>;
    }
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function parseProfile(raw: string): ParsedProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`failed to parse profile JSON. Raw tail: ${raw.slice(-200)}`);
  }
  const profile = unwrapProfile(parsed);
  const usersRaw = Array.isArray(profile.users) ? profile.users : [];
  const groupsRaw = Array.isArray(profile.groups) ? profile.groups : [];

  const users: ProfileUser[] = usersRaw
    .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
    .map(u => ({
      id: typeof u.id === 'string' ? u.id : '',
      public_key: typeof u.public_key === 'string' ? u.public_key : '',
      parentGroup: typeof u.parentGroup === 'string' ? u.parentGroup : '',
      SIGNATURE: typeof u.SIGNATURE === 'string' ? u.SIGNATURE : '',
    }));

  const groups: ProfileGroup[] = groupsRaw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map(g => ({
      id: typeof g.id === 'string' ? g.id : '',
      name: typeof g.name === 'string' ? g.name : '',
    }));

  return { users, groups };
}

export function extractUsersFromProfile(p: ParsedProfile): ProfileUser[] {
  return p.users;
}

export function extractGroupsFromProfile(p: ParsedProfile): ProfileGroup[] {
  return p.groups;
}

function formatGroupLabel(g: ProfileGroup): string {
  return g.id === g.name ? g.id : `${g.id} (${g.name})`;
}

function groupBullets(groups: ProfileGroup[]): string {
  return groups.map(g => `  - ${formatGroupLabel(g)}`).join('\n');
}

export function resolveCreateUserTarget(args: {
  destination: string;
  group?: string;
  groups: ProfileGroup[];
}): string {
  const { destination, group, groups } = args;

  if (group === undefined || group === null || group === '') {
    if (groups.length === 0) return 'Primary';
    if (groups.length === 1) return groups[0].id;
    throw new Error(
      `group ambiguous in safe ${destination} — specify \`group\` (pass the id, not the name):\n${groupBullets(groups)}`,
    );
  }

  const match = groups.find(g => g.id === group);
  if (match) return match.id;

  throw new Error(
    `group "${group}" not a valid group id in safe ${destination}. Valid ids (pass the id, not the name):\n${groupBullets(groups)}`,
  );
}

export function resolveDeleteUserTarget(args: {
  destination: string;
  user: string;
  group?: string;
  users: ProfileUser[];
  groups: ProfileGroup[];
}): { userId: string; signature: string; parentGroup: string } {
  const { destination, user, group, users, groups } = args;

  let validGroupId: string | undefined;
  if (group !== undefined && group !== null && group !== '') {
    const gm = groups.find(g => g.id === group);
    if (!gm) {
      throw new Error(
        `group "${group}" not a valid group id in safe ${destination}. Valid ids (pass the id, not the name):\n${groupBullets(groups)}`,
      );
    }
    validGroupId = gm.id;
  }

  let matches = users.filter(u => u.public_key === user);
  if (validGroupId !== undefined) matches = matches.filter(u => u.parentGroup === validGroupId);

  if (matches.length === 0) {
    const ext = validGroupId ? ` in group ${validGroupId}` : '';
    throw new Error(`user ${user} not found in safe ${destination}${ext}`);
  }
  if (matches.length === 1) {
    const m = matches[0];
    return { userId: m.id, signature: m.SIGNATURE, parentGroup: m.parentGroup };
  }

  const lines = matches
    .map(m => {
      const g = groups.find(gg => gg.id === m.parentGroup);
      const label = g ? formatGroupLabel(g) : m.parentGroup;
      return `  - ${label} (userId: ${m.id})`;
    })
    .join('\n');
  throw new Error(
    `user ${user} appears in multiple groups in safe ${destination} — specify \`group\` (pass the id, not the name):\n${lines}`,
  );
}
