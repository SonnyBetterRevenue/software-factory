import { Deferred, Duration, Effect, Fiber } from "effect";
import { AgentStreamEmitter } from "./AgentStreamEmitter.js";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  AgentVisibleInactivityTimeoutError,
  InitError,
  SessionCaptureError,
} from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory, SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider, IterationUsage } from "./AgentProvider.js";
import type { Timeouts } from "./run.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";

export type { ParsedStreamEvent, IterationUsage } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  provider: AgentProvider,
  idleTimeoutMs: number,
  completionTimeoutMs: number,
  heartbeatIntervalMs: number,
  visibleInactivityTimeoutMs: number | undefined,
  completionSignals: readonly string[],
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  onRawLine: (line: string) => void,
  onHeartbeat: (
    state: ActivityState,
    elapsedMs: number,
    lastVisibleEventAt: Date | undefined,
    visibleSilenceMs: number,
  ) => void,
  onIdleWarning: (minutes: number) => void,
  onCompletionTimeout: (timeoutMs: number) => void,
  idleWarningIntervalMs: number = IDLE_WARNING_INTERVAL_MS,
  resumeSession?: string,
  forkSession?: boolean,
  signal?: AbortSignal,
): Effect.Effect<
  {
    result: string;
    sessionId?: string;
    usage?: IterationUsage;
    timing: IterationTimingSummary;
  },
  SandboxError
