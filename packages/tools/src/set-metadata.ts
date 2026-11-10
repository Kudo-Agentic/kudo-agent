import { z } from "zod";
import { KudoError } from "@kudo-dev/sdk";

import { agentIdField, define, fromField, toJson, type ToolContext } from "./shared.js";

/**
 * Updates an ERC-8004 identity's metadata. `teeId` is special: it claims the
 * agent runs in a specific Phala enclave, so the only value accepted is the
 * enclave's own app id, read from dstack by this process.
 */
export const setMetadata = ({ kudo, signing, unsigned, agentIdOf, teeId }: ToolContext) =>
  define({
    name: "set_metadata",
    title: "Set agent metadata",
    description:
      "ERC-8004 setMetadata: updates your identity's name or endpoint, or refreshes its teeId. teeId takes no value: inside a TEE it is set to this enclave's own app id (do this at startup if it differs from the one on chain); outside a TEE it cannot be set.",
    inputShape: {
      key: z.enum(["name", "endpoint", "teeId"]).describe("Which entry to set"),
      value: z.string().max(200).optional().describe("The new name or endpoint. Leave out for teeId."),
      agentId: agentIdField.optional(),
      from: fromField,
    },
    writes: true,
    execute: async ({ key, value, agentId, from }) => {
      const id = agentIdOf(agentId);
      let v: string;
      if (key === "teeId") {
        if (!teeId) {
          throw new KudoError(
            "INVALID_INPUT",
            "This agent is not running in a TEE, so it has no teeId to record. Never write one by hand: it would describe some other app.",
          );
        }
        v = teeId;
      } else {
        v = value?.trim() ?? "";
        if (!v) throw new KudoError("INVALID_INPUT", `value is required for ${key}.`);
        if (key === "endpoint" && !z.string().url().safeParse(v).success) {
          throw new KudoError("INVALID_INPUT", "endpoint must be a URL.");
        }
      }
      const info = await kudo.getAgent(id);
      const current = key === "name" ? info.name : key === "teeId" ? info.teeId : undefined;
      if (current === v) {
        return toJson({ changed: false, agentId: id, [key]: v, note: `${key} is already ${v}; nothing to send.` });
      }
      if (!signing) {
        if (from && info.owner.toLowerCase() !== from.toLowerCase()) {
          throw new KudoError("NOT_AGENT_OWNER", `Agent ${id} belongs to ${info.owner}, not ${from}.`);
        }
        return unsigned(kudo.buildSetAgentMetadata(id, key, v), "Only the identity's owner can send this.", from);
      }
      const { hash } = await kudo.setAgentMetadata(id, key, v);
      return toJson({ signed: true, changed: true, agentId: id, [key]: v, hash, explorer: kudo.txUrl(hash) });
    },
  });
