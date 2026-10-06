//* scripts/reconcile-orphans.js

/**
 * Reclaim R2 objects that no database row claims.
 *
 * Usage:
 *   npm run reconcile:orphans                      # dry run, reports only
 *   npm run reconcile:orphans -- --apply           # delete the orphans found
 *   npm run reconcile:orphans -- --max-ratio=0.95  # raise the safety limit for one run
 *   npm run reconcile:orphans -- --verbose         # list every candidate key
 *
 * Dry run is the default; nothing is deleted without --apply.
 */

import mongoose from "mongoose";

import connectToMongoDB from "../src/database/mongoDB.js";
import {
	DEFAULT_MAX_ORPHAN_RATIO,
	SCANNED_PREFIXES,
	scanForOrphans,
	reclaimOrphans,
} from "../src/services/reconcile.service.js";
import {
	MAX_UPLOAD_RESERVATION_MS,
} from "../src/services/file/reservation.service.js";
import envConfig from "../src/constants/env.js";
import { ONE_DAY_MS, ONE_HOUR_MS, ONE_MINUTE_MS } from "../src/utils/date.js";

const { R2_BUCKET } = envConfig;

const USAGE =
	"Usage: npm run reconcile:orphans -- [--apply] [--max-ratio=<0-1>] [--verbose]";

const APPLY_FLAG = "--apply";
const VERBOSE_FLAG = "--verbose";
const MAX_RATIO_FLAG = "--max-ratio";
const MAX_RATIO_PREFIX = `${MAX_RATIO_FLAG}=`;

// Plain decimals only: Number("0x1") is 1, which would silently disable the breaker.
const RATIO_PATTERN = /^-?\d*\.?\d+(e-?\d+)?$/;

const failUsage = (reason) => {
	console.error(`❌ ${reason}`);
	console.error(USAGE);
	process.exit(1);
};

const apply = process.argv.includes(APPLY_FLAG);
const verbose = process.argv.includes(VERBOSE_FLAG);

const maxRatioArgs = process.argv.filter(
	(arg) => arg === MAX_RATIO_FLAG || arg.startsWith(MAX_RATIO_PREFIX),
);

// Rejected rather than first- or last-wins: either precedence rule guesses which number the operator meant, and guessing wrong here deletes.
if (maxRatioArgs.length > 1) {
	failUsage(
		`${MAX_RATIO_FLAG} was passed ${maxRatioArgs.length} times (${maxRatioArgs.join(" ")}); pass it exactly once.`,
	);
}

// The space-separated form parses as a bare flag, so it is rejected instead of discarding the value silently.
if (maxRatioArgs[0] === MAX_RATIO_FLAG) {
	failUsage(`${MAX_RATIO_FLAG} needs a value, as ${MAX_RATIO_PREFIX}<0-1>.`);
}

const rawMaxRatio = maxRatioArgs[0]?.slice(MAX_RATIO_PREFIX.length).trim();

const maxRatio =
	rawMaxRatio === undefined
		? DEFAULT_MAX_ORPHAN_RATIO
		: Number.parseFloat(rawMaxRatio);

// A blank value reads as 0 and a percentage typo (--max-ratio=20) disables the breaker, so shape and range are both checked.
if (
	rawMaxRatio !== undefined &&
	(!RATIO_PATTERN.test(rawMaxRatio) ||
		!Number.isFinite(maxRatio) ||
		maxRatio < 0 ||
		maxRatio > 1)
) {
	failUsage(`${MAX_RATIO_PREFIX}${rawMaxRatio} is not a ratio between 0 and 1.`);
}

//* Presentation helpers — formatting only, no logic.

const LABEL_WIDTH = 16;
const VALUE_WIDTH = 9;
const MIN_KEY_WIDTH = 76;
const SIZE_WIDTH = 10;
const MAX_LISTED_CANDIDATES = 10;

const BYTES_PER_UNIT = 1024;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const LARGE_UNIT_VALUE = 100;

const AGE_UNITS = [
	{ label: "day", ms: ONE_DAY_MS },
	{ label: "hour", ms: ONE_HOUR_MS },
	{ label: "minute", ms: ONE_MINUTE_MS },
];

const formatCount = (value) => value.toLocaleString("en-US");

const formatBytes = (bytes) => {
	// Below one byte the log goes negative and indexes past the start of BYTE_UNITS.
	if (!Number.isFinite(bytes) || bytes < 1) return "0 B";

	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(BYTES_PER_UNIT)),
		BYTE_UNITS.length - 1,
	);
	const value = bytes / BYTES_PER_UNIT ** exponent;
	const decimals = exponent === 0 || value >= LARGE_UNIT_VALUE ? 0 : 2;

	return `${value.toFixed(decimals)} ${BYTE_UNITS[exponent]}`;
};

const formatAge = (lastModified) => {
	// new Date(null) is the epoch rather than an Invalid Date, so the elapsed check below would read it as 20,000-odd days.
	if (lastModified == null) return "unknown";

	const elapsed = Date.now() - new Date(lastModified).getTime();

	if (!Number.isFinite(elapsed)) return "unknown";

	for (const { label, ms } of AGE_UNITS) {
		if (elapsed >= ms) {
			const value = Math.floor(elapsed / ms);
			return `${formatCount(value)} ${label}${value === 1 ? "" : "s"}`;
		}
	}

	return "under a minute";
};

const formatDuration = (ms) => {
	const hours = Math.floor(ms / ONE_HOUR_MS);
	const minutes = Math.round((ms % ONE_HOUR_MS) / ONE_MINUTE_MS);

	return hours === 0 ? `${minutes}m` : `${hours}h${minutes}m`;
};

