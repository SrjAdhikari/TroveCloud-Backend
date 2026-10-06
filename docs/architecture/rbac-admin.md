# RBAC + Admin v1

> **Status:** As-built (2026-05-15). Implementation reference for the RBAC + admin subsystem. Covers the foundation + read endpoints, the mutation endpoints, Vitest setup, and the suspended/deleted login gate.

## Context

Before this work, TroveCloud had no concept of privileged users. Every authenticated request was treated identically and ownership was enforced per-resource via `{ _id, userId }` query filters in the service layer. There were no admin endpoints, no role field on `User`, and no audit log.

This subsystem introduces **Role-Based Access Control (RBAC)** with three roles (`user | admin | superadmin`) and the first set of admin endpoints needed to operate the platform: list users, view details, force-logout, suspend/unsuspend, change roles, soft-delete + restore, hard-delete, and a system overview dashboard. An admin audit log is deliberately **not** part of v1; see "Out of scope" for the rationale.

The intent is to lay the **foundation** for future admin tooling cleanly — extending the role enum, adding new admin endpoints, or migrating to fine-grained permissions later should all be small follow-ups, not rewrites.

---

## Scope

**In scope (v1):**
- Role field on `User` with hierarchy: `superadmin > admin > user`
- Suspension state on `User` tracked via `suspendedAt` / `suspendedBy` timestamps (status is derived, not stored)
- 10 admin endpoints under `/api/admin/*`
- CLI seed script to create the first superadmin
- `authorize` middleware (role-aware) layered on top of existing `authenticate`
- `authenticate` middleware updated to reject suspended and soft-deleted users (`suspendedAt`/`deletedAt` checks); the populated `req.user` carries `role`/`suspendedAt`/`deletedAt` automatically
- Backfill of `role: 'user'`, `suspendedAt: null`, `deletedAt: null` on existing users (idempotent, runs from seed script)
- Atlas schema mirror documented as a manual deploy step

**Explicitly out of scope (deferred):**
- **Admin audit log (`AdminAuditLog` collection + `GET /admin/audit` endpoint + write call sites).** Deferred to a follow-up PR. Rationale: at single-admin scale the "who did what" trail collapses to "I did it." When a second admin is onboarded — or a compliance posture is needed — re-add as PR 3. The mutation handlers will need to be re-touched to wire in audit writes, but each touch is small.
- Fine-grained permissions array (revisit if multiple admin tiers ever need to be split)
- ~~Rate limiting on admin routes (deferred globally)~~ — **implemented**: admin reads use the `read` tier, mutations the `mutation` / `destructive` tiers, hard-delete the `hardDelete` tier (`src/middlewares/rateLimit.middleware.js`)
- Zod validation (deferred globally)
- Overview time-series, charts, signup funnels — v1 is point-in-time counters only
- Email notifications to suspended/deleted users
- Cron sweeper for soft-deleted users → hard-delete after retention window

---

## Locked design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Role model | Single enum: `user / admin / superadmin` | Smallest model that fits the use case; permissions array can be retrofitted later in ~50 LOC. |
| Hierarchy | `superadmin > admin > user`. Higher passes lower role checks. | Industry-standard semantics. `requireRole('admin')` accepts both admin and superadmin. |
| Bootstrap | One-time CLI seed script: `npm run seed:superadmin -- --email=x@y.com` | SaaS-deploy pattern. Explicit, auditable, no runtime cost, idempotent. |
| Suspend semantics | Block new logins **and** revoke all active sessions immediately | Industry standard (Slack/Linear-style). Suspended user is fully locked out. |
| Self-action rules | Cannot suspend/demote/soft-delete/purge **self**. Force-logout self is allowed (harmless). | Prevents accidental self-lockout. |
| Single-role topology | This deployment runs exactly **one** superadmin and **one** admin (operational invariant, not code-enforced). | Lets the service layer skip multi-superadmin defenses (last-superadmin count guard, TOCTOU race transactions) that would otherwise add complexity for scenarios that can't arise. If multiple superadmins are ever introduced, re-add the count guard at the time. |
| v1 privilege split | **Reads + force-logout: `admin` & `superadmin`. All mutations (role / suspend / unsuspend / soft-delete / hard-delete / restore): `superadmin` only.** | Conservative v1 posture: admins get visibility and the ability to punt active sessions; only superadmins can permanently alter account state. Service-layer `assertCanActOn` remains the second line of defense if the route gates are ever loosened. |
| Hierarchy enforcement (service layer) | Caller must outrank target. Same-rank or higher target → `CANNOT_ACT_ON_PEER`. Enforced in services even when the route gate already restricts the caller, so a future relaxation of route gates can't quietly grant peer-on-peer actions. | Defense in depth. |
| Hard-delete cascade | Wipe `User`, `File`, `Directory`, `Session` (DB) + physical disk files. | Irreversible by design — this is the only place admin-driven disk space is freed. |
| Code organization | `src/routes/admin/`, `src/controllers/admin/`, `src/services/admin/` | Mirrors existing layer discipline; isolates admin surface for future review/permission tightening. |

