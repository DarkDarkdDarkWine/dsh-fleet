import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the fleet data directory: $DSH_FLEET_DIR → $DSH_HOME/fleet → ~/.dsh/fleet.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDataDir(env = process.env) {
	if (env.DSH_FLEET_DIR) return env.DSH_FLEET_DIR;
	if (env.DSH_HOME) return join(env.DSH_HOME, "fleet");
	return join(homedir(), ".dsh", "fleet");
}
