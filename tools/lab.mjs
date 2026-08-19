#!/usr/bin/env node
// Root convenience CLI: pnpm lab:<action> <number>
// Resolves labs/NN-* directories and runs the matching command inside them.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const labsDir = path.join(repoRoot, "labs");

function listLabDirs() {
  if (!existsSync(labsDir)) return [];
  return readdirSync(labsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function resolveLab(numberArg) {
  const padded = String(numberArg).padStart(2, "0");
  const match = listLabDirs().find((name) => name.startsWith(`${padded}-`));
  if (!match) {
    console.error(`No lab found matching number "${numberArg}" under labs/`);
    process.exit(1);
  }
  return path.join(labsDir, match);
}

function titleFromReadme(labPath) {
  const readmePath = path.join(labPath, "README.md");
  if (!existsSync(readmePath)) return "(no README.md)";
  const firstLine = readFileSync(readmePath, "utf8").split("\n")[0];
  return firstLine.replace(/^#+\s*/, "");
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const [, , action, numberArg] = process.argv;

switch (action) {
  case "list": {
    for (const name of listLabDirs()) {
      console.log(`${name} - ${titleFromReadme(path.join(labsDir, name))}`);
    }
    break;
  }
  case "start": {
    const labPath = resolveLab(numberArg);
    run("docker", ["compose", "up", "-d"], labPath);
    break;
  }
  case "stop": {
    const labPath = resolveLab(numberArg);
    run("docker", ["compose", "down"], labPath);
    break;
  }
  case "reset": {
    const labPath = resolveLab(numberArg);
    run("docker", ["compose", "down", "-v"], labPath);
    break;
  }
  case "test": {
    const labPath = resolveLab(numberArg);
    run("pnpm", ["test"], labPath);
    break;
  }
  default: {
    console.error(`Unknown lab action "${action}". Use one of: list, start, stop, reset, test.`);
    process.exit(1);
  }
}
