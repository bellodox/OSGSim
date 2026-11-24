// SPDX-License-Identifier: MIT
// Discover installed Metaverse, local ROD Core and protected device identity.
import {readFile,writeFile,mkdir,stat,readdir} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {randomBytes} from 'node:crypto';
import {generateSecret,publicKey} from './crypto.mjs';
import {requireRodMainnet} from './network-policy.mjs';
export const NTP_HOSTS=Object.freeze(['time.cloudflare.com','time.google.com','pool.ntp.org']);
const safe=async file=>{try{return(await stat(file)).isFile()}catch{return false}};
export async function identifyInstall(start=process.cwd()){
 let path=resolve(start);for(let depth=0;depth<6;depth++){
  if(await safe(join(path,'Modules','Server','SpaceXpanse.exe'))&&await safe(join(path,'Config','Moon','Base','Brighton.cfg'))&&await safe(join(path,'OSGSim','apps','metaverse-native','v26','world.mjs')))return path;
  const up=dirname(path);if(path===up)break;path=up;
 }throw Error('native_Metaverse_v26_installation_not_found');
}
export async function secretFile(path){await mkdir(dirname(path),{recursive:true});try{
 const s=(await readFile(path,'utf8')).trim();publicKey(s);return s;
 }catch(e){if(e.code!=='ENOENT')throw e;const s=generateSecret();try{await writeFile(path,s+'\n',{mode:0o600,flag:'wx'});return s}catch(e){if(e.code!=='EEXIST')throw e;const k=(await readFile(path,'utf8')).trim();publicKey(k);return k}}
}
// ROD mainnet: 11998 is the peer-to-peer port. RPC uses the node's own `rpcport` from spacexpanse.conf; when the
// file does not set one, 11999 (the launcher also gives that port to a node it starts, because the built-in
// RPC default 11998 collides with the P2P port). There is no other override.
export const ROD_MAINNET_RPC_PORT=11999;
export const ROD_MAINNET_RPC_URL=`http://127.0.0.1:${ROD_MAINNET_RPC_PORT}`;
/** The main-chain settings of spacexpanse.conf: keys before the first [section] and in [main]. Other sections are other networks. */
export function parseRodConf(text){
 const values=new Map();let section='';
 for(const raw of String(text??'').split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith('#')||line.startsWith(';'))continue;
  const head=/^\[([^\]]+)\]$/.exec(line);if(head){section=head[1].trim().toLowerCase();continue;}
  if(section&&section!=='main')continue;
  const eq=line.indexOf('=');if(eq<1)continue;
  values.set(line.slice(0,eq).trim().toLowerCase(),line.slice(eq+1).trim());
 }
 return values;
}
const CONF_SKIP=new Set(['node_modules','.git','.data','OmniSpatialGraph-multi','Modules','Config','tests','fixtures']);
/** Folders under the installation folder (depth <= 3) that hold a spacexpanse.conf: the node's data directory may live next to its program. */
export async function installedConfDirs(root,depth=3){
 const found=[];
 const walk=async(dir,level)=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  if(entries.some(e=>e.isFile()&&e.name.toLowerCase()==='spacexpanse.conf'))found.push(dir);
  if(level<depth)for(const e of entries)if(e.isDirectory()&&!CONF_SKIP.has(e.name))await walk(join(dir,e.name),level+1);};
 if(root)await walk(root,0);
 return found;
}
/** Data directories to look at, best first: OSGSIM_ROD_DATADIR alone when set; otherwise a spacexpanse.conf under the
 * installation folder, then %APPDATA%\SpaceXpanse and ~/.spacexpanse. */
export async function rodDataDirectoryCandidates({root=null,env=process.env}={}){
 return env.OSGSIM_ROD_DATADIR?[env.OSGSIM_ROD_DATADIR]:[...await installedConfDirs(root),...rodDataDirectories(env)];
}
/** spacexpanse.conf of the node. null when there is none. */
export async function readRodConf({root=null,env=process.env,read=file=>readFile(file,'utf8')}={}){
 for(const dir of await rodDataDirectoryCandidates({root,env})){
  const file=join(dir,'spacexpanse.conf');
  try{return{file,dir,values:parseRodConf(await read(file))};}catch{/* no config file in this directory */}
 }
 return null;
}
const rpcPortOf=conf=>{const port=Number(conf?.values.get('rpcport')??ROD_MAINNET_RPC_PORT);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('ROD_CONF_INVALID_RPCPORT: '+conf.values.get('rpcport'));return port;};
/** An RPC URL given by the user, with its login inside: http://user:password@127.0.0.1:11999 . From OSGSIM_ROD_RPC_URL, else the
 * first line of OSGSim/rod-rpc-url.txt in the installation folder. Loopback only. null when none is given. */
