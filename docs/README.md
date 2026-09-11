# TroveCloud Backend Documentation

Welcome to the TroveCloud backend documentation! This folder contains all the technical documentation necessary to understand, run, and scale the application.

Please navigate to the specific domain you need below:

### 📂 [Architecture](./architecture)

- [`database-schema.md`](./architecture/database-schema.md) - Models, indexes, TTLs, hidden-field convention, and cross-model relationships.
- [`oauth-multi-provider.md`](./architecture/oauth-multi-provider.md) - Shared OAuth sign-in helper, provider-specific divergences, and account-takeover guards.
- [`transaction-patterns.md`](./architecture/transaction-patterns.md) - Atomic User+Directory creation, why Session.create runs outside the transaction, Mongoose mechanics.
- [`email-template-system.md`](./architecture/email-template-system.md) - Transactional email composition model, brand tokens, client-compatibility rules.
- [`drive-import.md`](./architecture/drive-import.md) - As-built design for the Google Drive import feature (`POST /api/drive/import`).
- [`rbac-admin.md`](./architecture/rbac-admin.md) - RBAC + admin subsystem (`/api/admin/*`): roles, lifecycle fields, authorize middleware, mutation cascades.
- [`profile-picture-upload.md`](./architecture/profile-picture-upload.md) - As-built design for profile-picture upload (`POST /api/users/profile-picture`) and the presigned `profilePictureUrl` returned on every user payload.
- [`storage-quota.md`](./architecture/storage-quota.md) - Per-user storage quota + usage breakdown endpoint (`GET /api/storage/usage`) and quota enforcement on upload.

### 📂 [Architecture Decision Records](./adr)

- [`0001-cloudflare-r2-for-object-storage.md`](./adr/0001-cloudflare-r2-for-object-storage.md) - Why Cloudflare R2 was chosen for user file storage, which providers were rejected, and the trade-offs accepted.
- [`0002-browser-direct-uploads-with-quota-reservation.md`](./adr/0002-browser-direct-uploads-with-quota-reservation.md) - Why the browser uploads straight to R2, how quota survives the server not seeing the bytes, and why there is no local-disk driver.

### 📂 [Authentication](./authentication)

- [`registration-flow.md`](./authentication/registration-flow.md) - User registration via email + OTP, plus Google and GitHub OAuth alternative paths.
- [`login-and-sessions.md`](./authentication/login-and-sessions.md) - Session issuance for email/password login, Google OAuth, and GitHub OAuth sign-in, the identity-provider model, and cookie-based session strategy.
- [`logout-flow.md`](./authentication/logout-flow.md) - Single-device and global logout, provider-agnostic session destruction.
- [`password-reset.md`](./authentication/password-reset.md) - Forgot password and reset password flow (OTP-based, reuses User OTP fields, atomic password update + session wipe).
- [`change-password.md`](./authentication/change-password.md) - Authenticated password change (verifies current password, atomic update + wipe of all other sessions, keeps the current one).

### 📂 [Workflow](./workflow)

- [`release-workflow.md`](./workflow/release-workflow.md) - Versioning (semver), branch model, release cadence, how to cut a release.
- [`branch-commit-strategy.md`](./workflow/branch-commit-strategy.md) - Branch naming, commit message conventions, PR workflow, post-merge cleanup.

### 📂 [API Documentation](./api)

- `endpoints.md` - Master list of all available API routes
- [`error-codes.md`](./api/error-codes.md) - Glossary for `appErrorCode` constants, HTTP-status conventions, framework-error mappings.
- `postman-collection.json` - Exported configurations for local testing

### 📂 [File](./file)

- [`file-retrieval.md`](./file/file-retrieval.md) - Retrieve file metadata and mint signed download URLs
- [`file-upload.md`](./file/file-upload.md) - Browser-direct upload to object storage, with quota reservation
- [`file-update.md`](./file/file-update.md) - Rename a file (atomic single-query update)
- [`file-deletion.md`](./file/file-deletion.md) - Delete a file's DB record and its stored object

### 📂 [Features](./features)

- `directory-management.md` - Logic for managing nested recursive directories
- `file-upload.md` - Logic for handling S3/Multer uploads

### 📂 [Deployment](./deployment)

- `local-setup.md` - Guide for spinning up the development server locally
- `production.md` - Production CI/CD strategies
