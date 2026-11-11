/**
 * Where the agent's signing key comes from.
 *
 *   KUDO_KEY_SOURCE=env      (default) PRIVATE_KEY from the environment.
 *   KUDO_KEY_SOURCE=dstack   derived inside the TEE by Phala's dstack. The key
 *                            never exists outside the enclave, is the same on
 *                            every restart of the same app, and nobody has to
 *                            paste it anywhere. A launched agent uses this.
 *
 * Either way the result lands in PRIVATE_KEY, because the bundled `cast` and
 * sponsored-send scripts read it from there.
 *
 *   KUDO_DSTACK_KEY_PATH   default "kudo/agent", the path every integration uses
 *   KUDO_DSTACK_SOCKET     default /var/run/dstack.sock
 */
import { DSTACK_KEY_PATH, dstackPrivateKey } from "../dstack.js";

export type KeySource = "env" | "dstack";

/** Puts the signing key in PRIVATE_KEY. Exits if KUDO_KEY_SOURCE is not one we know. */
export async function resolveSigningKey(env: NodeJS.ProcessEnv = process.env): Promise<KeySource> {
  const source = env.KUDO_KEY_SOURCE?.trim().toLowerCase() || "env";
  if (source === "env") return "env";
  if (source !== "dstack") {
    console.error(`KUDO_KEY_SOURCE must be "env" or "dstack", got "${env.KUDO_KEY_SOURCE}".`);
    process.exit(1);
  }

  if (env.PRIVATE_KEY?.trim()) {
    console.log("PRIVATE_KEY is set but ignored: KUDO_KEY_SOURCE=dstack takes the key from the TEE");
  }
  env.PRIVATE_KEY = await dstackPrivateKey(env.KUDO_DSTACK_KEY_PATH?.trim() || DSTACK_KEY_PATH, {
    socket: env.KUDO_DSTACK_SOCKET?.trim() || undefined,
  });
  return "dstack";
}
