import assert from "node:assert/strict";
import test from "node:test";
import {
  compareConfigurationSnapshots,
  formatConfigurationSnapshotDiff,
  SnapshotComparisonError,
} from "../src/features/snapshot-diff.js";
import { openDatabase } from "../src/storage/database.js";
import {
  getLatestConfigurationSnapshots,
  saveConfigurationSnapshot,
  UnsupportedSnapshotSchemaVersionError,
  type ConfigurationSnapshot,
  type SavedConfigurationSnapshot,
} from "../src/storage/snapshots.js";

const guildId = "11111111111111111";
const requesterId = "22222222222222222";

function payload(): ConfigurationSnapshot {
  return {
    guild: {
      id: guildId,
      name: "Test server",
      description: null,
      icon: null,
      features: [],
      preferred_locale: "en-US",
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      afk_channel_id: null,
      afk_timeout: 300,
      system_channel_id: null,
      system_channel_flags: "0",
      rules_channel_id: null,
      public_updates_channel_id: null,
      mfa_level: 0,
      nsfw_level: 0,
      premium_tier: 0,
    },
    roles: [
      {
        id: "33333333333333333",
        name: "Members",
        position: 1,
        permissions: "1024",
        colors: {
          primary_color: 0,
          secondary_color: null,
          tertiary_color: null,
        },
        hoist: false,
        managed: false,
        mentionable: false,
        flags: "0",
      },
    ],
    channels: [
      {
        id: "44444444444444444",
        type: 0,
        name: "general",
        position: 0,
        parent_id: null,
        topic: null,
        nsfw: false,
        rate_limit_per_user: 0,
        viewable: true,
        permission_overwrites: [],
      },
    ],
    visibility: {
      state: "limited",
      note: "The bot sees only channels returned by Discord.",
      returned_unviewable_channel_count: 0,
    },
  };
}

function saved(
  overrides: Partial<SavedConfigurationSnapshot> = {},
): SavedConfigurationSnapshot {
  return {
    id: "snapshot-older",
    guildId,
    requestedBy: requesterId,
    capturedAt: "2026-10-30T10:00:00.000Z",
    schemaVersion: 1,
    visibility: "limited",
    payload: payload(),
    ...overrides,
  };
}

test("reports no changes for equivalent supported data", () => {
  const result = compareConfigurationSnapshots(
    saved(),
    saved({ id: "snapshot-newer", capturedAt: "2026-10-30T10:01:00.000Z" }),
  );
  assert.deepEqual(result.entries, []);
  assert.match(
    formatConfigurationSnapshotDiff(result),
    /No supported differences/,
  );
});

test("compares guild settings and roles by stable identifiers", () => {
  const olderPayload = payload();
  const newerPayload = payload();
  olderPayload.roles.push({
    ...olderPayload.roles[0]!,
    id: "55555555555555555",
    name: "Guests",
  });
  newerPayload.guild.name = "Renamed server";
  newerPayload.roles[0]!.permissions = "2048";
  newerPayload.roles.push({
    ...newerPayload.roles[0]!,
    id: "66666666666666666",
    name: "Moderators",
  });

  const result = compareConfigurationSnapshots(
    saved({ payload: olderPayload }),
    saved({ id: "snapshot-newer", payload: newerPayload }),
  );

  assert.deepEqual(
    result.entries.map(({ category, kind, entity, field }) => ({
      category,
      kind,
      entity,
      field,
    })),
    [
      {
        category: "guild",
        kind: "changed",
        entity: "Server settings",
        field: "name",
      },
      {
        category: "role",
        kind: "changed",
        entity: "Members",
        field: "permissions",
      },
      {
        category: "role",
        kind: "removed",
        entity: "Guests",
        field: undefined,
      },
      {
        category: "role",
        kind: "added",
        entity: "Moderators",
        field: undefined,
      },
    ],
  );
});

