// SPDX-License-Identifier: MIT
// Canonical immutable universe definition, never dependent on local focus or installation path.
import {readFile,stat} from 'node:fs/promises';import {createHash} from 'node:crypto';import {resolve,sep} from 'node:path';
import {sha} from './ownership.mjs';
// Files that decide simulation physics and content. The SpeXGSP plugin is deliberately NOT part of the
// fingerprint: plugin compatibility is enforced by its capability handshake, so a plugin fix does not
// create a new universe and testers may build the plugin themselves.
export const CRITICAL=[
 "Config/Ariel.cfg",
 "Config/Callisto.cfg",
 "Config/Deimos.cfg",
 "Config/Dione.cfg",
 "Config/Earth.cfg",
 "Config/Earth/Data/Vsop87B.dat",
 "Config/Enceladus.cfg",
 "Config/Europa.cfg",
 "Config/Ganymede.cfg",
 "Config/Hyperion.cfg",
 "Config/Iapetus.cfg",
 "Config/Io.cfg",
 "Config/Jupiter.cfg",
 "Config/Jupiter/Data/Vsop87B.dat",
 "Config/Mars.cfg",
 "Config/Mars/Data/Vsop87B.dat",
 "Config/Mercury.cfg",
 "Config/Mercury/Data/Vsop87B.dat",
 "Config/Mimas.cfg",
 "Config/Miranda.cfg",
 "Config/Moon.cfg",
 "Config/Moon/Base/Brighton.cfg",
 "Config/Moon/Data/ELP82.dat",
 "Config/Neptune.cfg",
 "Config/Neptune/Data/Vsop87B.dat",
 "Config/Nereid.cfg",
 "Config/Oberon.cfg",
 "Config/Phobos.cfg",
 "Config/Proteus.cfg",
 "Config/Rhea.cfg",
 "Config/Saturn.cfg",
 "Config/Saturn/Data/Vsop87B.dat",
 "Config/Sol.cfg",
 "Config/Sun.cfg",
 "Config/Sun/Data/Vsop87E.dat",
 "Config/Tethys.cfg",
 "Config/Titan.cfg",
 "Config/Titania.cfg",
 "Config/Triton.cfg",
 "Config/Umbriel.cfg",
 "Config/Uranus.cfg",
 "Config/Uranus/Data/Vsop87B.dat",
 "Config/Venus.cfg",
 "Config/Venus/Data/Vsop87B.dat",
 "Config/Vessels/ShuttlePB.cfg",
 "Config/Vesta.cfg",
 "Meshes/ShuttlePB.msh",
 "Modules/Celbody/Ariel.dll",
 "Modules/Celbody/Callisto.dll",
 "Modules/Celbody/Deimos.dll",
 "Modules/Celbody/Dione.dll",
 "Modules/Celbody/Earth.dll",
 "Modules/Celbody/Enceladus.dll",
 "Modules/Celbody/Europa.dll",
 "Modules/Celbody/Ganymede.dll",
 "Modules/Celbody/Hyperion.dll",
 "Modules/Celbody/Iapetus.dll",
 "Modules/Celbody/Io.dll",
 "Modules/Celbody/Jupiter.dll",
 "Modules/Celbody/Mars.dll",
 "Modules/Celbody/Mercury.dll",
 "Modules/Celbody/Mimas.dll",
 "Modules/Celbody/Miranda.dll",
 "Modules/Celbody/Moon.dll",
 "Modules/Celbody/Neptune.dll",
 "Modules/Celbody/Oberon.dll",
 "Modules/Celbody/Phobos.dll",
 "Modules/Celbody/Rhea.dll",
 "Modules/Celbody/Saturn.dll",
 "Modules/Celbody/Sun.dll",
 "Modules/Celbody/Tethys.dll",
 "Modules/Celbody/Titan.dll",
 "Modules/Celbody/Titania.dll",
 "Modules/Celbody/Triton.dll",
 "Modules/Celbody/Umbriel.dll",
 "Modules/Celbody/Uranus.dll",
 "Modules/Celbody/Venus.dll",
 "Modules/Galsat.dll",
 "Modules/Satsat.dll",
 "Modules/Server/SpaceXpanse.exe",
 "Modules/ShuttlePB.dll",
 "Modules/Vsop87.dll",
 "Scenarios/Missions/In orbit around Moon.scn",
 "SpaceXpanse_ng.exe"
];
export async function canonicalWorldManifest(installRoot,{criticalFiles=CRITICAL}={}){
 const root=resolve(installRoot),files=[];if(!Array.isArray(criticalFiles)||criticalFiles.length<5||criticalFiles.length>128)throw Error('invalid_world_manifest_files');
 for(const path of [...new Set(criticalFiles)].sort()){
  if(!/^[A-Za-z0-9_./ -]+$/.test(path)||path.includes('..')||path.startsWith('/'))throw Error('invalid_manifest_path');
  const file=resolve(root,path);if(!file.startsWith(root+sep))throw Error('manifest_escape');
  const meta=await stat(file);if(!meta.isFile()||meta.size>200*1024*1024)throw Error('invalid_manifest_source');
  const buf=await readFile(file);files.push({path:path.replaceAll('\\','/'),bytes:buf.length,sha256:createHash('sha256').update(buf).digest('hex')});
 }
 const manifest={schema:26,protocol:'spexgsp-v26-native-ntp-port-nostr',files};return{manifest,worldId:sha(manifest)};
}
