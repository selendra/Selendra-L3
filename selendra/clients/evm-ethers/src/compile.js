import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(import.meta.dirname, "..");
const contractsDir = path.join(root, "contracts");
const outDir = path.join(root, "artifacts");

// Compiles every <dir>/*.sol with solc-js and writes artifacts/<Name>.json ({ abi, bytecode }).
export function compile(dir = contractsDir) {
  const sources = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
    sources[f] = { content: fs.readFileSync(path.join(dir, f), "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));

  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = {};
  for (const file of Object.values(output.contracts)) {
    for (const [name, c] of Object.entries(file)) {
      artifacts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
      fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(artifacts[name], null, 2));
    }
  }
  return artifacts;
}

if (process.argv[1] === import.meta.filename) {
  const a = compile();
  console.log(`Compiled with solc ${solc.version()}: ${Object.keys(a).join(", ")} -> artifacts/`);
}
