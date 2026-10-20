# State Transition Function

This directory contains two crates that work together to define your blockchain's State Transition Function (STF):

## Architecture Overview

### 1. `stf-declaration` crate
The inner crate where you define all your blockchain modules and runtime structure. This crate is:
- Independent of the Data Availability (DA) layer and ZKVM
- Where all modules must be registered


### 2. `stf` crate  
The outer crate that implements the `Runtime` trait and handles:

- Responsible for deriving the `CHAIN_HASH` from all modules of the `stf-declaration`
- Authentication and security
- DA layer integration through feature flags
- Node-level customizations and extensions

## How to Use

### Adding New Modules
When creating a new module for your blockchain:
1. Define the module in the `stf-declaration` crate
2. Register it in [`stf-declaration/src/lib.rs`](./stf-declaration/src/lib.rs)
3. The `CHAIN_HASH` will automatically update to include your new module

### Runtime Implementation
The main `stf` crate implements the `Runtime` trait in [`runtime.rs`](./src/runtime.rs). It:
- Uses feature flags to select the appropriate DA layer
- Retrieves the correct `CHAIN_HASH` value based on your DA configuration
- Provides the interface used throughout your application

## Key Concepts

- **CHAIN_HASH**: A unique identifier derived from all modules and the selected DA specification
- **Runtime**: The main trait that defines how your blockchain processes state transitions
- **Modules**: Individual components of your blockchain logic (e.g., token transfers, staking, governance)