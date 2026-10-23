# evm-ethers

Use Selendra as an EVM chain with ethers.js: compile Solidity with solc-js, deploy, call contracts and subscribe to events.

```bash
npm install
npm run demo                       # full walkthrough
npm run deploy -- SelendraToken "My Token" MTK 1000000000000000000000
npm run watch -- <token-address>   # live blocks + Transfer events (WebSocket)
npm run compat                     # EVM compatibility suite (65 checks + known differences)
```

Put your contracts in `contracts/`. Use `connect()` from `src/config.js` in your own scripts. It returns a
`SelendraWallet`, which handles Selendra's short nonce lag after soft confirmations.

Full guide, with viem, Hardhat, Foundry, MetaMask and the supported RPC methods: [`../../docs/EVM.md`](../../docs/EVM.md).
