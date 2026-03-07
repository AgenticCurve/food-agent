import fs from "fs";
import { DATA_DIR, dataPath } from "./paths.js";

const SETTINGS_PATH = dataPath("settings.json");

export interface Settings {
  telegram: {
    bot_token: string;
  };
  openrouter: {
    api_key: string;
  };
}

const DEFAULT_SETTINGS: Settings = {
  telegram: { bot_token: "" },
  openrouter: { api_key: "" },
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadSettings(): Settings {
  ensureDataDir();
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      telegram: { bot_token: parsed.telegram?.bot_token ?? "" },
      openrouter: { api_key: parsed.openrouter?.api_key ?? "" },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

export function resolveBotToken(): string | null {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken !== "your_token_here") return envToken;
  const settings = loadSettings();
  return settings.telegram.bot_token || null;
}

export function resolveOpenRouterKey(): string | null {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;
  const settings = loadSettings();
  return settings.openrouter.api_key || null;
}
