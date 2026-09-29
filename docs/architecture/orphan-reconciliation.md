# Orphan Object Reconciliation

> **Status:** As-built (2026-09-29). The `npm run reconcile:orphans` maintenance job — what an orphan object is, how to run the job, and how to read its report before deleting anything.

Cloudflare R2 and MongoDB are two independent systems, and a stored file lives in both: the bytes as an object in R2, the metadata as a row whose key field names that object. When the two drift, the residue is an **orphan** — an object in the bucket that no row claims. This job finds them, and on a separate, explicit pass deletes them.

Everything below is arranged around one rule: **scanning is free, deleting is irreversible.** The script deletes bucket objects directly, with the application's own credentials, and nothing restores them.

---

## 🏗️ What an Orphan Is

An orphan is an object under the `files/` or `profile-pictures/` prefix that neither a `File.objectKey` nor a `User.profilePictureKey` names.

An orphan is unreachable, not exposed. Every read path resolves its key from a document, and every key carries a 32-hex server-random nonce that is never handed out again once the row is gone — so an orphan has no confidentiality impact and no client can stumble onto one. The cost is Cloudflare storage billing, plus a permanent gap between what the bucket holds and what the denormalized `Directory` counters report.

### How orphans are created

| Source                                              | What happens                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A presigned `PUT` that lands after the expiry sweep | A presigned URL cannot be revoked, and R2 evaluates its expiry when the request is _authenticated_, not when the body finishes. The sweep (`settleExpiredPendingFiles`) looks up each expired reservation's object, sees nothing, deletes the row and refunds the bytes. The body can still land afterwards, and then nothing names it.   |
| A swallowed object delete                           | The object-removal helpers behind file delete, directory delete, the sweep, and profile-picture replace warn-log an R2 failure instead of rethrowing — the row is already gone and the database is the source of truth. The object stays behind.                                                                                          |
| A crash on the profile-picture path                 | `uploadProfilePicture` writes the object to R2 _before_ it writes the key onto the user row. A process death in between leaves an object with no row.                                                                                                                                                                                    |
| A sweep delete that is never retried                | The sweep removes objects best-effort and does not retry a rejected delete.                                                                                                                                                                                                                                                             |

Each of these is a narrow residue, not a routine outcome — the expected report is a small number of orphans, not a large one, which is what makes **Before `--apply`** below the part that matters.

---

## 🚧 Not in Scope

- **Incomplete multipart uploads.** A bucket lifecycle rule aborts them after one day, so the parts of an abandoned multipart upload are never this job's problem. The job looks only at the completed objects the listing returns.
- **Counters.** The job never writes to `Directory` or `User`. In every case above, the row was already deleted and its ancestors already refunded, so the counters are correct _relative to the rows_; only the bucket holds extra bytes. Adjusting them again would be a double refund, and would itself create the drift the job exists to remove.
- **Keys the job does not recognise.** A key matching neither the file nor the profile-picture key shape is counted as `unrecognized` and never deleted. Reporting beats guessing: the listing is the one R2 read that does not run keys through `assertKey`, so an unrecognised key is outside this job's remit by definition.

---

## 🛣️ Running the Job

The dry run is the default and deletes nothing. Deletion requires `--apply`.

```bash
npm run reconcile:orphans                      # dry run — reports, deletes nothing
npm run reconcile:orphans -- --apply           # delete what this run's scan found
npm run reconcile:orphans -- --max-ratio=0.95  # raise the safety limit for this one run
npm run reconcile:orphans -- --verbose         # list every candidate, not just the ten largest
```

The `--` is npm's argument separator and is required; without it the flags go to npm rather than to the script.

| Flag              | Effect                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_          | Scan and report. Nothing is deleted.                                                                                                                                                                                                                                               |
| `--apply`         | Scan, then delete the candidates that scan found. Still subject to the circuit breaker.                                                                                                                                                                                            |
| `--max-ratio=<n>` | Raise (or lower) the circuit-breaker limit for this run only. `n` is a plain decimal from `0` to `1`; the default is `0.2`. It must be joined with `=` and passed exactly once — a space-separated or repeated flag is rejected as a usage error, because guessing which number was meant is what deletes. |
| `--verbose`       | List every candidate key. Without it the report lists the ten largest and a count of the rest.                                                                                                                                                                                      |

Flags combine: `--apply --verbose --max-ratio=0.5` is one run.

