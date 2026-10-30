import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "../src/discord/commands/index.js";

type CommandOption = Readonly<{
  name?: string;
  required?: boolean;
  options?: readonly CommandOption[];
}>;

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
