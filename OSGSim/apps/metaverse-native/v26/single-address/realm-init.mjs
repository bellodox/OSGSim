// SPDX-License-Identifier: MIT
// World identity of a realm and the realm name installed with this Metaverse copy.
// Universes are created by OSGSim/scripts/spexgsp-create-universe.mjs.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DEFAULT_REALM_NAME} from './resolver.mjs';
import {sha256,hexId} from './crypto.mjs';
const realmIdRe=/^[a-z0-9][a-z0-9:/._-]{2,96}$/;
export function genesisWorldId({realmId,rodGenesis,assetRoot,genesisNonce}){
 if(!realmIdRe.test(realmId)||![rodGenesis,assetRoot,genesisNonce].every(hexId))throw Error('invalid_world_genesis_material');
 return sha256('OSGSIM/world-genesis/v1\n'+JSON.stringify({realmId,rodGenesis,assetRoot,genesisNonce}));
}
export async function installedRealmName(root){try{const x=JSON.parse(await readFile(join(root,'OSGSim','realm-authority.json'),'utf8'));
 if(x.realmName){if(!/^[a-z]+\/[a-z0-9/._:-]{2,240}$/.test(x.realmName))throw Error('invalid_preinstalled_realm_name');return x.realmName;}
 }catch(e){if(e.code!=='ENOENT')throw e;}return DEFAULT_REALM_NAME;
}
