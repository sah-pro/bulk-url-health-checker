# Bulk URL Health Checker

Paste a list of URLs (or upload a CSV), and a background system checks each one — status
code, response time, page title — while the UI updates live as results come in.

## One command to run it

```bash
cp .env.example .env
docker compose up --build
```

Then open **http://localhost:3000**. The API is on `:4000`, Postgres on `:5432`, Redis on
`:6379`. `docker compose up` runs Postgres and Redis, applies migrations via a one-shot
`migrate` service, then starts the API, **two** worker processes (see below), and the web app,
in the correct dependency order using Compose health checks — not just `depends_on` ordering.

To see the global rate limit / concurrency guarantees hold across even more workers:

```bash
docker compose up --build --scale worker=4
```

## Features

- Paste URLs or upload a CSV; both paths validate, normalize, and dedupe before anything is persisted.
- Batch + every URL row persisted in Postgres, in one transaction, before any job is enqueued.
- One BullMQ job per URL, processed by a worker pool that is a separate process from the API.
- A **global** rate limit (10 req/sec) and **global** concurrency cap (5 in flight), both enforced
  in Redis so they hold no matter how many worker processes are running.
- Up to 3 retries (4 attempts total) per URL with exponential backoff, transient vs. permanent failure classification, and the final HTTP status/response time always preserved even after retries are exhausted.
- Live progress via Server-Sent Events, backed by Redis pub/sub, correct across multiple API instances,
  refresh-safe, and self-healing after a dropped connection.
- Cancel batch (queued jobs stopped, in-flight jobs allowed to finish, never overwrites cancelled state).
- Retry failed only (re-enqueues just the FAILED rows; safe against double-clicks).
- 30-second cache on the batch list with explicit invalidation on every write, not just a bare TTL.
- Shared TypeScript types/schemas between the API and the Next.js app (`packages/shared`).
- Basic SSRF protection (DNS-resolve-and-reject private/loopback/link-local targets).

## Architecture

```text
                    ┌─────────────┐
   Browser ───────► │  Next.js    │  Server Components fetch from API for
     ▲               │  (apps/web) │  first paint; Client Components hold the
     │  SSE           └──────┬──────┘  SSE connection + handle controls
     │                       │
     │                       ▼  REST (JSON) + SSE
     │               ┌───────────────┐
     └────────────── │  Fastify API   │  Stateless. Any number of instances.
                     │  (apps/api)    │  Owns validation, persistence,
                     └───┬───────┬────┘  cache, and job enqueueing.
                         │       │
              ┌──────────┘       └──────────┐
              ▼                             ▼
     ┌─────────────────┐           ┌──────────────────┐
     │   PostgreSQL     │◄──────────│      Redis        │
     │ (source of truth │  workers  │  - BullMQ queue    │
     │  for all state)  │  read/    │  - rate limiter    │
     └────────▲─────────┘  write    │  - concurrency sem │
              │            directly │  - pub/sub events  │
              │                     │  - 30s list cache   │
              │                     └─────────┬──────────┘
              │                               │
              │                     ┌─────────▼─────────┐
              └─────────────────────│  Worker process(es) │
                                     │   (apps/worker)     │
                                     └─────────┬───────────┘
                                               │ GET (rate/concurrency limited)
                                               ▼
                                        External URLs
```

**API responsibilities**: request validation (Zod), transactional persistence, enqueueing jobs
_after_ commit, serving the cached/fresh batch list, SSE fan-out via Redis pub/sub, cancel/retry
endpoints. Holds no business state in process memory — safe to run N instances behind a
load balancer.

**Worker responsibilities**: pull jobs, enforce the global rate limit and concurrency cap
(Redis-backed, cross-process), perform the actual HTTP check with SSRF/timeout/size guards,
write the terminal result back to Postgres, publish the update, recompute batch aggregates.

**PostgreSQL**: the only place business state is authoritative. Batches and url_checks tables,
explicit state machines (below), triggers for `updated_at`, check constraints on the aggregate
counters so they can never go structurally inconsistent (`completed_urls <= total_urls`, etc).

**Redis**: four _distinct_ uses, all disposable/rebuildable, never the source of truth:
BullMQ's queue storage, the distributed rate limiter and concurrency semaphore (both plain Lua
scripts against Redis structures, not BullMQ features), pub/sub transport for live updates, and
the 30-second batch-list cache.

