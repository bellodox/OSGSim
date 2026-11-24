// SPDX-License-Identifier: MIT
// Mainnet ONLY, and the locally verified chain must be live and sufficiently
// synchronized. These are validity checks, not transaction/congestion limits.
export const REQUIRED_ROD_CHAIN='main';
export function assertRodMainnetInfo(info,{now=Date.now(),maxTipAgeMs=4*3600_000,maxHeaderLag=8,minProgress=0.999}={}){
 if(!info||info.chain!==REQUIRED_ROD_CHAIN)throw Error('ROD_MAINNET_REQUIRED: expected getblockchaininfo.chain=main');
 if(!Number.isSafeInteger(info.blocks)||info.blocks<1)throw Error('ROD_MAINNET_CHAIN_NOT_VALIDATED');
 if(info.initialblockdownload===true)throw Error('ROD_MAINNET_STILL_SYNCHRONIZING');
 if(!Number.isSafeInteger(info.headers)||info.headers<info.blocks||info.headers-info.blocks>maxHeaderLag)throw Error('ROD_MAINNET_HEADERS_NOT_CAUGHT_UP');
 if(typeof info.verificationprogress!=='number'||info.verificationprogress<minProgress||info.verificationprogress>1.00001)throw Error('ROD_MAINNET_VERIFICATION_PROGRESS_INSUFFICIENT');
 if(!Number.isFinite(info.mediantime)||info.mediantime<=0||Math.abs(now-info.mediantime*1000)>maxTipAgeMs)throw Error('ROD_MAINNET_STALE_OR_INVALID_TIP');
 if(info.bestblockhash!==undefined&&!/^[0-9a-f]{64}$/.test(info.bestblockhash))throw Error('ROD_MAINNET_TIP_HASH_INVALID');
 return info;
}
export async function requireRodMainnet(rpc,{now=Date.now(),requirePeers=true}={}){
 if(typeof rpc!=='function')throw Error('ROD_MAINNET_RPC_REQUIRED');
 const info=assertRodMainnetInfo(await rpc('getblockchaininfo',[]),{now});
 if(requirePeers){const network=await rpc('getnetworkinfo',[]);
  if(network?.networkactive===false||!Number.isSafeInteger(network?.connections)||network.connections<1)throw Error('ROD_MAINNET_NODE_HAS_NO_PEERS');
 }
 return info;
}
