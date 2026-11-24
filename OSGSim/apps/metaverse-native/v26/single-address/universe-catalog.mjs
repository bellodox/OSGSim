// SPDX-License-Identifier: MIT
// The relays a peer connects to. Relay transport is not authority: every advertised universe is
// verified against ROD before use.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {seedRelays,directoryRelayInfo} from './resolver.mjs';
function cleanUrl(address){
 let url;try{url=new URL(address)}catch{throw Error('invalid_bootstrap_relay_url')}
 if(url.protocol!=='wss:'||!url.hostname||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('invalid_bootstrap_relay_url');
 return url.toString();
}
/** `pins` (optional Map) receives relay URL -> certificate key hash for the relays whose certificates the owner pinned on ROD.
 * `skipRelays` lists this peer's own public URL: it already serves itself through its loopback listener. */
export async function bootstrapRelays({root,relayOverride=null,rpc,readConfig=readFile,localRelays=[],realmName=null,allowLocalWs=false,pins=null,skipRelays=[]}={}){
 // Only relays run by the simulation's own operators are used: the relay built into SpeXGSP (localRelays),
 // the relays the universe owner lists in the confirmed ROD realm directory (how peers find each other), the --relay
 // locator (IP, ROD name or wss:// URL) and an optional operator-edited list. No public relay is bundled.
 const local=[...new Set(localRelays)];
 const checkLocal=u=>{let x;try{x=new URL(u)}catch{throw Error('invalid_local_relay_url')}
  if(!(x.protocol==='wss:'||x.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(x.hostname)))throw Error('invalid_local_relay_url');return x.toString();};
 local.forEach(checkLocal);
 const info=realmName&&typeof rpc==='function'?await directoryRelayInfo(rpc,{realmName,allowLocalWs}):{urls:[],pins:new Map()};
 if(pins)for(const [url,pin] of info.pins)pins.set(url,pin);
 const skip=new Set(skipRelays.map(u=>new URL(u).toString()));
 const merge=list=>{const out=[...new Set([...local.map(checkLocal),...info.urls,...list])].filter(u=>!skip.has(u)||local.includes(u)).slice(0,8);
  if(!out.length)throw Error('NO_OPERATOR_RELAY_CONFIGURED: SpeXGSP runs its own relay by default; pass --relay=<ip|name.rod|wss://host/> to join an operator relay.');
  return out;};
 if(relayOverride)return merge(await seedRelays(relayOverride,rpc));
 if(typeof root!=='string'||!root)throw Error('bootstrap_installation_root_required');
 let configText;
 try{configText=await readConfig(join(root,'OSGSim','.data','spexgsp-single-address','bootstrap-relays.json'),'utf8');}
 catch(e){if(e.code!=='ENOENT')throw e;configText=await readConfig(join(root,'OSGSim','bootstrap-relays.json'),'utf8');}
 const config=JSON.parse(configText);
 if(config.schema!==1||!Array.isArray(config.relays)||config.relays.length>8)throw Error('invalid_installed_bootstrap_relay_list');
 const urls=[...new Set(config.relays.map(cleanUrl))];
 if(urls.length!==config.relays.length)throw Error('duplicate_installed_bootstrap_relays');
 return merge(urls);
}
