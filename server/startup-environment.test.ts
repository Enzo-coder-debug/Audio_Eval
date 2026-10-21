import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const temporaryDirectories: string[] = [];
const repository = fileURLToPath(new URL("..", import.meta.url));
const containerScript = readFileSync(
  join(repository, "start_container.sh"),
  "utf8"
);
const startupScript = readFileSync(join(repository, "start.sh"), "utf8");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "audio-startup-environment-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSnapshot(
  directory: string,
  environment: Record<string, string> = {}
) {
  const snapshotPath = join(directory, ".env");
  const snapshotScript = containerScript
    .slice(
      containerScript.indexOf('case "${DB_MIGRATE_ON_START-}"'),
      containerScript.indexOf('su -m admin -c "bash /home/admin/start.sh"')
    )
    .replace("ENV_FILE=/opt/app/.env", `ENV_FILE='${snapshotPath}'`);
  const result = spawnSync(
    "bash",
    ["-c", `chown() { :; }\n${snapshotScript}`],
    {
      env: { PATH: process.env.PATH, ...environment },
      encoding: "utf8",
    }
  );
  return { ...result, snapshotPath };
}

function runStartup(
  directory: string,
  inherited: Record<string, string>,
  profile: string
) {
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "dist"));
  symlinkSync(process.execPath, join(binDirectory, "node"));
  symlinkSync(
    join(repository, "node_modules"),
    join(directory, "node_modules")
  );
  writeFileSync(join(directory, "profile"), profile);
  const report = `console.log(JSON.stringify({ flag: process.env.DB_MIGRATE_ON_START, database: process.env.DATABASE_URL }));`;
  writeFileSync(join(directory, "scripts/prepare-database.mjs"), report);
  writeFileSync(
    join(directory, "dist/index.js"),
    `import "dotenv/config";\n${report}`
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const localScript = startupScript
    .replace("APP_DIR=/opt/app", `APP_DIR='${directory}'`)
    .replace("LOG_DIR=/export/log/audio-eval", `LOG_DIR='${directory}/logs'`)
    .replaceAll("/etc/profile", join(directory, "profile"))
    .replaceAll("/export/env", join(directory, "export-env"))
    .replaceAll("/home/admin/.jdos_env", join(directory, "jdos-env"))
    .replaceAll(
      "/home/admin/start_before.sh",
      join(directory, "start-before.sh")
    )
    .replaceAll(
      "/home/admin/start_after.sh",
      join(directory, "start-after.sh")
    );
  return spawnSync(
    "bash",
    ["-c", `pgrep() { return 1; }\nnohup() { "$@"; }\n${localScript}\nwait`],
    {
      env: {
        PATH: `${binDirectory}:${process.env.PATH}`,
        ...inherited,
      },
      encoding: "utf8",
      timeout: 10_000,
    }
  );
}

describe("JDOS 运行时环境快照", () => {
  it.each([undefined, "", "0", "1"])(
    "入口安全记录注入状态并固化开关：%s",
    flag => {
      const directory = createDirectory();
      const result = writeSnapshot(directory, {
        DATABASE_URL: "mysql://injected:synthetic-password@target/test",
        ...(flag === undefined ? {} : { DB_MIGRATE_ON_START: flag }),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `injected DB_MIGRATE_ON_START=${flag || "unset/empty; using 0"}`
      );
      expect(result.stdout + result.stderr).not.toContain("synthetic-password");
      expect(parse(readFileSync(result.snapshotPath)).DB_MIGRATE_ON_START).toBe(
        flag || "0"
      );
      expect(statSync(result.snapshotPath).mode & 0o777).toBe(0o600);
    }
  );

  it("入口拒绝非法开关，且不打印其原始内容", () => {
    const result = writeSnapshot(createDirectory(), {
      DB_MIGRATE_ON_START: "mysql://accidentally-pasted-secret",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must be 0 or 1");
    expect(result.stdout + result.stderr).not.toContain("accidentally-pasted");
  });

  it("显式开启迁移时不能从旧 profile 推断目标数据库", () => {
    const result = writeSnapshot(createDirectory(), {
      DB_MIGRATE_ON_START: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "requires DATABASE_URL in the same container environment"
    );
  });

  it.each(["0", "1", undefined])(
    "数据库准备与应用都使用容器快照，旧 profile 不能改写开关或目标库：%s",
    flag => {
      const directory = createDirectory();
      const injected = {
        DATABASE_URL: "mysql://injected-target/synthetic_test",
        ...(flag === undefined ? {} : { DB_MIGRATE_ON_START: flag }),
      };
      expect(writeSnapshot(directory, injected).status).toBe(0);
      const conflictingFlag = flag === "1" ? "0" : "1";
      const result = runStartup(
        directory,
        injected,
        `export DB_MIGRATE_ON_START=${conflictingFlag}\nexport DATABASE_URL=mysql://stale-profile/other_test\nexport DOTENV_CONFIG_OVERRIDE=false\nexport DOTENV_CONFIG_PATH=/nonexistent/stale.env\n`
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `shell DB_MIGRATE_ON_START=${conflictingFlag}`
      );
      const log = readFileSync(join(directory, "logs/app.log"), "utf8");
      const reports = log
        .split("\n")
        .filter(line => line.startsWith('{"flag":'))
        .map(line => JSON.parse(line));
      expect(reports).toEqual([
        { flag: flag ?? "0", database: injected.DATABASE_URL },
        { flag: flag ?? "0", database: injected.DATABASE_URL },
      ]);
    }
  );

  it("切换用户丢失环境后仍从容器快照恢复同一开关和数据库", () => {
    const directory = createDirectory();
    expect(
      writeSnapshot(directory, {
        DB_MIGRATE_ON_START: "1",
        DATABASE_URL: "mysql://injected-target/synthetic_test",
      }).status
    ).toBe(0);
    const result = runStartup(
      directory,
      {},
      "export DB_MIGRATE_ON_START=0\nexport DATABASE_URL=mysql://stale-profile/other_test\n"
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      '"flag":"1","database":"mysql://injected-target/synthetic_test"'
    );
  });

  it.each([undefined, "DATABASE_URL=mysql://old/synthetic_test\n"])(
    "快照缺失或缺少开关时停止启动，不使用旧 profile 授权迁移：%s",
    snapshot => {
      const directory = createDirectory();
      if (snapshot !== undefined)
        writeFileSync(join(directory, ".env"), snapshot);
      const result = runStartup(
        directory,
        {},
        "export DB_MIGRATE_ON_START=1\n"
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FATAL: runtime snapshot");
      expect(result.stdout).not.toContain("audio-eval start success");
      expect(result.stdout).not.toContain('{"flag":');
    }
  );
});
