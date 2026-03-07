/**
 * Per-user message buffer with debounce.
 * Collects rapid messages and fires a flush callback after the debounce
 * window expires, delivering all buffered messages at once.
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
  private debounceMs: number;
  private onFlush: FlushCallback;

  constructor(debounceMs: number, onFlush: FlushCallback) {
    this.debounceMs = debounceMs;
    this.onFlush = onFlush;
  }

  add(userId: string, msg: BufferedMessage): void {
    const buf = this.buffers.get(userId) ?? [];
    buf.push(msg);
    this.buffers.set(userId, buf);

    const existing = this.timers.get(userId);
    if (existing) clearTimeout(existing);

    this.timers.set(
      userId,
      setTimeout(() => this.flush(userId), this.debounceMs),
    );
  }

  private flush(userId: string): void {
    this.timers.delete(userId);
    const messages = this.buffers.get(userId);
    this.buffers.delete(userId);

    if (messages && messages.length > 0) {
      this.onFlush(userId, messages).catch((err) => {
        console.error(`[buffer] Flush error for ${userId}:`, err);
      });
    }
  }
}