---

## Data model

### `User` schema additions (`src/models/user.model.js`)

```js
role: {
  type: String,
  enum: Object.values(ROLES),          // ['user', 'admin', 'superadmin']
  default: ROLES.USER,
  required: true,
  index: true,                          // queried in admin user list + last-superadmin guard
},
suspendedAt: {
  type: Date,
  default: null,
  index: true,                          // queried in authenticate (reject if suspended) + list filtering
},
suspendedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
deletedAt: {
  type: Date,
  default: null,
  index: true,                          // queried in authenticate (reject if deleted) + list filtering
},
```

**Status is derived, not stored.** A small helper in `src/utils/userStatus.js`:

```js
export const USER_STATUS = Object.freeze({
  ACTIVE:    'active',
  SUSPENDED: 'suspended',
  DELETED:   'deleted',
});

export const getUserStatus = (user) => {
  if (user.deletedAt)   return USER_STATUS.DELETED;
  if (user.suspendedAt) return USER_STATUS.SUSPENDED;
  return USER_STATUS.ACTIVE;
};
```

Single source of truth — the timestamps. Status is computed on the fly for API responses and filtering. There is no `status` field on the User schema; storing one would duplicate information already carried by `suspendedAt`/`deletedAt` and create a class of "field drifted out of sync with timestamp" bugs by construction.

> **All four new fields (`role`, `suspendedAt`, `suspendedBy`, `deletedAt`) are introduced in this work** — none exist today. The project's STACK.md declares `deletedAt` as the soft-delete convention, but no model in `src/models/` uses it yet. This change introduces it for User; File and Directory continue with their existing (hard-delete) behavior until a future soft-delete pass.

> **Atlas mirror required** per STACK.md — apply the same fields with matching validators in MongoDB Atlas after merge.

---

## File placement

| File | Path | Type | Purpose |
|---|---|---|---|
| Role constants | `src/constants/roles.js` | New | Frozen `ROLES` enum |
| User status helper | `src/utils/userStatus.js` | New | Exports `USER_STATUS` constants + `getUserStatus(user)` derived-status helper |
| Authorize middleware | `src/middlewares/authorize.middleware.js` | New | `requireRole(role)`, `requireSuperadmin()`, helpers for hierarchy + self-action checks |
| Auth middleware | `src/middlewares/auth.middleware.js` | Modified | Hydrate `role`/`suspendedAt`/`deletedAt`; reject suspended (`suspendedAt != null`) and deleted (`deletedAt != null`) accounts |
| User model | `src/models/user.model.js` | Modified | Add `role`, `suspendedAt`, `suspendedBy`, `deletedAt` |
| Admin user router | `src/routes/admin/user.routes.js` | New | Mounts user-related admin endpoints |
| Admin overview router | `src/routes/admin/overview.routes.js` | New | Mounts the system-overview endpoint |
| Admin index router | `src/routes/admin/index.js` | New | Mounts the two above under `/admin` |
| Root routes index | `src/routes/index.js` | Modified | Mount `/admin` router |
| Admin user controller | `src/controllers/admin/user.controller.js` | New | List/detail/suspend/unsuspend/role/logout-all/soft-delete/purge handlers |
| Admin overview controller | `src/controllers/admin/overview.controller.js` | New | Overview handler |
| Admin user service | `src/services/admin/user.service.js` | New | Business logic for user admin actions + cascades |
| Admin overview service | `src/services/admin/overview.service.js` | New | System-wide aggregations (counts, totals, recent-signup window) |
| Storage cleanup helper | (reuse existing if present, else `src/utils/storage.cleanup.js`) | Reuse / New | Wipes a user's physical files from disk during purge. Reuse whatever `src/services/file/file.service.js` uses for delete today; do not reinvent. |
| App error codes | `src/constants/appErrorCode.js` | Modified | Add `ACCOUNT_SUSPENDED`, `CANNOT_ACT_ON_SELF`, `CANNOT_ACT_ON_PEER`, `LAST_SUPERADMIN`, `INSUFFICIENT_ROLE`. `ACCESS_DENIED` already exists. |
| Seed script | `scripts/seed-superadmin.js` | New | CLI: backfill missing `role`/`suspendedAt`/`deletedAt` fields, then promote target user to superadmin |
| `package.json` | `package.json` | Modified | Add `"seed:superadmin": "node scripts/seed-superadmin.js"` |

