#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseMesh,decodeDDS,meshToSplats} from '../packages/landing-scene/mesh-import.mjs';
import {encodeSplats} from '../packages/landing-scene/asset.mjs';
const source=resolve(process.argv[2]??'fixtures/landing/upstream'),destination=resolve(process.argv[3]??'fixtures/landing/assets');
const meshBytes=await readFile(join(source,'ShuttlePB.msh')),mesh=parseMesh(meshBytes.toString('utf8')),files=await readdir(source),textures=[],inputs={'ShuttlePB.msh':createHash('sha256').update(meshBytes).digest('hex')};
for(const name of mesh.textures){const file=files.find(x=>x.toLowerCase()===name.toLowerCase());if(!file)throw Error('Missing texture '+name);const bytes=await readFile(join(source,file));textures.push(decodeDDS(bytes));inputs[file]=createHash('sha256').update(bytes).digest('hex');}
const splats=meshToSplats(mesh,textures),bytes=encodeSplats(splats),hash=createHash('sha256').update(bytes).digest('hex');
await mkdir(destination,{recursive:true});await writeFile(join(destination,hash+'.splat'),bytes);
const manifest={version:1,vesselClass:'ShuttlePB',format:'OSGSPL1',hash,bytes:bytes.length,count:splats.length,units:'meters',coordinates:'metaverse-vessel-local-left-handed',inputs,source:{repository:'https://github.com/SpaceXpanse/Metaverse',commit:'3264a944196c48a39d14beab7dafdd10c6918461',mesh:'Src/Vessel/ShuttlePB/Meshes/ShuttlePB.msh',license:'MIT',licenseFile:'../upstream/LICENSE-Metaverse.txt'}};
await writeFile(join(destination,'ShuttlePB.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
