// SPDX-License-Identifier: MIT
// Distinguish an RPC refusal (nothing was broadcast) from an unknown outcome
// (timeout, connection loss, malformed reply). Only unknown outcomes justify
// freezing a wallet outbox; a locked wallet or a rejected transaction must not.
// Codes are the Bitcoin-Core family used by Namecoin/Xaya/ROD Core.
export const DEFINITE_RPC_REFUSAL=new Set([
 -4,  // RPC_WALLET_ERROR: transaction creation / mempool acceptance failed
 -6,  // RPC_WALLET_INSUFFICIENT_FUNDS
 -8,  // RPC_INVALID_PARAMETER
 -13, // RPC_WALLET_UNLOCK_NEEDED
 -14, // RPC_WALLET_PASSPHRASE_INCORRECT
 -22, // RPC_DESERIALIZATION_ERROR
 -25, // RPC_VERIFY_ERROR
 -26, // RPC_VERIFY_REJECTED
 -28, // RPC_IN_WARMUP
]);
export const isDefiniteRpcRefusal=error=>Number.isInteger(error?.code)&&DEFINITE_RPC_REFUSAL.has(error.code);
export const retryDelayMs=failures=>Math.min(60000,2000*2**Math.max(0,Math.min(10,failures-1)));
