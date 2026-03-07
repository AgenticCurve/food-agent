import type { ChatMessage } from "./types.js";

const MAX_MESSAGES = 20;
const histories = new Map<string, ChatMessage[]>();

export function getHistory(userId: string): ChatMessage[] {
  return histories.get(userId) ?? [];
}

export function addMessage(
  userId: string,
  role: "user" | "assistant",
  text: string,
): void {
  const history = histories.get(userId) ?? [];
  history.push({ role, text, timestamp: new Date().toISOString() });
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }
  histories.set(userId, history);
}

export function clearHistory(userId: string): void {
  histories.delete(userId);
}
