# Google Drive Import

> **Status:** As-built (2026-04-25). The `POST /api/drive/import` endpoint is live. Request-body validation was moved from inline controller checks to a Zod schema (`importDriveSchema`, `validateBody`) on 2026-05-28 — malformed input now returns `400 VALIDATION_ERROR` instead of `INVALID_INPUT` / `INVALID_DRIVE_TOKEN`. The design below matches the current implementation; refresh when behavior changes.

Lets a signed-in user pick files and folders from their Google Drive and copy them into TroveCloud, preserving the folder hierarchy. One-shot, selective import — not a persistent Drive sync.

---

## 🏗️ Architecture Overview

A single new endpoint (`POST /api/drive/import`) accepts a short-lived access token obtained on the frontend via Google Identity Services, plus a list of file / folder IDs the user picked in Google Picker. The backend copies each picked item into the authenticated user's TroveCloud tree on behalf of the user, then discards the access token.

Keeping the access token ephemeral (no persistence, no `refresh_token` in the DB) matches the existing codebase's "no token storage" philosophy for OAuth — same as Google sign-in (`src/lib/googleAuth.js`) and GitHub sign-in (`src/lib/githubAuth.js`).

---

## 🧭 Design Decisions

- **Scope: one-shot pick-and-import.** The access token is passed per request. No persistence, no `refresh_token` storage, no User-schema changes.
- **Google-native files** (Docs / Sheets / Slides) are converted to Office formats (`.docx`, `.xlsx`, `.pptx`) via Drive's `export` endpoint. Unsupported native types (Forms, Drawings, Jamboards, Sites, Shortcuts) are reported as failures in the response.
- **OAuth scope: `drive.readonly`.** The narrower `drive.file` grants a picked folder but not its children, so `files.list` would silently drop children the app has never touched and folder import would come back incomplete. `drive.readonly` is a restricted scope and needs Google's verification before public launch. Google Identity Services on the frontend obtains the token; the backend never exchanges codes and never sees the Google client secret.
- **Drive API client: raw `fetch`.** Consistent with `src/lib/githubAuth.js` — no `googleapis` SDK dependency.
- **URL choice:** `/api/drive/import` for now. If additional providers (Dropbox, OneDrive) land later, re-scope to `/api/imports/{provider}`.

---

## 🛣️ API Contract

### Endpoint

`POST /api/drive/import` — gated by the `authenticate` middleware.

### Request body

```
{
  accessToken: string,                     // short-lived, from Google Identity Services
  items: Array<{ id, mimeType, name? }>,   // from Google Picker
  parentDirId?: string                     // optional; defaults to user.rootDirId
}
```

### Response

Returns HTTP `200` for any non-fatal outcome — partial success is a valid result, so the caller inspects the body to see what succeeded and what failed:

```
{
  success: true,
  message: "Import completed",
  data: {
    imported: [{ driveId, troveId, name, kind: "file" | "folder" }],
    failed:   [{ driveId, name, reason }]   // reason is an appErrorCode value
  }
}
```

Malformed input (missing / wrong-type body fields) returns `400 VALIDATION_ERROR` from the `validateBody(importDriveSchema)` middleware, before the handler runs.

---

## 🔄 Per-Item Processing Flow

For each picked item:

1. **Re-fetch metadata from Drive.** The client-supplied `mimeType` is not trusted — users could spoof.
2. **Early reject**: trashed items, files over the per-file size cap, items whose recursion depth would exceed the cap, or files whose sanitized name does not end in a simple extension (`INVALID_INPUT`). All of these are rejected before the download or export starts, except Google-native files over the per-file cap: they have no declared size, so they trip mid-stream.
3. **Folder** (`application/vnd.google-apps.folder`) → create a TroveCloud `Directory`, paginate children via `files.list`, recurse depth-first.
4. **Google-native** → look up the export MIME in `GOOGLE_APPS_EXPORT_MAP`. If not mapped (Forms, Drawings, Shortcuts, etc.), push to `failed` with `UNSUPPORTED_DRIVE_TYPE`.
5. **Regular file** → call the Drive download endpoint, wrap `response.body` as a Node Readable (`Readable.fromWeb`), and pass to the existing `uploadFileFromServer` service, which enforces the user's storage quota against the streamed size. An item that would push the user past their quota lands in `failed` with `STORAGE_LIMIT_EXCEEDED`; later items that still fit are imported. When Drive declares the file's `size`, the quota is pre-checked against it first (current root `size` + declared size), so an over-quota file is rejected without being downloaded; that pre-check settles the user's expired reservations once before rejecting, and is skipped when the account's limit is unusable. It is advisory: the in-upload check stays authoritative.
6. **Track transferred bytes.** Bytes streamed from Drive count against the per-request cap, including those of a file later rejected (e.g. over quota). File names are validated before the download or export starts, so an unsupported name never opens a transfer and costs nothing against the cap. Once the cap is spent, remaining items fail fast with `DRIVE_IMPORT_LIMIT_EXCEEDED` without being downloaded.

Per-item processing runs inside a `try / catch`: any failure pushes the item to `failed` with a reason code and moves on. Partial success is the user-facing contract.

---

## 🧱 File Layout

### New files

**`src/lib/googleDrive.js`** — raw-fetch wrapper around Drive REST, mirroring `src/lib/githubAuth.js` (AbortSignal timeout, explicit User-Agent, `response.ok` checks, AppError-passthrough catch).

Exports:

- `getDriveFileMetadata(accessToken, fileId)` — `GET /drive/v3/files/{fileId}?fields=id,name,mimeType,size,parents,trashed,shortcutDetails`
- `downloadDriveFile(accessToken, fileId)` — returns the `fetch` `Response` so the caller can read `.body` as a Web stream
- `exportGoogleDoc(accessToken, fileId, exportMimeType)` — returns `Response`
- `listDriveFolderChildren(accessToken, folderId, pageToken?)` — `GET /drive/v3/files?q='{folderId}' in parents and trashed=false&fields=files(id,name,mimeType,size),nextPageToken&pageSize=100`

Module-level constants:

- `DRIVE_FETCH_TIMEOUT_MS = 15000` (Drive is slower than GitHub — the GitHub wrapper uses 8s)
- `DRIVE_USER_AGENT = "TroveCloud"`
- `GOOGLE_APPS_EXPORT_MAP`:
  ```
  "application/vnd.google-apps.document"     → { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" }
  "application/vnd.google-apps.spreadsheet"  → { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       ext: ".xlsx" }
  "application/vnd.google-apps.presentation" → { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" }
  ```

Error mapping in the shared catch:

| HTTP status                                   | Maps to                                                           |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `401`                                         | `INVALID_DRIVE_TOKEN`                                             |
| `404`                                         | `DRIVE_ITEM_NOT_FOUND`                                            |
| `403` with `"exportSizeLimitExceeded"` reason | `DRIVE_EXPORT_TOO_LARGE` (Docs / Slides ≥10 MB can't be exported) |
| `403` quota / rate                            | `DRIVE_IMPORT_FAILED` (generic message; no internals leaked)      |
| Network / JSON parse / other                  | `DRIVE_IMPORT_FAILED`                                             |

**Token hygiene:** the `accessToken` is never included in any `AppError` message or `console.error` output. Dev-mode logging must redact tokens before emitting.

**`src/services/drive.service.js`** — orchestrator.

Exports `importFromDrive(userId, accessToken, items, parentDirId, storageLimit)`:

- `storageLimit` is the controller's `req.user.storageLimit`, passed to every `uploadFileFromServer` call so each file is checked against the quota.
- Resolves `parentDirId` to `user.rootDirId` if omitted. Parent-ownership is validated implicitly by `createDirectory`'s existing check — no extra query needed at the top level.
- Deduplicates `items` by `id`. Also maintains a `seen: Set<driveId>` across folder traversal, so picking a folder AND a file inside that folder imports the file once.
- Iterates items sequentially. This keeps Drive API quota (1000 req / 100s / user) safe for the MVP. Can be parallelized with `p-limit` later if p95 import latency becomes a problem.

Internal helpers:

- `importItem(ctx, driveId, targetParentDirId, depth, knownMeta)` — metadata fetch, type branching, recursion, streaming. `knownMeta` is a child's entry from its folder's listing, used in place of a metadata fetch; top-level items pass `null` and are re-fetched, since the Picker's `mimeType` is client-supplied. `ctx = { userId, accessToken, storageLimit, totalBytes, reclaimSpent, imported, failed, seen }`.
- `sanitizeDirName(name)` — trims, strips control chars, pads names shorter than 3 chars with `_` suffix, truncates over 50, falls back to `"Imported folder"` if empty. Needed because `Directory.name` has `minlength: 3, maxlength: 50` but Drive folder names aren't bounded.
- `sanitizeFileName(name)` — same treatment against `File.name` constraints (no minlength today; still strip control chars and cap at 255, matching the existing `file.controller.js` sanitization).

**Streaming through the server:** Drive's response body arrives as a Web ReadableStream. It is wrapped in a `Transform` that counts bytes and aborts the pipeline when the post-hoc total exceeds the per-file cap or the remaining per-request budget — necessary because Google-native `export` responses have no pre-flight `size`. The counter-wrapped Readable is then passed to the existing `uploadFileFromServer(parentDirId, userId, displayName, readable, totalStorageLimit)` in `src/services/file/serverUpload.service.js` with the user's `storageLimit`, which handles the DB row creation, the write to R2, the quota check against the counted bytes, and rollback (row and object) when the stream or the quota check fails.

**`src/validators/drive.validator.js`** — request-body validation.

Exports `importDriveSchema`, consumed via `validateBody(importDriveSchema)` at the route. It enforces, before the handler runs:

- `accessToken` — string, trimmed, non-empty, `≤ 4096` chars.
- `items` — array of `1..50` objects, each `{ id, mimeType }` non-empty trimmed strings (extra keys are stripped; the service only consumes `item.id`).
- `parentDirId` — optional trimmed string (whitespace collapses to empty → resolved to the user's root downstream).

Any failure throws `400 VALIDATION_ERROR`. Because the fields are `z.string()`, operator-injection shapes like `{$ne:""}` are rejected here, before any service call.

**`src/controllers/drive.controller.js`** — thin HTTP handler.

Exports `importDriveHandler(req, res)`. The body is already validated/normalized by the route middleware, so the handler just reads `const { accessToken, items, parentDirId } = req.body;`, resolves `parentDirId` to `user.rootDirId` when blank, and delegates to `importFromDrive`.

Response: always `200` unless input itself is malformed (then `400 VALIDATION_ERROR` from the validator). Body per the contract above.

**`src/routes/drive.routes.js`** — route registration.

```js
driveRouter.use(authenticate);
driveRouter.post("/import", validateBody(importDriveSchema), importDriveHandler);
```

### Modified files

- **`src/routes/index.js`** — mount `driveRouter` under `/api/drive`.
- **`src/constants/appErrorCode.js`** — add the following codes under a new `// Drive` section: `INVALID_DRIVE_TOKEN`, `DRIVE_ITEM_NOT_FOUND`, `DRIVE_IMPORT_FAILED`, `UNSUPPORTED_DRIVE_TYPE`, `DRIVE_EXPORT_TOO_LARGE`, `DRIVE_IMPORT_LIMIT_EXCEEDED`.

### Files explicitly not changed

- **`src/models/user.model.js`** — no token storage. The User schema is untouched.
- **No new env vars.** The Google client secret stays on the frontend; the backend never exchanges codes.
- **No new dependencies.** Raw `fetch` against Drive's REST API is sufficient.

---

## 📐 Caps and Guards

Conservative defaults. The two byte caps are read from the environment through `getNumberEnv` in `src/constants/env.js` (`MAX_FILE_UPLOAD_SIZE` and `MAX_DRIVE_IMPORT_SIZE`), so the values below are the current settings rather than constants in code.

| Guard                       | Value        | Enforced in                                                                                                              |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Max items per request       | 50           | `importDriveSchema` (`validateBody`) — `400 VALIDATION_ERROR` on violation                                               |
| Per-file size cap           | env (100 MB) | `streamFileIntoTrove` pre-flight (via `size` from metadata) AND post-hoc byte counter (for native exports where `size` is absent) |
| Aggregate bytes per request | env (200 MB) | Transfer budget: `ctx.totalBytes` counts bytes streamed from Drive, including files later rejected; short-circuits remaining items with `DRIVE_IMPORT_LIMIT_EXCEEDED` |
| Per-user storage quota      | `User.storageLimit` | `streamFileIntoTrove` pre-flight against the declared `size` (regular files only, before the download) AND `checkQuota` inside `uploadFileFromServer`, per file; an over-quota item fails with `STORAGE_LIMIT_EXCEEDED` and the batch continues |
| Folder recursion depth      | 20           | Parameter passed through `importItem`; matches `$graphLookup` `maxDepth` elsewhere in the codebase                       |
| `accessToken` string length | ≤ 4096       | `importDriveSchema` (`validateBody`, defensive)                                                                          |
| Drive fetch timeout         | 15s per call | `AbortSignal.timeout` in `googleDrive.js`                                                                                |
| Picker items deduplicated   | by `driveId` | Orchestrator `seen` set (survives folder traversal)                                                                      |

---

## 🧰 Reuse Map

Existing code leveraged by the implementation — no duplication.

| What's needed                                                                        | Existing function                                       | Location                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------- |
| Stream bytes to object storage with rollback                                         | `uploadFileFromServer(parentDirId, userId, fileName, fileStream, totalStorageLimit)` | `src/services/file/serverUpload.service.js` |
| Create a directory with parent-ownership check                                       | `createDirectory(parentDirId, dirname, userId)`         | `src/services/directory.service.js`   |
| Session-based auth, attach `req.user`                                                | `authenticate` middleware                               | `src/middlewares/auth.middleware.js`  |
| Raw-fetch third-party API pattern (timeout, UA, `response.ok`, AppError passthrough) | `verifyGithubCodeAndFetchProfile`                       | `src/lib/githubAuth.js`               |
| Error response shape                                                                 | Global error middleware                                 | `src/middlewares/error.middleware.js` |

---

## 🧩 Edge Cases

- **Trashed items** — skipped via `trashed=false` on list queries; the metadata check rejects trashed picked items explicitly.
- **Shortcuts** (`application/vnd.google-apps.shortcut`) — rejected as `UNSUPPORTED_DRIVE_TYPE` for MVP. Following a shortcut would require an extra permission check against the target; out of scope.
- **Google-native export 10 MB cap** — Drive's `/export` endpoint returns `403 exportSizeLimitExceeded` for large Docs / Slides. Mapped to `DRIVE_EXPORT_TOO_LARGE` with a user-facing reason.
- **`size` field as string** — Drive API returns `size` as a JSON string (64-bit int). Coerce via `Number()` before comparing against the cap.
- **Zero-byte files** — allowed (the cap comparison is `>= 0`).
- **Short / long folder names** — the sanitizer reconciles the `3..50` Mongoose constraint with Drive folder names, which aren't bounded.
- **Name collisions** — `File.name` has no uniqueness index today; duplicates are silently allowed during manual upload. The import mirrors that behavior.
- **Dedup across picks** — picking a folder AND a file inside that folder imports the file once, thanks to the `seen` set.
- **Empty folder after partial failure** — the folder is created; children fail; the folder stays. Matches the "partial success" UX contract and is consistent with per-item semantics.

---

## 🚧 Explicit Non-Goals

These are deliberately out of scope for the initial implementation. Each represents a future follow-up, not an oversight.

- **Persistent Drive linking / re-import.** No `refresh_token` storage. Would require a dedicated "Link Drive" flow and User-schema changes.
- **Progress streaming (SSE / WebSocket).** Synchronous response for MVP. Watch for it if p95 exceeds ~10s with real data (a 200 MB import at Drive's ~20 MB/s is ~10s). Confirm any reverse-proxy idle timeout is > 60s before shipping.
- **Rate-limit retry / backoff.** Drive allows 1000 queries / 100s / user. No exponential backoff for MVP — `403 userRateLimitExceeded` bubbles up as `DRIVE_IMPORT_FAILED`. Add retry if real quota pressure appears.
- **Shared-drive semantics.** `fields=parents` may be empty for shared-drive items — don't rely on it. Otherwise the feature works transparently since `drive.readonly` covers every item the user can read, regardless of ownership.
- **Client-disconnect cleanup.** If the client disconnects mid-import, the in-flight `uploadFileFromServer` rolls back its own partial write, but directories already created stay. Acceptable given per-item semantics.

---

## ✅ Verification

### Manual end-to-end

1. Configure a Google Cloud OAuth client with `drive.readonly` scope and authorized JavaScript origins pointing at the frontend.
2. On the frontend, use Google Identity Services `initTokenClient` + Google Picker to obtain an `accessToken` and the selected items.
3. Send a request:
   ```bash
   curl -i -X POST http://localhost:{PORT}/api/drive/import \
     -H "Content-Type: application/json" \
     -b "token=<signed session cookie>" \
     -d '{ "accessToken": "...", "items": [{ "id": "...", "mimeType": "..." }] }'
   ```
4. Confirm: objects appear in the Cloudflare R2 bucket; `Directory` and `File` rows exist in Mongo; response body matches the contract.

### Scenarios to cover

- Single regular file (e.g., `.pdf`) — imports; response shows `imported.length === 1`.
- Google Doc — arrives as `.docx`; opens cleanly in Word / LibreOffice.
- Google Sheet — arrives as `.xlsx`.
- Google Slides — arrives as `.pptx`.
- Folder with 3 nested subfolders + files at each level — hierarchy preserved in TroveCloud.
- Forms / Drawings — reported as `UNSUPPORTED_DRIVE_TYPE` in `failed`; `imported` untouched.
- Shortcut — `UNSUPPORTED_DRIVE_TYPE`.
- Trashed item — `DRIVE_ITEM_NOT_FOUND` (or an explicit trashed reason).
- File > 100 MB — `failed` with size reason.
- Oversize Google Doc (forces `exportSizeLimitExceeded` from Drive) — `DRIVE_EXPORT_TOO_LARGE`.
- Expired / tampered access token — `401` from Drive → `INVALID_DRIVE_TOKEN`; no partial data in the DB or R2.
- Dedup: pick folder `A` AND `A/file.pdf` explicitly — `file.pdf` appears once.
- Items length 0 or > 50 — `400 VALIDATION_ERROR`.
- No session cookie — `401` from `authenticate`.
- Aggregate limit: pick files summing past `MAX_DRIVE_IMPORT_SIZE` — early items import, later items fail with `DRIVE_IMPORT_LIMIT_EXCEEDED`. The same holds with the quota already full: bytes of rejected files still spend the budget.
- Storage quota: pick files that together exceed the user's remaining quota — the item that would overrun fails with `STORAGE_LIMIT_EXCEEDED`, leaves no file row or object behind, and later items that still fit import. A regular file whose declared `size` would overrun is rejected without being downloaded.

### Security audit items

- Grep the codebase post-implementation for `console.log` / `console.error` statements that might interpolate `accessToken`. Redact anything that does.
- Confirm `express.json()` body limit accommodates 50 Picker items (a few KB each — well under the default 100 KB).
- Confirm the global error handler doesn't expose `err.stack` in production (already the case — gated on `NODE_ENV !== "development"`).

---

## 📎 Critical Files Referenced

- `src/services/file/serverUpload.service.js` — `uploadFileFromServer` reused.
- `src/services/directory.service.js` — `createDirectory` reused.
- `src/lib/githubAuth.js` — structural template for `googleDrive.js`.
- `src/middlewares/auth.middleware.js` — `authenticate` reused.
- `src/constants/appErrorCode.js` — extended with Drive error codes.
- `src/routes/index.js` — mount point for the new router.
- `src/models/file.model.js`, `src/models/directory.model.js` — consulted for schema constraints; no changes.

---