test("reports channel field and permission overwrite changes", () => {
  const olderPayload = payload();
  const newerPayload = payload();
  olderPayload.channels[0]!.permission_overwrites = [
    { id: "33333333333333333", type: 0, allow: "1024", deny: "0" },
    { id: requesterId, type: 1, allow: "0", deny: "2048" },
  ];
  newerPayload.channels[0]!.topic = "Read the rules";
  newerPayload.channels[0]!.permission_overwrites = [
    { id: "33333333333333333", type: 0, allow: "2048", deny: "4096" },
    { id: "55555555555555555", type: 0, allow: "1024", deny: "0" },
  ];

  const result = compareConfigurationSnapshots(
    saved({ payload: olderPayload }),
    saved({ id: "snapshot-newer", payload: newerPayload }),
  );

  assert.deepEqual(
    result.entries.map(({ kind, entity, field, before, after }) => ({
      kind,
      entity,
      field,
      before,
      after,
    })),
    [
      {
        kind: "changed",
        entity: "general",
        field: "topic",
        before: "none",
        after: "Read the rules",
      },
      {
        kind: "changed",
        entity: "general",
        field: "permission overwrite role Members allow bits",
        before: "1024",
        after: "2048",
      },
      {
        kind: "changed",
        entity: "general",
        field: "permission overwrite role Members deny bits",
        before: "0",
        after: "4096",
      },
      {
        kind: "added",
        entity: "general",
        field: "permission overwrite role 55555555555555555",
        before: "none",
        after: "allow 1024, deny 0",
      },
      {
        kind: "removed",
        entity: "general",
        field: "permission overwrite member 22222222222222222",
        before: "allow 0, deny 2048",
        after: "none",
      },
    ],
  );
});

test("marks channels present in only one snapshot as visibility ambiguous", () => {
  const olderPayload = payload();
  const newerPayload = payload();
  newerPayload.channels.push({
    ...newerPayload.channels[0]!,
    id: "55555555555555555",
    name: "private-room",
  });
  olderPayload.channels[0]!.name = "old-room";

  const result = compareConfigurationSnapshots(
    saved({ payload: olderPayload }),
    saved({ id: "snapshot-newer", payload: newerPayload }),
  );
  assert.deepEqual(
    result.entries.map(({ kind, entity }) => ({ kind, entity })),
    [
      { kind: "changed", entity: "general" },
      { kind: "newly_returned", entity: "private-room" },
    ],
  );

  const output = formatConfigurationSnapshotDiff(result);
  assert.match(output, /may be new or newly visible/);
  assert.doesNotMatch(output, /Channel added:/);
});

test("marks channels no longer returned without claiming deletion", () => {
  const olderPayload = payload();
  const newerPayload = payload();
  olderPayload.channels.push({
    ...olderPayload.channels[0]!,
    id: "55555555555555555",
    name: "private-room",
  });

  const output = formatConfigurationSnapshotDiff(
    compareConfigurationSnapshots(
      saved({ payload: olderPayload }),
      saved({ id: "snapshot-newer", payload: newerPayload }),
    ),
  );
  assert.match(output, /may be removed or inaccessible/);
  assert.doesNotMatch(output, /Channel removed:/);
});

test("skips details when a channel was unviewable in either snapshot", () => {
  const olderPayload = payload();
  const newerPayload = payload();
  olderPayload.channels[0]!.viewable = false;
  newerPayload.channels[0]!.topic = "Changed while hidden";
  newerPayload.channels[0]!.permission_overwrites = [
    { id: requesterId, type: 1, allow: "1024", deny: "0" },
  ];
  olderPayload.visibility.returned_unviewable_channel_count = 1;

  const result = compareConfigurationSnapshots(
    saved({ payload: olderPayload }),
    saved({ id: "snapshot-newer", payload: newerPayload }),
  );
  assert.deepEqual(
    result.entries.map(({ kind, field }) => ({ kind, field })),
    [
      { kind: "changed", field: "visibility to the bot" },
      { kind: "incomplete", field: undefined },
      { kind: "changed", field: "returned unviewable channel count" },
    ],
  );
  assert.doesNotMatch(
    formatConfigurationSnapshotDiff(result),
    /Changed while hidden/,
  );
  assert.match(formatConfigurationSnapshotDiff(result), /limited visibility/);
});

