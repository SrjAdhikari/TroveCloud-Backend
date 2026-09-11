# Profile Picture Upload

> **Status:** As-built (2026-09-10). Lets users upload and replace their profile picture in the `/api/users` module. Bytes live in Cloudflare R2 under a stored `User.profilePictureKey`; every user payload carries a resolved, short-lived `profilePictureUrl` instead of a stable route — a presigned R2 URL when the user uploaded a picture, the OAuth provider's URL otherwise. *(Informally "avatar"; all API identifiers use `profilePicture` / `profile-picture`.)*

## Context

A user's photo has two possible origins: OAuth, which seeds `profilePicture` from the provider at account creation, and an upload by the user. Email/password users have only the second.

Both `name` and the picture are user-editable in-app, so the app is the source of truth for them after signup. That is why `oauth.service.js` seeds those fields once and does **not** re-sync them on later logins — a login that copied the provider's current values back over them would silently discard whatever the user set here.

The frontend still reads a single field and renders it directly in an `<img>` — `profilePictureUrl`, which resolves to either the provider's URL or a presigned R2 URL for a picture the user uploaded. The frontend never has to decide which; the raw `profilePicture` field is still present on the payload, and only `profilePictureKey` is withheld. The design adds no image-processing library and no multipart parser.

---

## Scope

**In scope:**
- `POST /api/users/profile-picture` — upload **and replace** the authenticated user's picture (raw image body).
- A resolved `profilePictureUrl` on every user payload: an uploaded picture is presigned for one hour, anything else falls back to the provider URL or `null`. There is **no** serving route: the browser loads the picture from R2 directly.
- No OAuth login re-sync of `name` + `profilePicture` — the block stays commented out in `oauth.service.js`, retained in case it is ever wanted back.
- Magic-byte image validation (JPEG / PNG / WEBP only), an environment-configured size cap, old-object cleanup on replace.

**Explicitly out of scope (deferred):**
- **`DELETE /api/users/profile-picture` (clear photo back to `null`).** Replacement already cleans up the previous object, so its absence does not accumulate storage — it only postpones the "remove my photo entirely" action.
- **Image resizing / normalization (e.g. `sharp`).** Stored as-uploaded. Add later only if thumbnail variants are needed.

---

## Locked design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Photo field | Two fields with a precedence order: `profilePictureKey` (our R2 object) wins, `profilePicture` (the provider's URL, OAuth-seeded) is the fallback | The two are different kinds of thing — one is a key we must presign, one is a URL we can hand over untouched. Collapsing them into one column would mean parsing a string to decide which it is. |
| Source-of-truth conflict | After signup the app owns the photo. OAuth **seeds** `profilePicture` (and `name`) once at account creation; the **login re-sync is disabled** (commented out) | Dissolves the two-writers clobber for both fields now that each is user-editable. Cost: provider-side changes won't auto-propagate (user can re-upload / re-edit). |
| Visibility | Any party the app shows the URL to can view the picture (owner + other users) | Pictures are meant to be seen. |
| Serving model | **Presigned GET, resolved per response.** No serving route exists; `formatUser` presigns the stored key — or falls back to the provider URL when there is no key — and returns the result as `profilePictureUrl` | An `<img>` can't carry custom auth, and a signed URL doesn't need it — the browser fetches from R2 with no cookie and no round trip through Express. Keeps the "server never proxies object bytes" rule that the file paths already follow. |
| URL lifetime | `PROFILE_PICTURE_URL_TTL_SECONDS` = one hour, same as file downloads | A signed URL is a bearer capability that outlives session revocation and `suspendedAt`, so it stays short even though the object itself is immutable. |
| Signature reuse | `presignGet` quantizes its signing date to a fixed window | The same key therefore yields a byte-identical URL for the life of that window, so repeat renders hit the browser's cache instead of refetching a picture that never changed. A fresh signature per response would produce a new URL string every time. |
| Storage layout | `profile-pictures/<userId>/<32 hex token>` — **no extension**; the type is stored as the object's `Content-Type` at upload | The owner prefix groups one user's avatars under a single listable path. The token is the cache-buster and makes the key unguessable; the type is recorded once rather than re-sniffed on every read. |
| Upload transport | Raw image body buffered in memory, then a single `putObject` | Unlike the file paths, the server does see these bytes — which is what makes the magic-byte check possible before anything is stored. The 2 MB cap keeps the buffer bounded. |
| Type validation | Declared `Content-Type` must be JPEG / PNG / WEBP **and** the leading bytes must match that declaration. Reject SVG and GIF | Checking the declaration alone trusts the client; checking the bytes alone would let a client store a valid PNG under a `Content-Type` R2 will later echo back. Both must agree. SVG is XML and can carry executable script — explicitly excluded. |
| Size cap | `MAX_PROFILE_PICTURE_SIZE` (currently 2 MB), checked against the declared `Content-Length` up front and again against the bytes actually received | Plenty for a picture; bounds memory and bandwidth. A raw body bypasses the 1 MB `express.json` limit, so this is the only guard. Read from the environment through `getNumberEnv` in `src/constants/env.js`, so clients should surface the error rather than mirror the number. |
| Response field | `profilePictureUrl` on the user payload; `formatUser` strips `profilePictureKey` and nothing else, so the OAuth-seeded `profilePicture` still ships alongside it | The key plus a bucket name is the whole address of the object, so the key is the one part that stays server-side. The client only ever needs something it can put in `src`. |
| Old-object cleanup | On replace, delete the previous `profilePictureKey`'s object **after** the new key is committed to the document, and only when it differs | Ordering means a crash leaves an orphaned object (reconcilable) rather than a user whose picture 404s (not). Failure to delete is warn-logged, never fatal. |
| Caching | `Cache-Control: private, max-age=<TTL>` written onto the object at upload | The object is served by R2, not by us, so caching has to be metadata on the object. `private` because the URL is a bearer token — a shared cache must not keep a copy for the next requester. |
| Code organization | All of it in existing `user.service.js` / `user.controller.js` / `user.routes.js`, behind `userRouter.use(authenticate)`. Generic image sniffing in `src/utils/mimeType.js`; every R2 call through `src/lib/r2.js` | Profile-picture data belongs to the user module; only the image-type sniffer is generic enough to live on its own. `routes/index.js` needs no change. |

