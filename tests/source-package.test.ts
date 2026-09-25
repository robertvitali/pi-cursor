import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("ships the complete source entry with scripts disabled and no built dist", () => {
  const root = resolve(import.meta.dirname, "..");
  const sandbox = mkdtempSync(join(tmpdir(), "cursor-source-package-"));
  try {
    cpSync(join(root, "package.json"), join(sandbox, "package.json"));
    cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
        cwd: sandbox,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, npm_config_cache: join(sandbox, "npm-cache") },
      }),
    );
    const paths = packed[0].files.map((file: { path: string }) => file.path) as string[];
    expect(paths).toContain("src/index.ts");
    const sourceFiles = readdirSync(join(sandbox, "src"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(sandbox.length + 1));
    expect(sourceFiles.length).toBeGreaterThan(1);
    for (const path of sourceFiles) expect(paths).toContain(path);
    expect(paths.some((path) => path.startsWith("dist/"))).toBe(false);
    expect(JSON.parse(readFileSync(join(sandbox, "package.json"), "utf8")).main).toBe(
      "./dist/index.js",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 40_000);
