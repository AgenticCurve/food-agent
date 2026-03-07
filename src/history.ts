import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import { getLogDirPath } from "./food-log.js";
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
  const data = JSON.stringify(history, null, 2);
  fs.writeFileSync(getHistoryPath(userId), data, "utf8");

  // Also save a copy in the user's log dir so Claude can read it
  try {
    const userDir = getLogDirPath(userId);
    fs.writeFileSync(path.join(userDir, "chat-history.json"), data, "utf8");
  } catch {}
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

  // Also remove from user's log dir
  try {
    const userDir = getLogDirPath(userId);
    const copy = path.join(userDir, "chat-history.json");
    if (fs.existsSync(copy)) fs.unlinkSync(copy);
  } catch {}
}
