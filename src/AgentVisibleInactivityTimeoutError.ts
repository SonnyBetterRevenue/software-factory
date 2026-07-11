import { AgentVisibleInactivityTimeoutError as AgentVisibleInactivityTimeoutErrorImpl } from "./errors.js";

/**
 * Run exceeded the configured visible inactivity timeout.
 *
 * Public-facing type for `AgentVisibleInactivityTimeoutError`. The runtime
 * class is the same `Data.TaggedError` from `errors.ts`, but we re-declare its
 * public shape here as a plain `Error` subclass so that Effect's type
 * machinery does not leak into Sandcastle's published `.d.ts` files.
 */
export interface AgentVisibleInactivityTimeoutError extends Error {
  readonly _tag: "AgentVisibleInactivityTimeoutError";
  readonly message: string;
  readonly timeoutMs: number;
  readonly preservedWorktreePath?: string;
}

interface AgentVisibleInactivityTimeoutErrorConstructor {
  new (args: {
    readonly message: string;
    readonly timeoutMs: number;
    readonly preservedWorktreePath?: string;
  }): AgentVisibleInactivityTimeoutError;
  readonly prototype: AgentVisibleInactivityTimeoutError;
}

/** Run exceeded the configured visible inactivity timeout. */
export const AgentVisibleInactivityTimeoutError: AgentVisibleInactivityTimeoutErrorConstructor =
  AgentVisibleInactivityTimeoutErrorImpl as unknown as AgentVisibleInactivityTimeoutErrorConstructor;
