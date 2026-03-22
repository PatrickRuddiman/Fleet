import { ExecFn } from "../ssh";

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
