import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockCodex = (..._args: unknown[]) => ({});
const mockRun = vi.fn();
const mockDocker = vi.fn((options?: unknown) => ({
  tag: "bind-mount",
  name: "docker",
  env: (options as { env?: Record<string, string> } | undefined)?.env ?? {},
}));

vi.mock(
  "@ai-hero/sandcastle",
  () => ({
    codex: (...args: unknown[]) => mockCodex(...args),
    run: mockRun,
  }),
  // @ts-expect-error Vitest supports virtual module mocks at runtime.
  { virtual: true },
);

vi.mock(
  "@ai-hero/sandcastle/sandboxes/docker",
  () => ({
    docker: mockDocker,
  }),
  // @ts-expect-error Vitest supports virtual module mocks at runtime.
  { virtual: true },
);

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(join(root, relativePath), "utf8");

const importCommon = async () =>
  import(
    `${join(root, ".sandcastle/agent-workflows/shared/common.ts")}?t=${Date.now()}_${Math.random().toString(36).slice(2)}`
  );

afterEach(() => {
  vi.resetModules();
  mockCodex = (..._args: unknown[]) => ({});
  mockRun.mockReset();
  mockDocker.mockClear();
  delete process.env.OUTPUT_DIR;
  delete process.env.CODEX_AUTH_JSON_B64;
  delete process.env.OPENAI_API_KEY;
});

const activeRoutes = [
  ".factory/implement-task.ts",
  ".sandcastle/run.ts",
  ".sandcastle/agent-workflows/explore/explore.ts",
  ".sandcastle/agent-workflows/implement/implement.ts",
  ".sandcastle/agent-workflows/implement-pr/implement-pr.ts",
  ".sandcastle/agent-workflows/review/review.ts",
  ".sandcastle/agent-workflows/update-branch/update-branch.ts",
];

const workflows = [
  ".github/workflows/agent-explore.yml",
  ".github/workflows/agent-implement.yml",
  ".github/workflows/agent-implement-pr.yml",
  ".github/workflows/agent-review.yml",
  ".github/workflows/agent-update-branch.yml",
];

