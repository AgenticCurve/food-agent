/**
 * Per-user message buffer with adaptive debounce.
 * Collects rapid messages and fires a flush callback after the user
 * stops typing. Base debounce is reset on each new message, with a
 * hard ceiling so the user isn't kept waiting forever.
 */

export interface BufferedMessage {
  text: string;
  messageId: number;
  chatId: number;
  replyText?: string;
}

type FlushCallback = (
  userId: string,
  messages: BufferedMessage[],
) => Promise<void>;

export class MessageBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private ceilingTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private maxWaitMs: number;
  private onFlush: FlushCallback;

  constructor(debounceMs: number, maxWaitMs: number, onFlush: FlushCallback) {
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
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
      this.onFlush(userId, messages).catch((err) => {
        console.error(`[buffer] Flush error for ${userId}:`, err);
      });
    }
  }
}