test("rejects identical, cross-server, and schema-incompatible snapshots", () => {
  const older = saved();
  assert.throws(
    () => compareConfigurationSnapshots(older, older),
    SnapshotComparisonError,
  );
  assert.throws(
    () =>
      compareConfigurationSnapshots(
        older,
        saved({ id: "new", guildId: "99999999999999999" }),
      ),
    SnapshotComparisonError,
  );
  assert.throws(
    () =>
      compareConfigurationSnapshots(
        older,
        saved({ id: "new", schemaVersion: 2 }),
      ),
    SnapshotComparisonError,
  );
});

test("limits output size and escapes untrusted names", () => {
  const olderPayload = payload();
  const newerPayload = payload();
  olderPayload.guild.name = "@everyone *old*";
  newerPayload.guild.name = "@here *new*";
  newerPayload.channels[0]!.topic = "x".repeat(500);
  newerPayload.channels.push(
    ...Array.from({ length: 100 }, (_, index) => ({
      ...newerPayload.channels[0]!,
      id: `6${String(index).padStart(16, "0")}`,
      name: `channel-${index}`,
      topic: `topic-${index}`,
    })),
  );

  const output = formatConfigurationSnapshotDiff(
    compareConfigurationSnapshots(
      saved({ payload: olderPayload }),
      saved({ id: "snapshot-newer", payload: newerPayload }),
    ),
  );
  assert.ok(output.length <= 2_000);
  assert.match(output, /@​everyone/);
  assert.match(output, /\\\*new\\\*/);
  assert.match(output, /additional difference\(s\) omitted/);
});

test("loads only the latest snapshots for the requested server", () => {
  const database = openDatabase(":memory:");
  try {
    const first = saveConfigurationSnapshot(database, {
      guildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: payload(),
    });
    const second = saveConfigurationSnapshot(database, {
      guildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: payload(),
    });
    const otherGuildId = "99999999999999999";
    const otherGuildPayload = payload();
    otherGuildPayload.guild.id = otherGuildId;
    const otherGuild = saveConfigurationSnapshot(database, {
      guildId: otherGuildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: otherGuildPayload,
    });
    database
      .prepare(
        "UPDATE configuration_snapshots SET captured_at = ? WHERE snapshot_id = ?",
      )
      .run("2026-10-30T10:00:00.000Z", first.id);
    database
      .prepare(
        "UPDATE configuration_snapshots SET captured_at = ? WHERE snapshot_id = ?",
      )
      .run("2026-10-30T10:01:00.000Z", second.id);
    database
      .prepare(
        "UPDATE configuration_snapshots SET captured_at = ? WHERE snapshot_id = ?",
      )
      .run("2026-10-30T10:02:00.000Z", otherGuild.id);

    assert.deepEqual(
      getLatestConfigurationSnapshots(database, guildId).map(({ id }) => id),
      [second.id, first.id],
    );
    assert.deepEqual(
      getLatestConfigurationSnapshots(database, guildId, 1).map(({ id }) => id),
      [second.id],
    );
    assert.deepEqual(
      getLatestConfigurationSnapshots(database, "88888888888888888"),
      [],
    );
    assert.throws(
      () => getLatestConfigurationSnapshots(database, guildId, 0),
      RangeError,
    );
  } finally {
    database.close();
  }
});

test("rejects a saved snapshot with an unsupported schema version", () => {
  const database = openDatabase(":memory:");
  try {
    const snapshot = saveConfigurationSnapshot(database, {
      guildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: payload(),
    });
    database
      .prepare(
        "UPDATE configuration_snapshots SET schema_version = 2 WHERE snapshot_id = ?",
      )
      .run(snapshot.id);

    assert.throws(
      () => getLatestConfigurationSnapshots(database, guildId),
      UnsupportedSnapshotSchemaVersionError,
    );
  } finally {
    database.close();
  }
});

test("rejects a saved snapshot with an invalid payload shape", () => {
  const database = openDatabase(":memory:");
  try {
    const snapshot = saveConfigurationSnapshot(database, {
      guildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: payload(),
    });
    database
      .prepare(
        "UPDATE configuration_snapshots SET payload_json = '{}' WHERE snapshot_id = ?",
      )
      .run(snapshot.id);

    assert.throws(
      () => getLatestConfigurationSnapshots(database, guildId),
      /invalid or mismatched payload/,
    );
  } finally {
    database.close();
  }
});
