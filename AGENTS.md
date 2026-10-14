# TroveCloud Backend

## Stack

- Node.js >= 20.11
- Express 5
- MongoDB + Mongoose
- ES modules

## Architecture

- Follow the existing flow: routes -> controllers -> services -> models.
- Routes define endpoints and middleware; keep business logic out of routes.
- Controllers handle HTTP concerns only: read `req`, call services, and shape `res`.
- Services own business logic and database operations. Do not pass `req` or `res` into services.
- Models define schema, indexes, validation, and model-level hooks.

## Validation and Errors

- Validate request input in middleware before the controller.
- Use `AppError` for application errors.
- Use `httpStatus` constants for HTTP status codes and `appErrorCode` constants for application error codes.
- Keep Mongoose/MongoDB error normalization centralized in `src/middlewares/error.middleware.js`.
- Express 5 handles rejected async handlers natively; do not add async-wrapper middleware.
- Express error middleware must keep all four parameters: `(err, req, res, next)`.

## Data

- Use MongoDB transactions for workflows that must update multiple collections atomically.
- Preserve each model's existing deletion semantics. Users use `deletedAt` soft deletion; do not change soft vs. physical deletion behavior without checking the owning flow.
- Use `.lean()` only for read-only queries.
- Keep sensitive schema fields excluded by default when the existing model follows that pattern.

## Authentication

- Authentication is session-based, not JWT-based.
- Sessions are stored in MongoDB and referenced by the signed HttpOnly `token` cookie.
- Preserve the existing cookie/security model unless a change is explicitly required.

## Storage

- Cloudflare R2 is the object-storage backend via its S3-compatible API.
- Preserve the existing upload/reservation/confirmation lifecycle when changing file-storage flows.

## Configuration

- Access environment variables through `src/constants/env.js`.
- Do not read `process.env` directly outside that configuration layer.

## Project Conventions

- Prefer a default export when a module exposes one clear primary function, value, type, or interface.
- Prefer inline named exports when a module exposes multiple public functions, values, constants, types, or interfaces; do not collect them in a trailing `export { ... }` block.
- Preserve the existing `//* relative/path.ts[x]` file-path header convention when adding or moving source files.
- Run relevant tests, typecheck, and/or build checks before claiming a change is complete.
