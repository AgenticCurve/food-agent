import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import { PROJECT_ROOT } from "./paths.js";
import { nowTZ } from "./food-log.js";

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

/** Recursively find all CSV files in a directory tree. */
function listCsvFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];

  function walk(d: string, prefix: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name), rel);
      } else if (entry.name.endsWith(".csv")) {
        results.push(rel);
      }
    }
  }

  walk(dir, "");
  return results.sort();
}

function buildSystemPrompt(logsDir: string, timezone: string): string {
  const files = listCsvFilesRecursive(logsDir);
  const localNow = nowTZ(timezone);
  const todayDate = localNow.split("T")[0];

  const filesInfo =
    files.length > 0
      ? `Food log CSV files (relative to current directory):\n${files.map((f) => `  ${f}`).join("\n")}`
      : "(no food log data yet)";

  return [
    "You are a health and wellness research assistant.",
    "",
    "PURPOSE:",
    "The user tracks their food intake, calories, sleep, weight, and notes via a Telegram bot.",
    "You are called when they need deeper analysis, research, or questions that require looking at their data or the web.",
    "",
    "DATA:",
    `Current date/time: ${localNow} (${timezone})`,
    `Today's date: ${todayDate}`,
    "",
    "Directory structure (current working directory is the user's log folder):",
    "  {yyyy}/{mm}/{yyyy-mm-dd}.csv — one food CSV file per date",
    "  sleep/{yyyy}-{mm}.csv — one sleep CSV file per month",
    "  notes.csv — all user notes (timestamp,note)",
    "  weight.csv — weight tracking (timestamp,weight_kg,notes)",
    "  chat-history.json — recent chat messages between user and bot (last 50)",
    "",
    filesInfo,
    "",
    "Food CSV schema: timestamp,food_item,quantity,unit,calories,notes",
    `- All timestamps are in the user's timezone (${timezone})`,
    "- Calories can be 0 for non-food items (medicine, supplements, water)",
    "- Units vary: piece, slice, cup, bowl, plate, gram, ml, serving, tbsp, tsp, pill, tablet, capsule, glass, dose",
    "",
    "Sleep CSV schema: date,type,start_time,end_time,duration_hours,quality,notes",
    "- type: night (overnight sleep) or nap (daytime)",
    "- quality: 1-10 scale (1=terrible, 10=perfect)",
    "- duration_hours: decimal hours (e.g. 7.5)",
    "",
    "Notes CSV schema: timestamp,note",
    "- Single file per user, stores user-requested notes/reminders",
    "",
    "Weight CSV schema: timestamp,weight_kg,notes",
    "- Single file per user, tracks weight over time",
    "",
    "WEB SEARCH:",
    "IMPORTANT: You do NOT have built-in web search. Do NOT try to use WebSearch or WebFetch tools — they will fail.",
    "Instead, to search the web you MUST run this bash command:",
    `  npx tsx ${PROJECT_ROOT}/src/search.ts "your search query"`,
    "This calls Perplexity API (sonar-pro) and prints results to stdout. Always use this for:",
    "- Any question that needs current/live information (prices, news, weather, etc.)",
    "- Nutrition research (calorie counts, macros, health info)",
    "- Food-related questions the data can't answer",
    "- Any factual question you're not 100% certain about",
    "",
    "INSTRUCTIONS:",
    "- Read CSV files as needed using your file tools",
    "- For ANY web lookup, use the bash search command above — never try built-in web tools",
    "- Be concise and helpful",
    `- All times should be in the user's timezone (${timezone}) — never mention UTC to the user`,
  ].join("\n");
}

/**
 * Ask Claude about the user's food data.
 * Claude runs with cwd set to the user's logs directory.
 */
export async function askAboutFoodData(
  userId: string,
  logsDir: string,
  question: string,
  timezone?: string,
): Promise<string> {
  const sessionId = userIdToUuid(userId);

  log("DEBUG", `askAboutFoodData: userId=${userId}, session=${sessionId}`);

  const systemPrompt = buildSystemPrompt(logsDir, timezone || "Asia/Hong_Kong");
  const fullPrompt = `${systemPrompt}\n\n---\n\n${question}`;

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

/**
 * Clear Claude session for a user (removes session marker so next call starts fresh).
 */
export function clearSession(userId: string): void {
  ensureSessionsDir();
  const marker = path.join(SESSIONS_DIR, userId);
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  log("INFO", `Cleared session marker for ${userId}`);
}
