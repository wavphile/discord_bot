import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  buildConfigurationQuestionEvidence,
  hasCurrentViewAccess,
  MAX_SNAPSHOT_AGE_MS,
} from "../src/features/configuration-questions.js";
import type { SavedConfigurationSnapshot } from "../src/storage/snapshots.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const roleId = "33333333333333333";
const memberId = "44444444444444444";
const unrelatedRoleId = "55555555555555555";
const unrelatedMemberId = "66666666666666666";
const capturedAt = new Date("2026-10-30T09:00:00.000Z");
const now = new Date("2026-10-30T10:00:00.000Z");

function snapshot(): SavedConfigurationSnapshot {
  return {
    id: "a55b1281-79b6-4d99-9b63-e774841dd7c5",
    guildId,
    requestedBy: memberId,
    capturedAt: capturedAt.toISOString(),
    schemaVersion: 1,
    visibility: "limited",
    payload: {
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
        afk_timeout: 0,
        system_channel_id: null,
        system_channel_flags: "0",
        rules_channel_id: null,
        public_updates_channel_id: null,
        mfa_level: 0,
        nsfw_level: 0,
        premium_tier: 0,
      },
      roles: [
        role(guildId, "@everyone", "0"),
        role(roleId, "Member", "0"),
        role(unrelatedRoleId, "Secret role", "0"),
      ],
      channels: [
        {
          id: channelId,
          type: 0,
          name: "bots",
          position: 1,
          parent_id: null,
          topic: "Test only",
          nsfw: false,
          rate_limit_per_user: 0,
          viewable: true,
          permission_overwrites: [
            {
              id: roleId,
              type: 0,
              allow: PermissionFlagsBits.ViewChannel.toString(),
              deny: "0",
            },
            {
              id: unrelatedRoleId,
              type: 0,
              allow: "0",
              deny: PermissionFlagsBits.ViewChannel.toString(),
            },
            {
              id: unrelatedMemberId,
              type: 1,
              allow: "0",
              deny: PermissionFlagsBits.ViewChannel.toString(),
            },
          ],
        },
        {
          id: "77777777777777777",
          type: 0,
          name: "secret-private",
          position: 2,
          parent_id: null,
          topic: "Do not send this channel to the provider",
          nsfw: false,
          rate_limit_per_user: 0,
          viewable: true,
          permission_overwrites: [],
        },
      ],
      visibility: {
        state: "limited",
        note: "Only channels returned by Discord are represented.",
        returned_unviewable_channel_count: 0,
      },
    },
  };
}

function role(id: string, name: string, permissions: string) {
  return {
    id,
    name,
    position: 1,
    permissions,
    colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
    hoist: false,
    managed: false,
    mentionable: false,
    flags: "0",
  };
}

test("question evidence uses only the selected channel and relevant role data", () => {
  const result = buildConfigurationQuestionEvidence({
    question: "  Why can this member see the channel?  ",
    channelId,
    snapshot: snapshot(),
    member: {
      id: memberId,
      roleIds: [guildId, roleId],
      guildOwnerId: "88888888888888888",
      isTimedOut: false,
    },
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.evidence.channelId, channelId);
  assert.equal(result.evidence.memberId, memberId);
  assert.equal(
    result.evidence.permissionExplanation?.viewChannel.allowed,
    true,
  );
  assert.match(
    result.evidence.permissionExplanation?.viewChannel.details.join(" ") ?? "",
    /Role overwrites allow it via \*\*Member\*\*/,
  );
  assert.match(result.evidence.prompt.input, /"name":"bots"/);
  assert.doesNotMatch(result.evidence.prompt.input, /secret-private/);
  assert.doesNotMatch(
    result.evidence.prompt.input,
    new RegExp(unrelatedMemberId),
  );
  assert.doesNotMatch(
    result.evidence.prompt.input,
    new RegExp(unrelatedRoleId),
  );
  assert.match(
    result.evidence.prompt.input,
    /Only channels returned by Discord/,
  );
  assert.equal(result.evidence.snapshotId, snapshot().id);
});

test("question evidence rejects absent, stale, and unviewable snapshot data", () => {
  const saved = snapshot();
  assert.deepEqual(
    buildConfigurationQuestionEvidence({
      question: "What is configured?",
      channelId: "88888888888888888",
      snapshot: saved,
      now,
    }),
    { ok: false, reason: "channel_not_in_snapshot" },
  );

  assert.deepEqual(
    buildConfigurationQuestionEvidence({
      question: "What is configured?",
      channelId,
      snapshot: {
        ...saved,
        capturedAt: new Date(
          now.getTime() - MAX_SNAPSHOT_AGE_MS - 1,
        ).toISOString(),
      },
      now,
    }),
    { ok: false, reason: "stale_snapshot" },
  );

  const hiddenSnapshot: SavedConfigurationSnapshot = {
    ...saved,
    payload: {
      ...saved.payload,
      channels: saved.payload.channels.map((channel) =>
        channel.id === channelId ? { ...channel, viewable: false } : channel,
      ),
    },
  };
  assert.deepEqual(
    buildConfigurationQuestionEvidence({
      question: "What is configured?",
      channelId,
      snapshot: hiddenSnapshot,
      now,
    }),
    { ok: false, reason: "channel_not_viewable" },
  );
});

test("question evidence refuses role data absent from the saved snapshot", () => {
  const saved = snapshot();
  const result = buildConfigurationQuestionEvidence({
    question: "Why can this member view it?",
    channelId,
    snapshot: {
      ...saved,
      payload: {
        ...saved.payload,
        roles: saved.payload.roles.filter((entry) => entry.id !== roleId),
      },
    },
    member: {
      id: memberId,
      roleIds: [guildId, roleId],
      guildOwnerId: "88888888888888888",
      isTimedOut: false,
    },
    now,
  });
  assert.deepEqual(result, { ok: false, reason: "role_data_missing" });
});

test("question evidence validates input bounds and snapshot time", () => {
  const saved = snapshot();
  assert.deepEqual(
    buildConfigurationQuestionEvidence({
      question: "   ",
      channelId,
      snapshot: saved,
      now,
    }),
    { ok: false, reason: "invalid_question" },
  );
  assert.deepEqual(
    buildConfigurationQuestionEvidence({
      question: "x".repeat(501),
      channelId,
      snapshot: saved,
      now,
    }),
    { ok: false, reason: "invalid_question" },
  );
  assert.deepEqual(
    buildConfigurationQuestionEvidence({
      question: "Is this future data?",
      channelId,
      snapshot: {
        ...saved,
        capturedAt: new Date(now.getTime() + 1).toISOString(),
      },
      now,
    }),
    { ok: false, reason: "stale_snapshot" },
  );
});

test("requester channel access fails closed when permission data is missing", () => {
  assert.equal(hasCurrentViewAccess(null), false);
  assert.equal(hasCurrentViewAccess({ has: () => false }), false);
  assert.equal(hasCurrentViewAccess({ has: () => true }), true);
});
