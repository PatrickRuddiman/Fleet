import { ParsedComposeFile } from "../compose/types";

export interface GenerateFleetYmlOptions {
  compose: ParsedComposeFile | null;
  stackName: string;
  composeFilename: string;
}
