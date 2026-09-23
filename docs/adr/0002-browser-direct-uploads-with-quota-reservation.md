# ADR-0002: Browser-direct uploads with server-side quota reservation

**Date**: 2026-09-02
**Status**: accepted
**Deciders**: SrjAdhikari (project owner)

## Context

[ADR-0001](./0001-cloudflare-r2-for-object-storage.md) moved storage to Cloudflare R2 but left open how bytes get in and out. Two mechanisms are available: proxy every byte through Express, or hand the browser a presigned URL and let it talk to R2 directly.

The choice is constrained by two things the current server does *because* it sees the bytes: it enforces a per-user storage quota by counting them mid-stream, and it validates profile-picture image types from their magic bytes. A direct upload removes both opportunities.

The Manakuru project already runs presigned PUT against R2 in production, which makes the mechanism proven here rather than theoretical. Its uploads are admin-only and carry no quota, so it trusts client-reported metadata and never records object sizes at all — an assumption TroveCloud cannot copy.

## Decision

The browser uploads directly to R2 via presigned PUT, in a **mint → PUT → confirm** flow, and reads objects through short-lived signed GET URLs returned as JSON. The server handles upload bytes only for Drive import, where they originate server-side. Development runs against a dedicated R2 bucket; there is no local-disk driver.

Object keys are generated server-side with a 128-bit random nonce and **stored** on the document — `File.objectKey`, `User.profilePictureKey` — never derived from an id at read time.

## Alternatives Considered

### Server-proxied upload into R2

- **Pros**: quota counting and magic-byte validation keep working untouched; one round trip; no new document states; nothing to reclaim afterwards.
- **Cons**: the app host pays bandwidth twice for every byte, Node becomes the throughput ceiling, and a 100 MB upload occupies a request for its whole duration.
- **Why not**: that bandwidth and bottleneck cost is the specific thing the move to object storage was meant to eliminate. Keeping it would leave the migration half-done.

### Presigned PUT trusting a client-reported size

- **Pros**: the simplest possible confirm step — verify the object exists and store what the client says about it. This is exactly what Manakuru does with video duration.
- **Cons**: quota becomes advisory. A client that under-declares its size gets storage for free, and the discrepancy compounds silently.
- **Why not**: Manakuru can afford it because its uploader is an admin and the reported value is display metadata. Here the reported value *is* the quota, so it must be enforced rather than believed.

### A storage abstraction keeping a local-disk driver for development

- **Pros**: offline development, and no R2 credentials needed to run the app.
- **Cons**: a disk cannot mint presigned URLs, so development would need a parallel HMAC-signed upload endpoint that exists nowhere in production — meaning dev diverges from prod on precisely the path most likely to break.
- **Why not**: the abstraction earns its keep only if both drivers are real. Building a fake presigner to preserve a seam is more code and less safety.

## Consequences

### Positive

- Upload and download bandwidth never touches the application host, and Node stops being the throughput ceiling.
- Large files and progress reporting become the browser's problem, where the tools already exist. Aborting a transfer does too — though releasing what the abort left behind takes a call back to the server.
- R2 serves `Range` requests natively, so media seeking works without a partial-content implementation.
- Development exercises the same code path as production.

### Negative

