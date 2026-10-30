import { z } from "zod";

// Keep opt-in environment switches strict: Boolean("false") would be true.
export const booleanEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
