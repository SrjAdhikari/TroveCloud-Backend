# File Deletion Architecture

> Status: As-built (2026-09-23)

This document outlines the architecture, data flow, and security mechanisms behind the Trove backend's File deletion system, including database cleanup and removal of the stored object.

## 🏗️ Architecture

The File deletion logic adheres to the Controller-Service pattern, with authentication and validation enforced at the router level before any handler executes.

- **Authentication (`auth.middleware.js`)**: Applied router-wide via `fileRouter.use(authenticate)`. Every file endpoint requires a valid session — unauthenticated requests are rejected before reaching any controller.
- **Middleware (`validate.middleware.js`)**: `validateId` is registered via `router.param()` on `id`. Validates MongoDB ObjectId format using `isValidObjectId`, throwing a `BAD_REQUEST` error before the request reaches the controller.
- **Controller (`file.controller.js`)**: Extracts route parameters, delegates to the Service layer. Contains zero business logic or database access.
- **Service (`file.service.js`)**: Verifies ownership, deletes the DB record and decrements the parent folders' denormalized sizes in a transaction, then removes the stored object from R2.
- **R2 library (`src/lib/r2.js`)**: Owns the S3 client and the legal key shapes. `deleteObject` is the only way this path reaches Cloudflare.

---

## 🛣️ API Endpoints

### 1. Delete a File

- **Route:** `DELETE /api/files/:id`
- **Params:** `id` (required) — MongoDB ObjectId of the file to delete
- **Authentication:** Required (session-based)
- **Flow:**
  1. `authenticate` middleware validates the user's session and populates `req.user`.
  2. `validateId` middleware confirms `:id` is a valid ObjectId format.
  3. Controller calls `deleteFile(fileId, userId)` in the Service layer.
  4. Returns the deleted file document.

- **Service Logic (`deleteFile`):**
  1. Queries `File.findOne({ _id: fileId, userId }).select("+objectKey").lean()` to fetch the file with ownership verification. The key is `select: false` at the schema level, so a read that needs it must say so.
  2. If no document matches, throws `AppError` with `NOT_FOUND` and `FILE_NOT_FOUND`.
  3. **Live reservations are refused:** `isUploadStillLive` — a row that is not yet `ready` and whose `uploadExpiresAt` has not passed — raises `409 UPLOAD_IN_PROGRESS`. Deleting there would refund bytes that the presigned URL, which cannot be revoked, can still consume.
  4. Splits the key off the document — `const { objectKey, ...responseFile } = file` — so the value used for the R2 delete is never the value returned to the client.
  5. **Atomic DB delete (transaction):** Inside `withTransaction`, runs `File.deleteOne({ _id, userId }, { session })` plus `updateAncestorDirectoryStats(file.parentDirId, { bytes: -file.size, files: -1 }, session)` — decrementing the parent folder and every ancestor's denormalized `size`/`fileCount`. `endSession()` runs in `finally`.
  6. **Object removal after commit:** Once the transaction commits, `removeObject(objectKey, file._id)` drops the stored object via `deleteObject` in `src/lib/r2.js` — a non-retryable side effect kept outside the transaction.
  7. Returns the deleted file document, key excluded (captured before deletion).

- **Response:**
  ```json
  {
    "success": true,
    "message": "File deleted successfully",
    "data": {
      "_id": "...",
      "name": "report.pdf",
      "extension": ".pdf",
      "contentType": "application/pdf",
      "size": 2457600,
      "parentDirId": "...",
      "userId": "...",
      "status": "ready",
      "createdAt": "...",
      "updatedAt": "...",
      "__v": 0
    }
  }
  ```

  `data` is the whole stored document with `objectKey` removed — the read is `.lean()`, so nothing else is shaped on the way out. `uploadExpiresAt` joins the payload in the one case where a `pending` row is deletable: a reservation whose window has already lapsed, which deletes as `"status": "pending"`.

### 2. Cancel a Pending Upload

`POST /api/files/:id/cancel` is the endpoint for an upload the user walks away from. It is a **separate endpoint**, not a mode of `DELETE`, and it deletes nothing at all: it only pulls the reservation's `uploadExpiresAt` in to the presign TTL plus a settle margin, keeping the document, the reserved bytes and the stored object. A presigned URL cannot be revoked, so an instant refund would be a storage bypass; and the sweep that settles the row afterwards may find the bytes there and promote it, which is why cancel must not remove the object out from under it. Its errors are `404 FILE_NOT_FOUND` and `400 UPLOAD_ALREADY_CONFIRMED`; it never raises `UPLOAD_IN_PROGRESS`. Full flow in [`file-upload.md`](./file-upload.md#4-cancel-an-upload).

**`DELETE /api/files/:id` is unchanged by it.** Delete still refuses a live reservation with `409 UPLOAD_IN_PROGRESS` — cancelling first only brings the moment that refusal stops forward, it does not make delete cancel anything. And the moment it brings forward is still safely behind the signed URL's real death, because the shortened deadline carries the settle margin, so a delete accepted after a cancel cannot refund bytes that a PUT can still deliver.

---

## 🚀 Performance & Scalability Considerations

### Transactional DB Delete, Then Object Removal

The DB delete is transactional: `File.deleteOne` and the `updateAncestorDirectoryStats` ancestor decrement run together inside `withTransaction`, so a file row can never disappear while its bytes stay counted in ancestor folder sizes (or vice versa). The R2 delete happens **after** the transaction commits — the DB is the source of truth, and a call out to object storage is a non-retryable side effect that must stay outside the transaction, because `withTransaction`'s automatic retry on a `WriteConflict` would re-issue it (the same rule the upload paths and `deleteDirectory` follow).

### `removeObject` swallows its own failures

`removeObject` wraps `deleteObject` in a `try/catch` that warn-logs the error's `name` and HTTP status and **does not rethrow**. A `DELETE` whose R2 call fails therefore still returns `200` with the deleted document, because by then the row is already gone and the caller has nothing left to retry — re-running the request would only return `404`. The cost of that choice is an object nobody names any more; it is billed until a reconciliation pass removes it, and a trigger for that pass is tracked separately. This is the same resilience posture as the `Promise.allSettled` fan-out in directory deletion, which also warn-logs rejected deletes rather than failing the request.

A delete for a key with no object behind it is not a failure to begin with: `DeleteObject` is idempotent in R2, so a file whose object was already dropped deletes cleanly.

### Ownership Verification Before Deletion

The `findOne` query is necessary before deletion to confirm the file exists and belongs to the user. `deleteOne` alone would silently succeed even if the file doesn't exist, preventing the service from returning a meaningful response or throwing the correct error.

---

## 🛡️ Security Mechanisms

### Ownership-Scoped Queries

Both the `findOne` and `deleteOne` queries include `userId` in the filter. This ensures a user cannot delete another user's file even if they know the ObjectId — defense-in-depth at both the read and write stages.

### Input Validation at Router Level

`router.param('id', validateId)` intercepts invalid ObjectId strings before they reach the controller. This prevents Mongoose `CastError` crashes and avoids sending malformed queries to the database.

---
