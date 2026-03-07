import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { ChatMessage } from "./types.js";

const HISTORY_DIR = dataPath("history");
const MAX_MESSAGES = 50;

function ensureDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function getHistoryPath(userId: string): string {
  return path.join(HISTORY_DIR, `${userId}.json`);
}

function loadFromDisk(userId: string): ChatMessage[] {
  ensureDir();
  const p = getHistoryPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function saveToDisk(userId: string, history: ChatMessage[]): void {
  ensureDir();
  fs.writeFileSync(getHistoryPath(userId), JSON.stringify(history, null, 2), "utf8");
}

export function getHistory(userId: string): ChatMessage[] {
  return loadFromDisk(userId);
}

export function addMessage(
  userId: string,
  role: "user" | "assistant",
  text: string,
): void {
  const history = loadFromDisk(userId);
  history.push({ role, text, timestamp: new Date().toISOString() });
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }
  saveToDisk(userId, history);
}

export function clearHistory(userId: string): void {
  ensureDir();
  const p = getHistoryPath(userId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
