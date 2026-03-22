export { Severity, Finding, Codes } from "./types";
export { checkFqdnFormat, checkPortRange, checkDuplicateHosts, checkInvalidStackName, checkEnvConflict } from "./fleet-checks";
export {
  checkReservedPortConflicts,
  checkServiceNotFound,
  checkPortExposed,
  checkNoImageOrBuild,
  checkOneShotNoMaxAttempts,
} from "./compose-checks";

import { FleetConfig } from "../config/schema";
import { ParsedComposeFile } from "../compose/types";
import { Finding } from "./types";
import { checkFqdnFormat, checkPortRange, checkDuplicateHosts, checkInvalidStackName, checkEnvConflict } from "./fleet-checks";
import {
  checkReservedPortConflicts,
  checkServiceNotFound,
  checkPortExposed,
  checkNoImageOrBuild,
  checkOneShotNoMaxAttempts,
} from "./compose-checks";

export function runAllChecks(
  config: FleetConfig,
  compose: ParsedComposeFile,
): Finding[] {
  return [
    ...checkInvalidStackName(config),
    ...checkEnvConflict(config),
    ...checkFqdnFormat(config.routes),
    ...checkPortRange(config.routes),
    ...checkDuplicateHosts(config.routes),
    ...checkReservedPortConflicts(compose),
    ...checkServiceNotFound(config, compose),
    ...checkPortExposed(compose),
    ...checkNoImageOrBuild(compose),
    ...checkOneShotNoMaxAttempts(compose),
  ];
}
