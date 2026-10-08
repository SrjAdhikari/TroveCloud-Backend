# Directory Deletion Architecture

This document outlines the architecture, data flow, and security mechanisms behind the Trove backend's Directory deletion system, including descendant collection, atomic database cleanup, and stored-object removal.

## 🏗️ Architecture

The Directory deletion logic adheres to the Controller-Service pattern, with authentication and validation enforced at the router level before any handler executes.

- **Authentication (`auth.middleware.js`)**: Applied router-wide via `directoryRouter.use(authenticate)`. Every directory endpoint requires a valid session — unauthenticated requests are rejected before reaching any controller.
- **Middleware (`validate.middleware.js`)**: `validateId` is registered via `router.param()` on `id`. Validates MongoDB ObjectId format using `isValidObjectId`, throwing a `BAD_REQUEST` error before the request reaches the controller.
- **Controller (`directory.controller.js`)**: Extracts route parameters, delegates to the Service layer. Contains zero business logic or database access.
- **Service (`directory.service.js`)**: Orchestrates the full deletion pipeline — descendant collection, atomic DB deletes, and stored-object cleanup.

---

## 🛣️ API Endpoints

### 1. Delete a Directory and All Its Contents

- **Route:** `DELETE /api/directories/:id`
- **Params:** `id` (required) — MongoDB ObjectId of the directory to delete
- **Authentication:** Required (session-based)
- **Flow:**
  1. `authenticate` middleware validates the user's session and populates `req.user`.
  2. `validateId` middleware confirms `:id` is a valid ObjectId format.
  3. Controller calls `deleteDirectory(directoryId, userId)` in the Service layer.
  4. Returns the deleted directory document.

- **Service Logic (`deleteDirectory`):**
  1. Finds the directory with `Directory.findOne({ _id: directoryId, userId })`. If none matches, throws `AppError` with `NOT_FOUND` and `DIRECTORY_NOT_FOUND`.
  2. **Edge Case Handled:** If the target directory has no `parentDirId` (i.e., it's the root directory), throws `AppError` with `BAD_REQUEST` and `DIRECTORY_DELETE_FAILED`. Root directories are permanent and cannot be deleted.
  3. Collects the directory and all its descendants with `Directory.find({ userId, ancestorIds: rootDir._id })`, then builds `allDirIds` (target + descendants).
  4. Fetches all files within those directories via `File.find({ parentDirId: { $in: allDirIds }, userId })`, including their `objectKey`.
  5. **Upload Check:** If any file is not `ready` and its upload deadline (`uploadExpiresAt`) has not passed, throws `AppError` with `CONFLICT` and `UPLOAD_IN_PROGRESS`. A pending upload past its deadline does not block. The same check repeats inside the transaction.
  6. **Atomic DB Deletion:** Within a `session.withTransaction()`, repeats the upload check, reads the root directory's current `size` and `fileCount` (`currentTotals`), deletes all file and directory records, then calls `updateAncestorDirectoryStats(rootDir.parentDirId, { bytes: -(currentTotals?.size ?? 0), files: -(currentTotals?.fileCount ?? 0), folders: -allDirIds.length }, session)` to subtract the deleted subtree's totals from every ancestor folder above it. If any step fails, all roll back together.
  7. **Object Cleanup:** After the DB transaction commits, calls `removeObjects` to delete the files' R2 objects in batches of up to 1000 keys. Failures here do not roll back the DB operation — orphaned objects are less harmful than phantom DB records.
  8. Returns the deleted root directory document.

- **Response:**
  ```json
  {
    "success": true,
    "message": "Directory deleted successfully",
    "data": {
      "_id": "...",
      "name": "...",
      "parentDirId": "...",
      "userId": "...",
      "subDirectories": [{ "_id": "...", "name": "..." }]
    }
  }
  ```

---

## 🔄 Descendant Collection (`ancestorIds`)

Every directory stores `ancestorIds`, the IDs of its ancestors (not itself). `deleteDirectory` collects the whole subtree in one query:

```js
Directory.find({ userId, ancestorIds: rootDir._id }, "_id")
```

- Matches every descendant at any depth, so there is no depth limit.
- Filters on `userId`, so only the authenticated user's directories are collected.
- Returns only `_id`; the target directory's own ID is added to form `allDirIds`.

---

## 🚀 Performance & Scalability Considerations

### Atomic Transactions with `session.withTransaction()`

File and directory `deleteMany` operations — plus the `updateAncestorDirectoryStats` ancestor-counter decrement — run inside a single transaction. If any operation fails, all roll back, preventing partial deletes where files exist without their parent directory, or ancestor `size`/`fileCount`/`folderCount` totals drift out of sync with what was actually removed.

### Session Lifecycle Safety

The session is wrapped in `try/finally` to guarantee `session.endSession()` runs even if the transaction throws. This prevents session leaks that could exhaust MongoDB's connection pool.

### DB-First, Objects-Second Deletion Order

Object deletion happens **after** the DB transaction succeeds. This ordering ensures:
- If the DB transaction fails, no stored objects are lost.
- If object deletion fails, the DB is already clean — orphaned objects in R2 are a minor cleanup task, not a data integrity issue.

### `removeObjects` for Object Cleanup

`removeObjects` (`src/services/file/objectCleanup.service.js`) never throws. Keys that are not valid storage keys are skipped with a warning. The rest go to R2 in requests of up to 1000 keys, each batch on its own, so a failed batch doesn't stop the later ones. Warnings never include the key: a skipped key names its label, a failed object names its label and error code, and a failed batch gives its size, error name and status.

---

## 🛡️ Security Mechanisms

### Root Directory Deletion Guard

The service explicitly checks `!rootDir.parentDirId` before proceeding. Root directories (created during user registration, `parentDirId: null`) are permanent anchors of the user's file tree and cannot be deleted.

### Ownership-Scoped Queries at Every Level

- The descendant lookup filters on `userId` — only the authenticated user's directories are collected.
- The `File.find` query includes `userId` in the filter — even though parent directories are already verified.
- The `deleteMany` operations include `userId` in the filter — defense-in-depth against IDOR attacks.

### Object Key Check

`removeObjects` only deletes keys that match the app's generated key format. Any other key is skipped with a warning.

### Input Validation at Router Level

`router.param('id', validateId)` intercepts invalid ObjectId strings before they reach the controller. This prevents Mongoose `CastError` crashes and avoids sending malformed queries to the database.

---
