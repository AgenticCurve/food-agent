import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dataPath } from "./paths.js";

const PAIRING_DIR = dataPath("pairing");
const CODE_LENGTH = 8;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PENDING_TTL_MS = 60 * 60 * 1000;
const PENDING_MAX = 3;

if (!fs.existsSync(PAIRING_DIR)) {
  fs.mkdirSync(PAIRING_DIR, { recursive: true });
}

export interface PairingRequest {
  id: string;
  code: string;
  channel: "telegram";
  sender: string;
  senderId: string;
  createdAt: string;
  lastSeenAt: string;
}

interface PairingStore {
  version: 1;
  requests: PairingRequest[];
}

interface AllowlistEntry {
  channel: "telegram";
  senderId: string;
  sender: string;
  approvedAt: string;
}

interface AllowlistStore {
  version: 1;
  allowlist: AllowlistEntry[];
}

function getPendingPath(): string {
  return path.join(PAIRING_DIR, "telegram-pending.json");
}

function getAllowlistPath(): string {
  return path.join(PAIRING_DIR, "allowlist.json");
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function isExpired(req: PairingRequest): boolean {
  return Date.now() - new Date(req.createdAt).getTime() > PENDING_TTL_MS;
}

function pruneExpired(requests: PairingRequest[]): PairingRequest[] {
  return requests.filter((r) => !isExpired(r));
}

const EMPTY_PENDING: PairingStore = { version: 1, requests: [] };
const EMPTY_ALLOWLIST: AllowlistStore = { version: 1, allowlist: [] };

export function isUserAllowed(senderId: string): boolean {
  const store = readJson<AllowlistStore>(getAllowlistPath(), EMPTY_ALLOWLIST);
  return store.allowlist.some(
    (e) => e.channel === "telegram" && e.senderId === senderId,
  );
}

export function upsertPairingRequest(
  sender: string,
  senderId: string,
): { code: string; created: boolean } {
  const storePath = getPendingPath();
  const store = readJson<PairingStore>(storePath, EMPTY_PENDING);
  const now = new Date().toISOString();

  let requests = pruneExpired(store.requests);

  const existing = requests.find((r) => r.senderId === senderId);
  if (existing) {
    existing.lastSeenAt = now;
    existing.sender = sender;
    writeJson(storePath, { version: 1, requests });
    return { code: existing.code, created: false };
  }

  if (requests.length >= PENDING_MAX) {
    requests.sort(
      (a, b) =>
        new Date(a.lastSeenAt).getTime() - new Date(b.lastSeenAt).getTime(),
    );
    requests.shift();
  }

  const usedCodes = new Set(requests.map((r) => r.code));
  let code: string;
  let attempts = 0;
  do {
    code = generateCode();
    if (++attempts > 100) throw new Error("Failed to generate unique code");
  } while (usedCodes.has(code));

  requests.push({
    id: `telegram_${senderId}`,
    code,
    channel: "telegram",
    sender,
    senderId,
    createdAt: now,
    lastSeenAt: now,
  });

  writeJson(storePath, { version: 1, requests });
  return { code, created: true };
}

export function listPairingRequests(): PairingRequest[] {
  const store = readJson<PairingStore>(getPendingPath(), EMPTY_PENDING);
  const valid = pruneExpired(store.requests);

  if (valid.length !== store.requests.length) {
    writeJson(getPendingPath(), { version: 1, requests: valid });
  }

  return valid.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export function approvePairingCode(
  code: string,
): { success: boolean; request?: PairingRequest } {
  const upperCode = code.toUpperCase();
  const storePath = getPendingPath();
  const store = readJson<PairingStore>(storePath, EMPTY_PENDING);
  const requests = pruneExpired(store.requests);

  const idx = requests.findIndex((r) => r.code === upperCode);
  if (idx < 0) return { success: false };

  const request = requests[idx];

  requests.splice(idx, 1);
  writeJson(storePath, { version: 1, requests });

  const allowlistPath = getAllowlistPath();
  const allowlist = readJson<AllowlistStore>(allowlistPath, EMPTY_ALLOWLIST);

  const alreadyExists = allowlist.allowlist.some(
    (e) => e.channel === "telegram" && e.senderId === request.senderId,
  );

  if (!alreadyExists) {
    allowlist.allowlist.push({
      channel: "telegram",
      senderId: request.senderId,
      sender: request.sender,
      approvedAt: new Date().toISOString(),
    });
    writeJson(allowlistPath, allowlist);
  }

  return { success: true, request };
}

export function listApprovedUsers(): AllowlistEntry[] {
  const store = readJson<AllowlistStore>(getAllowlistPath(), EMPTY_ALLOWLIST);
  return store.allowlist;
}

export function buildPairingMessage(senderId: string, code: string): string {
  return [
    "Food Agent: Access Required",
    "",
    `Your Telegram ID: ${senderId}`,
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to approve access:",
    `  npm run pairing -- approve ${code}`,
    "",
    "This code expires in 1 hour.",
  ].join("\n");
}