`--apply` runs its own scan rather than reusing the dry run's. The two can differ — a reservation may have settled in between — and the breaker is always evaluated against the numbers the applying run itself observed.

### Exit codes

| Code | When                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | A dry run under the threshold, or an `--apply` run that deleted everything it found (including a run with nothing to reclaim).             |
| `1`  | A dry run whose ratio is over the threshold; a tripped breaker under `--apply`; per-key delete failures; a failed scan; a usage error.     |

A non-zero exit is how a scheduler learns the job needs a human. Per-key delete failures do not stop the remaining keys, and the job is idempotent — the next run re-finds whatever was missed.

---

## 🛡️ The Safety Model

Four guards, in the order they take effect:

1. **Dry run is the default.** A mistyped invocation reports; it does not delete. Deletion is a second, explicit decision, made after reading a report.

2. **An object younger than the longest possible live reservation is never a candidate.** The floor is `MAX_UPLOAD_RESERVATION_MS` — the presigned-URL TTL (five minutes) plus the one-hour ceiling on the transfer allowance, currently **1h 5m** — derived from the same constants as the upload-expiry formula in [`../file/file-upload.md`](../file/file-upload.md), so the two cannot drift apart. It is deliberately the _maximum_ that formula permits rather than a typical value: the ceiling is a transfer budget at a pessimistic 16,000 bytes per second, the slowest link the system refuses to kill, so an upload still streaming must never have its bytes deleted out from under it. An object whose age cannot be read at all is treated as too new and skipped.

3. **A row in any state owns its object.** The ownership query filters on the key and nothing else — no `status`, no `deletedAt`. A `pending` row legitimately owns its object before confirm, and a soft-deleted user's `profilePictureKey` still names a live object. Adding either filter would turn live data into deletion candidates; it is the single most dangerous change available to this job.

4. **A ratio circuit breaker.** When the candidates exceed a share of everything scanned — 20% by default — the reclaim step throws `ORPHAN_RATIO_EXCEEDED` and deletes nothing. The denominator is every key the listing returned, including unrecognised ones and those the age floor skipped. The breaker exists because the failure that matters is silent: `File.objectKey` is `select: false`, so a broken projection, a dropped database connection, or a misdirected connection string yields an empty owner set — and then _every aged object in the bucket_ looks orphaned. The age floor is no help there; old objects all pass it.

Two further properties hold by construction:

- **A partial scan never authorises a delete.** If the listing fails, or an ownership query throws, the run aborts with nothing deleted. A failed ownership query is never read as "no row owns these keys."
- **Deleting an orphan cannot race a live request.** Every read path resolves its key from a document, so an object no document names is unreachable. Whether the application is serving traffic or idle is irrelevant to this job's safety.

---

## 📊 Reading the Output

```
Database        <database>
Bucket          <bucket>
Scanned             2,431   objects across 2 prefixes (files, profile-pictures)
  unrecognized          0
  too new              18   (inside the 1h5m reservation floor)
  checked           2,413
    owned           2,386
    orphaned           27   (1.1% of scanned — under the 20% threshold)
Reclaimable       1.84 GB
Oldest            14 days   Newest   2 hours
  files/6510a1b2c3d4e5f60718293a-9f3c2e5d8b1a47f0c6d9e2b5a80f3c1d.pdf             412 MB   9 days
  … 26 more (--verbose to list all)

Dry run — nothing deleted. Re-run with --apply to reclaim.
```

The first two lines name the run's target: the database the ownership check asked, and the bucket the listing read. They are printed above the counts because no number below them can distinguish a misdirected database from a genuinely dirty bucket.

| Counter        | Meaning                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `Scanned`      | Every key the listing returned, across both prefixes.                                                      |
| `unrecognized` | Matched neither key shape. Never checked, never a candidate, never deleted.                                 |
| `too new`      | Recognised, but inside the reservation floor. Never checked against the database — a live upload may own it. |
| `checked`      | Recognised and old enough; actually diffed against the database.                                            |
| `owned`        | Of `checked`, how many a row claimed.                                                                       |
| `orphaned`     | Of `checked`, how many no row claimed. These are the candidates, and the numerator of the breaker's ratio.   |

Two invariants hold on every run; a report that breaks either is a bug, not a finding:

```
Scanned  ===  unrecognized + too new + checked
checked  ===  owned + orphaned
```