> =>
  Effect.gen(function* () {
    let resultText = "";
    let sessionId: string | undefined;
    let usage: IterationUsage | undefined;
    // Accumulated text/result output, scanned for the completion signal so a
    // hanging process can be force-completed once the signal is in the buffer
    // (see ADR 0019).
    let accumulatedOutput = "";

    // Deferred that fails when the idle timer fires (no signal seen).
    const timeoutSignal = yield* Deferred.make<
      never,
      AgentIdleTimeoutError | AgentVisibleInactivityTimeoutError
    >();
    // Deferred that resolves successfully when the completion-grace timer
    // fires (signal seen but process hasn't exited). Resolving lets the race
    // hand control back to the orchestrator with the buffered output, which
    // still contains the signal so the existing completionSignal check works.
    const completionTimeoutDeferred = yield* Deferred.make<
      {
        result: string;
        sessionId?: string;
        usage?: IterationUsage;
        timing: IterationTimingSummary;
      },
      never
    >();
    let timeoutFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let completionDetected = false;
    // Periodic idle warning state
    let warningFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let idleMinuteCounter = 0;
    let heartbeatFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let visibleTimeoutFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    const startedAtMs = Date.now();
    let state: ActivityState = "provider_wait";
    let lastStateChangeAtMs = startedAtMs;
    let lastVisibleEventAtMs: number | undefined;
    let heartbeatCount = 0;
    let longestVisibleSilenceMs = 0;
    let outcome: IterationTimingSummary["outcome"] = "success";
    let providerWaitMs = 0;
    let toolRunningMs = 0;

    const interruptFiber = (
      fiber: Fiber.RuntimeFiber<unknown, unknown> | null,
    ) => {
      if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
    };

    const updateLongestVisibleSilence = (nowMs: number) => {
      const visibleSilenceMs =
        lastVisibleEventAtMs === undefined
          ? nowMs - startedAtMs
          : nowMs - lastVisibleEventAtMs;
      if (visibleSilenceMs > longestVisibleSilenceMs) {
        longestVisibleSilenceMs = visibleSilenceMs;
      }
      return visibleSilenceMs;
    };

    const addStateDuration = (nowMs: number) => {
      const delta = nowMs - lastStateChangeAtMs;
      if (state === "tool_running") {
        toolRunningMs += delta;
      } else {
        providerWaitMs += delta;
      }
      lastStateChangeAtMs = nowMs;
    };

    const setState = (next: ActivityState, nowMs: number) => {
      if (state === next) return;
      addStateDuration(nowMs);
      state = next;
    };

    const buildTimingSummary = (): IterationTimingSummary => {
      const nowMs = Date.now();
      addStateDuration(nowMs);
      updateLongestVisibleSilence(nowMs);
      return {
        providerWaitMs,
        toolRunningMs,
        longestVisibleSilenceMs,
        heartbeatCount,
        totalProviderMs: nowMs - startedAtMs,
        outcome,
      };
    };

    const startWarningInterval = () => {
      interruptFiber(warningFiber);
      idleMinuteCounter = 0;
      warningFiber = Effect.runFork(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(idleWarningIntervalMs));
            idleMinuteCounter++;
            onIdleWarning(idleMinuteCounter);
          }
        }),
      );
    };

    const startHeartbeatInterval = () => {
      interruptFiber(heartbeatFiber);
      heartbeatFiber = Effect.runFork(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(heartbeatIntervalMs));
            const nowMs = Date.now();
            const visibleSilenceMs = updateLongestVisibleSilence(nowMs);
            heartbeatCount++;
            onHeartbeat(
              state,
              nowMs - startedAtMs,
              lastVisibleEventAtMs === undefined
                ? undefined
                : new Date(lastVisibleEventAtMs),
              visibleSilenceMs,
            );
          }
        }),
      );
    };

    const resetVisibleTimeout = () => {
      interruptFiber(visibleTimeoutFiber);
      visibleTimeoutFiber = null;
      if (visibleInactivityTimeoutMs === undefined) return;
      if (completionDetected) return;
      visibleTimeoutFiber = Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(visibleInactivityTimeoutMs));
          outcome = "visible_inactivity_timeout";
          yield* Deferred.fail(
            timeoutSignal,
            new AgentVisibleInactivityTimeoutError({
              message:
                `Agent produced no visible progress for ${visibleInactivityTimeoutMs / 1000} seconds. ` +
                `Only text/tool events reset this timeout; raw provider noise does not.`,
              timeoutMs: visibleInactivityTimeoutMs,
            }),
          );
        }),
      );
    };

    const resetTimer = () => {
      interruptFiber(timeoutFiber);
      if (completionDetected) {
        // Post-signal grace window — successful resolution on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(completionTimeoutMs));
            outcome = "completion_timeout";
            onCompletionTimeout(completionTimeoutMs);
            yield* Deferred.succeed(completionTimeoutDeferred, {
              result: resultText || accumulatedOutput,
              sessionId,
              usage,
              timing: buildTimingSummary(),
            });
          }),
        );
      } else {
        // Pre-signal idle window — failure on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            outcome = "idle_timeout";
            yield* Deferred.fail(
              timeoutSignal,
              new AgentIdleTimeoutError({
                message: `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received. Consider increasing the idle timeout with --idle-timeout.`,
                timeoutMs: idleTimeoutMs,
              }),
            );
          }),
        );
        // Reset warning interval on activity, idle-phase only.
        startWarningInterval();
      }
    };

    // Deferred that will be resolved (as a defect) when the AbortSignal fires.
    // Uses Effect.die so the abort reason propagates as-is to run().
    const abortDeferred = yield* Deferred.make<never, never>();
    let abortCleanup: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        return yield* Effect.die(signal.reason);
      }
      const onAbort = () => {
        Effect.runFork(Deferred.die(abortDeferred, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }

    resetTimer();
    startHeartbeatInterval();
    resetVisibleTimeout();

    const execEffect = Effect.gen(function* () {
      const printCmd = provider.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
        forkSession,
      });
      const execResult = yield* sandbox.exec(printCmd.command, {
        onLine: (line) => {
          // Surface the raw line FIRST so verbose mode/forwarders see every
          // stdout line the agent produced, including ones parseStreamLine
          // drops. Errors thrown by the callback are caught by the emitter
          // layer; isolate the parser path here so a broken forwarder cannot
          // skip parsing.
          try {
            onRawLine(line);
          } catch {
            // Swallow — must not skip parsing/timer logic below.
          }
          for (const parsed of provider.parseStreamLine(line)) {
            if (parsed.type === "text") {
              const nowMs = Date.now();
              setState("provider_wait", nowMs);
              lastVisibleEventAtMs = nowMs;
              updateLongestVisibleSilence(nowMs);
              resetVisibleTimeout();
              onText(parsed.text);
              accumulatedOutput += parsed.text;
            } else if (parsed.type === "result") {
              const nowMs = Date.now();
              setState("provider_wait", nowMs);
              lastVisibleEventAtMs = nowMs;
              updateLongestVisibleSilence(nowMs);
              resetVisibleTimeout();
              resultText = parsed.result;
              accumulatedOutput += parsed.result;
            } else if (parsed.type === "tool_call") {
              const nowMs = Date.now();
              setState("tool_running", nowMs);
              lastVisibleEventAtMs = nowMs;
              updateLongestVisibleSilence(nowMs);
              resetVisibleTimeout();
              onToolCall(parsed.name, parsed.args);
            } else if (parsed.type === "session_id") {
              sessionId = parsed.sessionId;
            } else if (parsed.type === "usage") {
              usage = parsed.usage;
            }
          }
          // Check for the completion signal AFTER parsing this line so the
          // accumulator contains everything seen so far. Flip to the
          // completion-grace timer the first time the signal appears.
          if (
            !completionDetected &&
            completionSignals.some((sig) => accumulatedOutput.includes(sig))
          ) {
            completionDetected = true;
            interruptFiber(warningFiber);
            warningFiber = null;
            interruptFiber(visibleTimeoutFiber);
            visibleTimeoutFiber = null;
          }
          resetTimer();
        },
        cwd: sandboxRepoDir,
        stdin: printCmd.stdin,
      });

      if (execResult.exitCode !== 0) {
        outcome = "dead_provider";
        // Prefer stderr; fall back to resultText (from parsed stream events),
        // then to the tail of raw stdout (last 20 non-empty lines).
        let errorDetail = execResult.stderr;
        if (!errorDetail.trim()) {
          errorDetail = resultText;
        }
        if (!errorDetail.trim()) {
          const lines = execResult.stdout.split("\n").filter((l) => l.trim());
          errorDetail = lines.slice(-20).join("\n");
        }
        return yield* Effect.fail(
          new AgentError({
            message: `[dead_provider] ${provider.name} exited with code ${execResult.exitCode}:\n${errorDetail}`,
          }),
        );
      }

      return {
        result: resultText || execResult.stdout,
        sessionId,
        usage,
        timing: buildTimingSummary(),
      };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
          interruptFiber(heartbeatFiber);
          heartbeatFiber = null;
          interruptFiber(visibleTimeoutFiber);
          visibleTimeoutFiber = null;
        }),
      ),
    );

    let raced: Effect.Effect<
      {
        result: string;
        sessionId?: string;
        usage?: IterationUsage;
        timing: IterationTimingSummary;
      },
      AgentIdleTimeoutError | AgentVisibleInactivityTimeoutError | SandboxError
    > = Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
    raced = Effect.raceFirst(raced, Deferred.await(completionTimeoutDeferred));
    if (signal) {
      raced = Effect.raceFirst(
        raced,
        Deferred.await(abortDeferred) as Effect.Effect<never, never>,
      );
    }

    return yield* raced.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          abortCleanup?.();
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
          interruptFiber(heartbeatFiber);
          heartbeatFiber = null;
          interruptFiber(visibleTimeoutFiber);
          visibleTimeoutFiber = null;
        }),
      ),
    );
  });

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60; // 600 seconds
const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;

