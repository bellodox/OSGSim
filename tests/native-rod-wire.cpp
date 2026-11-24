// SPDX-License-Identifier: MIT
#include <cassert>
// The DLL includes windows.h first, which defines min/max as macros. Reproduce that: the standard headers come first,
// then the macros, then the wire header (its own includes are already satisfied), so std::min/std::max in it would not compile.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <locale>
#include <sstream>
#include <string>
#include <vector>
#include <deque>
#define min(a,b) (((a)<(b))?(a):(b))
#define max(a,b) (((a)>(b))?(a):(b))
#include "../native/spexgsp-rod/V26Wire.hpp"
int main(){
 v26wire::Despawn d;
 const std::string id(64,'a');
 assert(v26wire::despawn("OSGDESPAWN7\tpeer5\t"+id,d));
 assert(d.actor=="peer5"&&d.eventId==id);
 assert(!v26wire::despawn("OSGDESPAWN7\tpeer5\t"+std::string(64,'g'),d));
 assert(!v26wire::despawn("OSGDESPAWN7\t../peer5\t"+id,d));
 assert(!v26wire::despawn("OSGDESPAWN7\tpeer5\t"+id+"\textra",d));
 assert(!v26wire::despawn("OSGSPAWN4\tpeer5\t"+id,d));
 v26wire::Spawn spawn;assert(v26wire::spawn("OSGSPAWN4\t"+id+"\tpeer5\tGlider-Peer5\tShuttlePB\tMoon\tBrighton Beach\t5\t51982.12\t0\tPORT",spawn));

 // extrapolate(): same cases the Node sidecar test used before this logic moved into the DLL.
 {
  v26wire::Motion m;m.simMjd=60000;m.p={1000,2000,3000};m.v={10,-20,30};
  const auto near=[](double a,double b){return std::abs(a-b)<1e-3;}; // a double near MJD 60000 resolves ~0.6 us of time, so ~5 um of position
  const auto a=v26wire::extrapolate(m,60000+2.0/86400);assert(near(a[0],1020)&&near(a[1],1960)&&near(a[2],3060));
  const auto b=v26wire::extrapolate(m,60000+1);assert(b[0]==1100&&b[1]==1800&&b[2]==3300); // capped at 10 s
  assert(v26wire::extrapolate(m,59999)==m.p);                                              // never backwards
  m.landed=true;assert(v26wire::extrapolate(m,60000+2.0/86400)==m.p);                      // landed: surface coordinates are used
  m.landed=false;assert(v26wire::extrapolate(m,std::nan(""))==m.p);                       // no usable time: unchanged
 }

 // OSGREMOTES1 / revoked(): the verified remote-ship set the DLL compares with its own ships.
 {
  const std::string e1(64,'1'),e2(64,'2'),e3(64,'3');
  v26wire::RemoteSet rs;
  assert(v26wire::remoteSet("OSGREMOTES1\t0",rs)&&rs.ships.empty());
  assert(v26wire::remoteSet("OSGREMOTES1\t2\tpeer1\t"+e1+"\tpeer2\t"+e2,rs)&&rs.ships.size()==2&&rs.ships[1].actor=="peer2"&&rs.ships[1].eventId==e2);
  v26wire::RemoteSet bad;
  assert(!v26wire::remoteSet("OSGREMOTES1\t2\tpeer1\t"+e1,bad));                                  // count does not match the fields
  assert(!v26wire::remoteSet("OSGREMOTES1\t1\tpeer1\t"+e1+"\tpeer2\t"+e2,bad));
  assert(!v26wire::remoteSet("OSGREMOTES1\t1\t../x\t"+e1,bad));                                   // bad actor name
  assert(!v26wire::remoteSet("OSGREMOTES1\t1\tpeer1\t"+std::string(64,'g'),bad));                  // bad event hash
  assert(!v26wire::remoteSet("OSGREMOTES1\t2\tpeer1\t"+e1+"\tpeer1\t"+e2,bad));                   // duplicate actor
  assert(!v26wire::remoteSet("OSGREMOTES1\t7\ta\t"+e1,bad));                                      // more than 6 ships
  assert(!v26wire::remoteSet("OSGDESPAWN7\tpeer1\t"+e1,bad));
  const std::vector<v26wire::Despawn> have={{"peer1",e1},{"peer2",e2},{"peer3",e3}};
  v26wire::RemoteSet want;assert(v26wire::remoteSet("OSGREMOTES1\t2\tpeer1\t"+e1+"\tpeer2\t"+e3,want)); // peer2 replaced by another event, peer3 gone
  const auto gone=v26wire::revoked(have,want);
  assert(gone.size()==2&&gone[0].actor=="peer2"&&gone[0].eventId==e2&&gone[1].actor=="peer3");
  v26wire::RemoteSet none;assert(v26wire::remoteSet("OSGREMOTES1\t0",none));
  assert(v26wire::revoked(have,none).size()==3);                                                     // an empty set removes everything
  assert(v26wire::revoked({},want).empty());
  // dropStaleSpawns: queued spawns of remote ships the newer set no longer contains are dropped; the own ship never is.
  std::deque<v26wire::Spawn> q;v26wire::Spawn a,b,c,own;a.actor="peer1";a.eventId=e1;b.actor="peer2";b.eventId=e2;c.actor="peer3";c.eventId=e3;own.actor="peer0";own.eventId=e1;
  q={a,b,c,own};v26wire::dropStaleSpawns(q,want,"peer0");                  // want: peer1/e1, peer2/e3
  assert(q.size()==2&&q[0].actor=="peer1"&&q[1].actor=="peer0");          // peer2 has another event, peer3 is gone
  q={a,own};v26wire::dropStaleSpawns(q,none,"peer0");assert(q.size()==1&&q[0].actor=="peer0");
 }
}
