import { JsonRpcProvider, WebSocketProvider, Wallet } from "ethers";

// Selendra local testnet. Override with env vars to target another node.
export const RPC_URL = process.env.SELENDRA_RPC ?? "http://127.0.0.1:12346/rpc";
export const WS_URL = process.env.SELENDRA_WS ?? "ws://127.0.0.1:12346/rpc";
export const CHAIN_ID = 19610n;

// Dev key from testing/test-data/keys/token_deployer_private_key.json — the genesis admin, holds most SEL.
// NEVER use this key outside a local testnet. Override with PRIVATE_KEY.
export const PRIVATE_KEY =
  process.env.PRIVATE_KEY ?? "0x0187c12ea7c12024b3f70ac5d73587463af17c8bce2bd9e6fe87389310196c64";

// Right after a tx is soft-confirmed, eth_getTransactionCount can briefly return the previous nonce (the RPC reads
// committed state while the sequencer is already ahead), and Selendra's eth_estimateGas rejects a stale nonce.
// This wallet remembers the next nonce it should use and takes max(network, local), so back-to-back sends work.
// (ethers' NonceManager is not enough: it overrides the nonce only after gas was estimated with the stale one.)
export class SelendraWallet extends Wallet {
  #next = null;
  async getNonce(blockTag) {
    const network = await super.getNonce(blockTag);
    return blockTag === "pending" && this.#next != null ? Math.max(network, this.#next) : network;
  }
  async sendTransaction(tx) {
    const sent = await super.sendTransaction(tx);
    this.#next = Math.max(this.#next ?? 0, sent.nonce + 1);
    return sent;
  }
  connect(provider) {
    return new SelendraWallet(this.signingKey, provider);
  }
}

export function connect() {
  // Selendra has no filter API (eth_newFilter), so ethers must not poll for events over HTTP;
  // use WebSocketProvider (see watch.js) for subscriptions.
  const provider = new JsonRpcProvider(RPC_URL, { chainId: Number(CHAIN_ID), name: "selendra-local" }, { staticNetwork: true });
  const wallet = new SelendraWallet(PRIVATE_KEY, provider);
  return { provider, wallet };
}

export function connectWs() {
  return new WebSocketProvider(WS_URL, { chainId: Number(CHAIN_ID), name: "selendra-local" });
}
