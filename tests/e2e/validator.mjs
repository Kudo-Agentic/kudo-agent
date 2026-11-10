// Plays Kudo's validator on the local fork: the mainnet validator wallet holds
// EVALUATOR_CONTRACT_ROLE, so impersonating it lets a test accept an ask
// (status 1, IN_PROGRESS), which is what makes the minter's promise due.
import { encodeFunctionData } from "viem";
import { kudoAbi } from "@kudo-dev/sdk";

export const VALIDATOR = "0xE3dEc5683a860373c3020c8949C8B5C78d5a8EAD";
export const KUDO = "0x1930D0FEaB14b024353bF22adE03Db989aD640C7";

const call = (rpc, method, params) =>
  fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

/** Sets a covenant's status as the validator would, and waits for it to be mined. */
export async function setStatus(rpc, id, status) {
  await call(rpc, "hardhat_impersonateAccount", [VALIDATOR]);
  await call(rpc, "hardhat_setBalance", [VALIDATOR, "0xDE0B6B3A7640000"]);
  const data = encodeFunctionData({ abi: kudoAbi, functionName: "setCovenantStatus", args: [BigInt(id), status] });
  const sent = await call(rpc, "eth_sendTransaction", [{ from: VALIDATOR, to: KUDO, data }]);
  if (sent.error) throw new Error(`setCovenantStatus(${id}, ${status}) failed: ${sent.error.message}`);
  for (let i = 0; i < 100; i++) {
    const r = await call(rpc, "eth_getTransactionReceipt", [sent.result]);
    if (r.result) {
      if (r.result.status !== "0x1") throw new Error(`setCovenantStatus(${id}, ${status}) reverted`);
      return sent.result;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`setCovenantStatus(${id}, ${status}) was not mined`);
}

/** The validator accepts the claim on a covenant's ask: its promise is now due. */
export const acceptAsk = (rpc, id) => setStatus(rpc, id, 1);
