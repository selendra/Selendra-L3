import { createStandardRollup } from "@sovereign-sdk/web3";
import { Secp256k1Signer } from "@sovereign-sdk/signers";
import { computeAddress, parseUnits } from "ethers";
import { RuntimeCall } from "./types";

// Usage: npm run transfer -- <to-address> <amount> [token_id]
//   amount is in whole tokens (e.g. 1.5); the gas token (SEL, 18 decimals) is used if token_id is omitted.
const [to, amountArg, tokenArg] = process.argv.slice(2);
if (!to || !amountArg) {
  console.error("Usage: npm run transfer -- <to-address> <amount> [token_id]");
  process.exit(1);
}

const url = process.env.ROLLUP_URL ?? "http://127.0.0.1:12346";
const rollup = await createStandardRollup({ url });

// Dev key from testing/test-data/keys/token_deployer_private_key.json (0xA6ed…, holds most SEL in genesis).
// Override with PRIVATE_KEY.
const privKey =
  process.env.PRIVATE_KEY ?? "0187c12ea7c12024b3f70ac5d73587463af17c8bce2bd9e6fe87389310196c64";
const signer = new Secp256k1Signer(privKey);
const from = computeAddress(`0x${privKey}`).toLowerCase();

const tokenId =
  tokenArg ?? ((await (await fetch(`${url}/modules/bank/tokens/gas_token`)).json()).token_id as string);
const meta = await (await fetch(`${url}/modules/bank/tokens/${tokenId}/metadata`)).json();
const amount = parseUnits(amountArg, meta.decimals).toString();

console.log(`Transfer ${amountArg} ${meta.name} (${amount} base units)\n  from ${from}\n  to   ${to}`);

const callMessage: RuntimeCall = {
  bank: {
    transfer: {
      to,
      coins: { amount, token_id: tokenId },
    },
  },
};

const res = await rollup.call(callMessage, { signer });
console.log(`tx ${res.response.id}: ${res.response.receipt?.result ?? res.response.status}`);
