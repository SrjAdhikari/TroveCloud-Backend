# File Retrieval Architecture

> Status: As-built (2026-09-08)

This document outlines the architecture, data flow, and security mechanisms behind the Trove backend's File retrieval system.

Reading a file is two separate concerns, and two separate endpoints. `GET /api/files/:id` returns the file's **metadata**; `GET /api/files/:id/download-url` mints a short-lived signed URL that serves the **bytes** directly from Cloudflare R2. The API never streams file content itself.

## 🏗️ Architecture

The File retrieval logic adheres to the Controller-Service pattern, with authentication and validation enforced at the router level before any handler executes.

- **Authentication (`src/middlewares/auth.middleware.js`)**: Applied router-wide via `fileRouter.use(authenticate)`. Every file endpoint requires a valid session — unauthenticated requests are rejected before reaching any controller.
- **Middleware (`src/middlewares/validate.middleware.js`)**: `validateId` is registered via `router.param()` on `id`. Validates MongoDB ObjectId format using `isValidObjectId`, throwing a `BAD_REQUEST` error before the request reaches the controller.
- **Controller (`src/controllers/file.controller.js`)**: Extracts route parameters and query flags, delegates to the Service layer, and wraps the result in the standard response envelope. Contains zero business logic or database access.
- **Service (`src/services/file/file.service.js`)**: Executes ownership-scoped database queries and, for downloads, presigns a `GET` against the stored object key.

---

## 🛣️ API Endpoints

### 1. Retrieve File Metadata

- **Route:** `GET /api/files/:id`
- **Params:** `id` (required) — MongoDB ObjectId of the target file
- **Authentication:** Required (session-based)
- **Flow:**
  1. `authenticate` validates the user's session and populates `req.user`.
  2. `validateId` confirms `:id` is a valid ObjectId format.
  3. Controller calls `getFile(fileId, userId)` and returns the document in the standard envelope.

- **Service Logic (`getFile`):**
  1. Queries `File.findOne({ _id: fileId, userId, status: "ready" }).lean()`.
  2. If no document matches, throws `AppError` with `NOT_FOUND` and `FILE_NOT_FOUND`.
  3. Returns the document. `objectKey` is `select: false`, so it is absent by construction.

- **Response:**
  ```json
  {
    "success": true,
    "message": "File retrieved successfully",
    "data": {
      "_id": "...",
      "name": "report.pdf",
      "extension": ".pdf",
      "contentType": "application/pdf",
      "size": 2457600,
      "parentDirId": "...",
      "userId": "...",
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
  ```

An upload that has been initiated but not yet confirmed is **not** retrievable here — the `status: "ready"` filter makes it indistinguishable from a file that does not exist. A pending upload is quota bookkeeping, not a file the user has.

### 2. Mint a Download URL

- **Route:** `GET /api/files/:id/download-url`
- **Params:** `id` (required) — MongoDB ObjectId of the target file
- **Query:** `action=download` (optional) — forces an attachment response instead of inline rendering
- **Authentication:** Required (session-based)
- **Flow:**
  1. `authenticate` and `validateId` run as above.
  2. Controller calls `createDownloadUrl(fileId, userId, { download: req.query.action === "download" })`.

- **Service Logic (`createDownloadUrl`):**
  1. Queries `File.findOne({ _id: fileId, userId, status: "ready" }).select("+objectKey").lean()` — the key is `select: false`, so a read that needs it must ask.
  2. If no document matches, throws `AppError` with `NOT_FOUND` and `FILE_NOT_FOUND`.
  3. Decides the disposition: `inline` only when the caller did not request a download **and** the file's stored content type is on the inline allowlist. Everything else is served as an attachment.
  4. Presigns a `GET` against the **stored** object key, overriding the response's content type and `Content-Disposition`.
  5. Returns `{ url, expiresAt }`. The key itself never travels back.

- **Response:**
  ```json
  {
    "success": true,
    "message": "Download URL created successfully",
    "data": {
      "url": "https://....r2.cloudflarestorage.com/...",
      "expiresAt": "..."
    }
  }
  ```

The URL is valid for one hour. It should be minted on demand rather than cached, since possession of the URL is itself sufficient to read the file until it expires.

---

## 🚀 Performance & Scalability Considerations

### The bytes never transit the API

Serving a download costs one indexed document read and a signature computation — no streaming, no open file descriptors, no Node worker occupied for the length of the transfer. Range requests, `ETag`s, and resumable downloads are handled by Cloudflare's edge rather than by Express.

### Memory-safe reads (`.lean()`)

Both queries append `.lean()`, which returns a plain JavaScript object instead of a Mongoose document. This avoids hydrating change-tracking internals, virtuals, and prototype methods — reducing memory per document and improving JSON serialization speed.

### Stored keys, never rebuilt

The presigned `GET` targets `File.objectKey` as stored. Deriving a key from an id and an extension at read time would produce a different string than the one written at upload for any file whose name or extension has since changed, and would turn a malformed stored value into a 500 rather than a clean miss.

---

## 🛡️ Security Mechanisms

### Ownership-scoped queries

Both queries include `userId` as a filter condition. This prevents IDOR (Insecure Direct Object Reference) attacks where an authenticated user could access another user's file by guessing the ObjectId. The check happens before any URL is minted, so a signed URL is only ever issued to the file's owner.

### The inline allowlist carries the weight of `nosniff`

A presigned `GET` is served by Cloudflare from the storage origin, and the response headers are fixed at signing time — the API cannot attach `X-Content-Type-Options: nosniff` to it. So `inline` is granted only to an explicit allowlist of types that are safe to render (PDF, plain text, CSV, common image, video, and audio formats). Any type not on that list is forced to `attachment` even when the caller did not ask for a download, so an unanticipated or script-bearing type downloads rather than executing on the storage origin.

### The download filename carries the stored extension

Renaming a file changes its display name but not its bytes. `normalizeFileName` therefore builds the `Content-Disposition` filename from the **stored** extension, not the one in the current name — so renaming `payload.txt` to `payload.html` still offers the file as `payload.txt`, and a rename can never change how the browser treats the content.

### Short-lived, single-purpose URLs

A minted URL grants read access to exactly one object for one hour, and carries no session identity. It should not be logged, persisted, or shared.

### Input validation at router level

`router.param('id', validateId)` intercepts invalid ObjectId strings before they reach the controller. This prevents Mongoose `CastError` crashes and avoids sending malformed queries to the database.

### HTTP-agnostic service layer

The service returns plain data — a document, or a `{ url, expiresAt }` pair — and never touches `req` or `res`. This keeps it testable and reusable without mocking Express response objects.

---
