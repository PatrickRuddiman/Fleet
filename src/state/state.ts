import fs from "fs";
import path from "path";
import os from "os";
import { FleetState, StackState } from "./types";

const STATE_DIR = path.join(os.homedir(), ".fleet");
const STATE_FILE = path.join(STATE_DIR, "state.json");

function defaultState(): FleetState {
  return {
    fleet_root: "",
    caddy_bootstrapped: false,
    stacks: {},
  };
}

export function readState(): FleetState {
  if (!fs.existsSync(STATE_FILE)) {
    return defaultState();
  }

  let content: string;
  try {
    content = fs.readFileSync(STATE_FILE, "utf-8");
  } catch {
    throw new Error(`Could not read state file: ${STATE_FILE}`);
  }

  try {
    return JSON.parse(content) as FleetState;
  } catch {
    throw new Error(`Invalid JSON in state file: ${STATE_FILE}`);
  }
}

export function writeState(state: FleetState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function getStack(state: FleetState, name: string): StackState | undefined {
  return state.stacks[name];
}

export function removeStack(state: FleetState, name: string): FleetState {
  const { [name]: _, ...remainingStacks } = state.stacks;
  return {
    ...state,
    stacks: remainingStacks,
  };
}
