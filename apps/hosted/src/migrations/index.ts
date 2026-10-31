import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_init";
import * as m0002 from "./0002_passwords";

export const migrations: Record<string, Migration> = {
  "0001_init": m0001,
  "0002_passwords": m0002,
};
