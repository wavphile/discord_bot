import {
  ChannelType,
  PermissionFlagsBits,
  type TextChannel,
  type VoiceChannel,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import type { AuthorizationPolicy } from "../core/authorization.js";
import type { ChangePlanChange } from "../features/change-plans.js";
import {
  resolveAmbiguousPlanItem,
  summarizePlanJob,
} from "../features/durable-plan-jobs.js";
import { logger } from "../observability/logger.js";
import {
  beginPlanJobItemAttempt,
  cancelPendingPlanJobItems,
  claimPlanJob,
  finalizePlanJob,
  getPlanJob,
  hasOtherUnresolvedPlanJob,
  listRunnablePlanJobs,
  PlanJobStorageError,
  requestPlanJobCancellation,
  setPlanJobItemStatus,
} from "../storage/plan-jobs.js";
import {
  preflightChangePlanOnDiscord,
  readPlanTargetOnDiscord,
  type PlanTargetRead,
} from "./change-plan-preflight.js";

const maxWriteAttempts = 3;
const baseRetryDelayMs = 500;
const maxRetryDelayMs = 30_000;

export type PlanJobRunnerOptions = Readonly<{
  maxWriteAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}>;

export type PlanJobAdapter = Readonly<{
  preflight(
    guildId: string,
    change: ChangePlanChange,
    requestedBy: string,
  ): Promise<boolean>;
  read(guildId: string, change: ChangePlanChange): Promise<PlanTargetRead>;
  write(guildId: string, change: ChangePlanChange): Promise<void>;
}>;

export class DurablePlanJobRunner {
  private readonly guildTails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<void>>();
  private readonly stopController = new AbortController();

  constructor(
    private readonly database: DatabaseSync,
    private readonly client: Pick<import("discord.js").Client, "guilds">,
    private readonly requesterAuthorization: AuthorizationPolicy,
    private readonly adapter: PlanJobAdapter,
    private readonly options: PlanJobRunnerOptions = {},
  ) {}

  resumeOnStartup(): void {
    for (const job of listRunnablePlanJobs(this.database)) {
      this.schedule(job.guildId, job.id);
    }
  }

  schedule(guildId: string, jobId: string): Promise<void> {
    const previous = this.guildTails.get(guildId) ?? Promise.resolve();
    let task: Promise<void>;
    task = previous
      .catch(() => undefined)
      .then(() => this.executeQueuedJob(guildId, jobId))
      .catch((error: unknown) => {
        logger.error("plan_job.runner.failed", error, { guildId });
        try {
          finalizePlanJob(
            this.database,
            guildId,
            jobId,
            "reconciliation_required",
            "applying",
          );
        } catch (storageError) {
          logger.error("plan_job.recovery_state.failed", storageError, {
            guildId,
          });
        }
      })
      .finally(() => {
        this.active.delete(task);
        if (this.guildTails.get(guildId) === task) {
          this.guildTails.delete(guildId);
        }
      });
    this.guildTails.set(guildId, task);
    this.active.add(task);
    return task;
  }

  requestCancellation(guildId: string, jobId: string): void {
    requestPlanJobCancellation(this.database, guildId, jobId);
    this.schedule(guildId, jobId);
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await Promise.allSettled([...this.active]);
  }

  private async executeQueuedJob(
    guildId: string,
    jobId: string,
  ): Promise<void> {
    if (this.stopController.signal.aborted) return;
    if (hasOtherUnresolvedPlanJob(this.database, guildId, jobId)) return;
    if (!claimPlanJob(this.database, guildId, jobId)) return;

    const preflightAttempts = new Map<number, number>();
    while (!this.stopController.signal.aborted) {
      const job = getPlanJob(this.database, guildId, jobId);
      if (!job || isTerminalJobStatus(job.status)) return;

      const interrupted = job.items.find((item) => item.status === "applying");
      if (interrupted) {
        const read = await this.safeRead(guildId, interrupted.change);
        const resolution = resolveAmbiguousPlanItem(
          interrupted.change,
          read.current,
          read.targetAvailable,
          read.readable,
        );
        if (resolution === "unreadable") {
          finalizePlanJob(
            this.database,
            guildId,
            jobId,
            "reconciliation_required",
            "applying",
          );
          return;
        }
        if (resolution === "already_applied") {
          setPlanJobItemStatus(
            this.database,
            guildId,
            jobId,
            interrupted.ordinal,
            "applied",
            "Recovered after restart: Discord already had the planned value.",
          );
          continue;
        }
        if (resolution === "safe_to_retry") {
          if (interrupted.attempts >= this.maxAttempts()) {
            await this.finishItemFailure(
              jobId,
              job,
              interrupted.ordinal,
              "failed",
              "The bounded Discord retry limit was reached before restart.",
            );
            return;
          }
          setPlanJobItemStatus(
            this.database,
            guildId,
            jobId,
            interrupted.ordinal,
            "pending",
            "Recovered after restart: Discord still has the approved before value.",
          );
          continue;
        }
        await this.finishItemFailure(
          jobId,
          job,
          interrupted.ordinal,
          "conflicted",
          read.reason ??
            "The target changed while a Discord write was interrupted.",
        );
        return;
      }

      if (
        job.items.some(
          (item) => item.status === "failed" || item.status === "conflicted",
        )
      ) {
        cancelPendingPlanJobItems(this.database, jobId);
        this.finalizeFromCurrent(jobId, guildId);
        return;
      }

      if (job.cancelRequested) {
        cancelPendingPlanJobItems(this.database, jobId);
        this.finalizeFromCurrent(jobId, guildId);
        return;
      }

      const item = job.items.find(
        (candidate) => candidate.status === "pending",
      );
      if (!item) {
        this.finalizeFromCurrent(jobId, guildId);
        return;
      }

      let canProceed = false;
      try {
        canProceed = await this.adapter.preflight(
          guildId,
          item.change,
          job.requestedBy,
        );
      } catch (error) {
        if (this.stopController.signal.aborted) return;
        const attempts = (preflightAttempts.get(item.ordinal) ?? 0) + 1;
        preflightAttempts.set(item.ordinal, attempts);
        if (isRetryable(error) && attempts < this.maxAttempts()) {
          await this.waitForRetry(error, attempts);
          continue;
        }
        await this.finishItemFailure(
          jobId,
          job,
          item.ordinal,
          "failed",
          summarizeError(error),
        );
        return;
      }
      if (this.stopController.signal.aborted) return;
      if (!canProceed) {
        await this.finishItemFailure(
          jobId,
          job,
          item.ordinal,
          "conflicted",
          "The requester, target value, or bot permissions no longer pass preflight.",
        );
        return;
      }
      preflightAttempts.delete(item.ordinal);
      if (this.stopController.signal.aborted) return;

      let attempts: number;
      try {
        attempts = beginPlanJobItemAttempt(
          this.database,
          guildId,
          jobId,
          item.ordinal,
        );
      } catch (error) {
        if (
          error instanceof PlanJobStorageError &&
          error.code === "cancelled"
        ) {
          continue;
        }
        throw error;
      }

      try {
        await this.adapter.write(guildId, item.change);
        setPlanJobItemStatus(
          this.database,
          guildId,
          jobId,
          item.ordinal,
          "applied",
          null,
        );
      } catch (error) {
        const read = await this.safeRead(guildId, item.change);
        const resolution = resolveAmbiguousPlanItem(
          item.change,
          read.current,
          read.targetAvailable,
          read.readable,
        );
        if (resolution === "unreadable") {
          finalizePlanJob(
            this.database,
            guildId,
            jobId,
            "reconciliation_required",
            "applying",
          );
          return;
        }
        if (resolution === "already_applied") {
          setPlanJobItemStatus(
            this.database,
            guildId,
            jobId,
            item.ordinal,
            "applied",
            "Discord confirmed the planned value after an ambiguous response.",
          );
          continue;
        }
        if (
          resolution === "safe_to_retry" &&
          isRetryable(error) &&
          attempts < this.maxAttempts()
        ) {
          setPlanJobItemStatus(
            this.database,
            guildId,
            jobId,
            item.ordinal,
            "pending",
            summarizeError(error),
          );
          await this.waitForRetry(error, attempts);
          continue;
        }
        await this.finishItemFailure(
          jobId,
          job,
          item.ordinal,
          resolution === "conflicted" ? "conflicted" : "failed",
          resolution === "conflicted"
            ? (read.reason ?? "The target value changed after approval.")
            : summarizeError(error),
        );
        return;
      }
    }
  }

  private async finishItemFailure(
    jobId: string,
    job: NonNullable<ReturnType<typeof getPlanJob>>,
    ordinal: number,
    status: "failed" | "conflicted",
    reason: string,
  ): Promise<void> {
    setPlanJobItemStatus(
      this.database,
      job.guildId,
      jobId,
      ordinal,
      status,
      reason.slice(0, 500),
    );
    cancelPendingPlanJobItems(this.database, jobId);
    this.finalizeFromCurrent(jobId, job.guildId);
  }

  private finalizeFromCurrent(jobId: string, guildId: string): void {
    const job = getPlanJob(this.database, guildId, jobId);
    if (!job) return;
    const summary = summarizePlanJob(job.items, job.cancelRequested);
    finalizePlanJob(
      this.database,
      guildId,
      jobId,
      summary.jobStatus,
      summary.planStatus as import("../features/change-plans.js").ChangePlanStatus,
    );
  }

  private async safeRead(
    guildId: string,
    change: ChangePlanChange,
  ): Promise<PlanTargetRead> {
    try {
      return await this.adapter.read(guildId, change);
    } catch {
      return {
        current: null,
        readable: false,
        targetAvailable: false,
      };
    }
  }

  private async waitForRetry(error: unknown, attempt: number): Promise<void> {
    const retryAfterMs = retryAfterMilliseconds(error);
    const exponential = Math.min(
      this.options.maxRetryDelayMs ?? maxRetryDelayMs,
      (this.options.baseRetryDelayMs ?? baseRetryDelayMs) *
        2 ** Math.max(0, attempt - 1),
    );
    const delayMs = retryAfterMs ?? exponential;
    await abortableDelay(delayMs, this.stopController.signal);
  }

  private maxAttempts(): number {
    return Math.max(1, this.options.maxWriteAttempts ?? maxWriteAttempts);
  }
}

export function createDiscordPlanJobAdapter(
  client: Pick<import("discord.js").Client, "guilds">,
  requesterAuthorization: AuthorizationPolicy,
): PlanJobAdapter {
  return {
    async preflight(guildId, change, requestedBy) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return false;
      const result = await preflightChangePlanOnDiscord(
        guild,
        { requestedBy, changes: [change] },
        requesterAuthorization,
      );
      return result.ready;
    },
    async read(guildId, change) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        return {
          current: null,
          readable: false,
          targetAvailable: false,
          reason: "The planned server is not currently available.",
        };
      }
      return readPlanTargetOnDiscord(guild, change);
    },
    async write(guildId, change) {
      const guild = await client.guilds.fetch(guildId);
      if (!guild)
        throw new Error("The planned server is not currently available.");
      const channel = await guild.channels.fetch(change.channelId, {
        force: true,
      });
      if (!channel)
        throw new Error("The planned channel is no longer available.");

      if (change.settingKey === "channel.topic") {
        if (channel.type !== ChannelType.GuildText) {
          throw new Error("The planned topic channel is no longer supported.");
        }
        await channel.setTopic(change.after, "Apply approved change plan");
        return;
      }
      if (change.settingKey === "channel.slowmode") {
        if (channel.type !== ChannelType.GuildText) {
          throw new Error(
            "The planned slowmode channel is no longer supported.",
          );
        }
        await channel.setRateLimitPerUser(
          change.after,
          "Apply approved change plan",
        );
        return;
      }
      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildVoice
      ) {
        throw new Error(
          "The planned permission channel is no longer supported.",
        );
      }
      const permissionChanges = changedPermissionOptions(change);
      if (permissionChanges.length === 0) {
        throw new Error("The planned permission change has no changed bits.");
      }
      const options: Partial<
        Record<keyof typeof PermissionFlagsBits, boolean | null>
      > = {};
      for (const { name, state } of permissionChanges) {
        options[name as keyof typeof PermissionFlagsBits] = state;
      }
      await (channel as TextChannel | VoiceChannel).permissionOverwrites.edit(
        change.roleId,
        options,
        {
          reason: "Apply approved change plan",
        },
      );
    },
  };
}

