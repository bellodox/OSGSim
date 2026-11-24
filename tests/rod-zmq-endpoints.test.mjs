// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {selectRodZmqEndpoints} from '../OSGSim/apps/metaverse-native/v26/rod-game/zmq-preflight.mjs';
const local='tcp://127.0.0.1:28332',local2='tcp://127.0.0.1:28333';
test('actual ROD Core game publisher sockets are discovered, including split sockets',()=>{
 assert.deepEqual(selectRodZmqEndpoints([{type:'pubgamepending',address:local},{type:'pubgameblocks',address:local}]),[local]);
 assert.deepEqual(selectRodZmqEndpoints([{type:'pubgamepending',address:local},{type:'pubgameblocks',address:local2}]),[local,local2]);
 assert.deepEqual(selectRodZmqEndpoints([{type:'pubgamepending',address:local},{type:'pubgameblocks',address:local}],{requested:local}),[local]);
});
test('missing, wrong, or nonloopback game publishers fail before any player launch',()=>{
 assert.throws(()=>selectRodZmqEndpoints([]),/NOT_ENABLED/);
 assert.throws(()=>selectRodZmqEndpoints([{type:'pubgamepending',address:local}]),/NOT_ENABLED/);
 assert.throws(()=>selectRodZmqEndpoints([{type:'pubgamepending',address:'tcp://0.0.0.0:28332'},{type:'pubgameblocks',address:'tcp://0.0.0.0:28332'}]),/LOOPBACK/);
 assert.throws(()=>selectRodZmqEndpoints([{type:'pubgamepending',address:local},{type:'pubgameblocks',address:local2}],{requested:local}),/MISMATCH/);
});
