import type { ExecFn } from "../ssh";
import crypto from "crypto";
import { ParsedService } from "../compose/types";

/**
 * Retrieves the content-addressable SHA256 digest of a Docker image
 * by running `docker image inspect` via the injected exec function.
 *
 * Returns `null` if the image is not present locally, has no repo digests
 * (e.g., locally built images), or the inspect command fails.
 */
export async function getImageDigest(
  exec: ExecFn,
  image: string
): Promise<string | null> {
  const result = await exec(
    `docker image inspect ${image} --format '{{index .RepoDigests 0}}'`
  );

  if (result.code !== 0) {
    return null;
  }

  const stdout = result.stdout.trim();

  if (stdout === "" || stdout === "<no value>") {
    return null;
  }

  const parts = stdout.split("@");
  return parts[1]?.trim() ?? null;
}

/**
 * Computes the SHA-256 hash of a remote `.env` file by running
 * `sha256sum <envFilePath>` on the remote host via the provided exec function.
 *
 * @param exec - Remote command execution function
 * @param envFilePath - Absolute path to the `.env` file on the remote server
 * @returns A string in the format `"sha256:<hexdigest>"`, or `null` if the file
 *          is missing, unreadable, or the output cannot be parsed.
 */
export async function computeEnvHash(
  exec: ExecFn,
  envFilePath: string
): Promise<string | null> {
  const result = await exec(`sha256sum ${envFilePath}`);

  if (result.code !== 0) {
    return null;
  }

  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return null;
  }

  const hexDigest = trimmed.split(/\s+/)[0];
  if (!hexDigest) {
    return null;
  }

  return `sha256:${hexDigest}`;
}

/**
 * Included fields from ParsedService that affect the runtime definition.
 * Order here does not matter — keys are sorted before hashing.
 */
const INCLUDED_FIELDS: (keyof ParsedService)[] = [
  "image",
  "command",
  "entrypoint",
  "environment",
  "ports",
  "volumes",
  "labels",
  "user",
  "working_dir",
  "healthcheck",
];

/**
 * Recursively removes null, undefined, and empty-string values from
 * objects and arrays.
 *
 * - For objects: omits keys whose cleaned value is null, undefined, or "".
 * - For arrays: filters out null/undefined/"" elements, then recurses into
 *   surviving elements to clean nested structures.
 * - Primitives (numbers, booleans, non-empty strings) pass through unchanged.
 */
export function removeNullAndEmpty(obj: unknown): unknown {
  if (obj === null || obj === undefined || obj === "") {
    return undefined;
  }

  if (Array.isArray(obj)) {
    return obj
      .filter((item) => item !== null && item !== undefined && item !== "")
      .map((item) => removeNullAndEmpty(item));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleaned = removeNullAndEmpty(value);
      if (cleaned !== undefined && cleaned !== null && cleaned !== "") {
        result[key] = cleaned;
      }
    }
    return result;
  }

  return obj;
}

/**
 * Recursively sorts object keys alphabetically at every nesting level.
 * Arrays preserve element order but each element is recursively sorted
 * if it is an object.
 */
export function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sortKeysDeep(item));
  }

  if (typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return obj;
}

/**
 * Computes a deterministic SHA256 hash of the runtime-affecting fields
 * of a ParsedService definition.
 *
 * Only the 10 included fields are extracted (omitting keys not present
 * on the service). The result is piped through removeNullAndEmpty →
 * sortKeysDeep → JSON.stringify (no extra whitespace), then hashed
 * with SHA256. Returns "sha256:<hex digest>".
 */
export function computeDefinitionHash(service: ParsedService): string {
  const subset: Record<string, unknown> = {};
  for (const field of INCLUDED_FIELDS) {
    if (field in service) {
      subset[field] = service[field];
    }
  }

  const cleaned = removeNullAndEmpty(subset);
  const sorted = sortKeysDeep(cleaned);
  const json = JSON.stringify(sorted);
  const hex = crypto.createHash("sha256").update(json).digest("hex");

  return `sha256:${hex}`;
}