---

## Endpoint specifications

All admin routes are mounted under `/api/admin`, require `authenticate` + `requireRole('admin')`. Suspended/soft-deleted users are rejected by `authenticate` before the role check fires.

**v1 access matrix:**

| Endpoint | `admin` | `superadmin` |
|---|---|---|
| `GET /admin/users` (list) | ✓ | ✓ |
| `GET /admin/users/:id` (detail) | ✓ | ✓ |
| `GET /admin/overview` | ✓ | ✓ |
| `POST /admin/users/:id/logout` (force-logout) | ✓ | ✓ |
| `PATCH /admin/users/:id/role` | ✗ | ✓ |
| `PATCH /admin/users/:id/suspend` | ✗ | ✓ |
| `PATCH /admin/users/:id/unsuspend` | ✗ | ✓ |
| `DELETE /admin/users/:id/soft-delete` | ✗ | ✓ |
| `DELETE /admin/users/:id/hard-delete` | ✗ | ✓ |
| `POST /admin/users/:id/restore` | ✗ | ✓ |

The route layer enforces this via per-route `requireSuperadmin()` middleware on each mutation. The service layer's `assertCanActOn` still runs and enforces the strict hierarchy as defense-in-depth — so even if the route gates are ever relaxed, a same-rank action returns `CANNOT_ACT_ON_PEER`.

### `GET /api/admin/users`
Paginated user list.
- **Query:** `page` (default 1), `limit` (default 20, max 100), `q` (search email/name, case-insensitive), `role` (filter), `status` (one of `active | suspended | deleted`), `includeDeleted` (default false — when true, the `deleted` status is included in results regardless of the `status` filter being absent).
- **Status filter maps to timestamp predicates:**
  - `status=active`    → `{ suspendedAt: null, deletedAt: null }`
  - `status=suspended` → `{ suspendedAt: { $ne: null }, deletedAt: null }`
  - `status=deleted`   → `{ deletedAt: { $ne: null } }`
- **Response:** `{ items: [...], pagination: { page, limit, total, totalPages } }`. Each item has a computed `status` field via `getUserStatus(user)`.
- Excludes `password`, `otp`, etc. (schema-level `select: false`).

### `GET /api/admin/users/:id`
Single user detail with computed fields: storage used (sum of `File.size` where `userId === :id`), file count, directory count, active session count, last login (from most recent `Session.createdAt`).

### `GET /api/admin/overview`

**Scope: system-wide, not per-user.** This is the "admin dashboard home" endpoint — point-in-time aggregates across the entire platform. Contrast with the two preceding endpoints:

| Endpoint | Scope | Answers... |
|---|---|---|
| `GET /admin/users` | All users (paginated) | "Show me everyone on the platform" |
| `GET /admin/users/:id` | One specific user | "Tell me everything about user X" |
| `GET /admin/overview` | **The whole system** | "How is the platform doing overall?" |