export function changedPermissionOptions(
  change: Extract<ChangePlanChange, { settingKey: "channel.role_overwrite" }>,
): Array<{ name: string; state: boolean | null }> {
  const beforeAllow = BigInt(change.before?.allow ?? "0");
  const beforeDeny = BigInt(change.before?.deny ?? "0");
  const afterAllow = BigInt(change.after?.allow ?? "0");
  const afterDeny = BigInt(change.after?.deny ?? "0");
  const changedBits = (beforeAllow ^ afterAllow) | (beforeDeny ^ afterDeny);
  const options: Array<{ name: string; state: boolean | null }> = [];
  const supportedNames = new Set([
    "ViewChannel",
    "SendMessages",
    "ReadMessageHistory",
    "Connect",
    "Speak",
  ]);

  for (const [name, value] of Object.entries(PermissionFlagsBits)) {
    if (typeof value !== "bigint") continue;
    const bit = value;
    if ((changedBits & bit) === 0n) continue;
    if (!supportedNames.has(name)) {
      throw new Error(
        "The plan contains a permission this command does not support.",
      );
    }
    options.push({
      name,
      state:
        (afterAllow & bit) !== 0n
          ? true
          : (afterDeny & bit) !== 0n
            ? false
            : null,
    });
  }
  if ((changedBits & ~editablePlanPermissionBits()) !== 0n) {
    throw new Error(
      "The plan contains a permission bit this bot cannot apply safely.",
    );
  }
  return options;
}