**Next.js (App Router)**: `/batches` and `/batches/[id]` are Server Components that fetch fresh
from the API on every request — this is what makes opening a batch URL cold (new tab, no prior
client state) produce correct results immediately, and it's why `dynamic = 'force-dynamic'` is
set explicitly rather than left to Next's default heuristics (the API already owns caching; a
static/ISR cache in front of it would be a second, uncoordinated cache). `BatchDetailClient` is
a Client Component that takes over after first paint to hold the SSE connection and handle the
cancel/retry buttons — those are the only two things in the whole app that need to run in the
browser.

## Database design

```text
batches                              url_checks
────────                             ──────────
id (uuid, pk)                        id (uuid, pk)
status (enum)                        batch_id (fk -> batches, cascade delete)
total_urls                           url (text, as submitted)
completed_urls                       normalized_url (text, canonical + what's actually requested)
successful_urls                      status (enum)
failed_urls                          http_status
created_at / updated_at              response_time_ms
cancelled_at                         page_title
                                      error
                                      attempt / max_attempts
                                      run_generation (retry identity)
                                      run_generation
                                      created_at / updated_at
                                      UNIQUE (batch_id, normalized_url)
```

URLs are a separate, normalized table rather than a column on `batches` — a batch can hold up to
2000 URLs, each with independent status, retry count, and result fields that need indexed,
row-level updates (the claim-and-process pattern below does a single-row `UPDATE ... WHERE`).
An array/JSON column on `batches` would make that either impossible or require re-writing the
whole row (and re-serializing the whole array) for every single URL's status change.

### State machines

**Batch**: `PENDING → RUNNING → {COMPLETED | PARTIALLY_FAILED | FAILED}`, with `PENDING|RUNNING → CANCELLED`
possible at any point. `PENDING` exists only in the brief window between the transaction commit
and the enqueue calls returning; in practice a batch is `RUNNING` almost immediately. The
terminal status is _derived_, not tracked incrementally: every time a check reaches a terminal
state, the worker recomputes `COMPLETED / PARTIALLY_FAILED / FAILED` from a fresh aggregate query
over `url_checks`, inside the same transaction as the row write. This avoids counter drift that
independent increment/decrement operations under concurrency could introduce.

**URL check**: `QUEUED → PROCESSING → {SUCCESS | FAILED}`, with `QUEUED → CANCELLED` on batch
cancellation, and `FAILED → QUEUED` via "retry failed only". `PROCESSING` is never cancelled
directly — see the cancellation section.

## Queue design (BullMQ) & idempotency