export async function givenRodRpc({root=null,env=process.env,read=file=>readFile(file,'utf8')}={}){
 let text=env.OSGSIM_ROD_RPC_URL;
 if(!text&&root){try{text=(await read(join(root,'OSGSim','rod-rpc-url.txt'))).split(/\r?\n/)[0];}catch{/* none */}}
 text=String(text??'').trim();if(!text)return null;
 let u;try{u=new URL(text);}catch{throw Error('ROD_RPC_URL_INVALID: expected http://user:password@127.0.0.1:11999');}
 if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('ROD_RPC_MUST_REMAIN_LOOPBACK: use http://user:password@127.0.0.1:<port>');
 const port=Number(u.port||ROD_MAINNET_RPC_PORT);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('ROD_RPC_URL_INVALID_PORT');
 // http://user:password@127.0.0.1:11999/wallet/game1 names the wallet that pays for the player name and the moves.
 const named=/^\/wallet\/([^/]+)\/?$/.exec(u.pathname);let wallet=null;
 if(named){try{wallet=decodeURIComponent(named[1]);}catch{wallet=null;}if(!wallet||!/^[A-Za-z0-9_.-]{1,64}$/.test(wallet))throw Error('ROD_RPC_URL_INVALID_WALLET: expected .../wallet/<name> with letters, digits, _ . -');}
 else if(u.pathname!=='/'&&u.pathname!=='')throw Error('ROD_RPC_URL_INVALID: after the port only /wallet/<name> is allowed');
 return{url:`http://${u.hostname}:${port}`,port,wallet,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};
}
/** The RPC endpoint: a URL the user gave, else the node's spacexpanse.conf `rpcport`, else 11999. Needs no login, so it works before the node starts. */
export async function rodRpcUrl(options={}){
 const given=await givenRodRpc(options);if(given)return given.url;
 return`http://127.0.0.1:${rpcPortOf(await readRodConf(options))}`;
}
export function rodDataDirectories(env=process.env){
 const dirs=[];if(env.OSGSIM_ROD_DATADIR)dirs.push(env.OSGSIM_ROD_DATADIR);
 if(env.APPDATA)dirs.push(join(env.APPDATA,'SpaceXpanse'));
 const home=env.USERPROFILE??env.HOME;if(home)dirs.push(join(home,'.spacexpanse'));
 return dirs;
}
const writeSecret=async(file,text)=>{await mkdir(dirname(file),{recursive:true});await writeFile(file,text,{mode:0o600});};
/** The ROD RPC logins to try, best first, and the endpoint. A login the user gave as one URL is the only candidate. Otherwise:
 * the login that worked at the last start, OSGSIM_ROD_RPC_COOKIE, rpcuser/rpcpassword of spacexpanse.conf, the node's
 * .cookie and last an old local-rpc.auth. No password is built in. ROD answers a wrong login
 * with HTTP 401, so the launcher moves on to the next candidate (start-rod-core.mjs). */
export async function rodLoginCandidates(root,{env=process.env,exists=safe,read=file=>readFile(file,'utf8')}={}){
 const given=await givenRodRpc({root,env,read});
 if(given?.user&&given.password)return{url:given.url,logins:[{source:'rod-rpc-url',user:given.user,password:given.password}]};
 const conf=await readRodConf({root,env,read});
 const url=given?.url??`http://127.0.0.1:${rpcPortOf(conf)}`;
 const logins=[],data=join(root,'OSGSim','.data','spexgsp-rod');
 const cookie=async(source,file)=>{if(file&&await exists(file))logins.push({source,cookie:file});};
 await cookie('last working login',join(data,'working-rpc.auth'));
 await cookie('OSGSIM_ROD_RPC_COOKIE',env.OSGSIM_ROD_RPC_COOKIE);
 const user=conf?.values.get('rpcuser'),password=conf?.values.get('rpcpassword');
 if(user&&password&&!user.includes(':'))logins.push({source:'spacexpanse.conf',user,password});
 for(const dir of await rodDataDirectoryCandidates({root,env}))await cookie('.cookie in '+dir,join(dir,'.cookie'));
 await cookie('local-rpc.auth',join(data,'local-rpc.auth'));
 return{url,logins};
}
/** The first login candidate as {url, cookie}: the RPC client reads a `user:password` file like a cookie. */
export async function defaultRodRpc(root,{env=process.env,exists=safe,read=file=>readFile(file,'utf8'),write=writeSecret}={}){
 const {url,logins}=await rodLoginCandidates(root,{env,exists,read});
 const login=logins[0];
 if(!login)throw Error('ROD_RPC_NOT_FOUND: no RPC login found. Give the login as one URL, http://user:password@127.0.0.1:'+new URL(url).port+' , in OSGSIM_ROD_RPC_URL or on the first line of '+join(root,'OSGSim','rod-rpc-url.txt')+'.');
 if(login.cookie)return{url,cookie:login.cookie};
 const cookie=join(root,'OSGSim','.data','spexgsp-rod','conf-rpc.auth');
 await write(cookie,login.user+':'+login.password+'\n');return{url,cookie};
}
/** Keep the login that worked, so every later step of the launcher uses it first. A node's cookie changes at each node start; the
 * launcher stores the current one again at each start. */
