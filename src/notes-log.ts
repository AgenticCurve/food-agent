import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { NoteEntry } from "./types.js";

const LOGS_DIR = dataPath("logs");
const CSV_HEADER = "timestamp,note";
const DEFAULT_TZ = "Asia/Hong_Kong";

function todayTZ(timezone?: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone || DEFAULT_TZ });
}

function dateStrTZ(d: Date, timezone?: string): string {
  return d.toLocaleDateString("en-CA", { timeZone: timezone || DEFAULT_TZ });
}

/** logs/{userId}/{yyyy}/{mm}/notes-{yyyy-mm-dd}.csv */
function getDateFilePath(userId: string, date: string): string {
  const [year, month] = date.split("-");
  return path.join(LOGS_DIR, userId, year, month, `notes-${date}.csv`);
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function readDateFile(filePath: string): NoteEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const f = parseCSVLine(line);
    return { timestamp: f[0] || "", note: f[1] || "" };
  }).filter((e) => e.note);
}

function writeDateFile(filePath: string, entries: NoteEntry[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = [
    CSV_HEADER,
    ...entries.map((e) => `${e.timestamp},${escapeCSV(e.note)}`),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

export function appendNote(userId: string, entry: NoteEntry, timezone?: string): void {
  const date = todayTZ(timezone);
  const filePath = getDateFilePath(userId, date);
  const existing = readDateFile(filePath);
  existing.push(entry);
  writeDateFile(filePath, existing);
}

export function getTodayNotes(userId: string, timezone?: string): NoteEntry[] {
  return readDateFile(getDateFilePath(userId, todayTZ(timezone)));
}

export function getNotesForDays(userId: string, days: number, timezone?: string): NoteEntry[] {
  const entries: NoteEntry[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = dateStrTZ(d, timezone);
    entries.push(...readDateFile(getDateFilePath(userId, date)));
  }
  return entries;
}

export function updateTodayNote(
  userId: string,
  entryNumber: number,
  updates: Partial<NoteEntry>,
  timezone?: string,
): NoteEntry | null {
  const filePath = getDateFilePath(userId, todayTZ(timezone));
  const entries = readDateFile(filePath);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  entries[entryNumber - 1] = { ...entries[entryNumber - 1], ...updates };
  writeDateFile(filePath, entries);
  return entries[entryNumber - 1];
}

export function removeTodayNote(
  userId: string,
  entryNumber: number,
  timezone?: string,
): NoteEntry | null {
  const filePath = getDateFilePath(userId, todayTZ(timezone));
  const entries = readDateFile(filePath);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  const removed = entries.splice(entryNumber - 1, 1)[0];
  writeDateFile(filePath, entries);
  return removed;
}

export function updateNoteByDate(
  userId: string,
  date: string,
  entryNumber: number,
  updates: Partial<NoteEntry>,
): NoteEntry | null {
  const filePath = getDateFilePath(userId, date);
  const entries = readDateFile(filePath);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  entries[entryNumber - 1] = { ...entries[entryNumber - 1], ...updates };
  writeDateFile(filePath, entries);
  return entries[entryNumber - 1];
}

export function removeNoteByDate(
  userId: string,
  date: string,
  entryNumber: number,
): NoteEntry | null {
  const filePath = getDateFilePath(userId, date);
  const entries = readDateFile(filePath);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  const removed = entries.splice(entryNumber - 1, 1)[0];
  writeDateFile(filePath, entries);
  return removed;
}

export function getNotesForDateRange(
  userId: string,
  startDate: string,
  endDate: string,
): string {
  const results: NoteEntry[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    results.push(...readDateFile(getDateFilePath(userId, date)));
  }
  return results.length > 0
    ? `${CSV_HEADER}\n${results.map((e) => `${e.timestamp},${escapeCSV(e.note)}`).join("\n")}`
    : "No notes found for this date range.";
}

export function grepNotes(userId: string, pattern: string): string {
  const userDir = path.join(LOGS_DIR, userId);
  if (!fs.existsSync(userDir)) return `No notes matching "${pattern}".`;

  const lower = pattern.toLowerCase();
  const results: Array<{ date: string; note: string }> = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name.startsWith("notes-") && entry.name.endsWith(".csv")) {
        const date = entry.name.slice(6, -4); // notes-yyyy-mm-dd.csv → yyyy-mm-dd
        const entries = readDateFile(path.join(dir, entry.name));
        for (const e of entries) {
          if (e.note.toLowerCase().includes(lower)) {
            results.push({ date, note: e.note });
          }
        }
      }
    }
  }

  walk(userDir);
  results.sort((a, b) => a.date.localeCompare(b.date));

  return results.length > 0
    ? results
        .slice(0, 50)
        .map((r) => `[${r.date}] ${r.note}`)
        .join("\n") +
        (results.length > 50 ? `\n... and ${results.length - 50} more` : "")
    : `No notes matching "${pattern}".`;
}