const formatPercent = (ratio) => `${Number((ratio * 100).toFixed(1))}%`;

const row = (label, value, note) =>
	`${label.padEnd(LABEL_WIDTH)}${value.padStart(VALUE_WIDTH)}${note ? `   ${note}` : ""}`;

const targetRow = (label, value) => `${label.padEnd(LABEL_WIDTH)}${value}`;

// A key is 63 chars plus an unbounded extension, so the column grows to the widest one printed.
const keyColumnWidth = (items) =>
	items.reduce((width, { key }) => Math.max(width, key.length), MIN_KEY_WIDTH);

const printScanReport = (report, ratio, target) => {
	const { scanned, unrecognized, skippedTooNew, checked, owned, candidates } =
		report;

	// The breaker cannot tell a misdirected Mongo connection from genuine orphans — both read as zero owners — so both endpoints are named above the counts.
	console.log(targetRow("Database", target.database));
	console.log(targetRow("Bucket", target.bucket));

	console.log(
		row(
			"Scanned",
			formatCount(scanned),
			`objects across ${SCANNED_PREFIXES.length} prefixes (${SCANNED_PREFIXES.join(", ")})`,
		),
	);
	console.log(row("  unrecognized", formatCount(unrecognized)));
	console.log(
		row(
			"  too new",
			formatCount(skippedTooNew),
			`(inside the ${formatDuration(MAX_UPLOAD_RESERVATION_MS)} reservation floor)`,
		),
	);
	console.log(row("  checked", formatCount(checked)));
	console.log(row("    owned", formatCount(owned)));
	console.log(
		row(
			"    orphaned",
			formatCount(candidates.length),
			`(${formatPercent(ratio)} of scanned — ${ratio > maxRatio ? "over" : "under"} the ${formatPercent(maxRatio)} threshold)`,
		),
	);

	const reclaimable = candidates.reduce(
		(total, candidate) => total + (candidate.size ?? 0),
		0,
	);
	console.log(row("Reclaimable", formatBytes(reclaimable)));

	// Warning, not a gate: zero owners is routine here (per-worker test databases are dropped, the shared dev bucket keeps the leftovers), so a flag would be typed reflexively.
	if (checked > 0 && owned === 0) {
		console.log(
			`\n⚠️  Not one of the ${formatCount(checked)} objects checked is owned by a row — confirm the database above is the one that owns this bucket before ${APPLY_FLAG}.`,
		);
	}

	if (candidates.length === 0) return;

	const byAge = [...candidates].sort(
		(a, b) => new Date(a.lastModified) - new Date(b.lastModified),
	);
	console.log(
		`${"Oldest".padEnd(LABEL_WIDTH)}${formatAge(byAge[0].lastModified).padStart(VALUE_WIDTH)}   Newest   ${formatAge(byAge.at(-1).lastModified)}`,
	);

	// Largest first, so a capped list still explains where the reclaimable bytes are.
	const bySize = [...candidates].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
	const listed = verbose ? bySize : bySize.slice(0, MAX_LISTED_CANDIDATES);
	const keyWidth = keyColumnWidth(listed);

	for (const { key, size, lastModified } of listed) {
		console.log(
			`  ${key.padEnd(keyWidth)}${formatBytes(size).padStart(SIZE_WIDTH)}   ${formatAge(lastModified)}`,
		);
	}

	const hidden = candidates.length - listed.length;
	if (hidden > 0) {
		console.log(`  … ${formatCount(hidden)} more (${VERBOSE_FLAG} to list all)`);
	}
};

//* Run.

await connectToMongoDB();

// connection.name is only populated once connect() has resolved.
const target = {
	database: mongoose.connection.name ?? "unknown",
	bucket: R2_BUCKET,
};

try {
	const report = await scanForOrphans();

	// The scan report deliberately carries no ratio, so the dry-run display derives it.
	const ratio =
		report.scanned === 0 ? 0 : report.candidates.length / report.scanned;

	printScanReport(report, ratio, target);

	if (!apply) {
		if (ratio > maxRatio) {
			console.log(
				`\nDry run — nothing deleted. ${APPLY_FLAG} would abort: ${formatPercent(ratio)} exceeds the ${formatPercent(maxRatio)} safety limit (raise it with ${MAX_RATIO_PREFIX}<0-1>).`,
			);

			// A scheduled dry run is the expected first deployment, and a bucket over the threshold is the one condition it exists to surface.
			process.exitCode = 1;
		} else {
			console.log(
				`\nDry run — nothing deleted. Re-run with ${APPLY_FLAG} to reclaim.`,
			);
		}
	} else if (report.candidates.length === 0) {
		console.log("\nNothing to reclaim.");
	} else {
		const { deleted, errors } = await reclaimOrphans(report.candidates, {
			scanned: report.scanned,
			maxRatio,
		});

		console.log(
			`\n✅ Reclaimed ${formatCount(deleted.length)} of ${formatCount(report.candidates.length)} objects`,
		);

		if (errors.length > 0) {
			console.error(`❌ ${formatCount(errors.length)} deletes failed:`);

			const keyWidth = keyColumnWidth(errors);

			for (const { key, code, message } of errors) {
				console.error(`  ${key.padEnd(keyWidth)}${code}: ${message}`);
			}

			process.exitCode = 1;
		}
	}
} catch (error) {
	console.error(`\n❌ ${error.message}`);
	process.exitCode = 1;
} finally {
	await mongoose.disconnect();
}
