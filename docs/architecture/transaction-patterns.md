# Transaction Patterns

> **Status:** As-built (2026-09-10). Documents the MongoDB transaction usage across the codebase: Google OAuth, the shared OAuth helper, password reset, authenticated password change, admin suspend / soft-delete / hard-delete, denormalized folder-size maintenance, the per-user storage-quota check and byte reservation on upload, the compensating transactions that release reservations, and recursive folder-count maintenance. Used in `verifyOTP` since the original auth implementation.

Captures a subtle pattern that recurs across the codebase: when a flow needs to **atomically commit two or more cross-document writes** (User + Directory creation, User update + Session wipe, multi-collection user purge, a file write + its ancestor folder-counter updates), the database writes happen inside a `withTransaction` block. Where a flow also issues a `Session`, that **`Session.create` happens outside the transaction**. Where a flow also performs non-idempotent side effects in object storage, **those happen outside the transaction too**. This document explains why, and what to do if a new call site needs the same shape.

---

## 🏗️ The Pattern

```js
const mongooseSession = await mongoose.startSession();
const rootDirId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

try {
	await mongooseSession.withTransaction(async () => {
		await User.create([{ _id: userId /* ... */ }], {
			session: mongooseSession,
		});
		await Directory.create(
			[{ _id: rootDirId, name: `root-${email}`, userId, parentDirId: null }],
			{ session: mongooseSession },
		);
	});
} finally {
	await mongooseSession.endSession();
}

// Session.create runs OUTSIDE the transaction
const session = await Session.create({ userId, deviceInfo });
```

Two important shapes here:

1. **IDs generated up front.** `userId` and `rootDirId` are `new mongoose.Types.ObjectId()` calls _before_ the transaction opens, so they're available for the cross-document references (`User.rootDirId` → `Directory._id`, `Directory.userId` → `User._id`) at insert time. No round trip to discover an inserted ID.
2. **Session.create is outside the transaction.** This is the non-obvious part — see the next section.

---

## 🧭 Why Session.create is Outside

Mongoose's `withTransaction` automatically retries the callback on **transient transaction errors** — typically `WriteConflict` errors when two transactions touched the same documents concurrently. The retry behavior is unconditional and silent: if a conflict happens, the entire callback runs again from the top, and the previous attempt's writes (which were rolled back) are repeated.

If `Session.create` were inside the transaction:

- A retry would run `Session.create({ userId, deviceInfo })` a second time.
- Even though Session.create itself doesn't conflict (each session is a fresh document), the retry would create **two session documents** for one sign-in attempt.
- The user's cookie would only point to the second session; the first would be orphaned, never cleaned up except by the natural TTL.

Putting `Session.create` after `withTransaction` returns guarantees it runs exactly once per sign-in, regardless of how many times the User+Directory transaction had to retry.

The User and Directory writes inside the transaction are safe to retry because:

- Both inserts use **explicit IDs we generated**. A retry uses the same IDs. The second attempt either finds the documents already there (because the previous attempt actually committed before rollback) — which would error and abort the retry cleanly — or successfully inserts them.
- Mongoose's transaction wrapper handles the rollback semantics; if the callback throws on retry, the transaction aborts cleanly.

---

## 🔄 The Flow

### Happy path

1. Generate `userId` and (where applicable) `rootDirId`.
2. Open `withTransaction`.
3. Insert User (with the generated `_id`, plus `rootDirId` reference).
4. Insert Directory (with the generated `_id`, plus `userId` reference).
5. Transaction commits. Both documents are now persisted atomically.
6. Outside the transaction, create the Session.
7. Return `{ session, isNewUser: true }` to the caller.

### Failure modes

| Where it fails                                          | What rolls back                                                           | What persists                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| User.create throws                                      | Nothing was committed; rollback is automatic (transaction aborts)         | Nothing                                                     |
| Directory.create throws after User.create               | User insert is rolled back (still inside the transaction)                 | Nothing                                                     |
| Transaction commit succeeds, then Session.create throws | Nothing rolls back — User + Directory are persisted, no Session exists    | User + Directory; user has an account but no active session |
| Network blip during transaction                         | `withTransaction` retries automatically; if retries are exhausted, throws | Same as "transaction commit fails" — nothing                |

The "transaction commits, Session.create fails" case is the only one with **partial success**. It's recoverable — the user can simply re-attempt sign-in, hit the existing-user path of `loginOrCreateOAuthUser`, and get a session for the already-provisioned account. Acceptable trade-off.

---

## 📍 Where It's Used

Call sites in the codebase (as of 2026-06-13):

### 1. `verifyOTP` in `src/services/auth.service.js`