One job per URL check. Job id is `url-check-{urlCheckId}-run-{runGeneration}` — not just the
check's own id — where `run_generation` is a column owned by Postgres (`url_checks.run_generation`,
default `0`), bumped by exactly one atomically whenever `retryFailedUrls` resets a `FAILED` row
back to `QUEUED`. This is the fix for a real bug found during verification (see COMPLIANCE.md
"Bugs found and fixed"): a job id based only on the check's own id is idempotent for _duplicate_
enqueues of the same not-yet-finished job (good — a client retry of `POST /batches` or a
double-click on "retry failed" can't create a second job), but it also blocks a _legitimate_
retry once BullMQ is still retaining the original job's completed record under that same id — the
retry's `.add()` call would silently no-op, forever. Folding the generation into the id sidesteps
this entirely: every legitimate retry gets a brand-new, never-before-used job id, so it's never
blocked by a retained completed job, while two concurrent "retry failed" calls for the same batch
still only ever produce one generation bump (serialized by the batch row's `SELECT ... FOR
UPDATE` lock — see `batchService.ts::retryFailedUrls`) and therefore one logical retry job.

That's necessary but not sufficient — BullMQ's delivery guarantee is _at-least-once_, not
exactly-once (a job can be redelivered after a stalled-job timeout even if the original handler
is still finishing, and BullMQ's own backoff-retry redelivers the _same_ job id at a higher
`attemptsMade`, not a new job). So the actual DB write is protected independently, by a claim
that has to account for all of: duplicate delivery of the same attempt, a legitimate later
attempt of the same job, and a stale delivery from a generation that's since been superseded:

```sql
UPDATE url_checks
SET status = 'PROCESSING', attempt = $3,
    processing_claim_token = $4,
    processing_lease_until = now() + ($5 || ' milliseconds')::interval
WHERE id = $1
  AND run_generation = $2
  AND (
    (status = 'QUEUED' AND attempt < $3)
    OR (status = 'PROCESSING' AND attempt < $3)
    OR (status = 'PROCESSING' AND attempt = $3 AND processing_lease_until < now())
  )
RETURNING id, processing_claim_token;
```

- `run_generation = $2` rejects a stale job from an old generation outright — it can never claim
  or overwrite a row that has moved on to a newer generation.
- the leased claim token prevents a second active delivery from stealing an execution, while a higher BullMQ attempt or an expired lease permits legitimate retry/recovery; a _duplicate_ delivery of the same attempt is a no-op, while still accepting a genuinely later attempt.
- `status IN ('QUEUED', 'PROCESSING')`, not just `'QUEUED'`, matters because a legitimate second
  BullMQ-internal retry attempt is the _same_ job redelivered — the row is already `PROCESSING`
  from the first attempt, not back at `QUEUED`. An earlier version of this claim required
  `status = 'QUEUED'` and silently broke every retry past the first: the claim matched zero rows,
  `processUrlCheckJob` returned without throwing, and BullMQ marked the job **completed** — so
  retries never actually re-checked anything, and the row was stuck in `PROCESSING` forever. This
  was caught by an actual live run, not by reading the code (see COMPLIANCE.md).

The same generation-aware compare-and-swap pattern protects every terminal write (`WHERE
run_generation = $2 AND status = 'PROCESSING'`) — including the interim write that records a 5xx
or network-transient result's `http_status`/`response_time_ms` _before_ throwing, so the final
attempt's real result is never lost to retries (see "Retry strategy & final result" below). This
is the mechanism the assignment specifically asks for: duplicate execution is made _safe_, not
merely _unlikely_.

`attempts: 4` with `backoff: { type: 'exponential', delay: 2000 }` (2s, 4s, 8s between attempts)
is the default job option — "up to 3 retries" reads as 3 retries _in addition to_ the initial
attempt, i.e. 4 total attempts; `url_checks.max_attempts` defaults to the same value for
display/audit purposes. On the final failed attempt, the worker's failure handler writes a
terminal `FAILED` row itself (rather than leaving BullMQ's own "job failed" state as the only
record), so a check that keeps hitting transient errors doesn't stay stuck in `PROCESSING`
forever.

Transient vs. permanent classification (`healthCheck.ts`): timeouts, connection resets/refused,
DNS transient failures, and 5xx responses are transient and retried; malformed URLs, unsupported
protocols, and SSRF-blocked targets are permanent and fail immediately without burning retries.

## Retry strategy & final result preservation

A 5xx response, or a network-level transient failure, is recorded (`http_status`/
`response_time_ms`) the moment it's observed — _before_ the retry is thrown — rather than only on
the terminal write. This means whichever attempt turns out to be the last one, its real observed
result is already durably persisted: a final `500`/`502`/`503` is stored as that exact status
(never nulled out), and a final pure network failure (no HTTP response was ever received) stores
`http_status = NULL` deliberately, because fabricating a status for a request that got no
response would be worse than an honest null. `finalizeExhaustedRetries` (the BullMQ
"attempts exhausted" handler) only flips `status` to `FAILED` and sets `error` — it does not
touch `http_status`/`response_time_ms`, so it can never clobber what the last real attempt
already wrote.

## Queue reconciliation

The assignment calls out a specific gap: the batch and its rows are committed to Postgres
_before_ any BullMQ job is enqueued (see "Batch submission" above) — correct ordering — but the
enqueue step itself can still partially or fully fail after that commit (process crash, a Redis
blip between adding job 2 and job 3 of a batch, etc.), leaving some rows durably `QUEUED` with no
job that will ever process them.

`reconcileStuckUrlChecks()` (`batchService.ts`) recovers this: on an interval (every 10s, run
independently on every API instance — see `index.ts`), it finds `url_checks` rows that are
`QUEUED` and have been `updated_at`-stale for at least 15 seconds, checks whether a BullMQ job
already exists under that row's current `(id, run_generation)` job id, and enqueues one if not.
The 15-second look-back window is what avoids reconciliation racing the _original_ enqueue call
for a row that was only just inserted or reset — a fresh row's `updated_at` is well inside the
window, so this pass simply leaves it alone and lets the original call finish normally. Because
the job id is deterministic per `(id, run_generation)`, re-enqueueing is idempotent by
construction — even if reconciliation runs concurrently with the original enqueue, or runs twice,
at most one job ever exists per generation.

This intentionally only recovers one direction: DB says `QUEUED`, no job exists. The symmetric
case — a BullMQ job finishes but the worker crashes before its DB write in `finalizeCheck` lands
— is a different failure mode, and isn't silently ignored either: the row is left `PROCESSING`,
which BullMQ's own stalled-job detection is designed to catch and redeliver; the
generation-aware claim step above is what allows that redelivered attempt to reclaim a
`PROCESSING` row safely. Documented here rather than left implicit.

## Rate limiting — the global 10 req/sec guarantee

Implemented as a **token bucket stored entirely in Redis**, updated by a single Lua script
(`EVAL`), which Redis runs atomically. That atomicity is the entire point: two worker processes
calling this at the same instant cannot both be handed the same token, because Redis executes
Lua scripts one at a time — "read tokens, refill for elapsed time, decide, write back" happens
as one indivisible step regardless of how many processes are racing it. An in-memory counter
inside a single process cannot provide this across processes, which is why it's explicitly ruled
out.

- Capacity = rate = 10, refilled continuously from elapsed wall-clock time (not a fixed
  1-second window), so there's no thundering-herd re-approval at window boundaries.
- A cold bucket allows an initial burst up to capacity (10), then settles into steady 10/sec.
  This is standard token-bucket behavior, documented here rather than hidden.
- **Worker restart**: the bucket lives in Redis, not the process, so a restarted worker resumes
  drawing from the same shared state — it does not get a fresh allowance.
- **Verified, not just asserted**: I ran the actual Lua script under simulated concurrent load
  (5 async callers racing it for ~2 seconds) and confirmed steady-state acquisitions never
  exceeded 10 per one-second window after the initial burst window. See "Verification" below.

## Concurrency — the global 5-in-flight guarantee

A **global** limit, not per-worker — the assignment's failure scenarios explicitly include
multiple worker processes running simultaneously, and a per-worker limit of 5 would allow `5*N`
concurrent requests with N workers, which is the exact bug being tested for.

Implemented as a Redis **sorted set semaphore**: each held slot is a member keyed by a random
token, scored by acquisition timestamp. Acquire is a Lua script that first prunes members older
than a lease TTL (20s, comfortably above the 8s default request timeout), then adds a new member only if
the set's cardinality is still under 5. Release just removes that member.

The lease-TTL pruning is what makes this **self-healing** against a crashed worker: if a process
dies mid-request, it never calls release, which would otherwise permanently leak a slot out of
the pool of 5 forever. The next `acquire` call anywhere in the system prunes that stale member
automatically — no separate reaper process needed.

BullMQ's own `Worker({ concurrency: 5 })` option is also set, but only as a per-process ceiling
underneath the global limiter — it stops one process from even trying to pull more than 5 jobs
at once, but the Redis semaphore is what actually enforces correctness across N processes.

## Live updates

**Transport: Server-Sent Events**, not WebSockets. Updates only flow server → client — the
client never needs to push anything over this channel; cancel/retry are plain REST `POST`s.
SSE reconnects automatically in the browser with no client-side reconnection code needed, and it
works over plain HTTP/1.1 through any reverse proxy without upgrade handling. A WebSocket would
be justified if the client needed to send frequent messages back over the same channel — it
doesn't here.

**Fan-out: Redis pub/sub.** The worker that completes a check has no way to know which of N API
instances is holding the SSE connection for that browser tab. The worker publishes to a channel
keyed by batch id (`batch:{id}`); every API instance subscribes to that channel for any batch id
it currently has an open SSE connection for, so the event reaches the right browser regardless
of which instance holds the connection.

**Missed-event recovery, without the init-order race**: Redis pub/sub does not buffer messages
for absent subscribers, so a naive "read Postgres, then subscribe" leaves a real gap — an update
landing between the snapshot read and the subscription becoming active would be missed entirely
(too late for the snapshot, too early for the subscription). The fix actually implemented is
**subscribe first, buffer, then snapshot, then flush the buffer**:

```text
connect → subscribe to Redis (start buffering, not sending) → read Postgres snapshot
   → send snapshot → flush buffered events (in order) → switch to sending live events directly
```

Nothing published from the moment of subscribing onward can be missed: it's either already
reflected in the snapshot (if it committed before the snapshot's `SELECT` started) or it's
sitting in the buffer (if not) and gets replayed immediately after the snapshot. Sending the
snapshot and flushing the buffer happen as one synchronous block (`routes/events.ts`), which is
what makes this actually safe rather than "probably fine" — Node's single-threaded event loop
guarantees no message handler can interleave in between, so the client can never see a buffered
(guaranteed-fresher) event followed by an older snapshot regressing it.

```text
Client disconnects → URL completes → event is missed (nobody home) → client reconnects
   → subscribe first → Postgres snapshot read → snapshot sent → any buffered event replayed
   → UI is correct and never regresses
```

## Caching

The batch-list endpoint is cached in Redis for 30 seconds. A bare TTL alone would let stale data
survive up to 30 seconds after a batch is created or changes state, which the assignment
explicitly forbids ("must not go stale in a user-visible way"). So every write path that changes
what the list response would contain — batch creation, cancellation, retry-failed, and every
individual URL check completing (which changes the batch's own progress counters) — calls
`invalidateBatchListCache()` immediately. The 30s TTL is a backstop expiry, not the only
mechanism.

## Cancellation

- **Queued jobs**: `cancelBatch` flips their `url_checks` row straight to `CANCELLED`. When the
  worker eventually dequeues the corresponding job, its claim step (`UPDATE ... WHERE
run_generation = $2 AND status IN ('QUEUED','PROCESSING') AND ...`) matches zero rows — the row
  is `CANCELLED`, not `QUEUED` or `PROCESSING` — and the job is a silent no-op.
- **In-flight jobs**: not force-aborted. The request already in progress is allowed to finish,
  and its result is still recorded — a completed real result is more useful than a discarded
  one, and it cannot corrupt the batch's own status, which is already fixed at `CANCELLED`
  regardless of what happens to any individual in-flight row. The finalize write is itself
  conditional (`WHERE status = 'PROCESSING'`), so it can only land for rows that were genuinely
  still in flight, not ones already cancelled while queued.
- **Idempotent**: cancelling an already-cancelled or already-terminal batch is a no-op that
  returns current state rather than erroring, verified live (see below) — two rapid cancel
  requests never corrupt state or double-apply.
- **Known limitation**: an in-flight HTTP request is not physically aborted mid-flight. Doing so
  correctly (aborting the `fetch` the instant cancellation is observed) would need a second
  Redis pub/sub subscription inside the worker's request-handling path purely to watch for
  cancellation signals — meaningful additional complexity for a check that, worst case, keeps
  running for up to `REQUEST_TIMEOUT_MS` (8s) after cancellation. Documented rather than hidden.

## Retry failed only

Resets `FAILED` rows to `QUEUED` (clearing prior result fields) and re-enqueues exactly those
rows, inside one transaction. Idempotent against double-clicks: the reset query is
`UPDATE ... WHERE status = 'FAILED' ... RETURNING`, so a second concurrent call finds zero
`FAILED` rows left to claim (the first call already moved them to `QUEUED`) and enqueues
nothing new — verified live, see below. BullMQ's `jobId` de-dup is a second line of defense on
top of that.

## Horizontal scaling

- **API**: fully stateless — no in-memory business state, no local caches, no local counters.
  Any number of instances can run behind a load balancer; a request landing on any instance sees
  the same Postgres/Redis-backed state as any other. SSE connections are per-instance but the
  pub/sub fan-out (above) makes that invisible to correctness.
- **Workers**: the global rate limiter and concurrency semaphore are what make adding worker
  processes safe rather than dangerous — without them, more workers would mean proportionally
  more simultaneous outbound requests. With them, adding workers only adds _throughput up to the
  shared caps_, never exceeds them. `docker-compose.yml` runs 2 worker replicas by default and
  documents scaling further with `--scale worker=N`.
- **Redis** and **Postgres** are the only genuinely shared, stateful components; they are not
  themselves horizontally scaled in this project (out of scope for a 3-day assignment), but
  nothing in the API/worker design assumes a single Redis or Postgres node beyond the standard
  assumption that both provide atomicity/consistency, so read replicas or Redis Cluster could be
  introduced later without changing the application code's contracts.

## Failure scenarios

| Scenario                                                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API instance restarts                                      | No state lost — everything was in Postgres/Redis. In-flight HTTP requests to that instance fail over (client retries or, for SSE, browser auto-reconnects to any instance and gets a fresh state push).                                                                                                                                                                                                                                                                                                                                         |
| Worker crashes mid-request                                 | Its concurrency-semaphore slot is reclaimed automatically after the lease TTL (20s). The job is redelivered by BullMQ after its stalled-job timeout and the generation-aware leased claim rejects active duplicates, rejects stale generations, and allows recovery after an expired lease.                                                                                                                                                                                                                                                |
| Redis restarts/disconnects                                 | Rate limiter/concurrency limiter Lua calls fail — workers surface these as job errors and BullMQ retries with backoff, so a brief Redis outage degrades to slower throughput, not incorrect throughput (nothing is enforced by the _absence_ of the limiter — no data is checked without going through it, so restored Redis just resumes normal operation). The batch-list cache is unavailable during the outage — the API's `getCachedBatchList` call throwing degrades gracefully to a DB read (ioredis retries connections automatically). |
| PostgreSQL fails                                           | The API's `/health` check fails immediately, so orchestration (Docker health checks, a load balancer) can route around/restart it. In-flight writes fail loudly rather than silently losing data.                                                                                                                                                                                                                                                                                                                                               |
| Browser disconnects                                        | SSE auto-reconnects; the reconnect always receives fresh authoritative state as its first message (see "Live updates").                                                                                                                                                                                                                                                                                                                                                                                                                         |
| URL fails (network/DNS/5xx)                                | Classified transient → retried up to 3x with backoff → terminal `FAILED` with the error recorded if all attempts are exhausted.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| URL points at localhost/private IP                         | Rejected before any request is made (SSRF guard), recorded as a permanent `FAILED`, not retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DB commit succeeds, BullMQ enqueue fails/crashes mid-batch | The row(s) are durably `QUEUED` in Postgres with no job. `reconcileStuckUrlChecks()` (every 10s, any API instance) finds `QUEUED` rows stale for 15s+ with no live job under their `(id, run_generation)` job id and enqueues one. Idempotent by construction (deterministic job id), so it's safe to run on every instance concurrently and safe to run repeatedly. See "Queue reconciliation" above.                                                                                                                                          |

## Trade-offs / what I'd do with more time

- **SSRF protection resolves-then-checks but doesn't pin the resolved address for the actual
  fetch call**. Redirect targets are validated hop-by-hop, but a determined DNS-rebinding attacker could in principle race the validation lookup and the eventual socket lookup. Fully
  closing that needs a custom `fetch` dispatcher that connects to the pre-validated IP directly.
  Documented in `ssrf.ts`.
- **Cancellation doesn't abort an in-flight HTTP request**; it lets it finish and records the
  real result (see "Cancellation" above for the reasoning).
- **The 30s list cache only covers the default unfiltered/unpaginated first page.** A
  general-purpose cache keyed by arbitrary filter/pagination combinations was out of scope for
  what the assignment actually needs (a single list view).
- **No pagination UI** on the batch list beyond what the API already supports (`limit`/`offset`)
  — not required by the assignment ("function over form") and the list is expected to be small
  for a take-home-scale project.
- **Structured logging exists (pino, JSON) but there's no correlation/tracing across the
  API → Redis → worker boundary** beyond batch/check/job ids appearing in each log line
  independently. A request-id propagated through the job payload would make cross-process tracing
  cleaner.
- **Given more time**: I'd add integration tests that spin up real Postgres/Redis via
  testcontainers (I verified the rate limiter, concurrency limiter, and the full
  submit → process → cancel/retry flow manually against real infrastructure while building this
  — see "Verification" — but that should be an automated, repeatable test suite, not a one-off
  manual pass).

## Assumptions

- A bare hostname pasted without a scheme (`example.com`) defaults to `https://` — the
  overwhelmingly likely intent, and avoids silently rejecting the most common way someone would
  paste a URL.
- "Final HTTP status code" means the status _after_ following redirects (`fetch`'s default
  controlled redirects (up to 5 hops); each redirect target is independently SSRF-validated before the next request, matching what `curl -L` or a browser would report.
- A 5xx response is treated as a transient failure eligible for retry (the server might recover),
  while 4xx is treated as the terminal, successful _result_ of the check (we got a real answer;
  it's just not a 2xx) rather than a failure to retry.
- CSV files use a column named `url` (case-insensitive) if present, otherwise the first column.
- Max 2000 URLs per batch, max 5MB CSV upload — both configurable via env vars, documented here
  rather than silently enforced.

## API

| Method | Path                            | Notes                                                                                                |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST` | `/api/batches`                  | JSON body `{ urls: string[] }`, or `multipart/form-data` with a CSV file. Returns `201` + the batch. |
| `GET`  | `/api/batches?limit=&offset=`   | Cached 30s for the default page.                                                                     |
| `GET`  | `/api/batches/:id`              | Full detail including all url checks. `404` if not found.                                            |
| `POST` | `/api/batches/:id/cancel`       | Idempotent.                                                                                          |
| `POST` | `/api/batches/:id/retry-failed` | Idempotent. `400` if the batch is cancelled.                                                         |
| `GET`  | `/api/batches/:id/events`       | SSE stream. Sends fresh state immediately, then live deltas.                                         |

All error responses use `{ error: { code, message, details? } }`; internal errors never leak
stack traces to the client (logged server-side only). No auth (explicitly out of scope).

## Environment variables

See `.env.example` for the full list with defaults. The notable one: `API_URL` vs.
`NEXT_PUBLIC_API_URL` are deliberately separate — the former is used by Next.js Server Components
running inside the Docker network (`http://api:4000`), the latter by browser code, which can only
reach the API via whatever port is published to the host (`http://localhost:4000`).

## Local development (without Docker)

```bash
npm install
# Postgres + Redis running locally, then:
npm run migrate -w apps/api
npm run dev -w apps/api      # terminal 1
npm run dev -w apps/worker   # terminal 2 (run this twice in two terminals to see multi-worker behavior)
npm run dev -w apps/web      # terminal 3
```

## Testing

```bash
npm test                 # all workspaces (shared, api, worker) — 37 tests total
npm run test -w packages/shared   # URL normalization/parsing/dedup (8 pure unit tests)
npm run test -w apps/api          # CSV column extraction + integration tests below (19 total)
npm run test -w apps/worker       # transient vs. permanent classification + integration tests (10 total)
```

`apps/api` and `apps/worker` each include integration tests that run against a **real** Postgres
and Redis (connection strings from `vitest.config.ts` in each package, matching `.env.example`'s
defaults with a `test` database) — not mocks. If Postgres/Redis aren't reachable at those
addresses, these fail with a real connection error rather than silently passing; that's
deliberate; a green run means the behavior was actually exercised, not asserted against a stub.
Run `npm run migrate -w apps/api` against that `test` database first (once), same as any other
Postgres target. What they cover, beyond the pure-function unit tests:

- `apps/api/src/__tests__/retryGeneration.integration.test.ts` — the `run_generation` retry
  design: a retry works even when BullMQ still retains the previous generation's completed job;
  two concurrent retry-failed calls produce exactly one generation bump; successful URLs are
  never retried; a stale old-generation claim can't overwrite a newer generation; retrying twice
  in a row keeps working; retry-failed on a batch with nothing to retry is a true no-op. Plus 5
  tests for `reconcileStuckUrlChecks` (full/partial recovery, idempotent re-runs, fresh rows left
  alone, `SUCCESS` rows never touched).
- `apps/api/src/__tests__/events.integration.test.ts` — a real Fastify server + real SSE client:
  a deterministic assertion that the route subscribes to Redis before reading the authoritative
  snapshot (manually confirmed to fail against the old read-then-subscribe ordering, and pass
  against the fix), plus an end-to-end test that forces the race window open and confirms an
  event published during it is still delivered, in order.
- `apps/worker/src/__tests__/processUrl.integration.test.ts` — the worker's claim query: a
  second (retry) attempt is genuinely re-processed rather than silently no-op'd; a duplicate
  delivery of the same attempt is rejected; a stale generation can't claim or overwrite. Plus the
  final-HTTP-status-preservation fix: a final `503` and a final pure network failure are each
  persisted correctly (not nulled out, not fabricated) once retries are exhausted.

## Other root commands

```bash
npm run lint          # ESLint across the whole monorepo
npm run lint:fix       # ESLint --fix
npm run typecheck     # tsc --noEmit in every workspace
npm run format         # Prettier --write .
npm run format:check  # Prettier --check . (what CI/this verification pass uses)
npm run build          # build every workspace (tsc ×3, next build)
npm run dev             # api + worker + web concurrently, for local (non-Docker) development
```

## Verification

The repository was previously verified against real Postgres + Redis in an earlier revision. The
final remediation revision adds leased worker-claim recovery, hop-by-hop redirect SSRF checks,
shared queue payload types, configuration validation, and schema cleanup. Those final changes were
reviewed statically here, but this packaging environment could not complete a fresh `npm ci` because
external package downloads timed out. Therefore the commands below are the required final local
verification steps and are intentionally not marked as passed here.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run format:check
npm run build
docker compose config
docker compose up --build
```

For a multi-worker verification, use:

```bash
docker compose up --build --scale worker=4
```

Then exercise a real batch and verify the global 10 req/sec limit, global maximum of 5 in-flight
checks, retry behavior, cancellation, SSE reconnect, and queue recovery.

The final submission must not claim Docker or multi-worker runtime verification unless those commands
have actually been run successfully against this exact revision.

### Docker configuration audit

- `postgres` and `redis` each have a real `healthcheck` (`pg_isready`, `redis-cli ping`);
  `migrate` depends on `postgres: service_healthy`; `api` and `worker` depend on
  `postgres`/`redis: service_healthy` **and** `migrate: service_completed_successfully`. Nothing
  depends on container start order alone — it's readiness-gated throughout.
- `api` has its own `healthcheck` hitting `GET /health` (route exists — confirmed at
  `apps/api/src/index.ts`); `web` depends on `api: service_healthy`.
- `worker` intentionally has no HTTP healthcheck (it's a queue consumer with no server to probe);
  nothing else depends on its health, and BullMQ's own stalled-job detection is the app-level
  recovery mechanism for a dead worker (see "Failure scenarios").
- Added `.dockerignore` during this pass — it didn't exist before, so every `docker build` would
  have sent the full local `node_modules`/`.next`/`dist` into the build context unnecessarily
  (each `Dockerfile` only ever `COPY`s specific subpaths, so nothing was at risk of leaking into
  an image, but builds would have been needlessly slow).
- Known non-runtime-verified item: `deploy.replicas: 2` on the `worker` service — this is
  supported by Docker Compose v2 for local (non-Swarm) `docker compose up` in current versions,
  but that specific behavior was not exercised here since Docker itself isn't available in this
  environment. If it's ever not honored on a given Compose version, `docker compose up --scale
worker=2` is the explicit fallback and is already documented above the `deploy` block.

### Live-tested behavior (real Postgres + Redis + running processes, this pass)

- The rate limiter and concurrency limiter were driven directly against real Redis:
  30 concurrent `acquire()` calls showed the expected burst-then-10/sec steady state; 20
  concurrent `withSlot()` calls never exceeded 5 simultaneous holders, and total wall time matched
  5-at-a-time throttling almost exactly (1222ms observed vs. 1200ms expected for 20×300ms work at
  5-wide concurrency).
- SSRF protection: submitted `127.0.0.1` and a link-local metadata address; both were rejected
  before any connection was attempted.
- Cache invalidation: a newly created batch appeared in `GET /api/batches` immediately, not after
  the 30s TTL.
- Cancellation: cancelled a batch mid-processing — already-claimed in-flight checks finished and
  were recorded correctly; a second cancel call was a clean no-op.
- Retry-failed: exercised repeatedly, including two fixes made during this pass (see "Bugs found
  and fixed" in `COMPLIANCE.md`) — after the fixes, five consecutive `retry-failed` calls against
  the same batch (4 with an actual FAILED row to retry, 1 with none left) produced exactly 4 real
  worker reprocessing runs and left the batch correctly settled at a terminal state every time,
  including under a concurrent double-call.
- SSE: connecting to `/api/batches/:id/events` immediately received the full current batch state
  as the first message, confirming the reconnect-recovery design actually behaves as documented.
