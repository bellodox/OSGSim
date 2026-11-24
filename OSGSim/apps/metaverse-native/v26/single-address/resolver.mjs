// SPDX-License-Identifier: MIT
// Relay locators and the ROD realm directory. ROD name state is the trust root.
import net from 'node:net';
import {hexId} from './crypto.mjs';
import {assertRodMainnetInfo} from './network-policy.mjs';
export const DEFAULT_REALM_NAME='spexgsp/universe/default';
const REALM_NAME=/^[-a-z0-9/.]{1,120}$/;
export function safeRelayUrl(value,{allowLocalWs=false}={}){
 let u;try{u=new URL(value)}catch{throw Error('invalid_nostr_relay_url')}
 const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
 if(u.protocol!=='wss:'&&!(allowLocalWs&&local&&u.protocol==='ws:'))throw Error('insecure_nostr_relay_disallowed');
 if(u.username||u.password||u.hash||u.search||u.pathname!=='/'||!u.hostname)throw Error('invalid_nostr_relay_locator');return u.toString();
}
export function parseRelayAddress(input,{allowLocalWs=false}={}){
 const address=String(input??'').trim();if(!address||address.length>253)throw Error('relay_address_missing');
 if(address.toLowerCase().endsWith('.rod')){if(!/^[a-z0-9][a-z0-9-]{0,62}\.rod$/i.test(address))throw Error('invalid_rod_domain');return{kind:'rod',name:address.slice(0,-4).toLowerCase()};}
 let ip=address;let port=443;
 if(address.startsWith('[')){const m=/^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(address);if(!m||net.isIP(m[1])!==6)throw Error('invalid_ipv6_relay');ip=m[1];port=Number(m[2]??443);}
 else if(net.isIP(address)){}else if(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)){const [a,b]=address.split(':');ip=a;port=Number(b);}
 else if(address.startsWith('wss://')||(allowLocalWs&&address.startsWith('ws://')))return{kind:'relay',urls:[safeRelayUrl(address,{allowLocalWs})]};
 else throw Error('relay_ip_or_rod_name_required');
 if(net.isIP(ip)===0||port<1||port>65535||!Number.isInteger(port))throw Error('invalid_relay_ip_or_port');
 return{kind:'relay',urls:[safeRelayUrl('wss://'+(net.isIP(ip)===6?'['+ip+']':ip)+':'+port+'/',{allowLocalWs})]};
}
function checkDirectory(x,record,genesis){if(!x||x.schema!=='spexgsp/realm/1'||typeof x.realmId!=='string'||x.realmId.length>128||!hexId(x.worldId)||!hexId(x.publisher)||!hexId(x.rodGenesis)||!hexId(x.assetRoot)||!Number.isSafeInteger(x.era)||x.era<1)throw Error('invalid_ROD_world_directory');
 if(record.address!==x.ownerAddress||!record.txid||typeof record.height!=='number'||record.height<1)throw Error('ROD_directory_owner_or_confirmation_invalid');
 if(x.rodGenesis!==genesis)throw Error('wrong_ROD_genesis');
 return x;
}
export async function getRodDirectory(rpc,{realmName=DEFAULT_REALM_NAME,minConfirmations=1}={}){
 if(typeof rpc!=='function'||typeof realmName!=='string'||!REALM_NAME.test(realmName))throw Error('invalid_ROD_directory_request');
 const [record,blockchain,genesis]=await Promise.all([rpc('name_show',[realmName]),rpc('getblockchaininfo'),rpc('getblockhash',[0])]);
 assertRodMainnetInfo(blockchain);
 const height=blockchain.blocks;if(!Number.isSafeInteger(height)||!Number.isSafeInteger(record.height)||height-record.height+1<minConfirmations)throw Error('ROD_directory_not_confirmed');
 let data;try{data=JSON.parse(record.value)}catch{throw Error('ROD_directory_invalid_JSON')}
 return{directory:checkDirectory(data,record,genesis),record,network:blockchain.chain,chainHeight:height,genesis};
}
/** Relays listed by the universe owner in the confirmed ROD realm directory (`relays`, wss only, at most 6) and the
 * certificate pins the owner published for them (`relayPins`: relay URL -> SHA-256 of the relay certificate's public key).
 * A pinned relay needs no certificate authority: ROD vouches for its key. Unregistered or unreadable: none. */
export async function directoryRelayInfo(rpc,{realmName=DEFAULT_REALM_NAME,allowLocalWs=false}={}){
 const none={urls:[],pins:new Map()};
 let found;try{found=await getRodDirectory(rpc,{realmName});}catch{return none;}
 const list=found.directory.relays;if(list===undefined)return none;
 if(!Array.isArray(list)||list.length>6)throw Error('invalid_ROD_directory_relays');
 const urls=[...new Set(list.map(u=>safeRelayUrl(u,{allowLocalWs})))],pins=new Map();
 const raw=found.directory.relayPins;
 if(raw!==undefined){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('invalid_ROD_directory_relay_pins');
  for(const [key,pin] of Object.entries(raw)){
   const url=safeRelayUrl(key,{allowLocalWs});
   if(!urls.includes(url)||!/^[a-f0-9]{64}$/.test(pin))throw Error('invalid_ROD_directory_relay_pins');
   pins.set(url,pin);
  }
 }
 return{urls,pins};
}
export async function directoryRelays(rpc,options={}){return(await directoryRelayInfo(rpc,options)).urls;}
export async function resolveRodAlias(name,rpc,{allowLocalWs=false}={}){
 if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))throw Error('invalid_rod_label');
 const [record,chain]=await Promise.all([rpc('name_show',['d/'+name]),rpc('getblockchaininfo')]);
 assertRodMainnetInfo(chain);
 if(!record?.address||!record.txid||!Number.isSafeInteger(record.height)||record.height<1||!Number.isSafeInteger(chain.blocks)||chain.blocks<record.height)throw Error('rod_dns_name_unverified');
 let data;try{data=JSON.parse(record.value)}catch{throw Error('rod_dns_JSON_invalid')}
 if(data.ownerAddress&&data.ownerAddress!==record.address)throw Error('rod_dns_owner_mismatch');
 const urls=data?.svc?.nostr;if(!Array.isArray(urls)||!urls.length||urls.length>6)throw Error('rod_dns_has_no_nostr_service');
 return [...new Set(urls.map(u=>safeRelayUrl(u,{allowLocalWs})))];
}
export async function seedRelays(input,rpc,{allowLocalWs=false}={}){
 const x=parseRelayAddress(input,{allowLocalWs});return x.kind==='rod'?await resolveRodAlias(x.name,rpc,{allowLocalWs}):x.urls;
}
