// SPDX-License-Identifier: MIT
// Wallet-signed session challenge between the DLL (its built-in hub client) and the local world endpoint.
import {canonical} from './ownership.mjs';
const NAME=/^[A-Za-z0-9_.:-]{1,96}$/;
export function challengeMessage({world,actor,address,nonce,runId,runNonce=null}){
 if(!/^[a-f0-9]{64}$/.test(world)||!NAME.test(actor)||!NAME.test(runId)||
    !/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/.test(address)||
    !/^[-_a-zA-Z0-9]{32,96}$/.test(nonce))throw Error('invalid_challenge');
 // Bind the signed player wallet challenge to the exact native physics run.
 // Replaying a valid login for a different simulator process is not permitted.
 return runNonce?'OSGSIM/METAVERSE/SESSION/v3\n'+canonical({world,actor,address,nonce,runId,runNonce}):'OSGSIM/METAVERSE/SESSION/v2\n'+canonical({world,actor,address,nonce,runId});
}
export function requireLoopbackOrTLS(url){
 const u=new URL(url);
 if(u.protocol!=='https:'&&!(['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.protocol==='http:'))throw Error('remote OSG hub requires HTTPS with a trusted certificate');
 if(u.username||u.password||u.hash)throw Error('unsafe hub URL');
 return u;
}
