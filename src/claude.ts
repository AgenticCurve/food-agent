import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

const SESSIONS_DIR = dataPath("sessions");

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [claude] ${message}`);
}

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function userIdToUuid(userId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`food-agent:${userId}`)
    .digest("hex");

  const version = "4" + hash.slice(13, 16);
  const variant =
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    version,
    variant,
    hash.slice(20, 32),
  ].join("-");
}

function isSessionInitialized(userId: string): boolean {
  ensureSessionsDir();
  return fs.existsSync(path.join(SESSIONS_DIR, userId));
}

function markSessionInitialized(userId: string): void {
  ensureSessionsDir();
  fs.writeFileSync(path.join(SESSIONS_DIR, userId), "", "utf8");
}

function runClaude(
  sessionId: string,
  prompt: string,
  resume: boolean,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")),
    );

    const args = ["--dangerously-skip-permissions", "-p"];
    if (resume) {
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    log("DEBUG", `Running: claude ${args.join(" ")} (prompt: ${prompt.length} chars${cwd ? `, cwd: ${cwd}` : ""})`);

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: cwd || undefined,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        log("ERROR", `CLI failed (code ${code}): ${stderr.trim().slice(0, 500)}`);
        reject(
          new Error(
            `Claude CLI exited with code ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`,
          ),
        );
      } else {
        log("DEBUG", `Success (${stdout.length} chars response)`);
        resolve(stdout.trim());
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run Claude CLI: ${err.message}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function listCsvFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
}

/**
 * Ask Claude about the user's food data (used by deep_question from orchestrator).
 * Claude runs with cwd set to the user's logs directory.
 */
export async function askAboutFoodData(
  userId: string,
  logsDir: string,
  question: string,
): Promise<string> {
  const sessionId = userIdToUuid(userId);
  const files = listCsvFiles(logsDir);

  const filesInfo =
    files.length > 0
      ? `Food log CSV files in current directory (one per date, YYYY-MM-DD.csv):\n${files.join("\n")}\nSchema: timestamp,food_item,quantity,unit,calories,notes\nAll timestamps are in HKT (Hong Kong Time, +08:00).`
      : "(no food log data yet)";

  const fullPrompt = [
    "You are a food and nutrition assistant. The user's food log CSV files are in the current directory.",
    "",
    filesInfo,
    "",
    "---",
    "",
    "Answer the following question. Be concise and helpful.",
    "Read the CSV files as needed. If the question requires web search or research, use your tools.",
    "",
    question,
  ].join("\n");

  log("DEBUG", `askAboutFoodData: userId=${userId}, session=${sessionId}, files=${files.length}`);

  if (isSessionInitialized(userId)) {
    log("DEBUG", `Resuming existing session for ${userId}`);
    try {
      return await runClaude(sessionId, question, true, logsDir);
    } catch (err) {
      log(
        "WARN",
        `Resume failed, creating new session: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  try {
    log("DEBUG", `Creating new session for ${userId}`);
    const result = await runClaude(sessionId, fullPrompt, false, logsDir);
    markSessionInitialized(userId);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.includes("already in use")) {
      log("DEBUG", `Session already exists, resuming with full prompt`);
      markSessionInitialized(userId);
      return runClaude(sessionId, fullPrompt, true, logsDir);
    }
    throw err;
  }
}
