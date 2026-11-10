// The /connect snippets, read from kudo-client's snippets.ts, with only the
// placeholders swapped for test values: the "0x…" key and the "123" agent id.
// KUDO_RPC_URL is the one addition, so the server talks to the local fork.
const file = process.env.CONNECT_SNIPPETS;
if (!file) throw new Error("Set CONNECT_SNIPPETS to kudo-client/src/components/connect/snippets.ts");
const { CONNECT_OPTIONS } = await import(file);
export const snippet = (id) => {
  const s = CONNECT_OPTIONS.flatMap((o) => o.snippets).find((x) => x.id === id);
  if (!s) throw new Error(`no snippet ${id} in ${file}`);
  return s.code;
};
export const fill = (code, { key, agentId }) => code.replaceAll("0x…", key).replaceAll('"123"', `"${agentId}"`).replaceAll("=123", `=${agentId}`);
