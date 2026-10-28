import { createStandardRollup } from "@sovereign-sdk/web3";
import { Secp256k1Signer } from "@sovereign-sdk/signers";

// Usage: npm run prover-bond -- exit | register <amount>
// Unbonds or (re-)registers the dev prover (0xA6ed…, testing/test-data/keys/token_deployer_private_key.json).
const [action, amount] = process.argv.slice(2);
const rollup = await createStandardRollup({ url: process.env.ROLLUP_URL ?? "http://127.0.0.1:12346" });
const signer = new Secp256k1Signer(process.env.PRIVATE_KEY ?? "0187c12ea7c12024b3f70ac5d73587463af17c8bce2bd9e6fe87389310196c64");
const call = action === "exit" ? { prover_incentives: "exit" } : { prover_incentives: { register: amount } };
const res: any = await rollup.call(call as any, { signer });
console.log(action, "→", res.response?.receipt?.result, JSON.stringify(res.response?.events?.map((e: any) => e.key) ?? []), JSON.stringify(res.response?.receipt?.data ?? {}));
