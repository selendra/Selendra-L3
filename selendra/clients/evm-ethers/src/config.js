import { JsonRpcProvider, WebSocketProvider, Wallet } from "ethers";

// Selendra local testnet. Override with env vars to target another node.
export const RPC_URL = process.env.SELENDRA_RPC ?? "http://127.0.0.1:12346/rpc";
export const WS_URL = process.env.SELENDRA_WS ?? "ws://127.0.0.1:12346/rpc";
export const CHAIN_ID = 19610n;

// Dev key from testing/test-data/keys/token_deployer_private_key.json — the genesis admin, holds most SEL.
// NEVER use this key outside a local testnet. Override with PRIVATE_KEY.
export const PRIVATE_KEY =
  process.env.PRIVATE_KEY ?? "0x0187c12ea7c12024b3f70ac5d73587463af17c8bce2bd9e6fe87389310196c64";

// ethers caches identical RPC requests for 250 ms. Selendra soft-confirms a tx in ~50 ms, so the next send would reuse
// the cached nonce, gas estimate and fees of the previous one and fail with "bad nonce". Turn that cache off.
const OPTIONS = { cacheTimeout: -1 };
const NETWORK = { chainId: Number(CHAIN_ID), name: "selendra-local" };

export function connect() {
  // Selendra has no filter API (eth_newFilter), so ethers must not poll for events over HTTP;
  // use WebSocketProvider (see watch.js) for subscriptions.
  const provider = new JsonRpcProvider(RPC_URL, NETWORK, { ...OPTIONS, staticNetwork: true });
  const wallet = new Wallet(PRIVATE_KEY, provider);
  return { provider, wallet };
}

export function connectWs() {
  return new WebSocketProvider(WS_URL, NETWORK, OPTIONS);
}
