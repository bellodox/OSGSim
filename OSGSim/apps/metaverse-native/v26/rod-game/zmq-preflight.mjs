// SPDX-License-Identifier: MIT
// Discover native ROD Core publisher endpoints; NEVER open wallet RPC remotely.
const LOCAL=/^tcp:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(?:[1-9][0-9]{1,4})$/;
export function selectRodZmqEndpoints(notifiers,{requested=null}={}){
 if(!Array.isArray(notifiers))throw Error('ROD_NATIVE_ZMQ_NOTIFIER_RPC_UNAVAILABLE');
 const pending=notifiers.filter(n=>n?.type==='pubgamepending'),blocks=notifiers.filter(n=>n?.type==='pubgameblocks');
 if(!pending.length||!blocks.length)throw Error('ROD_NATIVE_GAME_ZMQ_PUBLISHERS_NOT_ENABLED');
 const all=[...new Set([...pending,...blocks].map(x=>x.address))];
 if(all.some(x=>!LOCAL.test(x??'')))throw Error('ROD_GAME_ZMQ_MUST_BIND_TO_LOOPBACK');
 if(all.length>4)throw Error('ROD_GAME_ZMQ_TOO_MANY_ADDRESSES');
 if(requested){if(!LOCAL.test(requested)||!pending.some(x=>x.address===requested)||!blocks.some(x=>x.address===requested))
  throw Error('ROD_GAME_ZMQ_CONFIGURED_ENDPOINT_MISMATCH');return [requested];}
 return all;
}