Each `users.*` count is computed from timestamps, not a stored status field:
```json
{
  "users":   { "total": N, "active": N, "suspended": N, "softDeleted": N,
               "byRole": { "user": N, "admin": N, "superadmin": N } },
  "storage": { "totalBytes": N, "totalFiles": N, "totalDirectories": N },
  "signups": { "last7d": N, "last30d": N },
  "sessions":{ "active": N }
}
```
- `users.active`      = `countDocuments({ suspendedAt: null, deletedAt: null })`
- `users.suspended`   = `countDocuments({ suspendedAt: { $ne: null }, deletedAt: null })`
- `users.softDeleted` = `countDocuments({ deletedAt: { $ne: null } })`
- `users.byRole.<role>` = `countDocuments({ role: <role>, deletedAt: null })` — counts users with the given role **excluding soft-deleted**. Suspended users are still counted. Sum of `byRole.*` equals `total − softDeleted` (i.e. `active + suspended`). This matches the operational reading of "how many admins/superadmins exist on the platform right now?" and the population PR 2's last-superadmin guard counts against.

### `PATCH /api/admin/users/:id/role` — **superadmin only**
- **Body:** `{ role: 'user' | 'admin' | 'superadmin' }`.
- **Pre-checks:**
  1. Caller is superadmin (route gate).
  2. Target is not the caller (no self-demote).
  3. Target is not soft-deleted.
- **Side effects:** none beyond the role write. Role is read from `req.user.role` per request, so the change is effective on the next request without session revocation. (If a compromised-account scenario is suspected, the superadmin can additionally call force-logout — explicit and auditable.)

### `PATCH /api/admin/users/:id/suspend` — **superadmin only**
- **Pre-checks:** target is not self; caller outranks target (service-layer defense-in-depth); target is not already suspended (`suspendedAt == null`); target is not soft-deleted (`deletedAt == null`).
- **Side effects (wrapped in `session.withTransaction()` per STACK.md):** set `suspendedAt = now`, `suspendedBy = caller._id`; revoke all active sessions for target.
- **Response:** the updated user document with derived `status`.

### `PATCH /api/admin/users/:id/unsuspend` — **superadmin only**
- **Pre-checks:** target is currently suspended (`suspendedAt != null`); caller outranks target; target is not soft-deleted.
- **Side effects:** clear `suspendedAt = null`, `suspendedBy = null`. Sessions are **not** restored — the user logs in fresh.

### `POST /api/admin/users/:id/logout`
Force-revoke every active session for the target. Lighter than suspend — user can log back in immediately.
- **Pre-checks:** target is self (always allowed — harmless), OR caller role **strictly greater than** target role. Admins **cannot** force-logout other admins (apply the strict hierarchy consistently); only superadmin can. Target must not be soft-deleted.
- **Side effects:** `Session.deleteMany({ userId: target._id })`.
- **Response:** `{ sessionsRevoked: N }`.

### `DELETE /api/admin/users/:id/soft-delete` — **superadmin only**
Soft delete. Sets `deletedAt`. Cascades to revoking sessions only (files/directories stay until hard-delete or restore).
- **Pre-checks:** target is not self; caller outranks target; target is not already soft-deleted.
- **Side effects (wrapped in `session.withTransaction()` per STACK.md):** set `deletedAt=now`; revoke all sessions.

### `DELETE /api/admin/users/:id/hard-delete` — **superadmin only**
Hard delete. Irreversible. Removes user + all their data from DB and disk.
- **Pre-checks:** same as soft delete.
- **Side effects (in this exact order):**
  1. **MongoDB transaction** (`session.withTransaction()` per STACK.md):
     - `Session.deleteMany({ userId })`
     - `File.deleteMany({ userId })`
     - `Directory.deleteMany({ userId })`
     - `User.deleteOne({ _id: userId })`
  2. **After commit:** delete the user's physical files from disk via the existing file-deletion utility used by `src/services/file/file.service.js`. If disk delete fails: log a warning, leave orphans for manual cleanup (DB is source of truth).
- **Response:** `{ filesDeleted, directoriesDeleted, bytesFreed }` (tallied during the transaction so the response itself gives the admin a confirmation of what was wiped).

### `POST /api/admin/users/:id/restore` — **superadmin only**
Reverse a soft-delete. Mirror image of `DELETE /admin/users/:id/soft-delete`.
- **Pre-checks (in this order):**
  1. Target is currently soft-deleted (`deletedAt != null`) — else 400 `INVALID_INPUT` ("user is not deleted"). Checked first so an active target returns the state error, not a hierarchy error.
  2. Caller outranks target (service-layer defense-in-depth). Hierarchy applies even though the target is in a soft-deleted state — once they come back, the hierarchy will apply normally.
  3. Self-check is skipped: a soft-deleted user can't authenticate (`authenticate` rejects them before reaching this route), so they can't be the caller. No `CANNOT_ACT_ON_SELF` possible here.
