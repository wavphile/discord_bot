import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemberQuestionEvidence,
  isMemberActivityQuestion,
  type CurrentMemberQuestionTarget,
} from "../src/features/member-questions.js";

const guildId = "11111111111111111";
const memberId = "22222222222222222";
const roleId = "33333333333333333";
const now = new Date("2026-10-30T10:00:00.000Z");

function member(
  overrides: Partial<CurrentMemberQuestionTarget> = {},
): CurrentMemberQuestionTarget {
  return {
    id: memberId,
    guildId,
    roles: [
      {
        id: guildId,
        guildId,
        name: "@everyone",
        permissions: ["ViewChannel"],
      },
      {
        id: roleId,
        guildId,
        name: "Helper",
        permissions: ["SendMessages", "ManageMessages"],
      },
    ],
    joinedAt: "2025-01-02T03:04:05.000Z",
    isServerOwner: false,
    isTimedOut: false,
    timeoutUntil: null,
    ...overrides,
  };
}

test("member question evidence uses current same-server roles and dated observations", () => {
  const result = buildMemberQuestionEvidence({
    question: "What roles and permissions does this member have?",
    guildId,
    member: member(),
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.evidence.guildId, guildId);
  assert.equal(result.evidence.memberId, memberId);
  assert.equal(result.evidence.observedAt, now.toISOString());
  assert.equal(result.evidence.joinedAt, member().joinedAt);
  assert.deepEqual(result.evidence.roleNames, ["@everyone", "Helper"]);
  assert.match(result.evidence.prompt.input, /"ManageMessages"/);
  assert.match(
    result.evidence.prompt.input,
    /"observed_at":"2026-10-30T10:00:00.000Z"/,
  );
  assert.match(
    result.evidence.prompt.input,
    /"message_content":"not_collected"/,
  );
  assert.match(result.evidence.prompt.instructions, /Do not infer past roles/);
  assert.match(
    result.evidence.prompt.instructions,
    /message or activity questions/,
  );
});

test("member evidence rejects activity questions before adding facts", () => {
  for (const question of [
    "What did this member say in their latest message?",
    "Show their message history.",
    "When were they last active?",
    "Did this member post yesterday?",
  ]) {
    assert.deepEqual(
      buildMemberQuestionEvidence({ question, guildId, member: member(), now }),
      { ok: false, reason: "activity_unavailable" },
      question,
    );
  }
});

test("member and role evidence cannot cross server boundaries", () => {
  assert.deepEqual(
    buildMemberQuestionEvidence({
      question: "What roles does this member have?",
      guildId,
      member: member({ guildId: "99999999999999999" }),
      now,
    }),
    { ok: false, reason: "cross_guild_member" },
  );

  assert.deepEqual(
    buildMemberQuestionEvidence({
      question: "What roles does this member have?",
      guildId,
      member: member({
        roles: member().roles.map((role, index) =>
          index === 1 ? { ...role, guildId: "99999999999999999" } : role,
        ),
      }),
      now,
    }),
    { ok: false, reason: "cross_guild_role" },
  );
});

test("member evidence rejects duplicate, malformed, or excessive role data", () => {
  assert.deepEqual(
    buildMemberQuestionEvidence({
      question: "What roles does this member have?",
      guildId,
      member: member({ roles: [member().roles[0]!, member().roles[0]!] }),
      now,
    }),
    { ok: false, reason: "invalid_member" },
  );

  assert.deepEqual(
    buildMemberQuestionEvidence({
      question: "What roles does this member have?",
      guildId,
      member: member({
        roles: Array.from({ length: 251 }, (_, index) => ({
          id: `${guildId.slice(0, -3)}${index.toString().padStart(3, "0")}`,
          guildId,
          name: `Role ${index}`,
          permissions: [],
        })),
      }),
      now,
    }),
    { ok: false, reason: "invalid_member" },
  );

  const manyPermissions = Array.from({ length: 20 }, () => "ManageMessages");
  const largeRoles = [
    member().roles[0]!,
    ...Array.from({ length: 249 }, (_, index) => ({
      id: `${guildId}${index.toString().padStart(3, "0")}`,
      guildId,
      name: `Helper ${index}`,
      permissions: manyPermissions,
    })),
  ];
  assert.deepEqual(
    buildMemberQuestionEvidence({
      question: "What roles does this member have?",
      guildId,
      member: member({ roles: largeRoles }),
      now,
    }),
    { ok: false, reason: "member_data_too_large" },
  );
});

test("activity wording catches history requests without blocking permission questions", () => {
  assert.equal(
    isMemberActivityQuestion("What did the member say yesterday?"),
    true,
  );
  assert.equal(
    isMemberActivityQuestion("Does this member have Send Messages permission?"),
    false,
  );
  assert.equal(
    isMemberActivityQuestion("Why can this member view the channel?"),
    false,
  );
});
