// End-to-end walkthrough of Selendra as an EVM chain with ethers.js.
// Run with the node up: `npm run demo` (or `make selendra-evm-demo` from the repo root).
import { ContractFactory, VoidSigner, formatEther, parseEther, parseUnits, formatUnits, Wallet, id } from "ethers";
import { compile } from "./compile.js";
import { connect } from "./config.js";

const { provider, wallet } = connect();
const me = wallet.address;
const step = (s) => console.log(`\n== ${s}`);

step("Network");
const net = await provider.getNetwork();
console.log("chainId      ", net.chainId.toString());
console.log("client       ", await provider.send("web3_clientVersion", []));
console.log("block        ", await provider.getBlockNumber());
console.log("deployer     ", me, formatEther(await provider.getBalance(me)), "SEL");

step("Compile + deploy SelendraToken (ERC-20)");
const { SelendraToken } = compile();
const factory = new ContractFactory(SelendraToken.abi, SelendraToken.bytecode, wallet);
const token = await factory.deploy("Selendra Demo Token", "SDT", parseUnits("1000000", 18));
const deployTx = token.deploymentTransaction();
console.log("tx           ", deployTx.hash);
await token.waitForDeployment();
const address = await token.getAddress();
const deployRcpt = await deployTx.wait();
console.log("address      ", address, `(block ${deployRcpt.blockNumber}, gas ${deployRcpt.gasUsed})`);
console.log("code size    ", (await provider.getCode(address)).length / 2 - 1, "bytes");

step("Read (eth_call)");
console.log("name/symbol  ", await token.name(), "/", await token.symbol());
console.log("totalSupply  ", formatUnits(await token.totalSupply(), 18));
console.log("my balance   ", formatUnits(await token.balanceOf(me), 18));

step("Write: ERC-20 transfer + events from the receipt");
const alice = Wallet.createRandom().address;
const est = await token.transfer.estimateGas(alice, parseUnits("250", 18));
const tx = await token.transfer(alice, parseUnits("250", 18));
const rcpt = await tx.wait();
console.log("tx           ", tx.hash, `status ${rcpt.status}, gas ${rcpt.gasUsed} (estimated ${est})`);
for (const log of rcpt.logs) {
  const ev = token.interface.parseLog(log);
  console.log("event        ", `${ev.name}(${ev.args.from} -> ${ev.args.to}, ${formatUnits(ev.args.value, 18)})`);
}
console.log("alice balance", formatUnits(await token.balanceOf(alice), 18), "SDT");

step("Query past events (eth_getLogs)");
const logs = await provider.getLogs({ address, topics: [id("Transfer(address,address,uint256)")], fromBlock: deployRcpt.blockNumber, toBlock: "latest" });
console.log("Transfer logs", logs.length);
const events = await token.queryFilter(token.filters.Transfer(null, alice), deployRcpt.blockNumber);
console.log("to alice     ", events.length);

step("Revert handling");
try {
  await token.connect(new VoidSigner(alice, provider)).mint.staticCall(alice, 1n);
} catch (e) {
  console.log("mint by non-owner reverted:", e.reason ?? e.shortMessage);
}

step("Native SEL transfer (EIP-1559)");
const fee = await provider.getFeeData();
console.log("fee data     ", `maxFeePerGas ${fee.maxFeePerGas}, priority ${fee.maxPriorityFeePerGas}`);
const send = await wallet.sendTransaction({ to: alice, value: parseEther("0.5") });
await send.wait();
console.log("alice SEL    ", formatEther(await provider.getBalance(alice)));

console.log(`\nDone. Open the explorer: http://127.0.0.1:8080/#/address/${alice}`);
