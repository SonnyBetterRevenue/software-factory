import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as sandcastle from "@ai-hero/sandcastle";

export const outputDir = (): string => process.env.OUTPUT_DIR ?? "/tmp";

export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};

export const fail = (message: string): never => {
  console.error(`\nFAILED: ${message}`);
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), "failure_reason.txt"), message);
  process.exit(1);
};

export const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const safeSh = (cmd: string): string => {
  try {
    return sh(cmd);
  } catch {
    return "";
  }
};

export const gh = (args: string[]): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export const writeJson = (filename: string, value: unknown): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(
    path.join(outputDir(), filename),
    JSON.stringify(value, null, 2),
  );
};

export const writeText = (filename: string, value: string): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), filename), value);
};

export const FACTORY_MODEL = "gpt-5.5";
export const FACTORY_EFFORT = "low";
export const FACTORY_CODEX_AUTH_ENV = "CODEX_AUTH_JSON_B64";
export const FACTORY_HEARTBEAT_SECONDS = 30;
export const FACTORY_VISIBLE_INACTIVITY_SECONDS = 60;

export const materializeCodexAuthCommand = (): string => `
set -eu
auth_dir="$HOME/.codex"
auth_file="$auth_dir/auth.json"
if [ -z "\${${FACTORY_CODEX_AUTH_ENV}:-}" ]; then
  echo "Missing required env var: ${FACTORY_CODEX_AUTH_ENV}" >&2
  exit 1
fi
if [ -e "$auth_file" ]; then
  echo "Refusing to overwrite pre-existing Codex auth file at $auth_file" >&2
  exit 1
fi
mkdir -p "$auth_dir"
chmod 700 "$auth_dir"
tmp_auth="$auth_file.tmp.$$"
cleanup_auth() {
  rm -f "$tmp_auth"
}
trap cleanup_auth EXIT
printf '%s' "\${${FACTORY_CODEX_AUTH_ENV}}" | base64 -d > "$tmp_auth"
chmod 600 "$tmp_auth"
mv "$tmp_auth" "$auth_file"
`;

const withCodexAuthCommand = (command: string): string => `
${materializeCodexAuthCommand()}
cleanup_factory_codex_auth() {
  rm -f "$HOME/.codex/auth.json"
}
trap cleanup_factory_codex_auth EXIT
unset ${FACTORY_CODEX_AUTH_ENV}
${command}
`;

export const factoryAgent = () => {
  const agent = sandcastle.codex(FACTORY_MODEL, {
    effort: FACTORY_EFFORT,
  });
  return {
    ...agent,
    buildPrintCommand: (
      options: Parameters<typeof agent.buildPrintCommand>[0],
    ) => {
      const printCommand = agent.buildPrintCommand(options);
      return {
        ...printCommand,
        command: withCodexAuthCommand(printCommand.command),
      };
    },
  };
};

export const factoryRunOptions = () => ({
  agent: factoryAgent(),
  heartbeatIntervalSeconds: FACTORY_HEARTBEAT_SECONDS,
  visibleInactivityTimeoutSeconds: FACTORY_VISIBLE_INACTIVITY_SECONDS,
});

const isVisibleInactivityTimeout = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag?: unknown })._tag === "AgentVisibleInactivityTimeoutError";

const recoveryPromptPath = (): string =>
  path.join(outputDir(), `factory-recovery-${Date.now()}-${randomUUID()}.md`);

const writeRecoveryPrompt = (originalPromptFile: string): string => {
  const promptPath = recoveryPromptPath();
  const original = fs.readFileSync(originalPromptFile, "utf8");
  fs.writeFileSync(
    promptPath,
    `${original}

The previous attempt timed out without visible progress. Retry exactly once in this preserved worktree. Use a smaller atom: inspect the current state, choose the smallest still-useful next change, make that change, verify it, and commit it. Do not switch models or start over elsewhere.
`,
  );
  return promptPath;
};

export async function runFactoryInSandbox<
  T extends { run(options: Record<string, unknown>): Promise<any> },
>(
  sandbox: T,
  options: Record<string, unknown> & { promptFile?: string },
): Promise<Awaited<ReturnType<T["run"]>>> {
  const runOptions = { ...options, ...factoryRunOptions() };
  try {
    return await sandbox.run(runOptions);
  } catch (error) {
    if (!isVisibleInactivityTimeout(error) || !options.promptFile) {
      throw error;
    }

    const promptFile = writeRecoveryPrompt(options.promptFile);
    try {
      return await sandbox.run({ ...runOptions, promptFile });
    } catch (secondError) {
      const preserved = (secondError as { preservedWorktreePath?: string })
        ?.preservedWorktreePath;
      if (isVisibleInactivityTimeout(secondError) && preserved) {
        fail(
          `Agent hit visible inactivity timeout twice. Preserved worktree: ${preserved}`,
        );
      }
      throw secondError;
    } finally {
      fs.rmSync(promptFile, { force: true });
    }
  }
}

export async function runFactoryAgent(
  options: Parameters<typeof sandcastle.run>[0],
): Promise<Awaited<ReturnType<typeof sandcastle.run>>> {
  try {
    return await sandcastle.run({ ...options, ...factoryRunOptions() });
  } catch (error) {
    if (!isVisibleInactivityTimeout(error) || !options.promptFile) {
      throw error;
    }

    const promptFile = writeRecoveryPrompt(options.promptFile);
    try {
      return await sandcastle.run({
        ...options,
        ...factoryRunOptions(),
        promptFile,
      });
    } catch (secondError) {
      const preserved = (secondError as { preservedWorktreePath?: string })
        ?.preservedWorktreePath;
      if (isVisibleInactivityTimeout(secondError) && preserved) {
        fail(
          `Agent hit visible inactivity timeout twice. Preserved worktree: ${preserved}`,
        );
      }
      throw secondError;
    } finally {
      fs.rmSync(promptFile, { force: true });
    }
  }
}

export const standardSchema = <T>(
  validate: (value: unknown) => T,
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "sandcastle-agent-workflows",
    validate: (value: unknown) => {
      try {
        return { value: validate(value) };
      } catch (error) {
        return {
          issues: [
            {
              message:
                error instanceof Error ? error.message : "Validation failed",
            },
          ],
        };
      }
    },
  },
});

export const asRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

export const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
};