---

## Data model

Two fields on `User`, read in precedence order:

```js
profilePicture:    { type: String, default: null },
profilePictureKey: {
    type: String,
    default: null,
    match: /^profile-pictures\/[a-f0-9]{24}\/[a-f0-9]{32}$/,
}
```

`profilePicture` holds the provider photo URL that OAuth seeded at signup, or `null`. `profilePictureKey` holds the R2 key of a picture the user uploaded. `resolveProfilePictureUrl` prefers the key: if one is set it presigns it, otherwise it falls back to `profilePicture`, otherwise `null`.

The `match` pattern is a second line of defence behind `assertKey` in `src/lib/r2.js` — a key is interpolated straight into an S3 request, so a value that escaped its own prefix would address someone else's object. It is mirrored in the Atlas `$jsonSchema` validator, so a write that goes around Mongoose is still rejected by the database. Mongoose's own `match` runs on an `updateOne` only when `runValidators: true` is passed, which the upload path does.

A partial index on `{ profilePictureKey: { $type: "string" } }` covers only the users who have actually uploaded one, rather than indexing the `null` that every other user carries.

The only other model-layer change is in `oauth.service.js` — the existing-user **login re-sync is commented out** so a login cannot clobber a user-edited name or an uploaded picture. The seed at `User.create` (which still writes `profilePicture`) is untouched.

