import { z } from "zod";
import { FleetState, StackState } from "./types";
import { ExecFn } from "../ssh";

const routeStateSchema = z.object({
  host: z.string(),
  service: z.string(),
  port: z.number(),
  caddy_id: z.string(),
});

const serviceStateSchema = z.object({
  // Core fields — always present
  definition_hash: z.string(),
  deployed_at: z.string(),
  status: z.string(),
  // Fields added in later versions — optional for backward compat
  image: z.string().optional(),
  image_digest: z.string().optional(),
  env_hash: z.string().optional(),
  skipped_at: z.string().nullable().optional(),
  one_shot: z.boolean().optional(),
});

const stackStateSchema = z.object({
  path: z.string(),
  compose_file: z.string(),
  deployed_at: z.string(),
  routes: z.array(routeStateSchema),
  env_hash: z.string().optional(),
  services: z.record(z.string(), serviceStateSchema).optional(),
});

const fleetStateSchema = z.object({
  fleet_root: z.string(),
  caddy_bootstrapped: z.boolean(),
  stacks: z.record(z.string(), stackStateSchema),
});

function defaultState(): FleetState {
  return {
    fleet_root: "",
    caddy_bootstrapped: false,
    stacks: {},
  };
}

export async function readState(exec: ExecFn): Promise<FleetState> {
  const result = await exec("cat ~/.fleet/state.json");

  if (result.code !== 0 || result.stdout.trim() === "") {
    return defaultState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "Failed to parse state file: invalid JSON in ~/.fleet/state.json"
    );
  }

  const validation = fleetStateSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      `Invalid state file structure: ~/.fleet/state.json — ${validation.error.issues.map((i) => i.message).join(", ")}`
    );
  }

  return validation.data;
}

export async function writeState(
  exec: ExecFn,
  state: FleetState
): Promise<void> {
  const json = JSON.stringify(state, null, 2);

  const mkdirResult = await exec("mkdir -p ~/.fleet");
  if (mkdirResult.code !== 0) {
    const detail = mkdirResult.stderr ? ` — ${mkdirResult.stderr}` : "";
    throw new Error(`Failed to write state file: command exited with code ${mkdirResult.code}${detail}`);
  }

  const writeResult = await exec(`cat << 'FLEET_EOF' > ~/.fleet/state.json.tmp\n${json}\nFLEET_EOF`);
  if (writeResult.code !== 0) {
    const detail = writeResult.stderr ? ` — ${writeResult.stderr}` : "";
    throw new Error(`Failed to write state file: command exited with code ${writeResult.code}${detail}`);
  }

  const mvResult = await exec("mv ~/.fleet/state.json.tmp ~/.fleet/state.json");
  if (mvResult.code !== 0) {
    const detail = mvResult.stderr ? ` — ${mvResult.stderr}` : "";
    throw new Error(`Failed to write state file: command exited with code ${mvResult.code}${detail}`);
  }
}

export function getStack(
  state: FleetState,
  name: string
): StackState | undefined {
  return state.stacks[name];
}

export function removeStack(state: FleetState, name: string): FleetState {
  const { [name]: _, ...remainingStacks } = state.stacks;
  return {
    ...state,
    stacks: remainingStacks,
  };
}
