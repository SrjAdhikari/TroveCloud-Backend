# File Upload Architecture

> Status: As-built (2026-09-10)

This document outlines the architecture, data flow, and security mechanisms behind the Trove backend's File upload system.

Uploads go **from the browser straight to Cloudflare R2**. The server never handles the file bytes on this path — it authorises the upload, reserves the quota, and afterwards verifies that what landed matches what it approved. The one exception is Google Drive import, where the bytes necessarily arrive at the server first; that path is documented separately below.

## 🏗️ Architecture

The File upload logic adheres to the Controller-Service pattern, with authentication and validation enforced at the router level before any handler executes.

- **Authentication (`src/middlewares/auth.middleware.js`)**: Applied router-wide via `fileRouter.use(authenticate)`. Every file endpoint requires a valid session — unauthenticated requests are rejected before reaching any controller.
- **Middleware (`src/middlewares/validate.middleware.js`)**: `validateId` is registered via `router.param()` on both `id` and `parentDirId`. `validateBody(initiateUploadSchema)` validates and sanitises the request body before the controller runs.
- **Controller (`src/controllers/file.controller.js`)**: Extracts route parameters and body fields, delegates to the Service layer. Contains zero business logic or database access.
- **Service (`src/services/file.service.js`)**: Verifies parent-directory ownership, generates the object key, enforces the quota inside a transaction, presigns the upload URL, and later verifies the stored object before promoting the file.
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

  `expiresAt` is when the URL stops working; `uploadExpiresAt` is when the reservation lapses. The second is always later than the first, and it is the client's real budget for finishing the transfer.

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
  5. Otherwise a single-document compare-and-set flips `status` to `ready` and unsets `uploadExpiresAt`. A single-document update is already atomic, so this needs no transaction.
  6. The object key never travels back in the response.

---

## 📏 Per-File Size Cap

`MAX_FILE_UPLOAD_SIZE` is read from the environment through `getNumberEnv` in `src/constants/env.js` (currently 100 MB, decimal). Because it is environment-driven, no client should mirror the number — surface the `FILE_TOO_LARGE` message instead.

On the browser path the cap is enforced twice, and the second time is the one that counts: `initiateUpload` rejects an over-cap **declared** size, and the signed `Content-Length` then bounds what can actually be stored. A client that declares a small size and uploads a large one is refused by Cloudflare, not by us.

On the server-side path (Drive import) there is no signature to lean on, so the cap is enforced mid-stream by `createByteCounter(perFileCap, remainingBudget)` from `src/utils/byteCounter.js`, which aborts the pipeline the moment cumulative bytes exceed the cap.

---

## 💾 Per-User Storage Quota

Each user has a total storage quota (`User.storageLimit`, defaulting to the environment-driven `DEFAULT_STORAGE_LIMIT`). It is enforced by the shared `checkQuota` helper, inside the transaction that writes the bytes into the ancestor counters — the reserving transaction on the browser path, the promoting one on the server-side path. The service reads the user's denormalized root-directory `size` and rejects with `STORAGE_LIMIT_EXCEEDED` (400) when the new bytes would exceed the limit. Because the quota read shares the root document that `updateAncestorDirectoryStats` `$inc`s, two concurrent uploads write-conflict on it and `withTransaction` retries the loser against the fresh size — the cap holds without an explicit lock.

The limit is passed in from `req.user.storageLimit`; the service never re-queries it. A non-numeric or absent limit **fails closed** rather than silently disabling the quota. Google Drive import declares its exemption explicitly by passing `Number.POSITIVE_INFINITY`.

The quota and its per-category usage breakdown are surfaced to the frontend via `GET /api/storage/usage` — see `../architecture/storage-quota.md`.

> **Note:** Google Drive imports do not yet count against this quota (tracked as GitHub issue #65).

### Why confirm never releases a reservation

A presigned URL cannot be revoked. Once it has been handed out, anyone holding it can store an object at that key until it expires. So the document that tracks the upload must outlive the URL — if confirm refunded the bytes on a failed check, a client could mint, deliberately fail confirm to get its quota back, then complete the held PUT anyway, repeating until the bucket filled. Every failure path therefore leaves the reservation in place and lets it expire on its own schedule.

### Reclaiming abandoned reservations

Bytes reserved for an upload that never completes are refunded opportunistically, at the start of the next upload the same user starts. `releaseExpiredFiles(userId)` runs first in **both** `initiateUpload` and `uploadFileFromServer`: it deletes that user's `pending` rows whose `uploadExpiresAt` has already passed, subtracts their bytes and file counts from the ancestor chain, and returns the deleted rows so their R2 objects can be dropped afterwards.

Three details carry the design:

- **Its own transaction, committed before the mint's transaction opens.** The refund lands before `checkQuota` reads the root directory's `size`, so the caller sees the reclaimed headroom on *this* request rather than the next one — and a quota check that rejects the new upload cannot roll the refund back along with it.
- **Capped at `MAX_EXPIRED_FILES_PER_SWEEP` (25) per call.** A user with a backlog drains it across several uploads instead of paying for the whole sweep on one request. Each delete is re-scoped to `{ _id, userId, status: "pending" }`, so a row another request has already promoted or removed is skipped rather than refunded twice.
- **Objects are dropped only for rows that are actually gone.** If the sweep aborts, the returned list is discarded instead of acted on — deleting an object for a row that rolled back would leave a live document naming a key with nothing behind it.

There is no cancel endpoint, by choice. Reclaim is tied to the next upload because that is the only moment a stale reservation costs anyone anything; a client that abandons an upload and never comes back is not holding a resource that is being contended for.

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
