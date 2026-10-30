import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  explainChannelPermissions,
  type ChannelPermissionOverwrite,
  type ExplainChannelPermissionsInput,
  type RolePermissionSource,
} from "../src/features/permission-explanations.js";

const viewChannel = PermissionFlagsBits.ViewChannel;
const sendMessages = PermissionFlagsBits.SendMessages;
const sendMessagesInThreads = PermissionFlagsBits.SendMessagesInThreads;
const administrator = PermissionFlagsBits.Administrator;

function role(
  id: string,
  name: string,
  permissions: bigint,
): RolePermissionSource {
  return { id, name, permissions };
}

function overwrite(
  id: string,
  target: ChannelPermissionOverwrite["target"],
  allow = 0n,
  deny = 0n,
  name = id,
): ChannelPermissionOverwrite {
  return { id, target, name, allow, deny };
}

function input(
  overrides: Partial<ExplainChannelPermissionsInput> = {},
): ExplainChannelPermissionsInput {
  return {
    memberId: "member-1",
    guildOwnerId: "owner-1",
    everyoneRole: role("guild-1", "@everyone", 0n),
    memberRoles: [],
    overwrites: [],
    isTimedOut: false,
    ...overrides,
  };
}

test("the guild owner bypasses role and channel restrictions", () => {
  const result = explainChannelPermissions(
    input({
      memberId: "owner-1",
      isTimedOut: true,
      overwrites: [
        overwrite("guild-1", "role", 0n, viewChannel | sendMessages),
        overwrite("owner-1", "member", 0n, sendMessagesInThreads),
      ],
    }),
  );

  assert.equal(result.viewChannel.allowed, true);
  assert.equal(result.sendMessages.allowed, true);
  assert.equal(result.sendMessagesInThreads.allowed, true);
});

test("Administrator bypasses channel overwrites and communication timeouts", () => {
  const result = explainChannelPermissions(
    input({
      memberRoles: [role("admin", "Admin", administrator)],
      isTimedOut: true,
      overwrites: [
        overwrite("guild-1", "role", 0n, viewChannel | sendMessages),
        overwrite("admin", "role", 0n, sendMessagesInThreads),
      ],
    }),
  );

  assert.equal(result.isAdministrator, true);
  assert.equal(result.viewChannel.allowed, true);
  assert.equal(result.sendMessages.allowed, true);
  assert.equal(result.sendMessagesInThreads.allowed, true);
});

test("base permissions combine the everyone role and all member roles", () => {
  const result = explainChannelPermissions(
    input({
      everyoneRole: role("guild-1", "@everyone", viewChannel),
      memberRoles: [role("helper", "Helper", sendMessages)],
    }),
  );

  assert.equal(result.viewChannel.allowed, true);
  assert.equal(result.sendMessages.allowed, true);
  assert.equal(result.sendMessagesInThreads.allowed, false);
});

test("an everyone overwrite applies before member role overwrites", () => {
  const result = explainChannelPermissions(
    input({
      everyoneRole: role("guild-1", "@everyone", viewChannel | sendMessages),
      memberRoles: [role("helper", "Helper", 0n)],
      overwrites: [
        overwrite("guild-1", "role", 0n, viewChannel | sendMessages),
        overwrite("helper", "role", viewChannel | sendMessages),
      ],
    }),
  );

  assert.equal(result.viewChannel.allowed, true);
  assert.equal(result.sendMessages.allowed, true);
  assert.match(
    result.viewChannel.details.join(" "),
    /@everyone channel overwrite denies it/,
  );
  assert.match(
    result.viewChannel.details.join(" "),
    /Role overwrites allow it/,
  );
});

test("role overwrite allows win over conflicting denies across member roles", () => {
  const result = explainChannelPermissions(
    input({
      memberRoles: [role("muted", "Muted", 0n), role("helper", "Helper", 0n)],
      overwrites: [
        overwrite("muted", "role", 0n, viewChannel | sendMessages),
        overwrite("helper", "role", viewChannel | sendMessages),
      ],
    }),
  );

  assert.equal(result.viewChannel.allowed, true);
  assert.equal(result.sendMessages.allowed, true);
  assert.match(
    result.sendMessages.details.join(" "),
    /role allows take precedence/,
  );
});

test("member-specific overwrites apply after role overwrites", () => {
  const result = explainChannelPermissions(
    input({
      memberRoles: [role("helper", "Helper", 0n)],
      overwrites: [
        overwrite("helper", "role", viewChannel | sendMessages),
        overwrite("member-1", "member", 0n, viewChannel),
      ],
    }),
  );

  assert.equal(result.viewChannel.allowed, false);
  assert.equal(result.sendMessages.rawAllowed, true);
  assert.equal(result.sendMessages.allowed, false);
  assert.match(
    result.viewChannel.details.join(" "),
    /member-specific channel overwrite denies it/,
  );
});

test("View Channel implicitly blocks sending and thread access", () => {
  const result = explainChannelPermissions(
    input({
      memberRoles: [
        role("helper", "Helper", sendMessages | sendMessagesInThreads),
      ],
      overwrites: [overwrite("guild-1", "role", 0n, viewChannel)],
    }),
  );

  assert.equal(result.viewChannel.allowed, false);
  assert.equal(result.sendMessages.rawAllowed, true);
  assert.equal(result.sendMessages.allowed, false);
  assert.equal(result.sendMessagesInThreads.rawAllowed, true);
  assert.equal(result.sendMessagesInThreads.allowed, false);
});

test("a communication timeout blocks sending but keeps visible channels visible", () => {
  const result = explainChannelPermissions(
    input({
      everyoneRole: role(
        "guild-1",
        "@everyone",
        viewChannel | sendMessages | sendMessagesInThreads,
      ),
      isTimedOut: true,
    }),
  );

  assert.equal(result.viewChannel.allowed, true);
  assert.equal(result.sendMessages.rawAllowed, true);
  assert.equal(result.sendMessages.allowed, false);
  assert.equal(result.sendMessagesInThreads.allowed, false);
});

test("thread replies use their own permission bit", () => {
  const result = explainChannelPermissions(
    input({
      everyoneRole: role("guild-1", "@everyone", viewChannel | sendMessages),
      memberRoles: [role("helper", "Helper", sendMessagesInThreads)],
    }),
  );

  assert.equal(result.sendMessages.allowed, true);
  assert.equal(result.sendMessagesInThreads.allowed, true);

  const withoutThreadPermission = explainChannelPermissions(
    input({
      everyoneRole: role("guild-1", "@everyone", viewChannel | sendMessages),
    }),
  );

  assert.equal(withoutThreadPermission.sendMessages.allowed, true);
  assert.equal(withoutThreadPermission.sendMessagesInThreads.allowed, false);
});