---

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/users/profile-picture` | session (`userRouter.use(authenticate)`) | Upload / replace own picture; returns the updated user (same projection as `PATCH /profile`) |
| `GET /api/auth/me` | session | Returns `profilePictureUrl`, resolved for this response. Within one signing window the presigned form is byte-identical to the previous response's |

**There is no picture-serving endpoint.** Every route in `user.routes.js` sits below `userRouter.use(authenticate)`; the bytes are fetched by the browser from R2 using the presigned URL, so nothing unauthenticated needs to exist on our side.

Any response that carries a user runs it through `formatUser`, which is what mints `profilePictureUrl`. A new endpoint returning a user must call it too — returning a raw lean document would both omit the URL and leak `profilePictureKey`.

---

## Upload flow (`POST /api/users/profile-picture`)

1. **Check the headers before reading a byte** (`validateProfilePictureHeaders`). The `Content-Type` — media type only, parameters dropped — must be `image/jpeg`, `image/png`, or `image/webp` (`INVALID_IMAGE_TYPE`, 400). `Content-Length` must be a positive integer (`INVALID_INPUT`, 400) and within `MAX_PROFILE_PICTURE_SIZE` (`IMAGE_TOO_LARGE`, 400). Rejecting on the declaration first means an oversized body is refused before it is buffered.
2. **Buffer the body** (`readProfilePictureBody`). Chunks accumulate with a running total; exceeding the cap throws `IMAGE_TOO_LARGE` mid-read rather than after. A body whose real length disagrees with the declared `Content-Length` throws `UPLOAD_INCOMPLETE` (400) — a truncated request must not be stored as a valid picture.
3. **Sniff and cross-check** (`detectVerifiedImageType`). `detectImageType` reads the leading bytes: JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WEBP `RIFF…WEBP` **plus** a `VP8 ` / `VP8L` / `VP8X` codec chunk at offset 12 (a bare `RIFF…WEBP` prefix is rejected). The detected type must **equal the declared one** — matching the allowlist is not enough, because the declared type is what gets written onto the object and echoed back to browsers later.
4. **Read the current key, then mint a new one and write the object.** The user's existing `profilePictureKey` is read first — that is where the object to clean up later comes from — and a miss here throws `USER_NOT_FOUND` with nothing yet written to undo. `buildProfilePictureKey(userId, randomBytes(16).toString("hex"))` produces `profile-pictures/<userId>/<token>`; `putObject` stores the buffer with the verified `Content-Type` and the `private, max-age=<TTL>` cache header. A new token per upload means the write never overwrites the picture currently in use.
5. **Commit the key, then clean up.** `User.findByIdAndUpdate` sets `profilePictureKey`. If that update fails or the user has vanished (`USER_NOT_FOUND`), the object just written is deleted before the error propagates. Only once the new key is committed is the previous object deleted, and only if it differs — a failure there is warn-logged, never fatal, because an orphaned object is recoverable and a missing picture is not.

Returns `{ success, message, data: <updated user, sensitive fields excluded> }`, with `profilePictureUrl` already resolved by `formatUser` in the controller.

---

## Serving flow (`resolveProfilePictureUrl`)

There is no request to serve. `formatUser` calls `resolveProfilePictureUrl` while building any user payload:

1. `profilePictureKey` set → `presignGet(key, { inline: true, ttl: PROFILE_PICTURE_URL_TTL_SECONDS })`. `inline` so the browser renders it in an `<img>` instead of downloading it.
2. Presigning throws → warn-log and return `null`. A key that cannot be signed degrades to "this user has no picture" rather than failing the whole request, which would take down `GET /api/auth/me` for one bad row.
3. No key → fall back to `profilePicture` (the OAuth-seeded provider URL), else `null`.

`formatUser` then strips `profilePictureKey` off the document and attaches the resolved value as `profilePictureUrl`.

---

## Security notes

- **No SVG/GIF, magic-byte enforced against the declaration** — defeats `Content-Type` spoofing and SVG-borne script. The stored `Content-Type` is one R2 will echo to every future viewer, so it has to be a type the bytes actually are.
- **Keys are pattern-checked twice** — by the schema `match` on write and by `assertKey` on every R2 call. A key is interpolated into an S3 request path, so a value that escaped its `profile-pictures/<userId>/` prefix would address another user's object.
- **128-bit token per upload** — the key is unguessable and not derivable from the `userId` alone, so knowing who someone is does not tell you where their picture lives.
- **Signed URLs are bearer capabilities** — anyone holding one reads that object until it expires, past logout and past suspension. Hence the one-hour TTL and `Cache-Control: private`, which keeps shared caches from serving one user's URL to the next requester.
- **Size cap before and during the read** — the declared `Content-Length` is rejected up front, and the running total is rejected again while buffering, so neither a lying header nor a chunked body gets past it.

---

## Where the code lives

| File | Responsibility |
|---|---|
| `src/models/user.model.js` | `profilePictureKey` field, its key pattern, and the partial index over it |
| `src/schemas/user.schema.js` | The Atlas `$jsonSchema` mirror of that field |
| `src/services/user.service.js` | `uploadProfilePicture` (validate → buffer → sniff → put → commit → clean up), `resolveProfilePictureUrl`, `formatUser` |
| `src/controllers/user.controller.js` | `uploadProfilePictureHandler`; also runs `formatUser` over every user it returns |
| `src/routes/user.routes.js` | `POST /profile-picture`, behind `authenticate` and `uploadLimiter` |
| `src/lib/r2.js` | `buildProfilePictureKey`, `assertKey`, `putObject`, `presignGet`, `deleteObject`, `PROFILE_PICTURE_URL_TTL_SECONDS` |
| `src/utils/mimeType.js` | `detectImageType` — magic-byte sniff for JPEG / PNG / WEBP |
| `src/services/oauth.service.js` | The commented-out existing-user login re-sync |
| `src/constants/appErrorCode.js` | `INVALID_IMAGE_TYPE`, `IMAGE_TOO_LARGE` |
| `src/constants/env.js` | `MAX_PROFILE_PICTURE_SIZE` |

Every controller that returns a user — `user.controller.js`, `auth.controller.js`, `admin/user.controller.js` — goes through `formatUser`, which is the single place `profilePictureUrl` is produced and `profilePictureKey` is dropped.

---

## Testing

Vitest + `mongodb-memory-server` at the service + util layer, matching existing `tests/services/*.test.js` and `tests/utils/*` conventions (no supertest in the repo → no HTTP-level tests):

- `mimeType`: accepts valid JPEG/PNG/WEBP signatures; rejects SVG, GIF, and truncated/garbage input.
- `user.model`: the key pattern defaults to `null`, accepts a well-formed key, and rejects both a key outside the `profile-pictures/` prefix and a traversal segment where the owner id belongs.
- `user.service` `uploadProfilePicture`: stores the object and sets `profilePictureKey`; rejects a mismatched declaration, an oversized declaration, an oversized body, and a short body; replacing a picture deletes the previous object and leaves the new one; a failed commit removes the object it just wrote.
- `user.service` `formatUser`: emits `profilePictureUrl` and never `profilePictureKey`; an unsignable key resolves to `null` instead of throwing.
- `oauth.service`: a returning OAuth user's `name` **and** `profilePicture` are **not** overwritten on login.

---

## Out of scope / follow-ups

- `DELETE /api/users/profile-picture` (clear the picture back to `null`).
- Image resizing / thumbnails — only if needed later.
- Reconciling stored keys against the bucket, so an object orphaned by a failed cleanup is eventually removed. `hardDeleteUser` drops the avatar alongside the user's file objects, but that delete is best-effort — a failure is warn-logged, not retried.
