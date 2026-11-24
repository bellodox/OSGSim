// SPDX-License-Identifier: MIT
// Self-signed TLS certificate for a public SpeXGSP relay, generated with Node's own crypto (no OpenSSL, no
// domain, no certificate authority). Joiners do not trust it through a CA: the universe owner publishes the
// SHA-256 of the certificate's public key ("pin") in the ROD realm directory, and ROD is the trust root.
import net from 'node:net';
import {createHash,generateKeyPairSync,randomBytes,sign,X509Certificate,createPrivateKey} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {atomicWriteFile} from '../fs-util.mjs';
import {join} from 'node:path';

export const RELAY_DEFAULT_PORT=7447;
const DAY=86400000;
const len=n=>n<128?Buffer.from([n]):n<256?Buffer.from([0x81,n]):Buffer.from([0x82,n>>8,n&255]);
const der=(tag,...parts)=>{const body=Buffer.concat(parts);return Buffer.concat([Buffer.from([tag]),len(body.length),body]);};
const seq=(...p)=>der(0x30,...p),set=(...p)=>der(0x31,...p);
const oid=text=>{const a=text.split('.').map(Number),out=[a[0]*40+a[1]];
 for(const n of a.slice(2)){const b=[n&127];let v=n>>7;while(v){b.unshift(128|(v&127));v>>=7;}out.push(...b);}return der(0x06,Buffer.from(out));};
const integer=bytes=>{let b=Buffer.from(bytes);while(b.length>1&&b[0]===0&&!(b[1]&0x80))b=b.subarray(1);if(b[0]&0x80)b=Buffer.concat([Buffer.from([0]),b]);return der(0x02,b);};
const pad=(n,w=2)=>String(n).padStart(w,'0');
const time=ms=>{const d=new Date(ms),y=d.getUTCFullYear();
 const rest=pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'Z';
 return y<2050?der(0x17,Buffer.from(pad(y%100)+rest)):der(0x18,Buffer.from(pad(y,4)+rest));};
const name=cn=>seq(set(seq(oid('2.5.4.3'),der(0x0c,Buffer.from(cn)))));
const extension=(id,value,critical=false)=>seq(oid(id),...(critical?[der(0x01,Buffer.from([0xff]))]:[]),der(0x04,value));
const ipv4=h=>Buffer.from(h.split('.').map(Number));
function ipv6(h){
 let [head,tail]=h.split('::');const part=s=>s?s.split(':'):[];
 let a=part(head),b=tail===undefined?[]:part(tail);
 const v4=list=>{const last=list[list.length-1];if(last&&last.includes('.')){const q=last.split('.').map(Number);list.splice(-1,1,((q[0]<<8)|q[1]).toString(16),((q[2]<<8)|q[3]).toString(16));}};
 v4(a);v4(b);
 const missing=8-a.length-b.length;if(tail===undefined&&missing!==0||missing<0)throw Error('invalid_relay_host');
 const words=[...a,...Array(tail===undefined?0:missing).fill('0'),...b].map(x=>parseInt(x||'0',16));
 return Buffer.from(words.flatMap(w=>[w>>8,w&255]));
}
const generalName=host=>{const t=net.isIP(host);return t===4?der(0x87,ipv4(host)):t===6?der(0x87,ipv6(host)):der(0x82,Buffer.from(host));};

// The relay is addressed by IP only: no DNS name, so no domain, DNS record or resolver is involved.
export const validRelayHost=host=>typeof host==='string'&&net.isIP(host)>0;
export const relayUrl=(host,port=RELAY_DEFAULT_PORT)=>`wss://${net.isIP(host)===6?'['+host+']':host}:${port}/`;
/** SHA-256 (hex) of a certificate's public key. Pinning the key, not the certificate, keeps the pin valid when the certificate is renewed. */
export const spkiPin=cert=>createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('hex');
const pem=(label,buf)=>`-----BEGIN ${label}-----\n${buf.toString('base64').replace(/(.{64})/g,'$1\n').replace(/\n$/,'')}\n-----END ${label}-----\n`;

