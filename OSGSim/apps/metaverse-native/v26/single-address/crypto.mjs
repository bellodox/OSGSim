// SPDX-License-Identifier: MIT
// BIP-340 Nostr event signing and verification.
// The compact BigInt secp256k1 code is intentionally isolated and vector-tested.
// For production hardening, replace it with a maintained audited secp256k1 library.
import {createHash,randomBytes,createECDH} from 'node:crypto';
const P=0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G={x:0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,y:0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n};
const hex64=/^[0-9a-f]{64}$/;const hex128=/^[0-9a-f]{128}$/;
const int=b=>BigInt('0x'+Buffer.from(b).toString('hex'));
const bytes=n=>Buffer.from(n.toString(16).padStart(64,'0'),'hex');
const mod=(a,m=P)=>((a%m)+m)%m;
function pow(a,b,m=P){let res=1n;for(let x=mod(a,m);b>0n;b>>=1n,x=mod(x*x,m))if(b&1n)res=mod(res*x,m);return res;}
const inverse=(a,m=P)=>pow(mod(a,m),m-2n,m);
// Jacobian coordinates avoid a modular inversion for every point operation.
const jac=p=>p?{X:p.x,Y:p.y,Z:1n}:null;
const affine=p=>{if(!p)return null;const inv=inverse(p.Z),z2=mod(inv*inv);return{x:mod(p.X*z2),y:mod(p.Y*z2*inv)}};
function double(p){if(!p||p.Y===0n)return null;
 const yy=mod(p.Y*p.Y),s=mod(4n*p.X*yy),m=mod(3n*p.X*p.X),x=mod(m*m-2n*s),y=mod(m*(s-x)-8n*yy*yy),z=mod(2n*p.Y*p.Z);
 return{X:x,Y:y,Z:z};
}
function addJ(a,b){if(!a)return b;if(!b)return a;
 const z1z1=mod(a.Z*a.Z),z2z2=mod(b.Z*b.Z),u1=mod(a.X*z2z2),u2=mod(b.X*z1z1),s1=mod(a.Y*b.Z*z2z2),s2=mod(b.Y*a.Z*z1z1);
 if(u1===u2)return s1===s2?double(a):null;
 const h=mod(u2-u1),r=mod(s2-s1),hh=mod(h*h),hhh=mod(h*hh),u1hh=mod(u1*hh),x=mod(r*r-hhh-2n*u1hh),y=mod(r*(u1hh-x)-s1*hhh),z=mod(h*a.Z*b.Z);
 return{X:x,Y:y,Z:z};
}
function mulJ(k,p=G){if(k<0n)throw Error('invalid_scalar');let x=null,y=jac(p);while(k>0n){if(k&1n)x=addJ(x,y);y=double(y);k>>=1n;}return x;}
function nativePoint(k){const e=createECDH('secp256k1');e.setPrivateKey(bytes(k));const pub=e.getPublicKey(undefined,'compressed');return{x:int(pub.subarray(1)),odd:pub[0]===3};}
function liftX(x){if(x>=P)return null;const c=mod(x*x*x+7n),y=pow(c,(P+1n)/4n);if(mod(y*y)!==c)return null;return{x,y:y%2n===0n?y:P-y};}
const hash=x=>createHash('sha256').update(x).digest();
function tagged(tag,data){const h=hash(Buffer.from(tag));return hash(Buffer.concat([h,h,data]));}
function validSecret(secret){if(typeof secret!=='string'||!hex64.test(secret)||int(Buffer.from(secret,'hex'))===0n||int(Buffer.from(secret,'hex'))>=N)throw Error('invalid_nostr_secret');return secret;}
export function generateSecret(){let s;do{s=randomBytes(32).toString('hex')}while(int(Buffer.from(s,'hex'))===0n||int(Buffer.from(s,'hex'))>=N);return s;}
// Point multiplication by the generator uses OpenSSL (createECDH); BigInt arithmetic is only used for verification.
export function publicKey(secret){return bytes(nativePoint(int(Buffer.from(validSecret(secret),'hex'))).x).toString('hex');}
export function schnorrSign(message,secret,aux=Buffer.alloc(32)){
 const msg=Buffer.from(message);if(aux.length!==32)throw Error('invalid_aux');const d0=int(Buffer.from(validSecret(secret),'hex')),
  pt=nativePoint(d0),d=pt.odd?N-d0:d0,pk=bytes(pt.x);
 const masked=Buffer.from(bytes(d));const auxHash=tagged('BIP0340/aux',aux);for(let i=0;i<32;i++)masked[i]^=auxHash[i];
 const k0=mod(int(tagged('BIP0340/nonce',Buffer.concat([masked,pk,msg]))),N);if(k0===0n)throw Error('invalid_nonce');
 const r=nativePoint(k0),k=r.odd?N-k0:k0;
 const rx=bytes(r.x),e=mod(int(tagged('BIP0340/challenge',Buffer.concat([rx,pk,msg]))),N),sig=Buffer.concat([rx,bytes(mod(k+e*d,N))]);
 if(!schnorrVerify(msg,pk.toString('hex'),sig.toString('hex')))throw Error('schnorr_sign_selfcheck_failed');
 return sig.toString('hex');
}
export function schnorrVerify(message,pubkey,signature){
 try{if(!hex64.test(pubkey)||!hex128.test(signature))return false;const msg=Buffer.from(message),pk=Buffer.from(pubkey,'hex'),sig=Buffer.from(signature,'hex');
  const p=liftX(int(pk)),r=int(sig.subarray(0,32)),s=int(sig.subarray(32));if(!p||r>=P||s>=N)return false;
  const e=mod(int(tagged('BIP0340/challenge',Buffer.concat([sig.subarray(0,32),pk,msg]))),N);
  const R=affine(addJ(mulJ(s),mulJ(N-e,p)));return !!R&&R.y%2n===0n&&R.x===r;
 }catch{return false;}
}
export const sha256=x=>hash(typeof x==='string'?Buffer.from(x):x).toString('hex');
export function signEvent({secret,kind,tags=[],content='',createdAt=Math.floor(Date.now()/1000),aux=randomBytes(32)}){
 const pubkey=publicKey(secret),created_at=createdAt;
 if(!Number.isSafeInteger(kind)||kind<0||typeof content!=='string'||!Array.isArray(tags)||tags.some(t=>!Array.isArray(t)||t.some(s=>typeof s!=='string')))throw Error('invalid_event_data');
 const id=sha256(JSON.stringify([0,pubkey,created_at,kind,tags,content]));const sig=schnorrSign(Buffer.from(id,'hex'),secret,aux);
 return{id,pubkey,created_at,kind,tags,content,sig};
}
export function verifyEvent(e){if(!e||!hex64.test(e.id??'')||!hex64.test(e.pubkey??'')||!hex128.test(e.sig??'')||!Number.isSafeInteger(e.created_at)||!Number.isSafeInteger(e.kind)||!Array.isArray(e.tags)||typeof e.content!=='string')return false;
 try{if(e.tags.some(t=>!Array.isArray(t)||t.some(s=>typeof s!=='string'))||Object.keys(e).sort().join()!=='content,created_at,id,kind,pubkey,sig,tags')return false;
 return sha256(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content]))===e.id && schnorrVerify(Buffer.from(e.id,'hex'),e.pubkey,e.sig);}catch{return false;}
}
export const hexId=s=>typeof s==='string'&&hex64.test(s);
