// SPDX-License-Identifier: MIT
// A PRIVATE, per-device loopback API for the SpeXGSP DLL (its built-in hub client).
// This is not a world coordinator, authority, relay, or other-device server.
// Preserve the tested v26 HTTP/native protocol while moving world authority
// to independently reconciled ROD game moves on each participant's machine.
import {createV26Hub} from '../hub.mjs';
export async function createLocalNativeEndpoint(options={}){
 if(options.host!==undefined&&options.host!=='127.0.0.1')throw Error('ROD_PEER_ENDPOINT_MUST_BE_LOCAL');
 if(options.tls!==undefined&&options.tls!==null)throw Error('ROD_PEER_NO_REMOTE_HTTP_SERVER');
 if(!options.world||typeof options.world.assertAuthority!=='function')throw Error('ROD_PEER_REQUIRES_DISTRIBUTED_WORLD');
 options.world.assertAuthority();
 return createV26Hub({...options,host:'127.0.0.1'});
}
