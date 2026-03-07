import fs from "fs";
import { DATA_DIR, dataPath } from "./paths.js";
import type { UserTarget } from "./types.js";

const TARGETS_PATH = dataPath("targets.json");

type TargetsStore = Record<string, UserTarget>;

const DEFAULT_TARGET: UserTarget = {
  daily_calories: 2400,
  timezone: "Asia/Hong_Kong",
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadTargets(): TargetsStore {
  ensureDataDir();
  try {
    if (!fs.existsSync(TARGETS_PATH)) return {};
    return JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveTargets(store: TargetsStore): void {
  ensureDataDir();
  fs.writeFileSync(TARGETS_PATH, JSON.stringify(store, null, 2), "utf8");
}

export function getTarget(userId: string): UserTarget {
  const store = loadTargets();
  return store[userId] ?? { ...DEFAULT_TARGET };
}

export function setTarget(userId: string, updates: Partial<UserTarget>): UserTarget {
  const store = loadTargets();
  const current = store[userId] ?? { ...DEFAULT_TARGET };
  const updated = { ...current, ...updates };
  store[userId] = updated;
  saveTargets(store);
  return updated;
}
