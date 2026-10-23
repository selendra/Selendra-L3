// Live subscriptions over WebSocket: new blocks and (optionally) a contract's Transfer events.
// Usage: npm run watch [-- <token-address>]
import { Contract, formatUnits } from "ethers";
import { connectWs } from "./config.js";

const provider = connectWs();
console.log("Listening on", provider.websocket.url, "(Ctrl+C to stop)");

provider.on("block", (n) => console.log("block", n));

const tokenAddress = process.argv[2];
if (tokenAddress) {
  const abi = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
  new Contract(tokenAddress, abi, provider).on("Transfer", (from, to, value) =>
    console.log(`Transfer ${from} -> ${to}: ${formatUnits(value, 18)}`),
  );
}
