// Stand-in for Alchemy's bundler on a local fork: enforces the BSO request
// shape (policy header, zero fees, no paymaster), verifies and applies the
// EIP-7702 authorization, then runs the UserOperation through the real
// EntryPoint v0.7 handleOps, exactly as a bundler would.
import { createServer } from "node:http";
import { createPublicClient, http, parseAbi, concat, pad, toHex, decodeEventLog } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

const RPC = "http://127.0.0.1:8545";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const BUNDLER = "0x00000000000000000000000000000000000b0b01";
const c = createPublicClient({ transport: http(RPC) });
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const abi = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const receipts = new Map();
export const log = [];

const pack = (op) => ({
  sender: op.sender, nonce: BigInt(op.nonce), initCode: "0x", callData: op.callData,
  accountGasLimits: concat([pad(toHex(BigInt(op.verificationGasLimit)), { size: 16 }), pad(toHex(BigInt(op.callGasLimit)), { size: 16 })]),
  preVerificationGas: BigInt(op.preVerificationGas),
  gasFees: concat([pad(toHex(BigInt(op.maxPriorityFeePerGas)), { size: 16 }), pad(toHex(BigInt(op.maxFeePerGas)), { size: 16 })]),
  paymasterAndData: "0x", signature: op.signature,
});

async function applyAuth(op) {
  const code = await c.getCode({ address: op.sender });
  if (code && code !== "0x") return;
  const a = op.eip7702Auth;
  if (!a) throw new Error("account is not delegated and no eip7702Auth was given");
  const signer = await recoverAuthorizationAddress({ authorization: { chainId: Number(a.chainId), address: a.address, nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) } });
  if (signer.toLowerCase() !== op.sender.toLowerCase()) throw new Error(`eip7702Auth signed by ${signer}, not ${op.sender}`);
  if (Number(a.chainId) !== 4663) throw new Error(`eip7702Auth chainId ${a.chainId}`);
  const nonce = await c.getTransactionCount({ address: op.sender });
  if (Number(a.nonce) !== nonce) throw new Error(`eip7702Auth nonce ${a.nonce}, account nonce ${nonce}`);
  await rpc("hardhat_setCode", [op.sender, concat(["0xef0100", a.address])]);
  await rpc("hardhat_setNonce", [op.sender, toHex(nonce + 1)]);
}

async function handle(method, params, headers) {
  if (!headers["x-alchemy-policy-id"]) throw new Error("missing x-alchemy-policy-id header");
  const [op, ep] = params ?? [];
  if (method === "eth_estimateUserOperationGas" || method === "eth_sendUserOperation") {
    if (ep?.toLowerCase() !== EP.toLowerCase()) throw new Error(`unsupported entrypoint ${ep}`);
    for (const f of ["maxFeePerGas", "maxPriorityFeePerGas", "preVerificationGas"]) if (BigInt(op[f]) !== 0n) throw new Error(`BSO requires ${f}=0, got ${op[f]}`);
    if (op.paymaster || op.paymasterAndData) throw new Error("BSO takes no paymaster fields");
  }
  if (method === "eth_estimateUserOperationGas") return { preVerificationGas: "0x0", verificationGasLimit: "0x30000", callGasLimit: "0x100000" };
  if (method === "eth_sendUserOperation") {
    log.push({ method, auth: !!op.eip7702Auth });
    await applyAuth(op);
    const packed = pack(op);
    const userOpHash = await c.readContract({ address: EP, abi, functionName: "getUserOpHash", args: [packed] });
    await rpc("hardhat_impersonateAccount", [BUNDLER]);
    await rpc("hardhat_setBalance", [BUNDLER, "0xDE0B6B3A7640000"]);
    const { encodeFunctionData } = await import("viem");
    const sent = await rpc("eth_sendTransaction", [{ from: BUNDLER, to: EP, gas: "0x1000000", data: encodeFunctionData({ abi, functionName: "handleOps", args: [[packed], BUNDLER] }) }]);
    if (sent.error) throw new Error(`handleOps reverted: ${JSON.stringify(sent.error).slice(0, 300)}`);
    const receipt = await c.waitForTransactionReceipt({ hash: sent.result });
    const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "UserOperationEvent");
    receipts.set(userOpHash, { userOpHash, success: !!ev?.args.success, receipt: { transactionHash: receipt.transactionHash } });
    return userOpHash;
  }
  if (method === "eth_getUserOperationReceipt") return receipts.get(params[0]) ?? null;
  throw new Error(`method ${method} not supported`);
}

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", async () => {
    const { id, method, params } = JSON.parse(body);
    try {
      const result = await handle(method, params, req.headers);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (e) {
      console.error(`[bundler] ${method}: ${e.message}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32500, message: e.message } }));
    }
  });
}).listen(4337, () => console.error("[bundler] listening on :4337"));
