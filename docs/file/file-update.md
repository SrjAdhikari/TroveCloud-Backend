# File Update (Rename) Architecture

This document outlines the architecture, data flow, and security mechanisms behind the Trove backend's File rename system.

## 🏗️ Architecture

The File update logic adheres to the Controller-Service pattern, with authentication and validation enforced at the router level before any handler executes.

- **Authentication (`auth.middleware.js`)**: Applied router-wide via `fileRouter.use(authenticate)`. Every file endpoint requires a valid session — unauthenticated requests are rejected before reaching any controller.
- **Middleware (`validate.middleware.js`)**: `validateId` is registered via `router.param()` on `id` (ObjectId format check), and `validateBody(renameFileSchema)` validates + sanitizes the body — both run before the request reaches the controller.
- **Controller (`file.controller.js`)**: Extracts route parameters and the already-validated request body, delegates to the Service layer. Contains zero business logic or database access.
- **Service (`src/services/file/file.service.js`)**: Performs an atomic ownership-scoped rename.

---

## 🛣️ API Endpoints

### 1. Rename a File

- **Route:** `PATCH /api/files/:id`
- **Params:** `id` (required) — MongoDB ObjectId of the file to rename
- **Body:** `{ "newFileName": "Updated Name.pdf" }` (required)
- **Authentication:** Required (session-based)
- **Flow:**
  1. `authenticate` middleware validates the user's session and populates `req.user`.
  2. `validateId` middleware confirms `:id` is a valid ObjectId format.
  3. `validateBody(renameFileSchema)` validates and sanitizes the body at the route — `newFileName` is required, reduced to its base name via `path.basename` (anti-traversal), stripped of control characters and backslashes, trimmed, and capped at 255 chars. A missing / non-string / empty-after-sanitize value is rejected with `400 VALIDATION_ERROR`.
  4. Controller reads the already-clean `req.body.newFileName` and delegates.
  5. Calls `updateFile(fileId, newFileName, userId)` in the Service layer.
  6. Returns the updated file document.

- **Service Logic (`updateFile`):**
  1. Uses `File.findOneAndUpdate({ _id: fileId, userId }, { name: newFileName }, { new: true, runValidators: true }).lean()` as a single atomic operation.
  2. If no document matches (wrong ID or wrong owner), the result is `null` — throws `AppError` with `NOT_FOUND` and `FILE_NOT_FOUND`.
  3. `runValidators: true` ensures schema constraints (`minlength`, `trim`) are enforced on the new name.
  4. `.lean()` returns a plain object for efficient serialization.
  5. Returns the updated file document.

- **Response:**
  ```json
  {
    "success": true,
    "message": "File renamed successfully",
    "data": {
      "_id": "...",
      "name": "Updated Name.pdf",
      "extension": ".pdf",
      "size": 2457600,
      "parentDirId": "...",
      "userId": "...",
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
  ```

---

## 🚀 Performance & Scalability Considerations

### Single Atomic Query

Unlike the directory rename (which requires a separate query for the root directory guard), the file rename uses a single `findOneAndUpdate` — one database round-trip for both ownership verification and the update. The query's filter `{ _id, userId }` doubles as the ownership check: if either doesn't match, the result is `null`.

### No Physical File Rename Required

Since files are stored on disk using `<ObjectId><extension>` as the filename, renaming a file only updates the `name` field in MongoDB. The physical file on disk is unaffected — no filesystem rename, no race conditions, no broken references.

---

## 🛡️ Security Mechanisms

### Ownership-Scoped Queries

The `findOneAndUpdate` query includes `userId` in the filter. This ensures a user cannot rename another user's file even if they know the ObjectId — the query returns `null` and the service throws `NOT_FOUND`.

### Schema Validation on Update

`runValidators: true` re-applies Mongoose schema validators on the updated fields. Without this flag, `findOneAndUpdate` bypasses schema validation by default, which could allow invalid names (too short) to be saved.

### Input Validation at the Router (Zod)

`validateBody(renameFileSchema)` validates and sanitizes the body before the controller runs: `newFileName` must be a string, is reduced to its base name (`path.basename`, defusing traversal), stripped of control characters and backslashes, trimmed, and capped at 255 chars; an empty-after-sanitize value is rejected with `400 VALIDATION_ERROR`. Because the field is `z.string()`, operator-injection shapes like `{ $ne: "" }` are rejected before the service runs.

---
