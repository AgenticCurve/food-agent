import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

const LOGS_DIR = dataPath("logs");

function getFilePath(userId: string): string {
  return path.join(LOGS_DIR, userId, "profile.txt");
}

export function getProfile(userId: string): string[] {
  const p = getFilePath(userId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim());
}

export function getProfileText(userId: string): string {
  const lines = getProfile(userId);
  return lines.length > 0 ? lines.join("\n") : "";
}

function writeProfile(userId: string, lines: string[]): void {
  const p = getFilePath(userId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
}

export function addProfileFact(userId: string, fact: string): void {
  const lines = getProfile(userId);
  lines.push(fact.trim());
  writeProfile(userId, lines);
}

export function removeProfileFact(userId: string, factNumber: number): string | null {
  const lines = getProfile(userId);
  if (factNumber < 1 || factNumber > lines.length) return null;
  const removed = lines.splice(factNumber - 1, 1)[0];
  writeProfile(userId, lines);
  return removed;
}

export function updateProfileFact(userId: string, factNumber: number, newFact: string): string | null {
  const lines = getProfile(userId);
  if (factNumber < 1 || factNumber > lines.length) return null;
  lines[factNumber - 1] = newFact.trim();
  writeProfile(userId, lines);
  return newFact.trim();
}