export async function rememberRodLogin(root,login,{read=file=>readFile(file,'utf8'),write=writeSecret}={}){
 const text=login.cookie?(await read(login.cookie)).trim():login.user+':'+login.password;
 await write(join(root,'OSGSim','.data','spexgsp-rod','working-rpc.auth'),text+'\n');
}
/**
 * The address to send ROD to. It is created once per wallet (legacy type, like every SpeXGSP address), kept in
 * OSGSim/.data/spexgsp-rod/funding-address.json and reported with the wallet balance on every start.
 */
export async function announceFunding({rpc,wallet,root,onStatus=()=>{}}){
 const file=join(root,'OSGSim','.data','spexgsp-rod','funding-address.json');
 let saved=null;try{saved=JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT'&&e.name!=='SyntaxError')throw e}
 let address=saved?.wallet===wallet?saved.address:null;
 if(address){const info=await rpc('getaddressinfo',[address]).catch(()=>null);if(info?.ismine!==true)address=null;}
 if(!address){
  address=await rpc('getnewaddress',['spexgsp-funding','legacy']);
  await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify({schema:1,wallet,address})+'\n',{mode:0o600});
 }
 let balance=null;
 try{const b=await rpc('getbalances',[]);balance={confirmed:b.mine.trusted,pending:b.mine.untrusted_pending};}
 catch{try{balance={confirmed:await rpc('getbalance',[]),pending:null};}catch{/* the address is still reported */}}
 onStatus('FUNDING_ADDRESS',{address,wallet,balance,note:'Send ROD to this address: it pays for the player name and every game move.'});
 return{address,balance};
}
export async function discoverLocalRpc(root,{rpcClient}={}){
 if(typeof rpcClient!=='function')throw Error('ROD_RPC_ADAPTER_NOT_INSTALLED');
 const config=await defaultRodRpc(root);
 const urlWallet=(await givenRodRpc({root}))?.wallet??null;
 const url=new URL(config.url);if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('ROD_RPC_MUST_REMAIN_LOOPBACK');
 const canonical={...config};if(config.cookie&&!isAbsolute(config.cookie))canonical.cookie=resolve(root,config.cookie);
 const baseUrl=new URL(url.toString());baseUrl.pathname=baseUrl.pathname.replace(/\/wallet\/[^/]+$/, '/');
 const rootRpc=rpcClient({...canonical,url:baseUrl.toString()});
 try{await requireRodMainnet(rootRpc)}catch(e){throw Error('LOCAL_ROD_MAINNET_NOT_READY: '+e.message)}
 let wallets=[];try{wallets=await rootRpc('listwallets',[])}catch{}
 if(!Array.isArray(wallets))wallets=[];
 const pinnedFile=join(root,'OSGSim','.data','spexgsp-single-address','wallet-profile.json');
 let pinned=null;try{pinned=JSON.parse(await readFile(pinnedFile,'utf8')).wallet}catch(e){if(e.code!=='ENOENT')throw e}
 let selected=null;
 if(urlWallet){
  // The wallet named in the RPC URL is the user's explicit choice: it replaces an earlier automatic pin. It must exist; none is created.
  if(!wallets.includes(urlWallet)){try{await rootRpc('loadwallet',[urlWallet]);wallets.push(urlWallet);}catch(e){throw Error('REQUESTED_ROD_WALLET_NOT_AVAILABLE: '+urlWallet+': '+e.message);}}
  selected=urlWallet;
 }
 else if(pinned){if(!wallets.includes(pinned)){try{await rootRpc('loadwallet',[pinned]);wallets.push(pinned)}catch{throw Error('PINNED_ROD_WALLET_NOT_LOADED')}}selected=pinned;}
 else{
  // Unattended registration and game moves spend from this wallet. Never fall
  // back to an arbitrary (possibly the user's main) wallet: use an explicit
  // OSGSIM_ROD_WALLET, a dedicated spex-* wallet, or create an isolated one.
  const requested=process.env.OSGSIM_ROD_WALLET||null;
  if(requested&&!/^[A-Za-z0-9_.-]{1,64}$/.test(requested))throw Error('OSGSIM_ROD_WALLET_INVALID');
  const prefer=wallets.filter(x=>/^spex-player|^spex-owner|^spex-auto/.test(x)).sort();
  selected=requested??prefer[0]??wallets.find(x=>x==='spex-hub')??'spex-auto-player';
  if(!wallets.includes(selected)){
   try{await rootRpc('loadwallet',[selected]);}
   catch(loadError){
    if(requested)throw Error('REQUESTED_ROD_WALLET_NOT_AVAILABLE: '+loadError.message);
    try{await rootRpc('createwallet',[selected]);}catch(e){throw Error('AUTOMATIC_ROD_WALLET_INITIALIZATION_FAILED: '+e.message)}
   }
  }
 }
 if(selected===null)throw Error('no_ROD_wallet_available');
 const walletUrl=new URL(baseUrl);walletUrl.pathname='/wallet/'+encodeURIComponent(selected);
 const rpcOptions={...canonical,url:walletUrl.toString()},rpc=rpcClient(rpcOptions);
 try{await rpc('getwalletinfo',[])}catch(e){throw Error('ROD_WALLET_UNAVAILABLE: '+e.message)}
 if(pinned!==selected){await mkdir(dirname(pinnedFile),{recursive:true});await writeFile(pinnedFile,JSON.stringify({schema:1,wallet:selected})+'\n',{mode:0o600});}
 const walletRpc=name=>{const u=new URL(baseUrl);u.pathname='/wallet/'+encodeURIComponent(name);return rpcClient({...canonical,url:u.toString()});};
 return{rpc,config:rpcOptions,wallet:selected,wallets,rootRpc,walletRpc};
}
// Refuse a second peer in the same installation (shared wallet profile, OSG store and relay port).
// A dead local PID can be reclaimed only after verifying the original writer stopped and the lock stayed unchanged.
export async function acquireLocalRunLock(root){
 const {open,unlink}=await import('node:fs/promises'),{hostname}=await import('node:os');
 const file=join(root,'OSGSim','.data','spexgsp-single-address','peer.lock');await mkdir(dirname(file),{recursive:true});
 const owner={schema:1,pid:process.pid,host:hostname(),nonce:randomBytes(16).toString('hex'),startedUtc:Date.now()};
 for(let tries=0;tries<3;tries++){
  try{const fd=await open(file,'wx',0o600);await fd.writeFile(JSON.stringify(owner)+'\n');await fd.sync();await fd.close();
   return{file,owner,async release(){try{const current=JSON.parse(await readFile(file,'utf8'));if(current.pid===owner.pid&&current.nonce===owner.nonce&&current.host===owner.host)await unlink(file)}catch(e){if(e.code!=='ENOENT')throw e}}};
  }catch(e){if(e.code!=='EEXIST')throw e;
   const before=await stat(file);if(Date.now()-before.mtimeMs<2000)throw Error('SPEXGSP_PEER_ALREADY_STARTING');
   let existing;try{existing=JSON.parse(await readFile(file,'utf8'))}catch{throw Error('SPEXGSP_PEER_LOCK_MALFORMED')}
   if(existing.schema!==1||existing.host!==hostname()||!Number.isSafeInteger(existing.pid)||existing.pid<1||!existing.nonce)throw Error('SPEXGSP_PEER_LOCK_OWNED_BY_OTHER_HOST_OR_UNKNOWN');
   // A lock written before this boot is stale even if its PID now belongs to another process (Windows reuses PIDs).
   const {uptime}=await import('node:os');const bootedAt=Date.now()-uptime()*1000;
   let alive=false;if(!(Number.isSafeInteger(existing.startedUtc)&&existing.startedUtc<bootedAt-60000)){try{process.kill(existing.pid,0);alive=true}catch(err){if(err.code!=='ESRCH')alive=true}}
   if(alive)throw Error('SPEXGSP_PEER_ALREADY_RUNNING_PID_'+existing.pid);
   const after=await stat(file).catch(()=>null);if(after&&after.mtimeMs===before.mtimeMs&&after.size===before.size&&after.ino===before.ino){await unlink(file)}else throw Error('SPEXGSP_PEER_LOCK_CHANGED_DURING_RECOVERY');
  }
 }
 throw Error('SPEXGSP_PEER_LOCK_UNAVAILABLE');
}
