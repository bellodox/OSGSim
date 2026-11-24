// SPDX-License-Identifier: MIT
// Test-only adapters with the call shapes older tests use, implemented by the one runtime crypto module.
import {publicKey,signEvent,verifyEvent,schnorrSign as sign,schnorrVerify as verify} from '../../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
export const pubkeyFromSecret=publicKey;
export const signNostrEvent=({secret,kind,tags=[],content,created_at})=>signEvent({secret,kind,tags,content,...(created_at===undefined?{}:{createdAt:created_at})});
export const verifyNostrEvent=verifyEvent;
export const schnorrSign=(message,secret,aux)=>sign(message,secret,aux??Buffer.alloc(32));
// Old order: (message, signature, publicKey).
export const schnorrVerify=(message,signature,pub)=>verify(message,pub,signature);
