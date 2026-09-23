# File Upload Architecture

> Status: As-built (2026-09-23)

This document outlines the architecture, data flow, and security mechanisms behind the Trove backend's File upload system.

Uploads go **from the browser straight to Cloudflare R2**. The server never handles the file bytes on this path — it authorises the upload, reserves the quota, and afterwards verifies that what landed matches what it approved. The one exception is Google Drive import, where the bytes necessarily arrive at the server first; that path is documented separately below.

## 🏗️ Architecture

The File upload logic adheres to the Controller-Service pattern, with authentication and validation enforced at the router level before any handler executes.

- **Authentication (`src/middlewares/auth.middleware.js`)**: Applied router-wide via `fileRouter.use(authenticate)`. Every file endpoint requires a valid session — unauthenticated requests are rejected before reaching any controller.
- **Middleware (`src/middlewares/validate.middleware.js`)**: `validateId` is registered via `router.param()` on both `id` and `parentDirId`. `validateBody(initiateUploadSchema)` validates and sanitises the request body before the controller runs.
- **Controller (`src/controllers/file.controller.js`)**: Extracts route parameters and body fields, delegates to the Service layer. Contains zero business logic or database access.
- **Service (`src/services/file.service.js`)**: Verifies parent-directory ownership, generates the object key, enforces the quota inside a transaction, presigns the upload URL, later verifies the stored object before promoting the file, and on cancel shortens the reservation window instead of refunding it.
- **R2 library (`src/lib/r2.js`)**: Owns the S3 client, the legal key shapes, and the presign helpers. No other module talks to Cloudflare directly.

---

## 🔄 The Upload Lifecycle

An upload is three steps, and the file exists as a database row for all of them:

```
1. INITIATE   POST /api/files{/:parentDirId}   → reserve quota, create a `pending` row, return a presigned PUT
2. TRANSFER   PUT <uploadUrl>                  → browser sends the bytes directly to Cloudflare
3. CONFIRM    POST /api/files/:id/confirm      → verify the stored object, promote the row to `ready`
```

The row is created at step 1, not step 3. That is what makes the quota enforceable: the bytes are counted against the user the moment the upload is authorised, before they exist.

