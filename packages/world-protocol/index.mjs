// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const TYPES = Object.freeze([
  'WORLD_INIT', 'WORLD_DELTA', 'OBSERVER_EVIDENCE', 'COMMAND_REQUEST',
  'COMMAND_ACCEPTED', 'CONTACT_BEGIN', 'CONTACT_END', 'CHECKPOINT',
  'RESYNC_REQUIRED', 'PHYSICS_SAMPLE', 'SIMULATION_RESET', 'HELLO'
]);
const typeSet = new Set(TYPES);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function identifier(value, field='id') {
  assert(typeof value === 'string' && safeId.test(value), `invalid ${field}`); return value;
}
export function finite(value, field) {
  assert(typeof value === 'number' && Number.isFinite(value), `invalid ${field}`); return value;
}
export function integer(value, field, minimum=0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `invalid ${field}`); return value;
}
export function vec3(value, field) {
  assert(Array.isArray(value) && value.length === 3, `invalid ${field} dimensions`);
  return Array.from(value,(v,i)=>finite(v,`${field}[${i}]`));
}
export function quat(value, field) {
  assert(Array.isArray(value) && value.length === 4, `invalid ${field} dimensions`);
  const q = value.map((v,i)=>finite(v,`${field}[${i}]`));
  const len = Math.hypot(...q); assert(Math.abs(len-1)<1e-3,`invalid ${field} normalization`);
  return q;
}
export function validateEnvelope(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'envelope must be object');
  assert(input.version === PROTOCOL_VERSION, 'protocol version mismatch');
  assert(typeSet.has(input.type), 'unsupported message type');
  identifier(input.runId, 'runId');
  integer(input.epoch, 'epoch'); integer(input.step, 'step');
  integer(input.sequence, 'sequence');
  if ('simTime' in input) finite(input.simTime, 'simTime');
  if ('simDt' in input) { finite(input.simDt, 'simDt'); assert(input.simDt >= 0,'negative simDt'); }
  if ('entityId' in input) identifier(input.entityId,'entityId');
  if ('frameId' in input) identifier(input.frameId,'frameId');
  if ('eventId' in input) identifier(input.eventId,'eventId');
  if ('position' in input) vec3(input.position,'position');
  if ('velocity' in input) vec3(input.velocity,'velocity');
  if ('orientation' in input) quat(input.orientation,'orientation');
  if ('angularVelocity' in input) vec3(input.angularVelocity,'angularVelocity');
  if ('contact' in input) assert(typeof input.contact==='boolean','invalid contact');
  if ('source' in input) assert(['native','recorded','derived','illustrative'].includes(input.source),'invalid source');
  if ('assetHash' in input) assert(typeof input.assetHash === 'string' && /^[0-9a-f]{64}$/.test(input.assetHash),'invalid asset hash');
  if ('transportAuthenticated' in input) assert(typeof input.transportAuthenticated === 'boolean','invalid transport authentication flag');
  if (input.type === 'HELLO') {
    assert(input.source === 'native', 'bridge HELLO source must be native');
    assert(input.step === 0 && input.sequence === 0, 'HELLO must be pre-stream');
    assert(typeof input.bridgeToken === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(input.bridgeToken), 'invalid bridge token');
  }
  if (input.type === 'PHYSICS_SAMPLE') {
    identifier(input.frameId,'frameId');
    integer(input.step,'step',1); integer(input.sequence,'sequence',1);
    identifier(input.entityId,'entityId'); vec3(input.position,'position');
    vec3(input.velocity,'velocity'); assert(typeof input.contact === 'boolean','invalid contact');
    finite(input.simTime,'simTime'); finite(input.simDt,'simDt');
    assert(input.source === 'native' || input.source === 'recorded','sample must identify source');
  }
  if (input.type === 'CONTACT_BEGIN' || input.type === 'CONTACT_END') {
    identifier(input.entityId,'entityId'); identifier(input.eventId,'eventId');
    assert(input.source==='native' || input.source==='recorded', 'invalid contact provenance');
  }
  if (input.type === 'COMMAND_REQUEST') {
    identifier(input.commandId,'commandId'); identifier(input.entityId,'entityId');
    assert(input.operation==='set-thruster', 'operation not permitted');
    assert(typeof input.level === 'number' && input.level>=0 && input.level<=1,'invalid thrust level');
    identifier(input.actorId,'actorId');
  }
  const encoded = Buffer.byteLength(JSON.stringify(input));
  assert(encoded<=MAX_ENVELOPE_BYTES,'oversized envelope');
  return input;
}
export function makeEnvelope(type, fields) { return validateEnvelope({version:1,type, ...fields}); }
export class SequenceGate {
  #cursor = new Map(); #eventDigests = new Map();
  accept(event) {
    validateEnvelope(event);
    const k = `${event.runId}/${event.epoch}`;
    const last = this.#cursor.get(k) ?? 0;
    if (event.sequence !== last+1) throw new Error(`out-of-order sequence: expected ${last+1}, got ${event.sequence}`);
    if (event.eventId) {
      const k2 = `${event.runId}/${event.epoch}/${event.eventId}`;
      const digest = sha256(JSON.stringify(event));
      if (this.#eventDigests.has(k2)) throw new Error('duplicate event ID');
      this.#eventDigests.set(k2,digest);
    }
    this.#cursor.set(k,event.sequence);
    return true;
  }
}
export function eventIdentity(event) {
  return `event:${sha256(JSON.stringify([event.runId,event.epoch,event.step,event.type,event.entityId ?? '']))}`;
}
