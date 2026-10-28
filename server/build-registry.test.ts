import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = fileURLToPath(new URL("..", import.meta.url));
const dockerfile = readFileSync(join(repository, "Dockerfile"), "utf8");
const npmrc = readFileSync(join(repository, ".npmrc"), "utf8");
const packageManager = JSON.parse(
  readFileSync(join(repository, "package.json"), "utf8")
).packageManager;
const instructions = dockerfile.replace(/\\\n\s*/g, " ").split("\n");
const bootstrap = instructions
  .find(line => line.startsWith("RUN export COREPACK_NPM_REGISTRY="))!
  .slice(4);
const install = instructions
  .find(line => line.startsWith("RUN COREPACK_NPM_REGISTRY="))!
  .slice(4);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runBuildCommands({
  existingCorepack = true,
  failCommand = "",
  registry = "https://registry.npmmirror.com",
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "audio-build-registry-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  writeFileSync(join(binDirectory, "package.json"), '{"type":"commonjs"}');
  symlinkSync(process.execPath, join(binDirectory, "node"));
  copyFileSync(
    join(repository, "package.json"),
    join(directory, "package.json")
  );
  const commandLog = join(directory, "commands.jsonl");
  writeFileSync(commandLog, "");
  const mockCommand = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({ command, args, npmRegistry: process.env.npm_config_registry, corepackRegistry: process.env.COREPACK_NPM_REGISTRY, nodeEnv: process.env.NODE_ENV }) + "\\n");
if (process.env.TEST_FAIL_COMMAND === [command, args[0]].join(" ")) process.exit(1);
if (command === "npm") fs.copyFileSync(process.argv[1], path.join(path.dirname(process.argv[1]), "corepack"));
`;
  for (const command of existingCorepack
    ? ["corepack", "pnpm", "npm"]
    : ["pnpm", "npm"]) {
    const commandPath = join(binDirectory, command);
    writeFileSync(commandPath, mockCommand);
    chmodSync(commandPath, 0o755);
  }
  const environment: Record<string, string> = {};
  for (const line of instructions.filter(value => value.startsWith("ENV "))) {
    const match = /^ENV (\w+)=(.*)$/.exec(line);
    if (match)
      environment[match[1]] = match[2].replace("${NPM_REGISTRY}", registry);
  }
  const result = spawnSync(
    "/bin/sh",
    ["-c", `(${bootstrap}) && (${install})`],
    {
      cwd: directory,
      env: {
        ...environment,
        PATH: binDirectory,
        TEST_COMMAND_LOG: commandLog,
        TEST_FAIL_COMMAND: failCommand,
      },
      encoding: "utf8",
    }
  );
  const calls = readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return { result, calls };
}

describe("构建依赖源配置", () => {
  it("项目级镜像配置包含有限重试和并发，保持 TLS 校验", () => {
    expect(npmrc).toContain("registry=https://registry.npmmirror.com/");
    expect(npmrc).toContain("fetch-retries=3");
    expect(npmrc).toContain("fetch-timeout=60000");
    expect(npmrc).toContain("network-concurrency=8");
    expect(npmrc).toContain("strict-ssl=true");
    expect(npmrc).not.toMatch(/_auth|token|password/i);
  });

  it("首次调用包管理器前配置下载源并复制项目配置", () => {
    const firstRun = dockerfile.indexOf("RUN ");
    expect(
      dockerfile.indexOf("ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}")
    ).toBeLessThan(firstRun);
    expect(
      dockerfile.indexOf("COPY package.json pnpm-lock.yaml .npmrc ./")
    ).toBeLessThan(firstRun);
    expect(dockerfile).toContain("ENV COREPACK_DEFAULT_TO_LATEST=0");
    expect(dockerfile).not.toMatch(
      /COREPACK_INTEGRITY_KEYS=0|strict-ssl=false/
    );
    expect(
      readFileSync(join(repository, "pnpm-lock.yaml"), "utf8")
    ).not.toContain("registry.npmjs.org");
  });

  it("使用现有 Corepack 和锁定 pnpm 的版本及摘要，不隐式安装最新版", () => {
    const { result, calls } = runBuildCommands();
    expect(result.status, result.stderr).toBe(0);
    expect(calls.map(call => call.command)).toEqual([
      "corepack",
      "corepack",
      "pnpm",
    ]);
    expect(calls[1].args).toEqual(["prepare", packageManager, "--activate"]);
    expect(calls[2].args).toEqual([
      "install",
      "--frozen-lockfile",
      "--prod=false",
      "--registry=https://registry.npmmirror.com",
    ]);
    expect(
      calls.every(
        call => call.corepackRegistry === "https://registry.npmmirror.com"
      )
    ).toBe(true);
    expect(
      calls.every(call => call.npmRegistry === call.corepackRegistry)
    ).toBe(true);
    expect(calls[2].nodeEnv).toBe("production");
  });

  it("基础镜像缺少 Corepack 时使用固定兼容版本及同一镜像源", () => {
    const { result, calls } = runBuildCommands({ existingCorepack: false });
    expect(result.status, result.stderr).toBe(0);
    expect(calls[0]).toMatchObject({
      command: "npm",
      args: [
        "install",
        "--global",
        "corepack@0.31.0",
        "--registry=https://registry.npmmirror.com",
      ],
    });
    expect(calls.map(call => call.command)).toEqual([
      "npm",
      "corepack",
      "corepack",
      "pnpm",
    ]);
  });

  it("构建参数可将 npm、Corepack 和 pnpm 一起切换到内网源", () => {
    const registry = "https://packages.example.test/npm/";
    const { result, calls } = runBuildCommands({
      existingCorepack: false,
      registry,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      calls.every(
        call =>
          call.npmRegistry === registry &&
          call.corepackRegistry === registry.replace(/\/$/, "")
      )
    ).toBe(true);
    expect(calls[0].args).toContain(
      `--registry=${registry.replace(/\/$/, "")}`
    );
    expect(calls.at(-1).args).toContain(`--registry=${registry}`);
  });

  it.each(["corepack enable", "corepack prepare", "npm install"])(
    "%s 失败立即停止，不掩盖错误继续安装",
    failCommand => {
      const { result, calls } = runBuildCommands({
        existingCorepack: failCommand !== "npm install",
        failCommand,
      });
      expect(result.status).not.toBe(0);
      expect(calls.some(call => call.command === "pnpm")).toBe(false);
      if (failCommand !== "npm install")
        expect(calls.some(call => call.command === "npm")).toBe(false);
    }
  );
});