A fourth endpoint sits off to the side of that line. `POST /api/files/:id/cancel` is for the upload the user walks away from: it closes the reservation window early, but it does **not** refund the bytes and does **not** touch the stored object — see [Cancelling an upload](#4-cancel-an-upload).

---

## 🛣️ API Endpoints

### 1. Initiate an Upload

- **Route:** `POST /api/files{/:parentDirId}`
- **Params:** `parentDirId` (optional) — MongoDB ObjectId of the target parent directory
- **Body:** `{ name, size }` — the filename including a simple extension, and the exact byte length
- **Authentication:** Required (session-based)
- **Flow:**
  1. `authenticate` populates `req.user`; `validateId` confirms `parentDirId` is a well-formed ObjectId when present.
  2. `validateBody(initiateUploadSchema)` sanitises `name` and type-checks `size`.
  3. **Edge case handled:** if `parentDirId` is omitted, the controller falls back to `req.user.rootDirId` — the user's permanent root directory created during registration.
  4. Calls `initiateUpload(parentDirId, userId, name, size, req.user.storageLimit)`.
  5. Returns `201 Created` with the presigned URL and both expiry timestamps.

- **Service Logic (`initiateUpload`):**
  1. Rejects a `size` that is not a positive integer (`INVALID_INPUT`), or that exceeds the per-file cap (`FILE_TOO_LARGE`).
  2. `validateAndBuildNewFile` verifies the parent directory belongs to the user (`DIRECTORY_NOT_FOUND` otherwise), extracts and validates the extension, mints a fresh `_id`, derives the `contentType` from the extension, and generates the object key.
  3. Computes `uploadExpiresAt` — the presign TTL **plus** an allowance for the transfer itself, derived from the declared size at a deliberately pessimistic floor rate and clamped between fifteen minutes and one hour. The reservation must outlive the URL, or a slow but legitimate upload could have its bytes reclaimed mid-transfer.
  4. **Inside a transaction:** enforces the per-user quota via `checkQuota`, creates the `File` row with `status: "pending"`, and calls `updateAncestorDirectoryStats(parentDirId, { bytes, files: 1 })` so the reserved bytes immediately count toward every ancestor folder's denormalized totals.
  5. **Outside the transaction:** presigns the `PUT`, pinning **both** `Content-Length` and `Content-Type` into the signature. If presigning fails, the reservation is released and `FILE_UPLOAD_FAILED` is thrown — the row must not survive a URL that was never handed out.

- **Response:**
  ```json
  {
    "success": true,
    "message": "Upload initiated successfully",
    "data": {
      "fileId": "...",
      "uploadUrl": "https://....r2.cloudflarestorage.com/...",
      "contentType": "application/pdf",
      "expiresAt": "...",
      "uploadExpiresAt": "..."
    }
  }
  ```

  `expiresAt` is when the URL stops working; `uploadExpiresAt` is when the reservation lapses. As minted the second is always later than the first, and it is the client's real budget for finishing the transfer. Cancelling the upload is the one thing that pulls it back to the first.

### 2. Transfer the Bytes

The client `PUT`s the file to `uploadUrl` with exactly the `Content-Type` returned above and a `Content-Length` equal to the declared size. Both headers are part of the SigV4 signature, so Cloudflare rejects any mismatch with `403` before a byte is stored. No session cookie or `Authorization` header is sent — the signed URL *is* the authorisation, and an unsigned extra header invalidates the signature.

### 3. Confirm the Upload

- **Route:** `POST /api/files/:id/confirm`
- **Body:** none
- **Authentication:** Required (session-based)
- **Service Logic (`confirmUpload`):**
  1. Loads the file with `.select("+objectKey")` — the key is `select: false`, so a read that needs it must say so.
  2. Issues a `HeadObject` against the stored key and compares the reported size **and** content type against what was reserved.
  3. If the row is already `ready`: returns it when the object still matches (confirm is **idempotent** and safe to retry), otherwise throws `UPLOAD_ALREADY_CONFIRMED`.
  4. No object at the key ⇒ `UPLOAD_INCOMPLETE`. A mismatch ⇒ `UPLOAD_OBJECT_MISMATCH`.
  5. Otherwise a single-document compare-and-set flips `status` to `ready` and unsets `uploadExpiresAt`. The filter also requires `cancelledAt: { $exists: false }`, so a cancel that landed between the read above and this write cannot be promoted away. A single-document update is already atomic, so this needs no transaction.
  6. If that compare-and-set matches nothing, the row is re-read: a `cancelledAt` on it ⇒ `UPLOAD_CANCELLED` (409). The object behind a cancelled row belongs to the sweep, which is the only path that can promote it while keeping its bytes counted.
  7. The object key never travels back in the response.

### 4. Cancel an Upload

- **Route:** `POST /api/files/:id/cancel`
- **Body:** none
- **Authentication:** Required (session-based). Rate-limited with the `mutation` tier rather than `destructive`, because a bulk upload that the user abandons cancels once per file.
- **Service Logic (`cancelUpload`):**
  1. Loads the file with `File.findOne({ _id, userId })`. Nothing matched ⇒ `FILE_NOT_FOUND` (404), whether the file is absent or belongs to another user. The two are deliberately indistinguishable, so cancel cannot be used to probe for someone else's file ids. The object key is never selected, because cancel has no use for it.
  2. A row that is not `pending` ⇒ `UPLOAD_ALREADY_CONFIRMED` (400). This is the lookup's job rather than the compare-and-set's: a single scoped update cannot tell "no such file" from "already finished", and the two deserve different answers.
  3. Computes the shortened deadline — `createdAt + UPLOAD_URL_TTL_SECONDS + ONE_MINUTE_MS`, roughly six minutes. The margin is not padding; see [Why the shortened deadline is not just the presign TTL](#why-the-shortened-deadline-is-not-just-the-presign-ttl).
  4. A compare-and-set scoped to `{ _id, userId, status: "pending" }` applies `$min` to `uploadExpiresAt` **and** sets `cancelledAt`, in one atomic update. `$min` only ever moves the deadline earlier, so a repeated or late cancel cannot extend a reservation; `cancelledAt` is what stops a late `confirmUpload` promoting the row out from under the cancel.
  5. The compare-and-set matching nothing means `confirmUpload` won the race in between ⇒ `UPLOAD_ALREADY_CONFIRMED` (400) again, and the same message.
  6. Returns the updated row. **Nothing else happens.** The row is kept, the bytes stay counted, and the stored object is left exactly where it is — see [Why cancel does not refund](#why-cancel-does-not-refund) and [Why cancel does not delete the object](#why-cancel-does-not-delete-the-object).

- **Response:**
  ```json
  {
    "success": true,
    "message": "Upload cancelled successfully",
    "data": {
      "_id": "...",
      "name": "report.pdf",
      "extension": ".pdf",
      "contentType": "application/pdf",
      "size": 2457600,
      "parentDirId": "...",
      "userId": "...",
      "status": "pending",
      "uploadExpiresAt": "...",
      "cancelledAt": "...",
      "createdAt": "...",
      "updatedAt": "...",
      "__v": 0
    }
  }
  ```

  A **success** response carrying `"status": "pending"` and a still-live `uploadExpiresAt` is the point, not a leak: it is the client's proof that the row survived and its bytes are still counted against the quota. The deadline in it is the shortened one, so a client that wants to show the user when the space comes back can read it straight off the response.

The sweep settles the row once that deadline passes — refunding the bytes and dropping the object if the bytes never landed, promoting the row if they did — so the quota returns in roughly six minutes rather than the twenty to sixty-five minutes a lapsed reservation otherwise runs to.

#### Why cancel does not delete the object

Cancel commits a deadline that may already be in the past: a client that gives up six minutes after starting gets a `$min` that lands behind `now`. The row is therefore sweep-eligible the instant the update commits, and a sweep running in that gap will `HEAD` the object, find the bytes there, and promote the row to `ready`.

If cancel deleted the object after winning its compare-and-set, it would be deleting the object out from under that promotion — leaving a `ready`, quota-counted, listable file with nothing behind it. Handing the whole object lifecycle to the sweep removes the race by construction rather than by timing: exactly one path decides whether an object is garbage, and it decides by looking.

#### Why the shortened deadline is not just the presign TTL

The extra `ONE_MINUTE_MS` of margin is there because `createdAt + UPLOAD_URL_TTL_SECONDS` is **not** when the URL dies. Two gaps push the real death later:

- `createdAt` is stamped inside the reservation transaction, but `presignPut` runs after that transaction commits — so the URL's clock starts after the row's.
- A presigned PUT is authorised when its request is signed, not when its body finishes. Bytes can still be landing after the TTL has technically elapsed.

Refund the reservation inside either gap and a client gets storage that nothing counts. The margin keeps the refund strictly behind the last moment a PUT can still be streaming, which is the same reason the reservation outlives the URL in the first place.

#### A cancelled row can still become a file

`cancelledAt` blocks the **live** `confirmUpload` call. It deliberately does not block sweep promotion: because cancel leaves the object alone, a `PUT` that completed anyway still has its bytes in storage when the sweep looks, and the sweep promotes the row rather than refunding it — refunding bytes that are sitting in storage is exactly the bypass this design exists to prevent.

The visible consequence is worth stating plainly: a confirm that loses the race to a cancel gets a `409 UPLOAD_CANCELLED`, and yet that same file may later appear as `ready`. That is intended, not a glitch — the alternative is either losing the user's bytes or giving away untracked storage.

`DELETE /api/files/:id` is a different endpoint and is unchanged by this: it still refuses a live reservation with `409 UPLOAD_IN_PROGRESS`. Cancel is how a client closes that window; delete is how it removes a file that already exists.

---

## 📏 Per-File Size Cap

`MAX_FILE_UPLOAD_SIZE` is read from the environment through `getNumberEnv` in `src/constants/env.js` (currently 100 MB, decimal). Because it is environment-driven, no client should mirror the number — surface the `FILE_TOO_LARGE` message instead.

On the browser path the cap is enforced twice, and the second time is the one that counts: `initiateUpload` rejects an over-cap **declared** size, and the signed `Content-Length` then bounds what can actually be stored. A client that declares a small size and uploads a large one is refused by Cloudflare, not by us.

On the server-side path (Drive import) there is no signature to lean on, so the cap is enforced mid-stream by `createByteCounter(perFileCap, remainingBudget)` from `src/utils/byteCounter.js`, which aborts the pipeline the moment cumulative bytes exceed the cap.

---

## 💾 Per-User Storage Quota

Each user has a total storage quota (`User.storageLimit`, defaulting to the environment-driven `DEFAULT_STORAGE_LIMIT`). It is enforced by the shared `checkQuota` helper, inside the transaction that writes the bytes into the ancestor counters — the reserving transaction on the browser path, the promoting one on the server-side path. The service reads the user's denormalized root-directory `size` and rejects with `STORAGE_LIMIT_EXCEEDED` (400) when the new bytes would exceed the limit. Because the quota read shares the root document that `updateAncestorDirectoryStats` `$inc`s, two concurrent uploads write-conflict on it and `withTransaction` retries the loser against the fresh size — the cap holds without an explicit lock.

The limit is passed in from `req.user.storageLimit`; the service never re-queries it. A non-numeric or absent limit **fails closed**, but as its own error: `checkQuota` raises `INVALID_STORAGE_LIMIT` (500) before it reads anything, rather than borrowing the quota rejection. The distinction is load-bearing, because a quota rejection is what buys a sweep — reporting a configuration fault as one would make every upload attempt drive a destructive cleanup. Google Drive import declares its exemption explicitly by passing `Number.POSITIVE_INFINITY`, which is a valid limit rather than a missing one.

The quota and its per-category usage breakdown are surfaced to the frontend via `GET /api/storage/usage` — see `../architecture/storage-quota.md`.

> **Note:** Google Drive imports do not yet count against this quota (tracked as GitHub issue #65).

### Why confirm never releases a reservation

A presigned URL cannot be revoked. Once it has been handed out, anyone holding it can store an object at that key until it expires. So the document that tracks the upload must outlive the URL — if confirm refunded the bytes on a failed check, a client could mint, deliberately fail confirm to get its quota back, then complete the held PUT anyway, repeating until the bucket filled. Every failure path therefore leaves the reservation in place and lets it expire on its own schedule.

### Why cancel does not refund

Cancel obeys the same constraint from the other end. A client that could mint a reservation and hand the bytes straight back would have an unlimited-storage bypass: mint, cancel, then complete the `PUT` with the URL it still holds — the object lands, nothing counts it, repeat. So cancel does one thing only: it shortens the window, and leaves the bookkeeping to the sweep.

The consequence is deliberate: a client that cancels and then completes the `PUT` inside the remaining window is **promoted**, not punished. The promotion comes from the sweep rather than from confirm — a cancelled row carries `cancelledAt`, which `confirmUpload` refuses — but the outcome is the one that matters: the object is there, so the row becomes `ready` and the bytes stay counted. That is the same path that already serves an honest user whose confirm failed on a flaky connection.

### Settling lapsed reservations

`releaseExpiredFiles(userId)` closes out that user's `pending` rows whose `uploadExpiresAt` has passed, and it **decides by the object, not by the deadline**. A lapsed deadline says the client stopped talking to us; it does not say whether the bytes arrived. So each expired row is looked up in storage first, and only then is its fate decided:

`classifyExpiredObjects` asks storage about every expired row and returns a map of three verdicts, and `promoteOrRefundExpiredFiles` acts on each:

- **present** — the object exists and matches the row's `size` and `contentType` ⇒ the row is **promoted** to `ready`, clearing `uploadExpiresAt` and `cancelledAt`. The ancestor counters are left alone, because those bytes were counted at mint and the file is now real.
- **absent** — the object is missing or does not match ⇒ the row is deleted, its bytes and file count subtracted from the ancestor chain, and the row returned so its object can be dropped afterwards.
- **unknown** — the lookup itself failed ⇒ the row is **skipped entirely**, neither promoted nor refunded, and left for the next sweep.

Only deleted rows come back from the sweep. A promoted row's object is a file the user now has, so dropping it would be destroying their data.

Six details carry the design:

- **It runs on rejection, not on arrival.** Both `initiateUpload` and `uploadFileFromServer` open their quota-checked transaction first; only a `STORAGE_LIMIT_EXCEEDED` triggers the sweep, and only if the sweep actually freed rows is that transaction retried — exactly once, after which the real error stands. A user with headroom pays nothing on the upload path at all; a genuinely full user pays one indexed query.
- **The storage lookups happen outside the transaction.** `classifyExpiredObjects` `HEAD`s the expired rows first and hands the transaction a finished map, so the transaction never waits on the network. A round trip per row inside it would spend its time limit on latency. The fan-out is a flat `Promise.all` bounded by the feeding query's `.limit(MAX_EXPIRED_FILES_PER_SWEEP)`, so at most 25 lookups are ever in flight; each row's failure resolves to its own verdict rather than rejecting the batch.
- **A lookup that fails proves nothing, so its row is left alone.** `getObjectMetadata` returns `null` for a genuine 404, so a *throw* means a real fault — an R2 5xx, a reset connection, a request past its timeout — not an absent object. Skipping is strictly safer than either alternative: the bytes stay reserved, so there is no bypass, and the object survives, so there is no data loss. Refunding on a failed lookup would let one R2 brownout destroy every completed-but-unconfirmed upload in the batch.
- **The caller's own in-flight row is spared.** `releaseExpiredFiles(userId, excludedFileId)` adds `_id: { $ne: excludedFileId }` when given an id. `uploadFileFromServer` passes its own `fileId`, because a server-side transfer can outlive its own one-hour claim and would otherwise sweep the row for the object it is still writing. `initiateUpload` passes nothing, deliberately: the sweep runs between its two reservation attempts, and the first attempt's transaction aborted, so no row with that id exists to protect.
- **Its own transaction, committed before the retry opens one.** The refund never shares a transaction with the reservation it is meant to unblock, so the quota check that rejected the first attempt cannot roll the refund back along with itself. Both branches are re-scoped to `{ _id, userId, status: "pending" }`, so a row another request has already settled is skipped rather than acted on twice.
- **Capped at `MAX_EXPIRED_FILES_PER_SWEEP` (25) per call.** A user with a backlog drains it across several rejected uploads instead of paying for the whole sweep on one request. If the sweep aborts, the returned list is discarded rather than acted on — deleting an object for a row the rollback restored would leave a live document naming a key with nothing behind it.

Cancel is what makes this timely for the case users actually notice. Left alone, a reservation runs to a deadline between twenty and sixty-five minutes out; cancelled, it lapses about six minutes after the row was created, so the next upload that hits the quota can settle it.

Objects that no document names at all — the residue of a failure between writing the object and keeping the row that names it — are not reclaimed here. Finding them is a whole-bucket scan rather than a per-user query, so it cannot ride on a request; a trigger for it is tracked separately.

`deleteFile` follows the same rule from the other direction: its refund is guarded on `deletedCount === 1`, so a delete that races another delete of the same file returns cleanly without decrementing the ancestor chain a second time.

---

## 🌐 Server-Side Uploads

`uploadFileFromServer(parentDirId, userId, fileName, fileStream, totalStorageLimit, perFileCap)` covers the cases where the bytes reach the server first and a presigned PUT is therefore not an option — today that is Google Drive import. It shares `validateAndBuildNewFile` and `checkQuota` with the browser path so the two cannot drift apart.

The row still comes first here too. A `pending` row carrying the final `objectKey` and `size: 0` is committed **before** anything is written to R2, so an object can never exist that no document names. The stream then runs through a byte counter into `putObject`, and a second transaction enforces the quota against the counted size and flips the row to `ready`. The claim reserves a file slot rather than bytes — the real size is unknown until the stream ends — so every failure path after it refunds nothing but that slot and deletes the object. There is no client-driven confirm step, because there is no untrusted client in the middle.

See `../architecture/drive-import.md` for how the import path uses it.

---

## 🚀 Performance & Scalability Considerations

### The server never sees the bytes

On the browser path the file travels from the user's machine to Cloudflare and never transits our process. Upload throughput is therefore bounded by Cloudflare rather than by our host, memory use is constant regardless of file size, and a large upload cannot occupy a Node worker for its duration.

### Reserve first, verify after

The alternative — write the row after the upload succeeds — cannot enforce a quota, because the server has no way to know how many bytes are in flight. Reserving at mint makes the quota exact at the cost of holding bytes for uploads that never complete, which is the trade this design accepts.

### Stored keys, never rebuilt

`File.objectKey` is generated once and read thereafter. Rebuilding a key from an id plus an extension at read time is how a mint key and a delete key drift apart, and it makes every read site a place where a malformed value turns into a 500.

---

## 🛡️ Security Mechanisms

### Unguessable object keys

Keys have the shape `files/<fileId>-<32 hex nonce><extension>`. The nonce is the access control: without it, knowing another user's file id would be enough to construct their object key. `objectKey` is `select: false` at the schema level, so it is omitted from every query that does not explicitly ask for it and cannot leak into an API response by accident.

### The signature is the size bound

Pinning `Content-Length` into the presigned PUT is what makes the reservation meaningful. Omitting it does not fail — it silently drops the header from the signature and mints an **unbounded** upload URL, so `presignPut` requires both length and type rather than defaulting them.

### Content-type verification at confirm

`confirmUpload` compares the stored object's content type as well as its size. Cloudflare folds every `x-amz-*` header into the signature, so a copy-source header cannot be smuggled onto a presigned PUT in the first place; the type check is defence in depth behind that.

### Parent directory ownership verification

Before reserving anything, the service verifies that the parent directory belongs to the authenticated user. This prevents users from injecting files into another user's directory by guessing a `parentDirId`.

### Schema-level validation

The File model enforces `minlength: 3` on `name`, a strict pattern on `extension` and `objectKey`, `required: true` on all fields, and `strict: "throw"` to reject any fields not defined in the schema.

---