let editablePlanPermissionBitsCache: bigint | undefined;
function editablePlanPermissionBits(): bigint {
  if (editablePlanPermissionBitsCache !== undefined) {
    return editablePlanPermissionBitsCache;
  }
  const supportedNames = new Set([
    "ViewChannel",
    "SendMessages",
    "ReadMessageHistory",
    "Connect",
    "Speak",
  ]);
  editablePlanPermissionBitsCache = Object.entries(
    PermissionFlagsBits,
  ).reduce<bigint>(
    (bits, [name, value]) =>
      typeof value === "bigint" && supportedNames.has(name)
        ? bits | value
        : bits,
    0n,
  );
  return editablePlanPermissionBitsCache;
}

function isTerminalJobStatus(status: string): boolean {
  return ["applied", "partial", "failed", "conflicted", "cancelled"].includes(
    status,
  );
}

function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 429 || (status !== null && status >= 500)) return true;
  if (retryAfterMilliseconds(error) !== null) return true;
  const code = errorCode(error);
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
  ].includes(code ?? "");
}

function retryAfterMilliseconds(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if ("retryAfter" in error && typeof error.retryAfter === "number") {
    return Math.max(0, error.retryAfter);
  }
  if ("data" in error && isRecord(error.data)) {
    const seconds = error.data["retry_after"];
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return Math.max(0, Math.ceil(seconds * 1_000));
    }
  }
  if ("rawError" in error && isRecord(error.rawError)) {
    const seconds = error.rawError["retry_after"];
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return Math.max(0, Math.ceil(seconds * 1_000));
    }
  }
  return null;
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  if (typeof error.code === "string") return error.code;
  if (typeof error.code === "number") return String(error.code);
  return null;
}

function summarizeError(error: unknown): string {
  const status = errorStatus(error);
  if (status !== null) return `Discord request failed with HTTP ${status}.`;
  const code = errorCode(error);
  if (code) return `Discord request failed (${code}).`;
  return "Discord request failed; no settings were confirmed as applied.";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", complete);
      resolve();
    };
    const timer = setTimeout(complete, ms);
    signal.addEventListener("abort", complete, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
