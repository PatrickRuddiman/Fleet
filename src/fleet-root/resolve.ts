import { ExecFn } from "../ssh";

const PRIMARY_ROOT = "/opt/fleet";
const FLEET_ROOT_FILE = "~/.fleet-root";

function isPermissionError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("permission denied") || lower.includes("operation not permitted");
}

export async function resolveFleetRoot(exec: ExecFn): Promise<string> {
  // Attempt primary path: /opt/fleet
  const primary = await exec(`mkdir -p ${PRIMARY_ROOT}`);
  if (primary.code === 0) {
    await exec(`echo '${PRIMARY_ROOT}' > ${FLEET_ROOT_FILE}`);
    return PRIMARY_ROOT;
  }

  // If not a permission error, throw immediately
  if (!isPermissionError(primary.stderr)) {
    throw new Error(
      `Failed to create fleet root at ${PRIMARY_ROOT}: ${primary.stderr}`
    );
  }

  // Fallback: ~/fleet — resolve ~ via shell
  const homeResult = await exec("echo ~");
  const home = homeResult.stdout.trim();
  if (homeResult.code !== 0 || !home) {
    throw new Error("Failed to resolve home directory on remote server");
  }

  const fallbackRoot = `${home}/fleet`;
  const fallback = await exec(`mkdir -p ${fallbackRoot}`);
  if (fallback.code !== 0) {
    throw new Error(
      `Failed to create fleet root at ${fallbackRoot}: ${fallback.stderr}`
    );
  }

  await exec(`echo '${fallbackRoot}' > ${FLEET_ROOT_FILE}`);
  return fallbackRoot;
}

export async function readFleetRoot(exec: ExecFn): Promise<string | null> {
  const result = await exec(`cat ${FLEET_ROOT_FILE}`);
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}