- An upload is three round trips instead of one, and the frontend owns a state machine it did not need before.
- A `pending` File document now exists purely as quota bookkeeping, and is invisible to every read path.
- **Settling a lapsed reservation becomes application work.** Nothing expires one on its own. `releaseExpiredFiles` runs inside a request — and only inside one whose quota check has already rejected, after which that reservation is retried once — so a lapsed row is settled by the owner's next blocked upload rather than by a clock. It cannot be replaced by a TTL index, for two reasons: expiring the document alone would leave the reserved bytes counted in every ancestor directory, and the decision is not the deadline's to make. A lapsed row whose object is in storage is promoted to `ready` rather than deleted, which means the sweep has to look in the bucket before it can act.
- **Objects that no document claims have no reclaimer at all.** Finding them is a whole-bucket scan, which cannot hang off one user's request the way the reservation sweep does. Their only cost is storage billing, and a trigger for that pass is tracked as its own issue.
- **Abandoning an upload needs an endpoint of its own.** Because the reservation commits at mint, a client that gives up has to say so: `POST /api/files/:id/cancel` pulls `uploadExpiresAt` in to the presign TTL plus a settle margin, and does nothing else. It cannot refund the bytes (see the presigned-URL risk below) and it must not delete the object either, because the deadline it commits may already be past, which makes the row eligible for a sweep that would promote it — and deleting the object then would strip a `ready` file of its bytes. So the quota returns in about six minutes rather than immediately, one path owns object lifecycle, and the frontend has one more call to make on every abort.
- **Cancel and confirm can race, and the loser gets a confusing answer.** A confirm that arrives after a cancel is refused with `UPLOAD_CANCELLED` (409) — the cancelled row carries `cancelledAt` and confirm's compare-and-set requires its absence, because the cancel has already committed a deadline that hands the row to the sweep. The bytes are not lost: cancel leaves the object alone, so if the `PUT` completed, the sweep promotes the row afterwards. So a client can be told its upload was cancelled and later find the file present. That is the honest outcome of two writers disagreeing, and the alternative is either silent data loss or untracked storage.
- Inline content inspection is no longer possible. Virus scanning, image re-encoding, and EXIF stripping would need an R2 event handler or a Worker.
- Every developer needs R2 credentials to run the application at all.

### Risks

- **A client under-declares its size to beat the quota.** Mitigated by signing `Content-Length` into the presigned PUT — R2 rejects a body of any other length — and by requiring HeadObject at confirm to report *exactly* the reserved size. Confirm rejects any mismatch rather than reconciling a delta, so there is no unchecked write path into the quota.
- **`Content-Type` is not signed by default.** `@aws-sdk/s3-request-presigner` adds `content-type` to `unsignableHeaders` unconditionally (`dist-cjs/index.js:47`), so the type must be forced back in with `signableHeaders: new Set(["content-type"])`. Without that the stored type is client-controlled. Verified: the default signed set is `content-length;host`; with the option it is `content-length;content-type;host`.
- **A presigned URL cannot be revoked.** Everything about the reservation lifecycle follows from this: the document tracking a minted upload must outlive the URL that can still write to it. Neither confirm nor cancel therefore releases a reservation — only the sweep does, once `uploadExpiresAt` has passed and only for a row whose object is genuinely not in storage. Cancel pulls that deadline in but leaves both the bytes counted and the object untouched; releasing early would let a caller take the refund and then upload to a live URL. The shortened deadline carries a settle margin for the same reason, because the URL outlives `createdAt + TTL`: it is signed after the reservation commits, and a PUT stays authorised while its body is still arriving.
- **A guessable key is a targetable key.** A Mongo ObjectId is structurally predictable, so a key derived from one lets an attacker name another user's object — which matters because an unsigned header on a presigned PUT could otherwise reinterpret it as a copy. Mitigated by the random nonce in the stored key, and by confirm requiring an exact size *and* type match.
- **A client uploads non-image bytes under an image Content-Type.** Mitigated at confirm by a 16-byte ranged GET run through the existing magic-byte table; a mismatch deletes the object and rejects. This is a point-in-time check, not a durable property — a client may re-PUT inside the remaining presign window, though the signed length forces any replacement to be byte-identical in size.
- **A signed URL is a bearer capability.** Anyone holding one can read that object until it expires — one hour for both files and avatars. Avatars get the same short TTL despite being immutable, because a signed URL outlives session revocation and `suspendedAt`.
- **A reservation is only settled when its owner is blocked.** The sweep fires on a quota rejection, so a lapsed row can sit counted until that user next hits their limit — at which point it is refunded, or promoted if its bytes turned up, and the upload retried. That is self-correcting for the person actually affected and invisible to everyone else, but it means "bytes used" can read high indefinitely for a user who stops uploading, and a landed-but-unconfirmed upload stays invisible to them until the same moment. There is no alerting on either.

### Revisit when

Inline content inspection becomes a requirement (malware scanning being the likely trigger), or uploads need resumability beyond a single PUT — browser-side multipart would change the mint and confirm contracts.
