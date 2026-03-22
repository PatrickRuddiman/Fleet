import type { ParsedComposeFile } from "../compose/types";
import type { StackState } from "../state/types";
import { alwaysRedeploy } from "../compose/queries";

/**
 * Freshly computed hashes for a single service, used as input
 * to the classification decision tree.
 */
export interface CandidateHashes {
  definitionHash: string;
  imageDigest: string | null;
}

/**
 * The result of classifying all services in a compose file into
 * three action buckets: deploy, restart, or skip.
 */
export interface ServiceClassification {
  toDeploy: string[];
  toRestart: string[];
  toSkip: string[];
  reasons: Record<string, string>;
}

/**
 * Classifies each service in a compose file into one of three action
 * buckets based on comparison with stored stack state and candidate hashes.
 *
 * Decision tree (evaluated in strict priority order per service):
 * 1. One-shot service → toDeploy
 * 2. Service not found in stack state → toDeploy
 * 3. Definition hash differs → toDeploy
 * 4. Image digest differs (both non-null) → toDeploy
 * 5. Env hash changed → toRestart
 * 6. Otherwise → toSkip
 *
 * @param compose - The parsed compose file containing service definitions
 * @param stackState - The stored stack state with previous service hashes
 * @param candidateHashes - Map of service name to freshly computed hashes
 * @param envHashChanged - Whether the environment hash has changed
 * @returns Classification of services into toDeploy, toRestart, and toSkip arrays
 */
export function classifyServices(
  compose: ParsedComposeFile,
  stackState: StackState,
  candidateHashes: Record<string, CandidateHashes>,
  envHashChanged: boolean,
): ServiceClassification {
  const toDeploy: string[] = [];
  const toRestart: string[] = [];
  const toSkip: string[] = [];
  const reasons: Record<string, string> = {};

  for (const name of Object.keys(compose.services)) {
    const service = compose.services[name];
    const stored = stackState.services?.[name];
    const candidate = candidateHashes[name];

    // 1. Services with limited restart policies always redeploy
    if (alwaysRedeploy(service)) {
      toDeploy.push(name);
      reasons[name] = "one-shot";
      continue;
    }

    // 2. New service (not in stored state)
    if (!stored) {
      toDeploy.push(name);
      reasons[name] = "new service";
      continue;
    }

    // 3. Definition hash changed
    if (candidate && stored.definition_hash !== candidate.definitionHash) {
      toDeploy.push(name);
      reasons[name] = "definition changed";
      continue;
    }

    // 4. Image digest changed (both non-null)
    if (
      candidate &&
      candidate.imageDigest !== null &&
      stored.image_digest !== null &&
      stored.image_digest !== candidate.imageDigest
    ) {
      toDeploy.push(name);
      reasons[name] = `image changed (${stored.image_digest.substring(0, 7)} → ${candidate.imageDigest!.substring(0, 7)})`;
      continue;
    }

    // 5. Env hash changed
    if (envHashChanged) {
      toRestart.push(name);
      reasons[name] = "env changed";
      continue;
    }

    // 6. Nothing changed
    toSkip.push(name);
    reasons[name] = "no changes";
  }

  return { toDeploy, toRestart, toSkip, reasons };
}
