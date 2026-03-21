import { FleetState, StackState, ExecFn } from "./types";

function defaultState(): FleetState {
  return {
    fleet_root: "",
    caddy_bootstrapped: false,
    stacks: {},
  };
}

export async function readState(exec: ExecFn): Promise<FleetState> {
  const result = await exec("cat ~/.fleet/state.json");

  if (result.exitCode !== 0 || result.stdout.trim() === "") {
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

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.fleet_root !== "string" ||
    typeof obj.caddy_bootstrapped !== "boolean" ||
    typeof obj.stacks !== "object" ||
    obj.stacks === null
  ) {
    throw new Error(
      "Invalid state file structure: ~/.fleet/state.json — expected fleet_root (string), caddy_bootstrapped (boolean), and stacks (object)"
    );
  }

  return parsed as FleetState;
}

export async function writeState(
  exec: ExecFn,
  state: FleetState
): Promise<void> {
  const json = JSON.stringify(state, null, 2);
  const command = `mkdir -p ~/.fleet && cat << 'FLEET_EOF' > ~/.fleet/state.json.tmp\n${json}\nFLEET_EOF\n&& mv ~/.fleet/state.json.tmp ~/.fleet/state.json`;

  const result = await exec(command);

  if (result.exitCode !== 0) {
    const detail = result.stderr
      ? ` — ${result.stderr}`
      : "";
    throw new Error(
      `Failed to write state file: command exited with code ${result.exitCode}${detail}`
    );
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