- **Side effects:**
  - Set `deletedAt = null`.
  - **Do NOT** auto-clear `suspendedAt`. If the user was suspended before being soft-deleted, they come back suspended — never silently grant access. Admin can call unsuspend separately.
  - **Do NOT** restore sessions. The user must log in fresh.
- **Response:** the restored user document plus the derived `status` field (will be `"suspended"` or `"active"` depending on `suspendedAt`).

---

## Middleware

### `authenticate` (modified, `src/middlewares/auth.middleware.js`)

The existing populate select string already strips `password`/`otp`/etc. and returns everything else, so `role`, `suspendedAt`, `suspendedBy`, and `deletedAt` will be on `req.user` automatically once the schema fields exist. No populate change needed.

After session/user lookup, add two guards before `next()`:
```js
if (session.userId.deletedAt) {
  clearAuthCookie(res);
  throw new AppError('Account no longer exists', UNAUTHORIZED, UNAUTHORIZED_ACCESS);
}
if (session.userId.suspendedAt) {
  clearAuthCookie(res);
  throw new AppError('Account is suspended', FORBIDDEN, ACCOUNT_SUSPENDED);
}
```

Order matters: `deletedAt` is checked first because a deleted user shouldn't get a "suspended" error even if both timestamps happen to be set (defensive — the mutation handlers shouldn't create that state, but the guard is order-stable anyway).

### `authorize` (new, `src/middlewares/authorize.middleware.js`)

Exports composable middleware factories:

```js
requireRole(minRole)            // 'user' | 'admin' | 'superadmin' — hierarchical
requireSuperadmin()             // shorthand for requireRole('superadmin')
```

**Why a numeric rank?** Comparing role strings directly to enforce a hierarchy is verbose and error-prone — every gate would have to enumerate which roles pass:

```js
// Without ranks (ugly, bug-prone):
if (req.user.role === 'admin' || req.user.role === 'superadmin') { ok }
```

With ranks, the hierarchy collapses to a single number comparison:

```js
const ROLE_RANK = { user: 1, admin: 2, superadmin: 3 };

export const requireRole = (minRole) => (req, res, next) => {
  const callerRank   = ROLE_RANK[req.user.role];
  const requiredRank = ROLE_RANK[minRole];

  if (callerRank < requiredRank) {
    throw new AppError(
      'Insufficient role',
      httpStatus.FORBIDDEN,
      appErrorCode.INSUFFICIENT_ROLE,
    );
  }
  next();
};
```

**How that plays out:**

| Route gate | user (1) | admin (2) | superadmin (3) |
|---|---|---|---|
| `requireRole('user')` — needs ≥ 1 | ✓ | ✓ | ✓ |
| `requireRole('admin')` — needs ≥ 2 | ✗ 403 | ✓ | ✓ |
| `requireRole('superadmin')` — needs ≥ 3 | ✗ 403 | ✗ 403 | ✓ |

The "higher rank passes lower checks" rule from the hierarchy decision falls out of `callerRank >= requiredRank` automatically — there's no per-route enumeration of which roles are allowed.

**Failure response.** When `requireRole` throws, Express 5 catches the rejected promise and routes to `globalErrorHandler`, which produces HTTP 403 with the standard envelope:

```json
{
  "success": false,
  "error": "Insufficient role",
  "errorCode": "INSUFFICIENT_ROLE"
}
```

**The same rank trick is reused in the service layer** for "can act on" checks. For example, the suspend handler in `admin/user.service.js`:

```js
if (ROLE_RANK[caller.role] <= ROLE_RANK[target.role]) {
  throw new AppError(
    'Cannot act on a peer or higher',
    httpStatus.FORBIDDEN,
    appErrorCode.CANNOT_ACT_ON_PEER,
  );
}
```

