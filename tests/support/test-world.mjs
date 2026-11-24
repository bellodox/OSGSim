// SPDX-License-Identifier: MIT
// Test-only world: the runtime gets ships from the ROD projection (DistributedV26World); these tests exercise the
// shared proof, physics and occupancy rules with a direct local enrollment instead.
import {V26World} from '../../OSGSim/apps/metaverse-native/v26/world.mjs';
import {canonicalSpawn} from '../../OSGSim/apps/metaverse-native/v26/spawn-ports.mjs';
import {sha} from '../../OSGSim/apps/metaverse-native/v26/ownership.mjs';
const clone=x=>structuredClone(x);
const ADDR=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/;
const occupied=x=>x&&['RESERVED','ACTIVE','DEPARTED','LANDED'].includes(x.phase);
export class TestWorld extends V26World{
 constructor(options={}){super(options);this.reservationMs=options.reservationMs??600000;}
 async expireReservationsUnsafe(){
  const overdue=Object.values(this.state.ships).filter(x=>x.phase==='RESERVED'&&x.reservedUntilUtcMs<=this.now());
  for(const x of overdue){const next=clone(this.state);delete next.ships[x.actor];next.sequence++;await this.commit(next,'VESSEL_RESERVATION_EXPIRED',{actor:x.actor,eventId:x.eventId,slot:x.slot});}
  return overdue.length;
 }
 expireReservations(){return this.queue(()=>this.expireReservationsUnsafe());}
 async enroll({address,portId,slot=null}={}){return this.queue(async()=>{
  if(!ADDR.test(address)||portId!==this.port.portId)throw Error('unknown_address_or_port');await this.expireReservationsUnsafe();
  const prior=Object.values(this.state.ships).find(x=>x.owner===address);if(prior)return {...clone(prior),recovered:true};
  const selected=slot?this.port.slots.find(x=>x.slot===slot):this.port.slots.find(x=>!Object.values(this.state.ships).some(p=>p.slot===x.slot&&occupied(p)));
  if(!selected||Object.values(this.state.ships).some(p=>p.slot===selected.slot&&occupied(p)))throw Error(slot?'port_slot_occupied':'port_full');
  const index=this.state.nextActorId;if(index>9999)throw Error('world_actor_capacity');
  const actor=`peer${index}`,nativeName=`Glider-Peer${index}`,asset=`ship:peer${index}`;
  const eventId=sha({worldId:this.worldId,actor,address,portId,slot:selected.slot,kind:'VESSEL_SPAWN',sequence:this.state.sequence+1});
  const ship={worldId:this.worldId,actor,asset,owner:address,nativeName,vesselClass:'ShuttlePB',referenceBody:'Moon',portId,slot:selected.slot,eventId,phase:'RESERVED',spawnUtcMs:this.now(),reservedUntilUtcMs:this.now()+this.reservationMs,epoch:this.clock.era};
  canonicalSpawn(ship,this.port);const next=clone(this.state);next.ships[actor]=ship;next.nextActorId=index+1;next.sequence++;await this.commit(next,'VESSEL_RESERVATION',{ship});return clone(ship);
 });}
}
