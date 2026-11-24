// SPDX-License-Identifier: MIT
// Loopback-only, wallet-authenticated endpoint between the DLL (its built-in hub client) and the local world.
// No wallet private key leaves ROD Core.
import http from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {canonical} from './ownership.mjs';
import {challengeMessage} from './peer-wire.mjs';
const ADDR=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/;
const ACTOR=/^peer(?:0|[1-9]\d{0,4})$/;
const RUN=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const hex=s=>createHash('sha256').update(s).digest('hex');
const errorStatus=e=>/session_expired|session_auth_required/.test(e)?401:/unknown|invalid|malformed|bad_|missing_|mismatch/.test(e)?400:/auth|owner|session|signature|challenge|fenced/.test(e)?403:409;
export const enrollMessage=({worldId,address,nonce,portId,slot})=>'OSGSIM/METAVERSE/ENROLL/v1\n'+canonical({world:worldId,address,nonce,portId,slot:slot??null});
async function body(req){let n=0,parts=[];for await(const c of req){n+=c.length;if(n>65536)throw Error('body_too_large');parts.push(c);}if(n===0)throw Error('empty_body');let x;try{x=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('invalid_json');}if(!x||typeof x!=='object'||Array.isArray(x))throw Error('invalid_body');return x;}
const respond=(res,status,obj)=>{const b=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(b)});res.end(b);};
export async function createV26Hub({world,rpc,host='127.0.0.1',listenPort=0,now=()=>Date.now(),sessionMs=900000,runNonce=null}={}){
 if(!['127.0.0.1','::1'].includes(host))throw Error('world_endpoint_is_loopback_only');
 if(!world)throw Error('world_required');
 const state=world;await state.init();
 const challenges=new Map(),sessions=new Map();let closed=false;const recordToken=t=>hex(t);
 function prune(){for(const[k,v]of challenges)if(v.exp<=now())challenges.delete(k);for(const[k,v]of sessions)if(v.exp<=now())sessions.delete(k);}
 const publicWorld=async()=>{const s=await state.snapshot();return{schema:26,worldId:s.worldId,clock:s.clock,port:s.port,root:s.root,osgHead:s.osgHead,ships:s.ships,sequence:s.sequence,eventHead:s.eventHead,nextActorId:s.nextActorId,events:s.events,authorityRevision:s.authorityRevision};};
 const auth=req=>{const matched=/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization??'');if(!matched)throw Error('session_auth_required');const x=sessions.get(recordToken(matched[1]));if(!x||x.exp<=now())throw Error('session_expired');return x;};
 const issue=(kind,address,extra={})=>{if(challenges.size>4096)throw Error('challenge_limit');const id=randomBytes(16).toString('hex'),nonce=randomBytes(32).toString('base64url');challenges.set(id,{kind,address,nonce,exp:now()+60000,...extra});return{id,nonce,expiresInMs:60000};};
 async function route(req,res){prune();const url=new URL(req.url,'http://localhost');
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw Error('bad_origin');
  if(req.method==='GET'&&url.pathname==='/world')return respond(res,200,await publicWorld());
  if(req.method==='GET'&&url.pathname==='/history'){const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??100);return respond(res,200,await state.history(after,limit));}
  if(req.method==='GET'&&url.pathname==='/health'){const s=await state.snapshot();return respond(res,200,{ok:true,world:s.worldId,root:s.root,osgHead:s.osgHead,ships:Object.keys(s.ships).length,sequence:s.sequence,sessions:sessions.size});}
  if(req.method==='GET'&&url.pathname==='/enroll-challenge'){
   const address=url.searchParams.get('address');if(!ADDR.test(address))throw Error('invalid_address');
   const data=issue('enroll',address,{portId:state.port.portId,slot:url.searchParams.get('slot')||null});return respond(res,200,{...data,worldId:state.worldId,portId:state.port.portId,slot:url.searchParams.get('slot')||null});
  }
  if(req.method==='POST'&&url.pathname==='/enroll'){
   const x=await body(req),c=challenges.get(x.challengeId);challenges.delete(x.challengeId);
   if(!c||c.kind!=='enroll'||c.address!==x.address||c.nonce!==x.nonce||c.exp<=now()||c.portId!==x.portId||c.slot!==(x.slot??null))throw Error('enrollment_challenge_mismatch');
   const text=enrollMessage({worldId:state.worldId,address:x.address,nonce:x.nonce,portId:x.portId,slot:x.slot});
   if(!x.signature||(await rpc('verifymessage',[x.address,x.signature,text]))!==true)throw Error('wallet_signature_invalid');
   const ship=await state.enroll({address:x.address,portId:x.portId,slot:x.slot});const snap=await state.snapshot();return respond(res,200,{ship,world:await publicWorld(),resumeFrame:ship.recovered?(snap.frames[ship.actor]??null):null});
  }
  if(req.method==='GET'&&url.pathname==='/session-challenge'){
   const actor=url.searchParams.get('actor'),runId=url.searchParams.get('runId');const s=await state.snapshot(),ship=s.ships[actor];
   if(!ACTOR.test(actor)||!RUN.test(runId)||!ship)throw Error('unknown_actor_or_run');const data=issue('session',ship.owner,{actor,runId});
   return respond(res,200,{...data,actor,runId,address:ship.owner,worldId:state.worldId,runNonce});
  }
  if(req.method==='POST'&&url.pathname==='/session'){
   const x=await body(req),c=challenges.get(x.challengeId);challenges.delete(x.challengeId);
   const s=await state.snapshot(),ship=s.ships[x.actor];
   if(!c||c.kind!=='session'||!ship||c.address!==x.address||c.nonce!==x.nonce||c.actor!==x.actor||c.runId!==x.runId||c.exp<=now())throw Error('session_challenge_mismatch');
   if(runNonce&&x.runNonce!==runNonce)throw Error('world_run_nonce_mismatch');
   const text=challengeMessage({world:state.worldId,actor:x.actor,address:x.address,nonce:x.nonce,runId:x.runId,runNonce});
   if(!x.signature||(await rpc('verifymessage',[x.address,x.signature,text]))!==true)throw Error('wallet_signature_invalid');
   for(const[k,v]of sessions)if(v.actor===x.actor)sessions.delete(k);
   const token=randomBytes(32).toString('hex');sessions.set(recordToken(token),{actor:x.actor,runId:x.runId,owner:x.address,runNonce,exp:now()+sessionMs});
   return respond(res,200,{token,expiresAt:now()+sessionMs,runNonce,ship,world:await publicWorld()});
  }
  const sess=auth(req);
  if(req.method==='GET'&&url.pathname==='/view'){
   const s=await state.snapshot();return respond(res,200,{schema:26,worldId:s.worldId,clock:s.clock,root:s.root,osgHead:s.osgHead,sequence:s.sequence,eventHead:s.eventHead,nextActorId:s.nextActorId,events:s.events,authorityRevision:s.authorityRevision,ships:s.ships,frames:s.frames,proofs:s.proofs,port:s.port,liveFrames:state.liveFramesView?.()??{}});
  }
  if(req.method==='POST'&&url.pathname==='/native-proof'){
   const x=await body(req);if(x.observer!==sess.actor||x.runId!==sess.runId||(runNonce&&x.runNonce!==runNonce))throw Error('native_proof_not_from_authenticated_run');
   const proof=await state.nativeProof(x);return respond(res,200,{ok:true,proof,root:(await state.snapshot()).root});
  }
  if(req.method==='POST'&&url.pathname==='/scene-proof'){
   const x=await body(req);if(x.observer!==sess.actor||x.runId!==sess.runId||(runNonce&&x.runNonce!==runNonce))throw Error('scene_proof_not_from_native_run');
   const proof=await state.sceneProof(x);return respond(res,200,{ok:true,proof,root:(await state.snapshot()).root});
  }
  if(req.method==='POST'&&url.pathname==='/sample'){
   const x=await body(req);if(x.actor!==sess.actor||x.runId!==sess.runId)throw Error('wrong_owned_run');
   const result=await state.publish({actor:sess.actor,runId:sess.runId,sample:x.sample});return respond(res,200,{accepted:true,...result});
  }
  return respond(res,404,{error:'unknown_route'});
 }
 const handler=(req,res)=>route(req,res).catch(e=>respond(res,errorStatus(e.message),{error:e.message}));
 const server=http.createServer(handler);
 server.headersTimeout=8000;server.requestTimeout=15000;await new Promise((a,b)=>{server.once('error',b);server.listen(listenPort,host,a);});
 return{world:state,url:`http://${host==='::1'?'[::1]':host}:${server.address().port}`,port:server.address().port,async close(){if(closed)return;closed=true;await new Promise(r=>server.close(r));await state.graph.close?.();}};
}
