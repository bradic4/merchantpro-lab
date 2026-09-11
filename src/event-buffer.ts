/**
 * Smart Event Buffer for Ecommerce Tracking
 * 
 * Safely captures, buffers, and replays critical ecommerce events
 * (page_view, view_item, add_to_cart, view_cart, begin_checkout, purchase)
 * while marketing scripts (Meta Pixel, Google Tag Manager/GA4, TikTok Pixel)
 * are deferred to improve Core Web Vitals (TBT/INP).
 */

export interface BufferedEvent {
  id: string;
  channel: 'meta' | 'google' | 'tiktok';
  eventName: string;
  args: any[];
  timestamp: number;
  flushed: boolean;
}

export class SmartEventBuffer {
  private queue: BufferedEvent[] = [];
  private eventCounter = 0;
  private dedupeHashes = new Set<string>();

  constructor() {}

  private hashArgs(channel: string, eventName: string, args: any[]): string {
    try {
      return `${channel}:${eventName}:${JSON.stringify(args)}`;
    } catch {
      return `${channel}:${eventName}:${String(args)}`;
    }
  }

  /**
   * Pushes a tracking call into the buffer.
   * If deduplicate is true, identical calls within a short time window are prevented.
   */
  public push(channel: 'meta' | 'google' | 'tiktok', eventName: string, args: any[]): BufferedEvent | null {
    const hash = this.hashArgs(channel, eventName, args);
    if (this.dedupeHashes.has(hash)) {
      // Duplicate event prevented
      return null;
    }
    this.dedupeHashes.add(hash);

    this.eventCounter++;
    const buffered: BufferedEvent = {
      id: `evt-${Date.now()}-${this.eventCounter}`,
      channel,
      eventName,
      args: Array.from(args),
      timestamp: Date.now(),
      flushed: false,
    };

    this.queue.push(buffered);
    return buffered;
  }

  /**
   * Retrieves all buffered events in FIFO order.
   */
  public getEvents(channel?: 'meta' | 'google' | 'tiktok'): BufferedEvent[] {
    if (channel) {
      return this.queue.filter(e => e.channel === channel);
    }
    return [...this.queue];
  }

  /**
   * Flushes queued events to the target SDK function in exact FIFO order.
   * Marks flushed events to guarantee zero duplication.
   */
  public flush(channel: 'meta' | 'google' | 'tiktok', targetFn: (...args: any[]) => void): number {
    const pending = this.queue.filter(e => e.channel === channel && !e.flushed);
    for (const evt of pending) {
      targetFn(...evt.args);
      evt.flushed = true;
    }
    return pending.length;
  }

  /**
   * Returns summary metrics for audit and verification.
   */
  public getStats() {
    const total = this.queue.length;
    const flushed = this.queue.filter(e => e.flushed).length;
    const pending = total - flushed;
    return { total, flushed, pending };
  }
}

/**
 * Returns the self-contained JavaScript snippet to be injected into page <head>
 * before any marketing or theme scripts run.
 */
export function generateSmartBufferSnippet(): string {
  return `
<script id="smart-tracking-layer">
(function(window) {
  window.__mproEventBuffer = window.__mproEventBuffer || [];
  
  // 1. Meta fbq stub
  window.fbq = window.fbq || function() {
    var args = Array.prototype.slice.call(arguments);
    window.__mproEventBuffer.push({ channel: 'meta', eventName: args[1] || 'call', args: args, ts: Date.now() });
    if (window.fbq.queue) window.fbq.queue.push(args);
  };
  window.fbq.queue = window.fbq.queue || [];
  window.fbq.loaded = true;

  // 2. Google dataLayer / gtag stub
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function() {
    var args = Array.prototype.slice.call(arguments);
    window.dataLayer.push(args);
    window.__mproEventBuffer.push({ channel: 'google', eventName: args[0] || 'gtag', args: args, ts: Date.now() });
  };

  // 3. TikTok ttq stub
  window.ttq = window.ttq || [];
  window.ttq.methods = ['page', 'track', 'identify'];
  window.ttq.methods.forEach(function(method) {
    window.ttq[method] = function() {
      var args = Array.prototype.slice.call(arguments);
      window.__mproEventBuffer.push({ channel: 'tiktok', eventName: method, args: args, ts: Date.now() });
    };
  });
})(window);
</script>
`.trim();
}
