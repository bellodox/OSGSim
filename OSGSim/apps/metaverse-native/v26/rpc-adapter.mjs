// SPDX-License-Identifier: MIT
import {readFile} from 'node:fs/promises';
export function rpcClient({url,cookie,user,password}){
 const endpoint=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('Keep wallet RPC local; use a tunnel for remote administration');
 return async(method,params=[])=>{const credential=cookie?(await readFile(cookie,'utf8')).trim():`${user}:${password}`;
 let res;
 try{res=await fetch(endpoint,{method:'POST',headers:{authorization:'Basic '+Buffer.from(credential).toString('base64'),'content-type':'application/json'},body:JSON.stringify({jsonrpc:'1.0',id:'osgdemo',method,params}),signal:AbortSignal.timeout(10000)});}
 catch(e){
  // fetch reports every network failure as "fetch failed"; the system error (ECONNREFUSED, ECONNRESET, ...) is in e.cause.
  const c=e.cause;const why=e.name==='TimeoutError'?'no answer within 10 s':c?.code?c.code+(c.message&&c.message!==c.code?' ('+c.message+')':''):c?.message??e.message;
  throw Object.assign(Error(`ROD RPC ${method} not answered: ${why}`),{cause:c??e});
 }
 // ROD Core answers a refused login with HTTP 401 and an empty body, so the status is read before the JSON.
 const text=await res.text();let data=null;try{data=text?JSON.parse(text):null;}catch{/* not JSON */}
 if(data?.error)throw Object.assign(Error(`ROD ${method}: ${data.error.message}`),{code:data.error.code});
 if(!res.ok)throw Object.assign(Error(`ROD RPC HTTP ${res.status}`+(res.status===401?' - the RPC login was refused (rpcuser/rpcpassword or .cookie do not belong to the node answering on this port)':'')),{httpStatus:res.status});
 if(data===null)throw Error(`ROD RPC ${method}: empty or invalid answer (HTTP ${res.status}); this is probably not the RPC port`);
 return data.result;};
}