When an unverified email-password user enters the correct OTP, the verification flips `isVerified: true` AND creates the user's root Directory in one transaction. Pattern is identical except: the User already exists (it's being mutated, not inserted), so `user.save({ session })` is used instead of `User.create([...], { session })`. The Session is not created in this flow at all — verification is separate from login.

### 2. `loginOrCreateOAuthUser` in `src/services/oauth.service.js` (new-user branch)

When a Google or GitHub OAuth sign-in is the user's first interaction, both User and Directory are inserted via the pattern above. Then Session.create runs outside. Used for both providers via the shared helper.

### 3. `resetPassword` in `src/services/auth.service.js`

When a user submits a valid reset OTP, the password is updated AND every active session is wiped in one transaction:

```js
const session = await mongoose.startSession();
try {
    await session.withTransaction(async () => {
        user.password = newPassword;
        user.otp = undefined;
        user.otpExpiresAt = undefined;
        await user.save({ session });
        await Session.deleteMany({ userId: user._id }, { session });
    });
} finally {
    await session.endSession();
}
```

If `Session.deleteMany` fails after `user.save`, the whole thing rolls back — the password change is reverted and the OTP fields stay populated, so the user can retry the same call cleanly with the same code. Without the transaction, a partial failure would leave the password updated but old sessions alive and the OTP consumed — a worse recovery story for the user.

### 4. `changePassword` in `src/services/auth.service.js`

The authenticated counterpart to `resetPassword`. After verifying the current password, the new password is set AND every **other** session is revoked in one transaction:

```js
const session = await mongoose.startSession();
try {
    await session.withTransaction(async () => {
        user.password = newPassword;
        await user.save({ session });
        await Session.deleteMany(
            { userId: user._id, _id: { $ne: currentSessionId } },
            { session },
        );
    });
} finally {
    await session.endSession();
}
```

The only structural difference from `resetPassword` is the `_id: { $ne: currentSessionId }` filter: the device that performed the change stays signed in, while all other sessions are wiped. Same retry-safety story — both writes are idempotent under a `WriteConflict` replay (the password re-hash and the scoped delete re-apply cleanly). See [`../authentication/change-password.md`](../authentication/change-password.md) for the surrounding flow and why the current session is preserved.

### 5. `suspendUser` in `src/services/admin/user.service.js`

Setting `suspendedAt = now` and revoking every active session for the target need to land together — a half-applied suspension where the timestamp is set but the user's existing sessions stay alive would leave the locked-out user temporarily able to use the app until those sessions expire on their own. Same shape as `resetPassword`: `user.save({ session })` plus `Session.deleteMany({ userId }, { session })`.

### 6. `softDeleteUser` in `src/services/admin/user.service.js`

Mirror image of suspend: set `deletedAt = now` and `Session.deleteMany` for the target in one transaction. Files and directories deliberately stay until hard-delete or restore.

### 7. `hardDeleteUser` in `src/services/admin/user.service.js`

The widest transaction in the codebase — a four-collection wipe (`Session.deleteMany` → `File.deleteMany` → `Directory.deleteMany` → `User.deleteOne`) all keyed by `userId`. Inside the same transaction, a pre-read `File.find({ userId }, "_id objectKey", { session })` snapshots the object keys to remove, and a second read picks up the user's `profilePictureKey`; both are captured into closure variables. Reading the avatar key inside the transaction rather than from the document fetched earlier is what makes a concurrent replace safe — that write conflicts with the `User.deleteOne` here, and the retry sees the new key.

**Object cleanup happens outside the transaction** via `Promise.allSettled` over one list holding both the file objects and the avatar object, each entry carrying a label so a failure names the right thing. Same reasoning as Session.create being outside: dropping an object is a side effect against R2, and `withTransaction`'s automatic retries would re-issue the deletes on a `WriteConflict`. `allSettled` ensures one failed delete doesn't stop the others from running; rejected promises are warn-logged but never re-thrown — the DB is the source of truth and orphaned bytes are reconcilable later.

### 8. Folder-stats maintenance in `src/services/file.service.js` and `src/services/directory.service.js`

Every directory stores denormalized `size`/`fileCount`/`folderCount` for its whole subtree, kept correct on each write inside a transaction. The shared primitive is `updateAncestorDirectoryStats(startDirId, { bytes, files, folders }, session)` in `directory.service.js` (renamed from `adjustAncestorStats`), which walks the `parentDirId` chain to the root and `$inc`s each ancestor:

- **`initiateUpload`** mints the file `_id` and its object key up front, then inside the transaction enforces the quota via `checkQuota`, does `File.create([{ _id, size, status: "pending", ... }], { session })`, and calls `updateAncestorDirectoryStats(parentDirId, { bytes, files: 1 }, session)`. The bytes are reserved before they exist — that is what makes the quota enforceable against an upload the server never sees. Presigning happens **outside** the transaction (a non-retryable side effect); if it fails the reservation is released in a follow-up transaction. Retry-safe for the same reason as the User+Directory pattern: the fixed `_id` and the constant delta re-apply cleanly after a `WriteConflict` rollback.
- **`uploadFileFromServer`** takes **two** transactions on the server-held-bytes path, with the stream to R2 in between. The first commits a `pending` row carrying the final `objectKey` and `size: 0`, paired with `updateAncestorDirectoryStats(parentDirId, { bytes: 0, files: 1 }, session)` — it claims a file slot for the key before the object exists, so no object can ever be written that no row names. The second runs once the byte counter has the real size: `checkQuota`, a compare-and-set from `pending` to `ready` with the counted `size`, and `updateAncestorDirectoryStats(parentDirId, { bytes }, session)`. The split is forced by the stream, which is neither retry-safe nor time-bounded and so cannot sit inside either one.
- **`releaseExpiredFiles`** refunds abandoned reservations, and runs at the **start** of both upload paths in a transaction of its own that commits before the minting transaction opens. Keeping it separate is the whole point: sharing a transaction with the reservation would let a rejected `checkQuota` roll the refund back too, and the reclaimed headroom would never become visible. It deletes up to `MAX_EXPIRED_FILES_PER_SWEEP` (25) expired `pending` rows per call — each via a `{ _id, userId, status: "pending" }`-scoped `deleteOne` whose `deletedCount` gates the paired inverse `updateAncestorDirectoryStats` — and returns the deleted rows so their objects can be dropped **after** the commit. An aborted sweep returns an empty list instead of the collected one: dropping an object for a row the rollback restored would strand a live document naming an absent key.
- **`confirmUpload`** deliberately uses **no** transaction. Promoting a pending upload is a single-document compare-and-set, which is already atomic; a session would be dead weight on the upload hot path.
- **`deleteFile`** does `File.deleteOne({ _id, userId }, { session })` plus the inverse `updateAncestorDirectoryStats(parentDirId, { bytes: -size, files: -1 }, session)` inside the transaction, with the decrement gated on `deletedCount === 1` so a delete that races another delete of the same file cannot refund its bytes twice; the object delete happens **after** commit (DB is the source of truth — same "side effects outside" rule).
- **`deleteDirectory`**'s existing delete transaction gained one more in-transaction step: it re-reads the subtree's stored totals **inside** the transaction and subtracts those — `updateAncestorDirectoryStats(rootDir.parentDirId, { bytes: -(currentTotals?.size ?? 0), files: -(currentTotals?.fileCount ?? 0), folders: -allDirIds.length }, session)`. Re-reading inside rather than trusting a snapshot taken before the transaction is what keeps the refund correct when a `WriteConflict` retries the block against a subtree that changed underneath it.
- **`createDirectory`** became transactional: it inserts the new folder with `Directory.create([{ ... }], { session })` and pairs it with `updateAncestorDirectoryStats(parentDirId, { folders: 1 }, session)`, bumping every ancestor's `folderCount`. The walk starts at the parent, so the new folder's own `folderCount` stays at the schema default `0`. It does no disk I/O, so nothing sits outside the transaction.

`updateAncestorDirectoryStats` is intentionally **not** `userId`-scoped: every `parentDirId` points to a same-user directory by construction (`createDirectory` verifies ownership before linking; there is no move/re-parent feature), so the ancestor walk cannot cross tenants.

The call sites are **structurally similar but not identical**. `verifyOTP`, `resetPassword`, `changePassword`, `suspendUser`, and `softDeleteUser` all mutate an existing user; `changePassword` adds the one variation of a **scoped** session wipe (`$ne` the current session) where the others wipe all or none; OAuth new-user creates a fresh one; `hardDeleteUser` is the multi-collection variant that also performs irreversible object deletes outside the transaction; the folder-size sites pair a single `File` write/delete with a multi-document `$inc` across the ancestor chain, again keeping object-store I/O outside. The upload sites add one further variation: `initiateUpload` commits a byte reservation for content that does not exist yet, so its transaction is followed by an external side effect (presigning) whose failure must be undone by a second, compensating transaction rather than by a rollback. The "Session.create outside" and "object cleanup outside" rules are the same principle — anything that isn't safely retry-able stays out. A premature abstraction extracting them into a single helper would have to branch on "create vs update", "single vs cross-collection", and "with vs without external side effects" inside, which is exactly the kind of false-DRY that makes code worse. The pattern is documented; the call sites stay separate.

---

## ⚙️ Mongoose Mechanics

A few details worth knowing if you're new to MongoDB transactions in Mongoose:

- **`withTransaction` requires a replica set.** MongoDB transactions only work against a replica-set deployment, not a standalone `mongod`. Atlas clusters (free or paid) are replica sets by default. Local development typically uses `mongodb://localhost:27017/...` against a standalone — that will throw on transaction calls. Solution: Atlas (recommended) or a local replica set via `mongodb-memory-server-replica-set` for tests.
- **`{ session }` option must be passed to every operation inside the transaction.** Mongoose does not infer it from the surrounding `withTransaction` callback. Forgetting to pass `{ session }` on a `User.create` or `Directory.create` means that write **does not participate in the transaction** — it commits independently and is not rolled back if the rest of the transaction fails. Subtle and dangerous; double-check on review.
- **Use `.create([...], { session })` (array form), not `.create({...}, { session })`.** Mongoose's `Model.create` has two signatures: `create(docs, options)` where `docs` is an array, or `create(doc, callback)` for backwards compat. Passing `{ session }` as the second argument to a single-doc `create` works in some versions and silently fails in others. The array form is unambiguous.
- **Always `endSession()` in `finally`.** Sessions are connection resources; not releasing them leaks. The `try/finally` wrapping is mandatory, not optional.

---

## 🚧 Non-Goals

- **Distributed transactions across services.** Out of scope. The pattern is single-database, single-replica-set.
- **Long-lived transactions.** Each transaction is short — at most two `create` calls. MongoDB transactions have a 60-second default lifetime, but anything more than a few hundred ms is suspect.
- **Optimistic concurrency control on User documents.** No `__v`-based optimistic locking is enforced beyond Mongoose defaults. Concurrent writes to the same user from different requests will land last-write-wins.
- **Cross-collection cascading deletes via transactions.** `directory.service.js`'s recursive delete uses a transaction for the `File` + `Directory` deletes but performs object cleanup outside (with `Promise.allSettled`). Same principle as Session.create being outside — anything that's not safely retry-able stays out.

---

## 📌 Project Context

### Current call sites

- `src/services/auth.service.js` — `verifyOTP` (since project inception)
- `src/services/oauth.service.js` — `loginOrCreateOAuthUser` new-user branch
- `src/services/auth.service.js` — `resetPassword` (password update + full session wipe atomic)
- `src/services/auth.service.js` — `changePassword` (password update + wipe of all **other** sessions atomic, current preserved)
- `src/services/admin/user.service.js` — `suspendUser` (suspendedAt + session wipe atomic)
- `src/services/admin/user.service.js` — `softDeleteUser` (deletedAt + session wipe atomic)
- `src/services/admin/user.service.js` — `hardDeleteUser` (multi-collection wipe inside the transaction, object cleanup outside via `Promise.allSettled`)
- `src/services/directory.service.js` — `createDirectory` (inserts the new folder + an ancestor `folderCount` `$inc` inside the transaction)
- `src/services/directory.service.js` — recursive directory delete (separate pattern; transaction wraps DB deletes + an `updateAncestorDirectoryStats` ancestor decrement, object cleanup happens outside via `Promise.allSettled`)
- `src/services/file.service.js` — `initiateUpload`, `uploadFileFromServer` and `deleteFile` (a `File` create/delete plus an `updateAncestorDirectoryStats` ancestor `$inc` inside the transaction, with object-store I/O kept outside — presign or stream before on upload, object delete after on delete). Both upload paths also read the root-directory `size` and enforce the per-user storage quota inside a transaction — because that quota read shares the root doc the ancestor `$inc` writes, two concurrent uploads write-conflict on it and `withTransaction` retries the loser against the fresh size, so the cap holds without an explicit lock. `uploadFileFromServer` splits its work across two transactions (claim the row, then promote it against the counted size) since the stream between them can retry-unsafely fail.
- `src/services/file.service.js` — `releaseExpiredFiles` and `releaseReservedBytes` (compensating transactions that delete a `pending` row and apply the inverse `updateAncestorDirectoryStats`). `releaseExpiredFiles` runs ahead of both upload paths and must commit before their transactions open; `releaseReservedBytes` undoes a single reservation when the step that followed it failed — presigning, the stream to R2, or the promoting transaction itself, which includes a quota rejection. Both swallow their own errors: a refund that cannot commit is warn-logged and retried by the next upload, never surfaced as the caller's error.

### Deployment requirement

Production MongoDB must be a replica set. Current target is MongoDB Atlas, which is replica-set by default on every tier.

### When to add a new transaction

If a future feature needs to atomically create or mutate two or more documents that reference each other, it should adopt this pattern. Examples that might need it later:

- Sharing a directory with another user (creates a `Permission` document; updates the shared-with user's view metadata).
- Atomic file move across directories (the move plus any associated audit log entry).

If the feature also needs to create a Session as a side effect, follow the "Session outside" rule.

---