/** One P-256 key and one certificate naming `host` (an IP address). Also valid for localhost / 127.0.0.1. */
export function generateRelayCertificate({host,now=Date.now(),days=3650}={}){
 if(!validRelayHost(host))throw Error('invalid_relay_host');
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const spki=publicKey.export({type:'spki',format:'der'});
 const serial=randomBytes(16);serial[0]=(serial[0]&0x3f)|0x40;
 const names=[...new Set([host,'localhost','127.0.0.1'])];
 const algorithm=seq(oid('1.2.840.10045.4.3.2'));
 const subject=name('SpeXGSP relay '+host);
 const tbs=seq(
  der(0xa0,integer([2])),integer(serial),algorithm,subject,
  seq(time(now-DAY),time(now+days*DAY)),subject,Buffer.from(spki),
  der(0xa3,seq(
   extension('2.5.29.19',seq(),true),
   extension('2.5.29.15',der(0x03,Buffer.from([0x07,0x80])),true),
   extension('2.5.29.37',seq(oid('1.3.6.1.5.5.7.3.1'))),
   extension('2.5.29.17',seq(...names.map(generalName)))
  )));
 const certificate=seq(tbs,algorithm,der(0x03,Buffer.concat([Buffer.from([0]),sign('sha256',tbs,privateKey)])));
 const certPem=pem('CERTIFICATE',certificate);
 return{host,cert:certPem,key:privateKey.export({type:'pkcs8',format:'pem'}),pin:spkiPin(certPem),notAfter:now+days*DAY};
}

const FILES=dir=>({cert:join(dir,'relay-cert.pem'),key:join(dir,'relay-key.pem'),meta:join(dir,'relay-cert.json')});
const atomic=(file,text,mode)=>atomicWriteFile(file,text,{mode});

/** Read the generated certificate in `dir`, or null. */
export async function readRelayCertificate(dir){
 const f=FILES(dir);
 try{
  const [cert,key,meta]=await Promise.all([readFile(f.cert,'utf8'),readFile(f.key,'utf8'),readFile(f.meta,'utf8')]);
  const info=JSON.parse(meta);createPrivateKey(key);
  const x=new X509Certificate(cert);
  if(info.pin!==spkiPin(cert)||typeof info.host!=='string')return null;
  return{host:info.host,cert,key,pin:info.pin,notAfter:Date.parse(x.validTo)};
 }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError||/PEM|asn1|DECODER|X509/i.test(String(e.message)))return null;throw e;}
}

/** Reuse the certificate in `dir` while it names `host` and is valid for 90 more days; otherwise create a new one.
 * The key survives restarts, so the pin the owner registered on ROD stays valid. */
export async function ensureRelayCertificate({dir,host,now=Date.now()}={}){
 if(!dir||!validRelayHost(host))throw Error('invalid_relay_host');
 const have=await readRelayCertificate(dir);
 if(have&&have.host===host&&have.notAfter-now>90*DAY)return{...have,created:false};
 const made=generateRelayCertificate({host,now});
 const f=FILES(dir);await mkdir(dir,{recursive:true});
 // The key first and the metadata last: readRelayCertificate treats a partial set as absent.
 await atomic(f.key,made.key,0o600);await atomic(f.cert,made.cert,0o644);
 await atomic(f.meta,JSON.stringify({schema:1,host,pin:made.pin,notAfter:made.notAfter},null,1)+'\n',0o644);
 return{...made,created:true};
}

/** TLS material for the relay. Order: OSGSIM_RELAY_TLS_CERT/KEY (a certificate you obtained elsewhere), then the
 * certificate generated for this installation by -CreateUniverse (relayHost) in `dir`. Without either: null (loopback only). */
export async function loadRelayTls(env=process.env,{dir=null}={}){
 if(env.OSGSIM_RELAY_TLS_CERT||env.OSGSIM_RELAY_TLS_KEY){
  if(!env.OSGSIM_RELAY_TLS_CERT||!env.OSGSIM_RELAY_TLS_KEY)throw Error('RELAY_TLS_NEEDS_BOTH_OSGSIM_RELAY_TLS_CERT_AND_OSGSIM_RELAY_TLS_KEY');
  const cert=await readFile(env.OSGSIM_RELAY_TLS_CERT),key=await readFile(env.OSGSIM_RELAY_TLS_KEY);
  return{cert,key,pin:spkiPin(cert),host:null,source:'environment'};
 }
 if(!dir)return null;
 const have=await readRelayCertificate(dir);
 return have?{cert:have.cert,key:have.key,pin:have.pin,host:have.host,source:'generated'}:null;
}