describe("active Software Factory Codex policy", () => {
  it("selects Codex gpt-5.5 low through a shared active-route policy", () => {
    const common = read(".sandcastle/agent-workflows/shared/common.ts");

    expect(common).toContain('FACTORY_MODEL = "gpt-5.5"');
    expect(common).toContain('FACTORY_EFFORT = "low"');
    expect(common).toContain("sandcastle.codex(FACTORY_MODEL");
    expect(common).toContain("FACTORY_HEARTBEAT_SECONDS = 30");
    expect(common).toContain("FACTORY_VISIBLE_INACTIVITY_SECONDS = 60");

    for (const route of activeRoutes) {
      const contents = read(route);
      expect(contents, route).not.toMatch(/claudeCode\(|claudeAgent\(/);
      expect(contents, route).toMatch(
        /factoryAgent\(|factoryRunOptions\(|runFactoryAgent\(|runFactoryInSandbox\(|runWithExtraction\(/,
      );
    }
  });

  it("keeps active Dockerfile and workflows on pinned Codex without Claude", () => {
    const dockerfile = read(".sandcastle/Dockerfile");
    expect(dockerfile).toContain("npm install -g @openai/codex@0.143.0");
    expect(dockerfile).not.toMatch(/claude/i);
    expect(dockerfile.indexOf("@openai/codex@0.143.0")).toBeLessThan(
      dockerfile.indexOf("USER ${AGENT_UID}:${AGENT_GID}"),
    );

    for (const workflow of workflows) {
      const contents = read(workflow);
      expect(contents, workflow).toContain("@openai/codex@0.143.0");
      expect(contents, workflow).toContain("CODEX_AUTH_JSON_B64");
      expect(contents, workflow).not.toMatch(/Claude|claude|ANTHROPIC/);
      expect(contents, workflow).not.toContain("OPENAI_API_KEY");
      expect(contents, workflow).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  it("passes only Codex auth through the shared Factory Docker provider seam", async () => {
    process.env.CODEX_AUTH_JSON_B64 = "trusted-host-auth";
    process.env.OPENAI_API_KEY = "must-not-propagate";

    const { factoryDocker } = await importCommon();
    const provider = factoryDocker();

    expect(mockDocker).toHaveBeenCalledOnce();
    expect(provider.env).toEqual({
      CODEX_AUTH_JSON_B64: "trusted-host-auth",
    });
  });

  it("materializes Codex auth with private modes, unsets env, and cleans up on success and failure", async () => {
    mockCodex = () => ({
      buildPrintCommand: () => ({
        command:
          'node -e \'const fs=require("node:fs"),p=require("node:path");const a=p.join(process.env.HOME,".codex/auth.json");console.log((fs.statSync(p.dirname(a)).mode&0o777).toString(8));console.log((fs.statSync(a).mode&0o777).toString(8));console.log(process.env.CODEX_AUTH_JSON_B64||"unset");if(process.env.FAIL_CODEX)process.exit(9)\'',
      }),
    });

    const { factoryAgent } = await importCommon();
    const command = factoryAgent().buildPrintCommand({ prompt: "" }).command;
    const secret = '{"tokens":{"access_token":"top-secret"}}';
    const encoded = Buffer.from(secret).toString("base64");

    const run = (fail: boolean) => {
      const home = mkdtempSync(join(tmpdir(), "factory-codex-auth-"));
      try {
        const output = execFileSync("sh", ["-c", command], {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_AUTH_JSON_B64: encoded,
            FAIL_CODEX: fail ? "1" : "",
            HOME: home,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { home, output, failed: false };
      } catch (error) {
        const execError = error as { stdout?: Buffer; stderr?: Buffer };
        return {
          home,
          output: `${execError.stdout?.toString() ?? ""}${execError.stderr?.toString() ?? ""}`,
          failed: true,
        };
      }
    };

    const success = run(false);
    expect(success.failed).toBe(false);
    expect(success.output).toContain("700\n600\nunset");
    expect(success.output).not.toContain(secret);
    expect(success.output).not.toContain(encoded);
    expect(existsSync(join(success.home, ".codex/auth.json"))).toBe(false);

    const failure = run(true);
    expect(failure.failed).toBe(true);
    expect(failure.output).toContain("700\n600\nunset");
    expect(failure.output).not.toContain(secret);
    expect(failure.output).not.toContain(encoded);
    expect(existsSync(join(failure.home, ".codex/auth.json"))).toBe(false);
  });

  it("refuses pre-existing Codex auth and does not print the secret", async () => {
    const { materializeCodexAuthCommand } = await importCommon();
    const home = mkdtempSync(join(tmpdir(), "factory-codex-existing-"));
    const authPath = join(home, ".codex/auth.json");
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, "keep-me", { mode: 0o600 });
    const encoded = Buffer.from("new-secret").toString("base64");

    expect(() =>
      execFileSync("sh", ["-c", materializeCodexAuthCommand()], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, CODEX_AUTH_JSON_B64: encoded },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();
    expect(readFileSync(authPath, "utf8")).toBe("keep-me");
  });

  it("uses collision-resistant recovery prompts and removes them after retry", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "factory-recovery-"));
    const originalPrompt = join(outputDir, "prompt.md");
    writeFileSync(originalPrompt, "do the work");

    const seen: string[] = [];
    const { runFactoryInSandbox } = await importCommon();

    for (let worker = 0; worker < 4; worker++) {
      let attempt = 0;
      await runFactoryInSandbox(
        {
          run: async (options: { promptFile?: string }) => {
            attempt++;
            if (attempt === 1) {
              throw { _tag: "AgentVisibleInactivityTimeoutError" };
            }
            expect(options.promptFile).toBeDefined();
            expect(existsSync(options.promptFile!)).toBe(true);
            seen.push(options.promptFile!);
            return { ok: true };
          },
        },
        { promptFile: originalPrompt },
      );
    }

    expect(new Set(seen).size).toBe(4);
    for (const promptPath of seen) {
      expect(promptPath).toContain("factory-recovery-");
      expect(existsSync(promptPath)).toBe(false);
    }
    expect(readFileSync(originalPrompt, "utf8")).toBe("do the work");
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("reports the sandbox worktree path after a reused sandbox times out twice without an error path", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "factory-timeout-"));
    process.env.OUTPUT_DIR = outputDir;
    const originalPrompt = join(outputDir, "prompt.md");
    writeFileSync(originalPrompt, "do the work");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runFactoryInSandbox } = await importCommon();
    await expect(
      runFactoryInSandbox(
        {
          worktreePath: "/tmp/reused-sandbox-worktree",
          run: async () => {
            throw { _tag: "AgentVisibleInactivityTimeoutError" };
          },
        },
        { promptFile: originalPrompt },
      ),
    ).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Preserved worktree: /tmp/reused-sandbox-worktree",
      ),
    );

    exit.mockRestore();
    error.mockRestore();
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("reports cwd after a no-sandbox top-level run times out twice without an error path", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "factory-nosandbox-timeout-"));
    process.env.OUTPUT_DIR = outputDir;
    const originalPrompt = join(outputDir, "prompt.md");
    writeFileSync(originalPrompt, "do the work");
    mockRun.mockRejectedValue({ _tag: "AgentVisibleInactivityTimeoutError" });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runFactoryAgent } = await importCommon();
    await expect(
      runFactoryAgent({
        sandbox: { tag: "none", name: "no-sandbox", env: {} },
        cwd: "/tmp/no-sandbox-worktree",
        promptFile: originalPrompt,
      } as never),
    ).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Preserved worktree: /tmp/no-sandbox-worktree"),
    );

    exit.mockRestore();
    error.mockRestore();
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("reports process cwd after a head run times out twice without cwd or an error path", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "factory-head-timeout-"));
    process.env.OUTPUT_DIR = outputDir;
    const originalPrompt = join(outputDir, "prompt.md");
    writeFileSync(originalPrompt, "do the work");
    mockRun.mockRejectedValue({ _tag: "AgentVisibleInactivityTimeoutError" });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runFactoryAgent } = await importCommon();
    await expect(
      runFactoryAgent({
        sandbox: { tag: "none", name: "no-sandbox", env: {} },
        promptFile: originalPrompt,
      } as never),
    ).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`Preserved worktree: ${process.cwd()}`),
    );

    exit.mockRestore();
    error.mockRestore();
    rmSync(outputDir, { recursive: true, force: true });
  });
});
