// Deterministic simulated KV transfer (and tier-restore) pipeline.
//
// This is NOT RDMA/NCCL: transfers move an abstract byte payload over a
// shared pipe with a fixed per-transfer latency. All numbers are illustrative
// model parameters, never measured hardware figures.
//
// Scheduling policies (config.transferSchedulingPolicy):
// - 'fair-share': active transfers start FIFO and split the pipe equally.
// - 'fifo': strict queue order, head-of-line service — the first active
//   transfer takes the whole pipe (serial service, zero queue jumping).
// - 'priority': higher-priority requests start first (queue preference),
//   active transfers then share the pipe equally.

export interface TransferRecord {
  id: number;
  requestId: string;
  priority: number;           // scheduling rank (2 = high ... 0 = low)
  source: string;
  destination: string;
  bytes: number;              // KV payload bytes
  bytesDone: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  bandwidthGBps: number;      // pipe bandwidth for the record's pool (illustrative)
  fixedLatencyMs: number;     // per-transfer fixed latency (illustrative)
}

export interface TransferOptions {
  bandwidthGBps: number;
  latencyMs: number;
  maxConcurrent: number;
  policy: 'fair-share' | 'fifo' | 'priority';
}

export class KVTransferManager {
  queue: TransferRecord[] = [];
  active: TransferRecord[] = [];
  log: TransferRecord[] = [];
  completed = 0;
  bytesTotal = 0;
  private serial = 0;
  private opts: () => TransferOptions;

  constructor(opts: () => TransferOptions) {
    this.opts = opts;
  }

  enqueue(requestId: string, source: string, destination: string, bytes: number, now: number,
    priority = 1, bandwidthGBps = this.opts().bandwidthGBps,
    fixedLatencyMs = this.opts().latencyMs): TransferRecord {
    const rec: TransferRecord = {
      id: ++this.serial, requestId, priority, source, destination,
      bytes: Math.max(1, Math.round(bytes)), bytesDone: 0, queuedAt: now, bandwidthGBps, fixedLatencyMs,
    };
    this.queue.push(rec);
    return rec;
  }

  /** Remove every queued or in-flight transfer for a request; returns how many were removed. */
  cancel(requestId: string): number {
    let removed = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].requestId === requestId) { this.queue.splice(i, 1); removed++; }
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].requestId === requestId) { this.active.splice(i, 1); removed++; }
    }
    return removed;
  }

  /** Advance dtMs of simulated time; completes records via onComplete in FIFO order. */
  tick(dtMs: number, now: number, onComplete: (rec: TransferRecord) => void,
    onStart?: (rec: TransferRecord) => void) {
    const { maxConcurrent, policy } = this.opts();
    // Start queued transfers. Under 'priority' the queue drains by class first
    // (stable within a class: queue order); otherwise strict FIFO.
    if (policy === 'priority' && this.queue.length > 1) {
      this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt || a.id - b.id);
    }
    while (this.queue.length && this.active.length < maxConcurrent) {
      const rec = this.queue.shift()!;
      rec.startedAt = now;
      this.active.push(rec);
      onStart?.(rec);
    }
    if (this.active.length) {
      // Bandwidth sharing: 'fifo' serves strictly head-of-line (queue order,
      // one transfer at a time); 'fair-share' and 'priority' split equally.
      const headFirst = policy === 'fifo';
      const served = headFirst
        ? [...this.active].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id).slice(0, 1)
        : this.active;
      const shareGBps = served.length
        ? Math.min(...served.map(r => r.bandwidthGBps)) / served.length
        : 0;
      const finished: TransferRecord[] = [];
      for (const rec of this.active) {
        if (served.includes(rec)) rec.bytesDone += shareGBps * dtMs * 1e6; // GB/s -> bytes/ms
        const elapsed = now - (rec.startedAt ?? now);
        if (rec.bytesDone >= rec.bytes && elapsed >= rec.fixedLatencyMs) {
          rec.finishedAt = now;
          this.completed++;
          this.bytesTotal += rec.bytes;
          finished.push(rec);
        }
      }
      for (const rec of finished) {
        const i = this.active.indexOf(rec);
        if (i >= 0) this.active.splice(i, 1);
        this.log.push(rec);
        if (this.log.length > 200) this.log.shift();
        onComplete(rec);
      }
    }
  }
}
