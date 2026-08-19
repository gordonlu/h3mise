// In-process event bus + SSE fan-out. PRD §48: UI refresh must not depend on
// full-table polling; render/take/continuity events are pushed.

import type { AppEvent } from '@h3mise/shared';
import type { ServerResponse } from 'node:http';

type Listener = (event: AppEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private sseClients = new Set<ServerResponse>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AppEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // listener errors must never break the bus
      }
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  /** Attach an SSE response; returns a disposer. */
  subscribe(res: ServerResponse): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    this.sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* client gone */
      }
    }, 25_000);
    const dispose = () => {
      clearInterval(ping);
      this.sseClients.delete(res);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    res.on('close', dispose);
    return dispose;
  }
}