- admin (2) trying to suspend admin (2) → `2 <= 2` is true → 403 (peers can't act on each other)
- superadmin (3) trying to suspend admin (2) → `3 <= 2` is false → proceed

Strict `>` (not `≥`) because acting *on* a peer is disallowed, per the strict-hierarchy decision.

**Hierarchy + self-action checks** (`canActOn`, `assertLastSuperadminInvariant`) live in `src/services/admin/user.service.js` rather than middleware — they need DB lookups (target role + superadmin count) and belong in the service layer per the project's layer-discipline rule.

---

## Bootstrap procedure (CLI seed script)

`scripts/seed-superadmin.js`:

1. Load env, connect to MongoDB.
2. **Backfill** the new fields on existing users (idempotent — `$exists: false` only matches docs missing the field):
   - `User.updateMany({ role:        { $exists: false } }, { $set: { role:        'user' } })`
   - `User.updateMany({ suspendedAt: { $exists: false } }, { $set: { suspendedAt: null   } })`
   - `User.updateMany({ deletedAt:   { $exists: false } }, { $set: { deletedAt:   null   } })`
3. Read `--email` arg. Find verified user with that email. Reject if not found or not verified.
4. If already superadmin → log and exit 0 (idempotent).
5. Promote: `user.role = 'superadmin'; await user.save()`.
6. Print: `"Promoted alice@example.com to superadmin."`
7. Exit 0.

**Usage:** `npm run seed:superadmin -- --email=admin@example.com`

Document this in README under a new "First Deploy" section.

---

## Currently implemented

- `src/constants/roles.js` — frozen `ROLES` enum + `ROLE_RANK` map.
- `src/utils/userStatus.js` — derived-status helper (`USER_STATUS`, `getUserStatus`).
- `src/middlewares/authorize.middleware.js` — `requireRole(minRole)` and `requireSuperadmin()`.
- `src/middlewares/auth.middleware.js` — rejects soft-deleted (`UNAUTHORIZED_ACCESS`) and suspended (`ACCOUNT_SUSPENDED`) users; same gate is duplicated in `loginUser` so a fresh credential check on a locked account is rejected pre-session-issue.
- `src/models/user.model.js` — `role`, `suspendedAt`, `suspendedBy`, `deletedAt` fields, each indexed.
- `src/routes/admin/*`, `src/controllers/admin/*`, `src/services/admin/*` — the 10 endpoints in the access matrix above.
- `scripts/seed-superadmin.js` + `npm run seed:superadmin -- --email=<...>` — bootstrap.
- Vitest harness under `tests/` covering admin/auth/oauth services, run via `npm test` (configured in `vitest.config.js`).
- Atlas `$jsonSchema` for `users` mirrored manually with the four new fields.

The `assertNotLastSuperadmin` guard and the matching `LAST_SUPERADMIN` error were intentionally **not** wired. The deployment runs a single-superadmin topology (see "Locked design decisions"), so the only scenarios the guard would catch — demoting or deleting the last superadmin — cannot arise without first creating a second superadmin. The error code is defined in `appErrorCode.js` and ready to re-introduce if topology changes.

---

## Verification snapshot

Smoke tests that exercise the shipped surface:

- Promote a second user via `PATCH /admin/users/:id/role` → next request from that user reaches admin routes (role is read from `req.user.role` per request; no session invalidation needed).
- Suspend a user → `suspendedAt` set, sessions revoked, subsequent login attempts return `403 ACCOUNT_SUSPENDED`.
- Force-logout a user → response `{ sessionsRevoked: N }` matches `Session.deleteMany` count.
- Soft-delete → `deletedAt` set, login blocked with `UNAUTHORIZED_ACCESS`; files remain on disk.
- Hard-delete a user with at least 1 file + 1 directory → User/File/Directory/Session docs gone, disk files removed (or warn-logged on failure), response tallies match.
- Soft-delete then restore → `deletedAt` cleared. If the user was suspended before deletion, `suspendedAt` is preserved and they stay locked out until unsuspended.
- Restore a user who is not soft-deleted → `400 INVALID_INPUT`.
- Suspend self → `403 CANNOT_ACT_ON_SELF`.
- As admin, try to suspend another admin → `403 CANNOT_ACT_ON_PEER` (route gate also blocks via `requireSuperadmin()`, but the service-layer hierarchy check is the durable defense).
- Regression surface: existing auth flows and per-user file/directory CRUD are unchanged — admin code is fully additive.

---
