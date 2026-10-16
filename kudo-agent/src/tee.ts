/**
 * Where this agent is running.
 *
 * On Phala, dstack exposes a Unix socket inside the confidential VM. Its Info
 * endpoint returns the app id — the same string Phala's Trust Center uses in
 * its report URL. Publishing that id as identity metadata hands a counterparty
 * a page where they can check the hardware attestation, the OS image and the
 * compose file themselves, instead of taking our word for any of it.
 *
 * Outside a TEE there is no app id. That is not an error: the agent runs
 * locally with no attestation to offer, and says as much.
 */
import { request } from "node:http";

const DSTACK_SOCKET = "/var/run/dstack.sock";
const TRUST_CENTER = "https://trust.phala.com/app";
const INFO_TIMEOUT_MS = 2000;

export interface TeeIdentity {
  /** Phala app id, bare lowercase hex. */
  teeId: string;
  /** Trust Center report for that app id. */
  trustCenterUrl: string;
  /**
   * `dstack` means the enclave told us its own id, so the report describes this
   * process. `environment` means a human put the id there — it names some other
   * app, and attests nothing about this run.
   */
  source: "dstack" | "environment";
}

/** Trust Center paths carry bare hex; dstack and block explorers use `0x`. */
function bareHex(appId: string): string {
  return appId.trim().replace(/^0x/i, "").toLowerCase();
}

/** GET /Info over the dstack socket. Rejects if we are not in a dstack CVM. */
function dstackInfo(): Promise<{ app_id?: unknown }> {
  return new Promise((resolve, reject) => {
    const call = request(
      { socketPath: DSTACK_SOCKET, path: "/Info", timeout: INFO_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            return reject(new Error(`dstack /Info returned ${response.statusCode}`));
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("dstack /Info did not return JSON"));
          }
        });
      },
    );

    call.on("timeout", () => call.destroy(new Error("dstack /Info timed out")));
    call.on("error", reject);
    call.end();
  });
}

async function appIdFromDstack(): Promise<string | undefined> {
  try {
    const { app_id } = await dstackInfo();
    return typeof app_id === "string" && app_id.trim() ? app_id : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`no dstack socket (${reason}) — looking at the environment instead`);
    return undefined;
  }
}

/**
 * The app id from dstack, or from the environment when we are not in a CVM.
 *
 * `DSTACK_APP_ID` is set by Phala's own pre-launch script; `TEE_ID` is ours,
 * for pointing a local run at an already-deployed app's report.
 */
export async function resolveTeeIdentity(): Promise<TeeIdentity | undefined> {
  const attested = await appIdFromDstack();
  const appId =
    attested || process.env.DSTACK_APP_ID?.trim() || process.env.TEE_ID?.trim();

  if (!appId) return undefined;

  const teeId = bareHex(appId);
  return {
    teeId,
    trustCenterUrl: `${TRUST_CENTER}/${teeId}`,
    source: attested ? "dstack" : "environment",
  };
}
