// Deploy one contract from contracts/ and save its address to deployments/selendra-local.json.
// Usage: npm run deploy -- <ContractName> [constructor args...]
//   e.g. npm run deploy -- SelendraToken "My Token" MTK 1000000000000000000000000
import fs from "node:fs";
import path from "node:path";
import { ContractFactory } from "ethers";
import { compile } from "./compile.js";
import { connect } from "./config.js";

const [name = "SelendraToken", ...args] = process.argv.slice(2);
const ctorArgs = args.length || name !== "SelendraToken" ? args : ["Selendra Token", "SLT", (10n ** 24n).toString()];

const artifacts = compile();
if (!artifacts[name]) throw new Error(`No contract ${name}. Available: ${Object.keys(artifacts).join(", ")}`);

const { wallet } = connect();
const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, wallet).deploy(...ctorArgs);
await contract.waitForDeployment();
const address = await contract.getAddress();
console.log(`${name} deployed at ${address} (tx ${contract.deploymentTransaction().hash})`);

const file = path.resolve(import.meta.dirname, "..", "deployments", "selendra-local.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
saved[name] = { address, args: ctorArgs, deployedAt: new Date().toISOString() };
fs.writeFileSync(file, JSON.stringify(saved, null, 2));
console.log(`Saved to deployments/selendra-local.json`);
