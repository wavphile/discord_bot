import assert from "node:assert/strict";
import test from "node:test";
import { commands, createCommands } from "../src/discord/commands/index.js";

type CommandOption = Readonly<{
  name?: string;
  required?: boolean;
  options?: readonly CommandOption[];
}>;
type SerializedOption = {
  name?: string;
  choices?: Array<{ value: string }>;
  options?: SerializedOption[];
};

function findOption(
  options: readonly SerializedOption[],
  name: string,
): SerializedOption | undefined {
  for (const option of options) {
    if (option.name === name && option.choices) return option;
    const nested = option.options && findOption(option.options, name);
    if (nested) return nested;
  }
  return undefined;
}

function assertRequiredOptionsComeFirst(
  options: readonly CommandOption[],
  path: string,
): void {
  let optionalSeen = false;
  for (const option of options) {
    const optionPath = `${path}.${option.name ?? "<unnamed>"}`;
    if (option.required === true) {
      assert.equal(
        optionalSeen,
        false,
        `Required Discord command option ${optionPath} follows an optional option.`,
      );
    } else {
      optionalSeen = true;
    }
    if (option.options) {
      assertRequiredOptionsComeFirst(option.options, optionPath);
    }
  }
}

test("Discord slash-command schemas place required options before optional options", () => {
  for (const command of commands) {
    const definition = command.toJSON() as CommandOption & {
      name: string;
    };
    if (definition.options) {
      assertRequiredOptionsComeFirst(definition.options, `/${definition.name}`);
    }
  }
});

test("messages provider choices include only locally configured hosted providers", () => {
  const commandWithAnthropic = createCommands(["mock", "anthropic"]).find(
    (entry) => entry.name === "messages",
  );
  const commandWithoutHostedProviders = createCommands(["mock"]).find(
    (entry) => entry.name === "messages",
  );
  assert.ok(commandWithAnthropic);
  assert.ok(commandWithoutHostedProviders);
  const serializeChoices = (command: typeof commandWithAnthropic) => {
    const definition = JSON.parse(JSON.stringify(command.toJSON())) as {
      options: SerializedOption[];
    };
    return findOption(definition.options, "provider")?.choices?.map(
      (choice) => choice.value,
    );
  };
  assert.deepEqual(serializeChoices(commandWithAnthropic), [
    "mock",
    "anthropic",
  ]);
  assert.deepEqual(serializeChoices(commandWithoutHostedProviders), ["mock"]);
});
