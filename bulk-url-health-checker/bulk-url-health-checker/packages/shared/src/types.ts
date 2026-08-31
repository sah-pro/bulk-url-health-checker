/**
 * Shared domain types. This is the single source of truth for the shapes
 * that cross the client/server boundary. Both the API and the Next.js app
 * import from this package -- neither one redefines these independently.
 */

/** Lifecycle of a batch. Only these transitions are valid (enforced in batchService.ts):
 *   PENDING -> RUNNING -> COMPLETED | PARTIALLY_FAILED | FAILED
 *   PENDING | RUNNING -> CANCELLED
 */
export type BatchStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIALLY_FAILED' | 'FAILED' | 'CANCELLED';

/** Lifecycle of a single URL check. Only these transitions are valid:
 *   QUEUED -> PROCESSING -> SUCCESS | FAILED
 *   QUEUED | PROCESSING -> CANCELLED
 *   FAILED -> QUEUED (via "retry failed only")
 */
export type UrlCheckStatus = 'QUEUED' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface BatchSummary {
  id: string;
  status: BatchStatus;
  totalUrls: number;
  completedUrls: number; // SUCCESS + FAILED + CANCELLED (i.e. terminal)
  successfulUrls: number;
  failedUrls: number;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface UrlCheckDto {
  id: string;
  batchId: string;
  url: string;
  normalizedUrl: string;
  status: UrlCheckStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  pageTitle: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  /**
   * Database-owned retry generation. Bumped exactly once per legitimate
   * "retry failed" call for this row; the BullMQ job id for a check is
   * always `url-check-{id}-run-{runGeneration}`. Exposed mainly for
   * debugging/observability -- the UI doesn't need to act on it, but it
   * makes the retry design's state externally inspectable rather than an
   * internal-only implementation detail.
   */
  runGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchDetail extends BatchSummary {
  urlChecks: UrlCheckDto[];
}


export interface UrlCheckJobData {
  batchId: string;
  urlCheckId: string;
  normalizedUrl: string;
  runGeneration: number;
}

export interface CreateBatchRequest {
  /** Newline/comma separated raw URL text pasted by the user. Optional if a CSV file is uploaded instead. */
  urls?: string[];
}

export interface CreateBatchResponse {
  batch: BatchSummary;
}

export interface ListBatchesResponse {
  batches: BatchSummary[];
  /** True when this response was served from the 30s cache rather than computed fresh. */
  cached: boolean;
}

/** Server-Sent Event payloads pushed on the batch detail stream. */
export type BatchEvent =
  | { type: 'url-updated'; urlCheck: UrlCheckDto }
  | { type: 'batch-updated'; batch: BatchSummary }
  | { type: 'heartbeat'; ts: string };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