`Reclaimable` is the total size of the candidates. `Oldest` / `Newest` bracket their ages. The candidate list is largest-first, so a capped list still explains where the reclaimable bytes are; `--verbose` prints all of them. An `--apply` run replaces the closing line with a count of objects reclaimed, and lists any per-key delete failures beneath it.

Note what the counters can and cannot say. `too new` should be small and roughly proportional to upload traffic. `unrecognized` should be zero. `owned` is the one number that evidences that the database and the bucket belong together — and the run prints an explicit warning when `checked` is non-zero and `owned` is zero.

---

## ⚖️ Before `--apply`

**A tripped breaker is not a threshold to raise.** It has two causes, and from inside the process they are indistinguishable:

- **The bucket genuinely holds that many orphans.** Plausible on a development bucket, whose leftovers accumulate across runs against databases that no longer exist.
- **The job is pointed at the wrong pair.** The ownership check asks _one_ database whether it names these keys. A database that never owned this bucket — a stale connection string, a different cluster, a local instance, a dropped database — answers "no" for every key, and every aged object in the bucket becomes a candidate.

Both produce a high ratio, and the ratio cannot separate them. So the order of checks is:

1. **Read the `Database` and `Bucket` lines above the report.** Are they the pair you intended? This is the dangerous case and the cheapest one to rule out, so it goes first.
2. **Read `owned`.** Zero owners across a large `checked` is the signature of a database that does not own this bucket, and the run warns about it explicitly when it happens. A healthy run has `owned` accounting for nearly all of `checked`.
3. **Read the candidates** (`--verbose`). Their sizes and ages should look like the residue the sources above would leave — a small number of objects, aged in a way you can account for. A candidate list that reads like the whole bucket _is_ the whole bucket.
4. **Only then**, if the ratio is genuinely justified, raise `--max-ratio` — to the figure that verified scan actually warrants, for that one run.

`--max-ratio` authorises a cleanup you have already verified. It is not the remedy for a trip. Reaching for it because the job aborted, without first reading the two lines above the report, is precisely how a bucket gets emptied.

If any of the four checks leaves you unsure, re-run the dry run and do not pass `--apply`. Scanning costs a listing; a wrong `--apply` costs the bucket.

---

## ⏱️ Scheduling

There is no scheduler today — the application is not deployed, and no cron, queue, or scheduler dependency is installed. The job is run by hand.

At deploy time the same script attaches to whatever the platform offers, with no code change: a platform cron job, a system crontab entry, or a scheduled GitHub Actions workflow. Two things are worth settling at that point:

- **Schedule the dry run first.** It exits non-zero when the ratio is over the threshold, which is exactly the condition a scheduled report exists to surface, and it deletes nothing while the numbers are still being learned.
- **Give it credentials, not a config file.** The script loads the same validated environment as the application and fails fast on a missing variable, so a scheduled run needs the same `MONGODB_URI` and R2 variables the server needs, and nothing more.

---

## ⚠️ One Overlap to Avoid

Do not run the reconciler while a profile-picture key-format migration (open issue #110) is in flight. A migration copies an object to its new key and then updates the row; in the window between the two, the new object is an object no row names — an orphan by this job's definition. The age floor covers a migration that updates rows promptly, but the two should not be allowed to overlap.

---

## 🧱 Where the Code Lives

| File                                | Role                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/reconcile-orphans.js`      | Argument parsing, the connection lifecycle, output formatting, exit code. No business logic and no queries.                                                                                                                                              |
| `src/services/reconcile.service.js` | `scanForOrphans()` — the paginated listing, the age floor, the ownership diff, the counters. `reclaimOrphans()` — the circuit breaker, then the delete.                                                                                                  |
| `src/lib/r2.js`                     | `listObjects` (paginated by continuation token) and `deleteObjects`, which validates every key before issuing any request and batches at 1,000 keys per request. A per-key failure is returned to the caller, never thrown away.                          |
| `src/services/file.service.js`      | `MAX_UPLOAD_RESERVATION_MS`, the age floor, exported from where the upload-expiry formula is defined.                                                                                                                                                    |
| `src/constants/appErrorCode.js`     | `ORPHAN_RATIO_EXCEEDED` — see [`../api/error-codes.md`](../api/error-codes.md).                                                                                                                                                                          |

The logic sits in the service rather than the script so that it is testable without spawning a process, and so that a future admin endpoint reuses it by adding a controller alone — breaker included, rather than reimplemented.
