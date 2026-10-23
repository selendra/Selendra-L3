// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Contracts used by test/compat.js to check EVM compatibility feature by feature.

contract Child {
    uint256 public value;
    address public creator;

    constructor(uint256 v) payable {
        value = v;
        creator = msg.sender;
    }

    function set(uint256 v) external {
        value = v;
    }

    function boom(address payable to) external {
        selfdestruct(to);
    }
}

// Logic contract for delegatecall: writes into the caller's storage slot 0.
contract Logic {
    uint256 public stored;

    function setStored(uint256 v) external {
        stored = v;
    }
}

contract Compat {
    uint256 public stored; // slot 0 — must line up with Logic.stored for the delegatecall test

    error CustomError(uint256 code, string why);
    event Ping(address indexed from, uint256 indexed n, bytes data);
    event Anon(uint256 a) anonymous;
    event Received(address from, uint256 amount);

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    fallback() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ---- block / tx context ----
    function context()
        external
        view
        returns (
            uint256 number, uint256 timestamp, uint256 chainid, uint256 basefee, address coinbase,
            uint256 prevrandao, uint256 gaslimit, bytes32 parentHash, uint256 gasLeft, address origin, uint256 gasprice
        )
    {
        return (
            block.number, block.timestamp, block.chainid, block.basefee, block.coinbase,
            block.prevrandao, block.gaslimit, blockhash(block.number - 1), gasleft(), tx.origin, tx.gasprice
        );
    }

    function cancunOpcodes() external returns (uint256 tloaded, bytes32 copied, bytes32 blobHash0, uint256 blobBaseFee) {
        assembly {
            tstore(1, 42)
            tloaded := tload(1)
            mstore(0x80, 0x1122334455667788990011223344556677889900112233445566778899001122)
            mcopy(0xa0, 0x80, 32)
            copied := mload(0xa0)
            blobHash0 := blobhash(0)
            blobBaseFee := blobbasefee()
        }
    }

    function push0AndShifts(uint256 x) external pure returns (uint256 shl_, uint256 shr_, int256 sar_, uint256 zero) {
        assembly {
            shl_ := shl(4, x)
            shr_ := shr(4, x)
            sar_ := sar(4, sub(0, x))
            zero := 0
        }
    }

    // ---- value transfer ----
    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    function pay(address payable to, uint256 amount) external {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "pay failed");
    }

    // ---- creation ----
    function createChild(uint256 v) external payable returns (address) {
        return address(new Child{value: msg.value}(v));
    }

    function create2Child(uint256 v, bytes32 salt) external returns (address) {
        return address(new Child{salt: salt}(v));
    }

    function predict(uint256 v, bytes32 salt) external view returns (address) {
        bytes memory code = abi.encodePacked(type(Child).creationCode, abi.encode(v));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code))))));
    }

    // EIP-6780 (Cancun): selfdestruct only deletes a contract created in the same transaction.
    function createAndDestroy() external returns (address child, uint256 codeSizeAfter) {
        Child c = new Child(1);
        c.boom(payable(msg.sender));
        child = address(c);
        assembly {
            codeSizeAfter := extcodesize(child)
        }
    }

    function codeSize(address a) external view returns (uint256 s) {
        assembly {
            s := extcodesize(a)
        }
    }

    function codeHash(address a) external view returns (bytes32 h) {
        assembly {
            h := extcodehash(a)
        }
    }

    // ---- calls ----
    function callChild(address c, uint256 v) external returns (uint256) {
        Child(c).set(v);
        return Child(c).value();
    }

    function delegate(address logic, uint256 v) external returns (uint256) {
        (bool ok, ) = logic.delegatecall(abi.encodeWithSelector(Logic.setStored.selector, v));
        require(ok, "delegatecall failed");
        return stored;
    }

    function staticWrite(address c) external returns (bool ok) {
        (ok, ) = c.staticcall(abi.encodeWithSelector(Child.set.selector, 7));
    }

    // ---- errors ----
    function failRequire() external pure {
        require(false, "require message");
    }

    function failCustom() external pure {
        revert CustomError(7, "custom");
    }

    function failPanicDiv(uint256 z) external pure returns (uint256) {
        return 1 / z;
    }

    function failAssert() external pure {
        assert(false);
    }

    function failOverflow(uint256 x) external pure returns (uint256) {
        return x + type(uint256).max;
    }

    function tryCatch(address c) external returns (string memory) {
        try Compat(payable(c)).failRequire() {
            return "no revert";
        } catch Error(string memory reason) {
            return reason;
        }
    }

    // ---- logs ----
    function emitEvents(uint256 n, bytes calldata data) external {
        emit Ping(msg.sender, n, data);
        emit Anon(n);
    }

    // ---- crypto ----
    function recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) external pure returns (address) {
        return ecrecover(digest, v, r, s);
    }

    function hashes(bytes calldata data) external pure returns (bytes32 k, bytes32 s, bytes20 r) {
        return (keccak256(data), sha256(data), ripemd160(data));
    }

    // ---- storage / gas heavy ----
    mapping(uint256 => uint256) public map;
    uint256[] public arr;

    function writeMany(uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            map[i] = i * i;
            arr.push(i);
        }
        stored = n;
    }

    function setStored(uint256 v) external {
        stored = v;
    }
}

// Deploys with ~`size` bytes of runtime code, to test the EIP-170 (24,576 byte) code size limit.
contract BigCodeFactory {
    function deployRaw(uint256 size) external returns (address a) {
        // init code: CODECOPY the runtime (all STOP bytes) and RETURN it.
        bytes memory init = abi.encodePacked(
            hex"61", uint16(size), hex"80600c6000396000f3", new bytes(size)
        );
        assembly {
            a := create(0, add(init, 32), mload(init))
        }
    }
}