export type ActivityState = "provider_wait" | "tool_running";

export interface IterationTimingSummary {
  readonly providerWaitMs: number;
  readonly toolRunningMs: number;
  readonly longestVisibleSilenceMs: number;
  readonly heartbeatCount: number;
  readonly totalProviderMs: number;
  readonly outcome:
    | "success"
    | "completion_timeout"
    | "idle_timeout"
    | "visible_inactivity_timeout"
    | "dead_provider";
}

export interface RunTimingSummary extends IterationTimingSummary {
  readonly iterations: readonly IterationTimingSummary[];
}

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with AgentIdleTimeoutError. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /**
   * Grace window in seconds after a completion signal is observed in the
   * agent's output. The agent process is expected to exit shortly after
   * emitting the signal; if it does not (because a spawned child is keeping
   * stdout open — see ADR 0019), this timer fires and the iteration resolves
   * successfully with the buffered output. Resets on every subsequent output
   * line, so trailing data (token-usage events, terminal `result` events,
   * structured-output tags) is still captured. Default: 60 seconds.
   */
  readonly completionTimeoutSeconds?: number;
  /** Emit a visible heartbeat while the provider call is live. Default: 30 seconds. */
  readonly heartbeatIntervalSeconds?: number;
  /**
   * Timeout in seconds for visible inactivity only (displayed text/tool progress).
   * Raw/internal stream noise does not reset this timer. Disabled by default.
   */
  readonly visibleInactivityTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** Resume a prior Claude Code session by ID. Applied to iteration 1 only. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it — the parent JSONL stays intact and the agent writes a new session
   * under a fresh id. Applied to iteration 1 only. See ADR 0018.
   */
  readonly forkSession?: boolean;
  /** An AbortSignal that cancels the orchestration when aborted. */
  readonly signal?: AbortSignal;
  /** When true, skip prompt expansion (shell expression evaluation). Set for dynamic inline prompts. */
  readonly skipPromptExpansion?: boolean;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** Forwarded to `withSandboxLifecycle` — see `SandboxLifecycleOptions.keepSourceBranch`. */
  readonly keepSourceBranch?: boolean;
}

