// SPDX-License-Identifier: MIT
// Shared mock ROD node (regtest-like) for distributed tests. No network access.
import {createHash} from 'node:crypto';
import {validateMove,gameGenesis} from '../../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
export const W='a'.repeat(64),ASSET='d'.repeat(64),GEN='b'.repeat(64),ADDR1='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',ADDR2='rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw',GAME='osgsimv26';
export const defaultClock={schema:1,utcOriginMs:1700000000000,simMjd0:51982.1301160012,rate:1,era:1};
export const port={portId:'moon:brighton-beach',base:'Brighton Beach',configSha256:'1'.repeat(64),body:'Moon',allowedClasses:['ShuttlePB'],slots:[{slot:'pad-1',nativePadIndex:0,rotDegrees:90},{slot:'pad-2',nativePadIndex:1,rotDegrees:180}]};
export const hash=s=>createHash('sha256').update(s).digest('hex');
export const graph=()=>({values:new Map(),head:'c'.repeat(64),get(k){return this.values.get(k)},async put(k,v){return this.putMany([{id:k,value:v}])},async putMany(arr){for(const {id,value} of arr)this.values.set(id,structuredClone(value));this.head='c'+hash(JSON.stringify([...this.values])).slice(0,64);return this.head}});
export class TestRod{
 constructor({clock=defaultClock}={}){this.clock=clock;this.height=1;this.counter=0;this.chain=[{hash:GEN,tx:[]},{hash:'1'.repeat(64),tx:[]}];this.pool=[];this.txMap=new Map();this.owners={'p/alice':ADDR1,'p/bob':ADDR2}}
 rpc(address){return async(method,args=[])=>{
  switch(method){
   case 'getblockchaininfo':return{chain:'regtest',blocks:this.height,bestblockhash:this.chain[this.height].hash};
   case 'getblockhash':return this.chain[args[0]]?.hash??(()=>{throw Error('unknown_height')})();
   case 'getblock':{const b=this.chain.find(x=>x.hash===args[0]);return{tx:b?.tx??[],time:b?.time}}
   case 'getrawmempool':return this.pool.map(x=>x.txid);
   case 'getrawtransaction':{const t=this.txMap.get(args[0]);if(!t)throw Object.assign(Error('unknown tx'),{code:-5});return t}
   case 'gettransaction':{const txid=args[0],at=this.chain.findIndex(b=>b.tx.some(x=>x.txid===txid));return{confirmations:at<0?0:this.height-at,blockhash:at<0?null:this.chain[at].hash};}
   case 'name_show':{const name=args[0];if(name==='g/'+GAME)return{address:ADDR1,height:1,txid:'7'.repeat(64),value:JSON.stringify(gameGenesis({world:W,assetRoot:ASSET,port,clock:this.clock,rodGenesis:GEN}))};if(this.owners[name]){const last=[...this.chain].reverse().flatMap(b=>b.tx).reverse().find(tx=>tx.vout?.[0]?.scriptPubKey?.nameOp?.name===name);
    return{address:this.owners[name],height:last?this.height:1,txid:last?.txid??'8'.repeat(64),
     value:last?.vout[0].scriptPubKey.nameOp.value??JSON.stringify({schema:'spexgsp/player/1',worldId:W})};}throw Error('name missing')}
   case 'getaddressinfo': case 'validateaddress':return{ismine:args[0]===address};
   case 'name_pending':return this.pool.filter(tx=>tx.vout?.[0]?.scriptPubKey?.nameOp?.name===args[0]).map(tx=>({name:args[0],value:tx.vout[0].scriptPubKey.nameOp.value,txid:tx.txid}));
   case 'name_update':{
    const [player,value,options]=args;if(this.owners[player]!==address)throw Error('wallet_wrong_owner');
    // As in ROD: without destAddress the name moves to a fresh address of the wallet's default type.
    let to=address;if(options?.destAddress!==address){to='R'+hash('fresh'+(++this.counter)).replace(/0/g,'z').slice(0,33);this.owners[player]=to;}const move=JSON.parse(value).g[GAME];validateMove(move,{world:W,game:GAME});
    const txid=hash('TX'+(++this.counter)+value);const previous=[...this.pool].reverse().find(x=>x.vout[0].scriptPubKey.nameOp.name===player);
    const tx={txid,vin:previous?[{txid:previous.txid,vout:0}]:[],vout:[{n:0,scriptPubKey:{nameOp:{op:'name_update',name:player,value},address:to}}]};this.pool.push(tx);this.txMap.set(txid,tx);return txid;
   }
   case 'signmessage':return Buffer.from(args[1]).toString('base64');
   case 'verifymessage':return args[1]===Buffer.from(args[2]).toString('base64');
   default:throw Error('unknown_mock_rod_rpc_'+method);
  }
 }}
 mine(){this.height++;const b={hash:hash('block'+this.height+JSON.stringify(this.pool)),tx:this.pool,time:Math.floor(Date.now()/1000)};this.chain.push(b);this.pool=[];return b}
 reorg(){if(this.chain.length<3)throw Error('no block to orphan');this.chain.pop();this.height--;this.chain.push({hash:hash('alternative'+this.height),tx:[]});this.height++}
}
