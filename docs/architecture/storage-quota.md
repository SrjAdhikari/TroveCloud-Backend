# Storage Usage & Quota

> **Status:** As-built (2026-09-23). Per-user storage quota + the usage-breakdown endpoint.

This document covers the per-user storage quota: where the limit lives, how usage is read, how the quota is enforced on upload, and the `GET /api/storage/usage` endpoint that powers the frontend's sidebar storage bar and settings storage tab.

## 🏗️ Architecture

- **Quota storage** — the limit is a field on the user (`User.storageLimit`, `src/models/user.model.js`), defaulting to the environment-configured `DEFAULT_STORAGE_LIMIT` (read through `getNumberEnv` in `src/constants/env.js`; currently 700 MB, decimal, matching the per-file cap convention). It is per-user, so an admin can raise it on a single account later.
- **Usage source** — usage is **not** stored separately. It is read from the denormalized root-directory `size` (the whole-subtree byte total maintained inside the upload/delete transactions — see `./transaction-patterns.md`). This makes "bytes used" an O(1) read of one document.
- **Controller (`src/controllers/storage.controller.js`)** — `getStorageUsageHandler` extracts `req.user._id` and `req.user.storageLimit` (the limit rides on the session-populated user, so no extra DB read) and delegates to the service.
- **Service (`src/services/storage.service.js`)** — `getStorageUsage(userId, totalStorageLimit)` first settles the user's expired reservations (`settleExpiredPendingFiles`, the same sweep the upload paths use), then reads the root size, scans the user's files for the category breakdown, and returns the response shape. No HTTP concerns.
- **Category helper (`src/utils/fileCategories.js`)** — `categorizeExtension(ext)` maps a file extension to one of `Documents` / `Images` / `Videos` / `Audio` / `Archives` / `Other`; `CATEGORY_ICONS` maps each category to a Lucide icon name for the frontend.

---

## 🛣️ API Endpoints

### 1. Get Storage Usage

- **Route:** `GET /api/storage/usage`
- **Authentication:** Required (session-based; router-wide `storageRouter.use(authenticate)`, rate-limited with the `read` tier).
- **Flow:**
  1. `authenticate` validates the session and populates `req.user`.
  2. Controller passes `req.user._id` + `req.user.storageLimit` to `getStorageUsage`.
  3. Service awaits `settleExpiredPendingFiles(userId)` so lapsed and cancelled reservations settle before anything is read: rows whose object is absent are deleted and refunded, rows whose object landed are promoted to `ready`, and rows whose lookup failed are left alone. It is capped at `MAX_EXPIRED_FILES_PER_SWEEP` (25) per call and never throws — every failure is warn-logged inside the sweep or the object removal — so a storage or database fault leaves `used` at its current figure instead of failing the read.
  4. Service reads the user's root directory (`Directory.findOne({ userId, parentDirId: null }).select("size").lean()`); `used` = `root.size` (or `0` if the user has no root yet).
  5. Service scans the user's ready files (`File.find({ userId, status: "ready" }).select("extension size").lean()`) and sums bytes per category in memory with a single `reduce` — **no aggregation pipeline** (a deliberate simplicity choice; the same denormalized-read philosophy as folder size).
  6. The breakdown is built from the category map: only categories that actually have files are included, sorted by `size` descending, each annotated with its Lucide icon.
  7. Returns `{ used, total, breakdown }`.

- **Response — 200:**
  ```json
  {
    "success": true,
    "message": "Storage usage retrieved successfully",
    "data": {
      "used": 575703552,
      "total": 1000000000,
      "breakdown": [
        { "category": "Documents", "size": 314572800, "icon": "file-text" },
        { "category": "Images", "size": 209715200, "icon": "image" },
        { "category": "Other", "size": 51415552, "icon": "file" }
      ]
    }
  }
  ```
  - `used` is the authoritative byte total (the same value enforcement checks against on upload).
  - `total` is the user's quota in bytes.
  - `breakdown` is empty (`[]`) for a user with no files.

---

## 🛡️ Quota Enforcement on Upload

The quota is enforced by the shared `checkQuota` helper in `src/services/file.service.js`, called by both upload paths — `initiateUpload` (browser uploads, at the moment the bytes are reserved) and `uploadFileFromServer` (Drive import). See `../file/file-upload.md` for the full upload flow. The non-obvious parts:

- **Checked inside the transaction that writes the counters.** On the browser path that is the transaction creating the `pending` row: the check runs against the *declared* size, before any bytes exist. On the server-side path the row is claimed at `size: 0` before streaming and the check runs in the second transaction, against the byte counter's total, before the row is promoted to `ready` — the real size isn't knowable any earlier. Either way the transaction reads the current root `size` and rejects with `STORAGE_LIMIT_EXCEEDED` (400) when `usedBytes + uploadedBytes > storageLimit`.
- **On the upload paths, lapsed reservations are settled on rejection, not on arrival.** There, `releaseExpiredFiles` runs only when the quota check has already rejected with `STORAGE_LIMIT_EXCEEDED`. (It also runs on every `GET /api/storage/usage` read, before `used` is taken — see above — so the storage bar does not report a lapsed or cancelled reservation indefinitely.) It decides each expired row by looking its object up in storage — refunding only the rows whose bytes are genuinely not there, promoting the rows whose bytes are, and skipping any row whose lookup failed — then commits in a transaction of its own, and the rejected transaction is retried exactly once, and only if rows were actually freed. An upload that fits pays nothing for the sweep; a genuinely full user pays one indexed query before the real error stands. See `../file/file-upload.md`.
- **Concurrency-safe without a lock.** The same transaction also `$inc`s the root document (via `updateAncestorDirectoryStats`). Two simultaneous uploads therefore write-conflict on the root doc; `withTransaction` retries the loser, which re-reads the now-updated `size` and re-checks — so the cap holds even under concurrent uploads. (Details in `./transaction-patterns.md`.)
- **Boundary:** the check uses a strict `>`, so an upload that exactly fills the quota is allowed, and a 0-byte upload at an exactly-full quota is allowed.

---

## 🔄 Edge Cases & Failure Modes

| Scenario | Outcome |
| -------- | ------- |
| User with no files | `used: 0`, `breakdown: []`, `total` = their quota |
| File whose extension isn't recognised, or has no extension | Counted under the `Other` category |
| 0-byte file | Surfaces its category in the breakdown with `size: 0` |
| Upload would exceed the quota | Rejected with `STORAGE_LIMIT_EXCEEDED` (400). The browser path never creates a row; the server-side path deletes its claim row and the object it already wrote |
| Browser upload authorised but never completed | Its declared bytes stay reserved until `uploadExpiresAt`. The next time the owner reads `GET /api/storage/usage`, or one of their uploads is rejected for quota, the sweep looks the object up: absent or mismatched, the row is deleted and the bytes refunded; present and matching, the row is promoted to `ready` and the bytes stay counted as a real file; lookup failed, the row is skipped and left to the next sweep |
| Browser upload cancelled via `POST /api/files/:id/cancel` | The bytes stay counted and the object stays where it is — cancel only pulls `uploadExpiresAt` in to `createdAt` + the presign TTL + `ONE_MINUTE_MS` (about six minutes), so the sweep settles the row that much sooner — on the first usage read or quota rejection after that deadline. Cancel never refunds and never deletes; a presigned URL cannot be revoked, so an instant refund would be a storage bypass, and a `PUT` that completed anyway leaves bytes the sweep will promote rather than throw away |
| Storage limit missing or non-numeric on the account | Rejected with `INVALID_STORAGE_LIMIT` (500) before the root-directory read. Deliberately not a quota rejection: that code triggers a sweep and a retry, and a configuration fault must not drive destructive cleanup |
| Server-side claim that never promotes | Only a file slot is held, not bytes — the claim commits at `size: 0` and bytes are added when it flips to `ready`, so an abandoned one costs the quota nothing until the sweep removes the row |
| Two concurrent uploads near the limit | One commits; the other write-conflicts on the root doc, retries against the fresh size, and is accepted or rejected correctly |
| `used` vs `sum(breakdown)` | Both derive from the same files; in rare denormalization drift `used` (root size) is treated as authoritative |

---

## 🧹 Database Mechanisms

- **`User.storageLimit`** (`Number`, required, environment-configured default) — see `./database-schema.md`. Mirrored in the Atlas `$jsonSchema` as a typed property but **not** in the validator's `required` array (the Mongoose default guarantees presence on every ORM write; listing it would reject documents created before the field existed).
- No new collection or index — usage rides on the existing denormalized `Directory.size`.

---

## 🔀 Deferred

Google Drive imports do **not** yet count against the quota — the import path declares an explicit exemption by passing `Number.POSITIVE_INFINITY` as the limit. Tracked as a follow-up (GitHub issue #65).
