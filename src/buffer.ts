/**
 * Per-user message buffer with adaptive debounce.
 * Collects rapid messages and fires a flush callback after the user
 * stops typing. Base debounce is reset on each new message, with a
 * hard ceiling so the user isn't kept waiting forever.
 *
 * Each batch gets a block ID derived from the first message's
 * Telegram timestamp (Unix seconds from msg.date).
 */

export interface BufferedMessage {
  text: string;
  messageId: number;
  chatId: number;
  date: number; // Unix seconds (Telegram msg.date — when user actually sent it)
  replyText?: string;
}

type FlushCallback = (
  userId: string,
  messages: BufferedMessage[],
  blockId: string,
) => Promise<void>;

/** Format a Unix-seconds timestamp to an ISO 8601 string in a given timezone. */
function toBlockId(unixSeconds: number, timezone: string): string {
  const d = new Date(unixSeconds * 1000);
  // Build yyyy-mm-ddTHH:MM:SS in the user's timezone
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export class MessageBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private ceilingTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private maxWaitMs: number;
  private timezone: string;
  private onFlush: FlushCallback;

  constructor(
    debounceMs: number,
    maxWaitMs: number,
    timezone: string,
    onFlush: FlushCallback,
  ) {
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.timezone = timezone;
    this.onFlush = onFlush;
  }

  add(userId: string, msg: BufferedMessage): void {
    const buf = this.buffers.get(userId) ?? [];
    buf.push(msg);
    this.buffers.set(userId, buf);

    // Reset the per-message debounce timer
    const existing = this.timers.get(userId);
    if (existing) clearTimeout(existing);

    this.timers.set(
      userId,
      setTimeout(() => this.flush(userId), this.debounceMs),
    );

    // Start ceiling timer on first message in a batch
    if (!this.ceilingTimers.has(userId)) {
      this.ceilingTimers.set(
        userId,
        setTimeout(() => this.flush(userId), this.maxWaitMs),
      );
    }
  }

  private flush(userId: string): void {
    // Clear both timers
    const debounce = this.timers.get(userId);
    if (debounce) clearTimeout(debounce);
    this.timers.delete(userId);

    const ceiling = this.ceilingTimers.get(userId);
    if (ceiling) clearTimeout(ceiling);
    this.ceilingTimers.delete(userId);

    const messages = this.buffers.get(userId);
    this.buffers.delete(userId);

    if (messages && messages.length > 0) {
      const blockId = toBlockId(messages[0].date, this.timezone);
      this.onFlush(userId, messages, blockId).catch((err) => {
        console.error(`[buffer] Flush error for ${userId}:`, err);
      });
    }
  }
}
