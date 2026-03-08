/**
 * Per-user git repository for data versioning.
 * Each user's log directory gets its own git repo.
 * After every orchestrator round, we auto-commit all changes.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

const LOGS_DIR = dataPath("logs");

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [user-git] ${message}`);
}

function getUserDir(userId: string): string {
  return path.join(LOGS_DIR, userId);
}

function git(userDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: userDir,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", `git ${args[0]} failed in ${userDir}: ${msg}`);
    return "";
  }
}

/** Ensure the user's log directory has a git repo. */
export function ensureUserRepo(userId: string): void {
  const userDir = getUserDir(userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  const gitDir = path.join(userDir, ".git");
  if (!fs.existsSync(gitDir)) {
    git(userDir, ["init"]);
    // Initial commit so we have a baseline
    git(userDir, ["add", "-A"]);
    git(userDir, ["commit", "--allow-empty", "-m", "init"]);
    log("INFO", `Initialized git repo for user ${userId}`);
  }
}

/** Commit all current changes in the user's log directory. */
export function commitUserData(userId: string, message: string): void {
  const userDir = getUserDir(userId);
  if (!fs.existsSync(path.join(userDir, ".git"))) {
    ensureUserRepo(userId);
  }

  // Stage everything
  git(userDir, ["add", "-A"]);

  // Check if there's anything to commit
  const status = git(userDir, ["status", "--porcelain"]);
  if (!status) return; // nothing changed

  git(userDir, ["commit", "-m", message]);
  log("DEBUG", `Committed for ${userId}: ${message}`);
}
