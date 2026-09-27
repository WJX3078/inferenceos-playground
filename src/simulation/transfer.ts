// Deterministic simulated KV transfer (and tier-restore) pipeline.
//
// This is NOT RDMA/NCCL: transfers move an abstract byte payload over a
// shared-bandwidth pipe with a fixed per-transfer latency. All numbers are
// illustrative model parameters, never measured hardware figures.
//
// Model: active transfers share the configured bandwidth equally; a transfer
// completes when it has moved all bytes AND its fixed latency has elapsed.

export interface TransferRecord {
  id: number;
  requestId: string;
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

export interface TransferOptions { bandwidthGBps: number; latencyMs: number; maxConcurrent: number }

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
    bandwidthGBps = this.opts().bandwidthGBps, fixedLatencyMs = this.opts().latencyMs): TransferRecord {
    const rec: TransferRecord = {
      id: ++this.serial, requestId, source, destination,
      bytes: Math.max(1, Math.round(bytes)), bytesDone: 0, queuedAt: now, bandwidthGBps, fixedLatencyMs,
    };
    this.queue.push(rec);
    return rec;
  }

  /** Remove any queued or in-flight transfer for a request; returns true if one existed. */
  cancel(requestId: string): boolean {
    const qi = this.queue.findIndex(r => r.requestId === requestId);
    if (qi >= 0) { this.queue.splice(qi, 1); return true; }
    const ai = this.active.findIndex(r => r.requestId === requestId);
    if (ai >= 0) { this.active.splice(ai, 1); return true; }
    return false;
  }

  /** Advance dtMs of simulated time; completes records via onComplete in FIFO order. */
  tick(dtMs: number, now: number, onComplete: (rec: TransferRecord) => void,
    onStart?: (rec: TransferRecord) => void) {
    const { maxConcurrent } = this.opts();
    while (this.queue.length && this.active.length < maxConcurrent) {
      const rec = this.queue.shift()!;
      rec.startedAt = now;
      this.active.push(rec);
      onStart?.(rec);
    }
    if (this.active.length) {
      const finished: TransferRecord[] = [];
      for (const rec of this.active) {
        // Equal sharing of the pipe among concurrent transfers (documented simplification).
        const shareGBps = rec.bandwidthGBps / this.active.length;
        rec.bytesDone += shareGBps * dtMs * 1e6; // GB/s -> bytes/ms
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
