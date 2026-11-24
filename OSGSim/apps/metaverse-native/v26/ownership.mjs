// SPDX-License-Identifier: MIT
// Canonical JSON and SHA-256 identifiers shared by world state, ROD moves and Nostr evidence.
import {createHash} from 'node:crypto';

export const canonical=(v)=>v===null?'null':Array.isArray(v)?`[${v.map(canonical).join(',')}]`:typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const sha=(v)=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
