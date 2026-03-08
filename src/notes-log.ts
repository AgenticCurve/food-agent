import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { NoteEntry } from "./types.js";

const LOGS_DIR = dataPath("logs");
const CSV_HEADER = "timestamp,note";

function getNotesPath(userId: string): string {
  return path.join(LOGS_DIR, userId, "notes.csv");
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

function readNotesFile(userId: string): NoteEntry[] {
  const p = getNotesPath(userId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const f = parseCSVLine(line);
    return { timestamp: f[0] || "", note: f[1] || "" };
  }).filter((e) => e.note);
}

function writeNotesFile(userId: string, entries: NoteEntry[]): void {
  const p = getNotesPath(userId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = [
    CSV_HEADER,
    ...entries.map((e) => `${e.timestamp},${escapeCSV(e.note)}`),
  ];
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
}

export function appendNote(userId: string, entry: NoteEntry): void {
  const entries = readNotesFile(userId);
  entries.push(entry);
  writeNotesFile(userId, entries);
}

export function getAllNotes(userId: string): NoteEntry[] {
  return readNotesFile(userId);
}

export function getRecentNotes(userId: string, count: number): NoteEntry[] {
  const all = readNotesFile(userId);
  return all.slice(-count);
}

export function updateNote(
  userId: string,
  entryNumber: number,
  updates: Partial<NoteEntry>,
): NoteEntry | null {
  const entries = readNotesFile(userId);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  entries[entryNumber - 1] = { ...entries[entryNumber - 1], ...updates };
  writeNotesFile(userId, entries);
  return entries[entryNumber - 1];
}

export function removeNote(
  userId: string,
  entryNumber: number,
): NoteEntry | null {
  const entries = readNotesFile(userId);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  const removed = entries.splice(entryNumber - 1, 1)[0];
  writeNotesFile(userId, entries);
  return removed;
}

export function getNotesForDateRange(
  userId: string,
  startDate: string,
  endDate: string,
): string {
  const entries = readNotesFile(userId);
  const results = entries.filter((e) => {
    const d = e.timestamp.slice(0, 10);
    return d >= startDate && d <= endDate;
  });
  return results.length > 0
    ? `${CSV_HEADER}\n${results.map((e) => `${e.timestamp},${escapeCSV(e.note)}`).join("\n")}`
    : "No notes found for this date range.";
}

export function grepNotes(userId: string, pattern: string): string {
  const entries = readNotesFile(userId);
  const lower = pattern.toLowerCase();
  const results = entries.filter((e) => e.note.toLowerCase().includes(lower));
  return results.length > 0
    ? results
        .slice(0, 50)
        .map((e) => `[${e.timestamp.slice(0, 10)}] ${e.note}`)
        .join("\n") +
        (results.length > 50 ? `\n... and ${results.length - 50} more` : "")
    : `No notes matching "${pattern}".`;
}
