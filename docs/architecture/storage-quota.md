# Storage Usage & Quota

> **Status:** As-built (2026-09-10). Per-user storage quota + the usage-breakdown endpoint.

This document covers the per-user storage quota: where the limit lives, how usage is read, how the quota is enforced on upload, and the `GET /api/storage/usage` endpoint that powers the frontend's sidebar storage bar and settings storage tab.

## 🏗️ Architecture

- **Quota storage** — the limit is a field on the user (`User.storageLimit`, `src/models/user.model.js`), defaulting to the environment-configured `DEFAULT_STORAGE_LIMIT` (read through `getNumberEnv` in `src/constants/env.js`; currently 700 MB, decimal, matching the per-file cap convention). It is per-user, so an admin can raise it on a single account later.
- **Usage source** — usage is **not** stored separately. It is read from the denormalized root-directory `size` (the whole-subtree byte total maintained inside the upload/delete transactions — see `./transaction-patterns.md`). This makes "bytes used" an O(1) read of one document.
- **Controller (`src/controllers/storage.controller.js`)** — `getStorageUsageHandler` extracts `req.user._id` and `req.user.storageLimit` (the limit rides on the session-populated user, so no extra DB read) and delegates to the service.
- **Service (`src/services/storage.service.js`)** — `getStorageUsage(userId, totalStorageLimit)` reads the root size, scans the user's files for the category breakdown, and returns the response shape. No HTTP concerns.
- **Category helper (`src/utils/fileCategories.js`)** — `categorizeExtension(ext)` maps a file extension to one of `Documents` / `Images` / `Videos` / `Audio` / `Archives` / `Other`; `CATEGORY_ICONS` maps each category to a Lucide icon name for the frontend.

---

## 🛣️ API Endpoints

### 1. Get Storage Usage

- **Route:** `GET /api/storage/usage`
- **Authentication:** Required (session-based; router-wide `storageRouter.use(authenticate)`, rate-limited with the `read` tier).
- **Flow:**
  1. `authenticate` validates the session and populates `req.user`.
  2. Controller passes `req.user._id` + `req.user.storageLimit` to `getStorageUsage`.
  3. Service reads the user's root directory (`Directory.findOne({ userId, parentDirId: null }).select("size").lean()`); `used` = `root.size` (or `0` if the user has no root yet).
  4. Service scans the user's files (`File.find({ userId }).select("extension size").lean()`) and sums bytes per category in memory with a single `reduce` — **no aggregation pipeline** (a deliberate simplicity choice; the same denormalized-read philosophy as folder size).
  5. The breakdown is built from the category map: only categories that actually have files are included, sorted by `size` descending, each annotated with its Lucide icon.
  6. Returns `{ used, total, breakdown }`.

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
- **Abandoned reservations are refunded first.** `releaseExpiredFiles` runs at the head of both upload paths, in its own transaction that commits before the check opens, so bytes held by lapsed uploads are already back in the budget by the time the quota is evaluated. See `../file/file-upload.md`.
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
| Upload authorised but never completed | Its declared bytes stay reserved until `uploadExpiresAt`, then are refunded by the reclaim sweep at the head of the owner's next upload |
| Two concurrent uploads near the limit | One commits; the other write-conflicts on the root doc, retries against the fresh size, and is accepted or rejected correctly |
| `used` vs `sum(breakdown)` | Both derive from the same files; in rare denormalization drift `used` (root size) is treated as authoritative |

---

## 🧹 Database Mechanisms

- **`User.storageLimit`** (`Number`, required, environment-configured default) — see `./database-schema.md`. Mirrored in the Atlas `$jsonSchema` as a typed property but **not** in the validator's `required` array (the Mongoose default guarantees presence on every ORM write; listing it would reject documents created before the field existed).
- No new collection or index — usage rides on the existing denormalized `Directory.size`.

---

## 🔀 Deferred

Google Drive imports do **not** yet count against the quota — the import path declares an explicit exemption by passing `Number.POSITIVE_INFINITY` as the limit. Tracked as a follow-up (GitHub issue #65).
