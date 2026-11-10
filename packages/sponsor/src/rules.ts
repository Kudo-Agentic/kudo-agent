import { identityRegistryAbi, kudoAbi, reputationRegistryAbi, type Kudo, type KudoNetwork } from "@kudo-dev/sdk";
import { BaseError, ContractFunctionRevertedError, decodeFunctionData, type Abi, type Address, type Hex } from "viem";

/** One call the relay is asked to sponsor. Never carries value. */
export interface SponsoredCall {
  to: Address;
  data: Hex;
}

/** Which functions are sponsored on which contract. Nothing else is. */
export const SPONSORED_FUNCTIONS = {
  kudo: ["mintCovenant", "setAskSettlementData", "setPromiseSettlementData"],
  identityRegistry: ["register", "setMetadata"],
  // Allowed as a target so the list matches the contracts agents talk to, but
  // no Reputation Registry function is sponsored yet: every call to it is refused.
  reputationRegistry: [],
} as const satisfies Record<string, readonly string[]>;

export interface AllowedTarget {
  name: "Kudo" | "ERC-8004 Identity Registry" | "ERC-8004 Reputation Registry";
  contract: Address;
  abi: Abi;
  functions: readonly string[];
}

/** The contracts a sponsored call may go to, from the SDK's network config. */
export function allowedTargets(network: KudoNetwork): AllowedTarget[] {
  const targets: AllowedTarget[] = [
    { name: "Kudo", contract: network.kudo, abi: kudoAbi as Abi, functions: SPONSORED_FUNCTIONS.kudo },
    { name: "ERC-8004 Identity Registry", contract: network.identityRegistry, abi: identityRegistryAbi as Abi, functions: SPONSORED_FUNCTIONS.identityRegistry },
  ];
  if (network.reputationRegistry) {
    targets.push({ name: "ERC-8004 Reputation Registry", contract: network.reputationRegistry, abi: reputationRegistryAbi as Abi, functions: SPONSORED_FUNCTIONS.reputationRegistry });
  }
  return targets;
}

export type RuleResult =
  | { ok: true; target: AllowedTarget; functionName: string }
  | { ok: false; status: 403; error: "not_allowed"; reason: string }
  | { ok: false; status: 502; error: "upstream_unavailable"; reason: string };

const refuse = (reason: string): RuleResult => ({ ok: false, status: 403, error: "not_allowed", reason });

/** A read that reverted means "no"; anything else (RPC down) is not an answer. */
const reverted = (error: unknown) =>
  error instanceof BaseError && !!error.walk((e) => e instanceof ContractFunctionRevertedError);

/**
 * Decides whether `from` may have `call` sponsored. Run at prepare and again
 * at send, because ownership can change in between.
 */
export async function checkCall(kudo: Kudo, from: Address, call: SponsoredCall): Promise<RuleResult> {
  const target = allowedTargets(kudo.network).find((t) => t.contract.toLowerCase() === call.to.toLowerCase());
  if (!target) {
    return refuse(`${call.to} is not a contract the relay sponsors; only Kudo and the ERC-8004 registries are, and token transfers never are`);
  }

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: target.abi, data: call.data }) as typeof decoded;
  } catch {
    return refuse(`the calldata does not decode as a ${target.name} function`);
  }
  const { functionName, args = [] } = decoded;
  if (!target.functions.includes(functionName)) {
    return refuse(`${target.name}.${functionName} is not sponsored`);
  }
  if (target.name === "ERC-8004 Identity Registry" && functionName === "register") {
    return { ok: true, target, functionName };
  }

  const registry = kudo.network.identityRegistry;
  try {
    const balance = (await kudo.publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "balanceOf",
      args: [from],
    })) as bigint;
    if (balance === 0n) return refuse(`${from} owns no ERC-8004 identity; register one first`);

    // mintCovenant(agentId, …) and setMetadata(agentId, …): the id must be from's.
    if (functionName === "mintCovenant" || functionName === "setMetadata") {
      const agentId = args[0] as bigint;
      let owner: Address | undefined;
      try {
        owner = (await kudo.publicClient.readContract({
          address: registry,
          abi: identityRegistryAbi,
          functionName: "ownerOf",
          args: [agentId],
        })) as Address;
      } catch (error) {
        if (!reverted(error)) throw error;
      }
      if (owner?.toLowerCase() !== from.toLowerCase()) {
        return refuse(`agent ${agentId} is not owned by ${from}`);
      }
    }
  } catch {
    return { ok: false, status: 502, error: "upstream_unavailable", reason: "could not read the identity registry; nothing was sent" };
  }
  return { ok: true, target, functionName };
}
