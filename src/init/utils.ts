import fs from "fs";
import path from "path";
import { STACK_NAME_REGEX } from "../config/schema";

/**
 * Converts a directory name into a valid stack name.
 *
 * - Lowercases the string
 * - Replaces sequences of characters outside [a-z0-9-] with a single hyphen
 * - Strips leading/trailing hyphens
 * - Validates the result against STACK_NAME_REGEX
 *
 * Returns the slugified name, or null if the result is empty or invalid.
 */
export function slugify(input: string): string | null {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (slug === "" || !STACK_NAME_REGEX.test(slug)) {
    return null;
  }

  return slug;
}

/**
 * Checks the given directory for compose.yml and compose.yaml (in that order)
 * and returns the filename of the first match. If neither exists, returns
 * "compose.yml" as the literal default.
 */
export function detectComposeFile(dir: string): string {
  for (const candidate of ["compose.yml", "compose.yaml"]) {
    if (fs.existsSync(path.join(dir, candidate))) {
      return candidate;
    }
  }
  return "compose.yml";
}