/** Per-iteration result carrying an optional session ID. */
export interface IterationResult {
  /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
  readonly sessionId?: string;
  /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
  readonly sessionFilePath?: string;
  /** Token usage snapshot from the last assistant message in the session, or undefined when capture is disabled or provider does not support usage parsing. */
  readonly usage?: IterationUsage;
  readonly timing?: IterationTimingSummary;
}

export interface OrchestrateResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
  /** Host path to the preserved worktree from the last iteration, set when the worktree was left behind due to uncommitted changes on a successful run. */
  readonly preservedWorktreePath?: string;
  readonly timing: RunTimingSummary;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<
  OrchestrateResult,
  SandboxError,
  SandboxFactory | Display | AgentStreamEmitter
> => {
  const idleTimeoutMs =
    (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
  const completionTimeoutMs =
    (options.completionTimeoutSeconds ?? DEFAULT_COMPLETION_TIMEOUT_SECONDS) *
    1000;
  const heartbeatIntervalMs =
    (options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS) *
    1000;
  const visibleInactivityTimeoutMs =
    options.visibleInactivityTimeoutSeconds === undefined
      ? undefined
      : options.visibleInactivityTimeoutSeconds * 1000;
  return Effect.gen(function* () {
    if (
      options.heartbeatIntervalSeconds !== undefined &&
      (!Number.isFinite(options.heartbeatIntervalSeconds) ||
        options.heartbeatIntervalSeconds <= 0)
    ) {
      return yield* Effect.fail(
        new InitError({
          message: "heartbeatIntervalSeconds must be a finite positive number.",
        }),
      );
    }
    if (
      options.visibleInactivityTimeoutSeconds !== undefined &&
      (!Number.isFinite(options.visibleInactivityTimeoutSeconds) ||
        options.visibleInactivityTimeoutSeconds <= 0)
    ) {
      return yield* Effect.fail(
        new InitError({
          message:
            "visibleInactivityTimeoutSeconds must be a finite positive number.",
        }),
      );
    }
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const streamEmitter = yield* AgentStreamEmitter;
    const { hostRepoDir, iterations, hooks, prompt, branch, provider } =
      options;
    let completionSignals: string[];
    if (options.completionSignal === undefined) {
      completionSignals = [DEFAULT_COMPLETION_SIGNAL];
    } else if (Array.isArray(options.completionSignal)) {
      completionSignals = options.completionSignal;
    } else {
      completionSignals = [options.completionSignal];
    }

    const label = (msg: string): string =>
      options.name ? `[${options.name}] ${msg}` : msg;

    const allCommits: { sha: string }[] = [];
    const allIterations: IterationResult[] = [];
    const allTiming: IterationTimingSummary[] = [];
    let allStdout = "";
    let resolvedBranch = "";
    let iterationPreservedPath: string | undefined;

    // Helper: check abort signal and bail via defect so run() can
    // re-throw the signal's reason verbatim (no Sandcastle wrapping).
    const checkAbort = (): Effect.Effect<void> =>
      options.signal?.aborted ? Effect.die(options.signal.reason) : Effect.void;

    for (let i = 1; i <= iterations; i++) {
      yield* checkAbort();
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      const sandboxResult = yield* factory.withSandbox(
        (
          { hostWorktreePath, sandboxRepoPath, applyToHost, bindMountHandle },
          sandbox,
        ) =>
          withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir: sandboxRepoPath,
              hooks,
              branch,
              hostWorktreePath,
              applyToHost,
              signal: options.signal,
              timeouts: options.timeouts,
              keepSourceBranch: options.keepSourceBranch,
            },
            sandbox,
            (ctx) =>
              Effect.gen(function* () {
                // Resume session: transfer JSONL from host to sandbox before iteration 1
                const iterationResumeSession =
                  i === 1 ? options.resumeSession : undefined;
                const iterationForkSession =
                  i === 1 ? options.forkSession : undefined;
                if (
                  iterationResumeSession &&
                  bindMountHandle &&
                  provider.sessionStorage
                ) {
                  yield* display.status(label("Resuming session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      provider.sessionStorage!.resumeIntoSandbox({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId: iterationResumeSession,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId: iterationResumeSession,
                      }),
                  });
                }

                // Preprocess prompt (run !`command` expressions inside sandbox).
                // Inline prompts pass through literally — skip expansion.
                const fullPrompt = options.skipPromptExpansion
                  ? prompt
                  : yield* preprocessPrompt(
                      prompt,
                      ctx.sandbox,
                      ctx.sandboxRepoDir,
                    );

                yield* display.status(label("Agent started"), "success");

                // Invoke the agent — buffer text deltas so Pi's single-token
                // chunks are displayed as readable multi-word lines.
                const textBuffer = new TextDeltaBuffer((chunk) => {
                  Effect.runPromise(display.textChunk(chunk));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "text",
                      message: chunk,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                });
                const onText = (text: string) => {
                  textBuffer.write(text);
                };
                const onToolCall = (name: string, formattedArgs: string) => {
                  textBuffer.flush();
                  Effect.runPromise(display.toolCall(name, formattedArgs));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "toolCall",
                      name,
                      formattedArgs,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onRawLine = (line: string) => {
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "raw",
                      line,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onHeartbeat = (
                  state: ActivityState,
                  elapsedMs: number,
                  lastVisibleEventAt: Date | undefined,
                  visibleSilenceMs: number,
                ) => {
                  const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
                  const silentSeconds = (visibleSilenceMs / 1000).toFixed(1);
                  const lastVisiblePart =
                    lastVisibleEventAt === undefined
                      ? "last visible event: none yet"
                      : `last visible event: ${lastVisibleEventAt.toISOString()}`;
                  Effect.runPromise(
                    display.status(
                      label(
                        `Heartbeat: state=${state}, elapsed=${elapsedSeconds}s, visible silence=${silentSeconds}s, ${lastVisiblePart}`,
                      ),
                      "info",
                    ),
                  );
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "heartbeat",
                      state,
                      elapsedMs,
                      lastVisibleEventAt,
                      visibleSilenceMs,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onIdleWarning = (minutes: number) => {
                  const msg =
                    minutes === 1
                      ? "Agent idle for 1 minute"
                      : `Agent idle for ${minutes} minutes`;
                  Effect.runPromise(display.status(label(msg), "warn"));
                };
                const onCompletionTimeout = (timeoutMs: number) => {
                  Effect.runPromise(
                    display.status(
                      label(
                        `Completion signal seen but agent process is hanging — force-completing after ${timeoutMs / 1000}s grace window.`,
                      ),
                      "warn",
                    ),
                  );
                };
                const {
                  result: agentOutput,
                  sessionId,
                  usage: streamUsage,
                  timing,
                } = yield* invokeAgent(
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                  fullPrompt,
                  provider,
                  idleTimeoutMs,
                  completionTimeoutMs,
                  heartbeatIntervalMs,
                  visibleInactivityTimeoutMs,
                  completionSignals,
                  onText,
                  onToolCall,
                  onRawLine,
                  onHeartbeat,
                  onIdleWarning,
                  onCompletionTimeout,
                  options._idleWarningIntervalMs,
                  iterationResumeSession,
                  iterationForkSession,
                  options.signal,
                );

                // Flush any remaining buffered text deltas
                textBuffer.dispose();

                yield* display.status(label("Agent stopped"), "info");

                // Capture session while sandbox is still alive. Usage from the
                // stream (e.g. Codex's turn.completed) is the baseline; a
                // session-parsed value below overrides it when available.
                let sessionFilePath: string | undefined;
                let usage: IterationUsage | undefined = streamUsage;
                if (
                  provider.captureSessions &&
                  provider.sessionStorage &&
                  sessionId &&
                  bindMountHandle
                ) {
                  yield* display.status(label("Capturing session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      provider.sessionStorage!.captureToHost({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId,
                      }),
                  });
                  sessionFilePath = provider.sessionStorage.hostSessionFilePath(
                    hostRepoDir,
                    sessionId,
                  );

                  // Parse token usage from the captured session JSONL
                  if (provider.parseSessionUsage) {
                    const content = yield* Effect.promise(() =>
                      provider
                        .sessionStorage!.readHostSession(hostRepoDir, sessionId)
                        .catch(() => undefined as string | undefined),
                    );
                    if (content) {
                      const parsedUsage = provider.parseSessionUsage(content);
                      if (parsedUsage) usage = parsedUsage;
                    }
                  }
                }

                // Check completion signal
                const matchedSignal = completionSignals.find((sig) =>
                  agentOutput.includes(sig),
                );
                return {
                  completionSignal: matchedSignal,
                  stdout: agentOutput,
                  sessionId,
                  sessionFilePath,
                  usage,
                  timing,
                } as const;
              }),
          ),
      );

      const lifecycleResult = sandboxResult.value;
      iterationPreservedPath = sandboxResult.preservedWorktreePath;

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      allIterations.push({
        sessionId: lifecycleResult.result.sessionId,
        sessionFilePath: lifecycleResult.result.sessionFilePath,
        usage: lifecycleResult.result.usage,
        timing: lifecycleResult.result.timing,
      });
      allTiming.push(lifecycleResult.result.timing);

      if (lifecycleResult.result.completionSignal !== undefined) {
        const timing: RunTimingSummary = {
          iterations: allTiming,
          providerWaitMs: allTiming.reduce(
            (sum, item) => sum + item.providerWaitMs,
            0,
          ),
          toolRunningMs: allTiming.reduce(
            (sum, item) => sum + item.toolRunningMs,
            0,
          ),
          longestVisibleSilenceMs: allTiming.reduce(
            (max, item) => Math.max(max, item.longestVisibleSilenceMs),
            0,
          ),
          heartbeatCount: allTiming.reduce(
            (sum, item) => sum + item.heartbeatCount,
            0,
          ),
          totalProviderMs: allTiming.reduce(
            (sum, item) => sum + item.totalProviderMs,
            0,
          ),
          outcome: allTiming.at(-1)?.outcome ?? "success",
        };
        yield* display.text(
          label(
            `Timing: provider=${(timing.totalProviderMs / 1000).toFixed(1)}s, wait=${(timing.providerWaitMs / 1000).toFixed(1)}s, tool=${(timing.toolRunningMs / 1000).toFixed(1)}s, longest visible silence=${(timing.longestVisibleSilenceMs / 1000).toFixed(1)}s, heartbeats=${timing.heartbeatCount}, outcome=${timing.outcome}`,
          ),
        );
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success",
        );
        return {
          iterations: allIterations,
          completionSignal: lifecycleResult.result.completionSignal,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
          preservedWorktreePath: iterationPreservedPath,
          timing,
        };
      }
    }

    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info",
    );
    const timing: RunTimingSummary = {
      iterations: allTiming,
      providerWaitMs: allTiming.reduce(
        (sum, item) => sum + item.providerWaitMs,
        0,
      ),
      toolRunningMs: allTiming.reduce(
        (sum, item) => sum + item.toolRunningMs,
        0,
      ),
      longestVisibleSilenceMs: allTiming.reduce(
        (max, item) => Math.max(max, item.longestVisibleSilenceMs),
        0,
      ),
      heartbeatCount: allTiming.reduce(
        (sum, item) => sum + item.heartbeatCount,
        0,
      ),
      totalProviderMs: allTiming.reduce(
        (sum, item) => sum + item.totalProviderMs,
        0,
      ),
      outcome: allTiming.at(-1)?.outcome ?? "success",
    };
    yield* display.text(
      label(
        `Timing: provider=${(timing.totalProviderMs / 1000).toFixed(1)}s, wait=${(timing.providerWaitMs / 1000).toFixed(1)}s, tool=${(timing.toolRunningMs / 1000).toFixed(1)}s, longest visible silence=${(timing.longestVisibleSilenceMs / 1000).toFixed(1)}s, heartbeats=${timing.heartbeatCount}, outcome=${timing.outcome}`,
      ),
    );
    return {
      iterations: allIterations,
      completionSignal: undefined,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: iterationPreservedPath,
      timing,
    };
  });
};
