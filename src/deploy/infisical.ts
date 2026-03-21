import { ExecFn } from "../ssh";

/**
 * Ensures the Infisical CLI is installed on the remote server.
 * Checks if the CLI is already present; if not, installs it via the
 * official installer and verifies the installation succeeded.
 */
export async function bootstrapInfisicalCli(exec: ExecFn): Promise<void> {
  // Step 1: Check if Infisical CLI is already installed
  const checkResult = await exec("infisical --version");
  if (checkResult.code === 0) {
    return;
  }

  // Step 2: Install Infisical CLI using the official installer
  const installResult = await exec(
    "curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | sudo bash && sudo apt-get update && sudo apt-get install -y infisical"
  );
  if (installResult.code !== 0) {
    const detail = installResult.stderr ? ` — ${installResult.stderr}` : "";
    throw new Error(
      `Failed to install Infisical CLI: command exited with code ${installResult.code}${detail}`
    );
  }

  // Step 3: Verify the installation succeeded
  const verifyResult = await exec("infisical --version");
  if (verifyResult.code !== 0) {
    const detail = verifyResult.stderr ? ` — ${verifyResult.stderr}` : "";
    throw new Error(
      `Infisical CLI installation could not be verified: command exited with code ${verifyResult.code}${detail}`
    );
  }
}
