import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

vi.mock("./index.js", () => ({
  codex: (...args: unknown[]) => mockCodex(...args),
  run: mockRun,
}));

vi.mock("./sandboxes/docker.js", () => ({
  docker: mockDocker,
}));

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(join(root, relativePath), "utf8");
const authResidue = (home: string) =>
  existsSync(join(home, ".codex"))
    ? readdirSync(join(home, ".codex")).filter(
        (entry) => entry === "auth.json" || entry.startsWith("auth.json.tmp."),
      )
    : [];

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
    const source = read("src/factory-policy.ts");
    const packageJson = JSON.parse(read("package.json")) as {
      exports: Record<string, unknown>;
      scripts: Record<string, string>;
    };

    expect(common.trim()).toBe(
      'export * from "../../../src/factory-policy.js";',
    );
    expect(source).toContain('model: "gpt-5.5"');
    expect(source).toContain('effort: "low"');
    expect(source).toContain("FACTORY_MODEL = FACTORY_WORKER.model");
    expect(source).toContain("FACTORY_EFFORT = FACTORY_WORKER.effort");
    expect(source).toContain("sandcastle.codex(FACTORY_MODEL");
    expect(source).toContain("FACTORY_HEARTBEAT_SECONDS = 30");
    expect(source).toContain("FACTORY_VISIBLE_INACTIVITY_SECONDS = 60");
    expect(packageJson.exports).toMatchObject({
      "./factory-policy": {
        import: "./dist/factory-policy.js",
        types: "./dist/factory-policy.d.ts",
      },
    });
    expect(packageJson.scripts.prepare).toBe("husky && npm run build");

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
      expect(contents, workflow).toContain("CODEX_AUTH_JSON_B64");
      expect(contents, workflow).toContain("npx sandcastle docker build-image");
      expect(
        contents.indexOf("npx sandcastle docker build-image"),
      ).toBeLessThan(contents.indexOf("CODEX_AUTH_JSON_B64"));
      expect(contents, workflow).not.toMatch(/Claude|claude|ANTHROPIC/);
      expect(contents, workflow).not.toContain("@openai/codex");
      expect(contents, workflow).not.toContain("OPENAI_API_KEY");
      expect(contents, workflow).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });

  it("routes every active GitHub Actions agent through Factory Docker, not no-sandbox", () => {
    for (const route of activeRoutes) {
      const contents = read(route);
      expect(contents, route).not.toContain("noSandbox");
      expect(contents, route).not.toContain("sandboxes/no-sandbox");
      expect(contents, route).toMatch(/factoryDocker\(|runFactoryInSandbox\(/);
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
    expect(authResidue(success.home)).toEqual([]);

    const failure = run(true);
    expect(failure.failed).toBe(true);
    expect(failure.output).toContain("700\n600\nunset");
    expect(failure.output).not.toContain(secret);
    expect(failure.output).not.toContain(encoded);
    expect(existsSync(join(failure.home, ".codex/auth.json"))).toBe(false);
    expect(authResidue(failure.home)).toEqual([]);
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
    expect(authResidue(home)).toEqual(["auth.json"]);
  });

  it("cleans malformed Codex auth temp fragments without creating final auth", async () => {
    const { materializeCodexAuthCommand } = await importCommon();
    const home = mkdtempSync(join(tmpdir(), "factory-codex-malformed-"));
    const authPath = join(home, ".codex/auth.json");

    expect(() =>
      execFileSync("sh", ["-c", materializeCodexAuthCommand()], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CODEX_AUTH_JSON_B64: "eyJ0b2tlbnMi!!!!",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();

    expect(existsSync(authPath)).toBe(false);
    expect(authResidue(home)).toEqual([]);
  });

  it("fails closed without Codex auth secret and leaves no auth residue", async () => {
    const { materializeCodexAuthCommand } = await importCommon();
    const home = mkdtempSync(join(tmpdir(), "factory-codex-missing-"));
    const authPath = join(home, ".codex/auth.json");

    expect(() =>
      execFileSync("sh", ["-c", materializeCodexAuthCommand()], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, CODEX_AUTH_JSON_B64: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();

    expect(existsSync(authPath)).toBe(false);
    expect(authResidue(home)).toEqual([]);
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

  it("retries inline-prompt runs once after visible inactivity without a third attempt", async () => {
    const output = { tag: "output", schema: {} };
    const attempts: unknown[] = [];
    mockRun.mockImplementation(async (options: unknown) => {
      attempts.push(options);
      if (attempts.length <= 2) {
        throw { _tag: "AgentVisibleInactivityTimeoutError" };
      }
      throw new Error("third attempt should not run");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runFactoryAgent } = await importCommon();
    await expect(
      runFactoryAgent({
        sandbox: { tag: "none", name: "no-sandbox", env: {} },
        prompt: "extract this original prompt",
        output,
      } as never),
    ).rejects.toThrow("process.exit");

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      prompt: "extract this original prompt",
      output,
    });
    expect(attempts[1]).toMatchObject({
      prompt: expect.stringContaining("extract this original prompt"),
      output,
    });
    expect((attempts[1] as { prompt: string }).prompt).toContain(
      "Retry exactly once",
    );
    expect((attempts[1] as { promptFile?: string }).promptFile).toBeUndefined();

    exit.mockRestore();
    error.mockRestore();
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

describe("factory operator/worker engine specs (issue-61 atom A)", () => {
  const aliasesAreDerived = (source: string): boolean =>
    /export const FACTORY_MODEL = FACTORY_WORKER\.model;/.test(source) &&
    /export const FACTORY_EFFORT = FACTORY_WORKER\.effort;/.test(source) &&
    /export const FACTORY_CODEX_AUTH_ENV = FACTORY_WORKER\.authEnv;/.test(
      source,
    );

  const expectValidSpec = (spec: {
    engine: string;
    model: string;
    effort: string;
    command: readonly string[];
    authEnv: string;
  }) => {
    expect(["codex", "claude"]).toContain(spec.engine);
    expect(typeof spec.model).toBe("string");
    expect(spec.model.length).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(spec.effort);
    expect(Array.isArray(spec.command)).toBe(true);
    expect(spec.command.length).toBeGreaterThan(0);
    for (const part of spec.command) {
      expect(typeof part).toBe("string");
    }
    expect(typeof spec.authEnv).toBe("string");
    expect(spec.authEnv.length).toBeGreaterThan(0);
  };

  it("exports both FACTORY_OPERATOR and FACTORY_WORKER engine specs", async () => {
    const { FACTORY_OPERATOR, FACTORY_WORKER } = await importCommon();
    expect(FACTORY_OPERATOR).toBeDefined();
    expect(FACTORY_WORKER).toBeDefined();
    expectValidSpec(FACTORY_OPERATOR);
    expectValidSpec(FACTORY_WORKER);
  });

  it("keeps FACTORY_MODEL/FACTORY_EFFORT/FACTORY_CODEX_AUTH_ENV as derived aliases of FACTORY_WORKER, not duplicated literals", async () => {
    const {
      FACTORY_MODEL,
      FACTORY_EFFORT,
      FACTORY_CODEX_AUTH_ENV,
      FACTORY_WORKER,
    } = await importCommon();

    expect(FACTORY_MODEL).toBe(FACTORY_WORKER.model);
    expect(FACTORY_EFFORT).toBe(FACTORY_WORKER.effort);
    expect(FACTORY_CODEX_AUTH_ENV).toBe(FACTORY_WORKER.authEnv);

    const source = read("src/factory-policy.ts");
    expect(aliasesAreDerived(source)).toBe(true);
  });

  it("fails the derived-alias check if an alias is hardcoded again (regression guard, no false PASS)", () => {
    const source = read("src/factory-policy.ts");
    expect(aliasesAreDerived(source)).toBe(true);

    const regressed = source.replace(
      "export const FACTORY_MODEL = FACTORY_WORKER.model;",
      'export const FACTORY_MODEL = "gpt-5.5";',
    );
    expect(regressed).not.toBe(source);
    expect(aliasesAreDerived(regressed)).toBe(false);
  });
});
