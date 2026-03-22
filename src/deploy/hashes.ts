import type { ExecFn } from "../ssh";

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
