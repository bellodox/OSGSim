// SPDX-License-Identifier: MIT
// Out-of-tree Metaverse 0.1.6 SDK plugin. Windows x64 build/load requires user verification.
// Captures accepted post-integration state; no socket I/O runs on the physics thread.
#define SPACEXPANSE_MODULE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cmath>
#include <deque>
#include <array>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include "SpaceXpansesdk.h"
#include "OSGSimWire.hpp"
#pragma comment(lib, "Ws2_32.lib")

namespace {
constexpr size_t MAX_QUEUE = 8192;
std::uint64_t captureTime(){return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());}

std::string bridgeToken() {
  std::array<char, 256> buffer{};
  DWORD size=GetEnvironmentVariableA("OSG_BRIDGE_TOKEN",buffer.data(),static_cast<DWORD>(buffer.size()));
  if(size==0)return {};
  if(size>=buffer.size())return "!invalid!";
  std::string token(buffer.data(),size);
  if(token.size()<16 || token.size()>128 || token.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")!=std::string::npos)return "!invalid!";
  return token;
}
std::string displayName(const char* name){
  const std::string raw=name?std::string(name).substr(0,256):std::string();if(raw.empty())return {};
  UINT page=CP_UTF8;DWORD flags=MB_ERR_INVALID_CHARS;
  int size=MultiByteToWideChar(page,flags,raw.data(),static_cast<int>(raw.size()),nullptr,0);
  if(!size){page=CP_ACP;flags=0;size=MultiByteToWideChar(page,flags,raw.data(),static_cast<int>(raw.size()),nullptr,0);}
  if(!size)return {};std::wstring wide(size,L'\0');MultiByteToWideChar(page,flags,raw.data(),static_cast<int>(raw.size()),wide.data(),size);
  int bytes=WideCharToMultiByte(CP_UTF8,0,wide.data(),size,nullptr,0,nullptr,nullptr);std::string result(bytes,'\0');
  WideCharToMultiByte(CP_UTF8,0,wide.data(),size,result.data(),bytes,nullptr,nullptr);return result;
}
osgsim::Sample captureSample(const std::string& run,const std::string& entity,int epoch,unsigned long long step,
  unsigned long long sequence,double simt,double simdt,VESSEL* vessel) {
  VECTOR3 p,v,av; MATRIX3 m;
  vessel->GetGlobalPos(p);vessel->GetGlobalVel(v);
  vessel->GetAngularVel(av);vessel->GetRotationMatrix(m);
  return {run,entity,static_cast<std::uint64_t>(epoch),
    step,sequence,simt,simdt,{p.x,p.y,p.z},{v.x,v.y,v.z},{av.x,av.y,av.z},
    {m.m11,m.m12,m.m13,m.m21,m.m22,m.m23,m.m31,m.m32,m.m33},vessel->GroundContact(),false,{},0};
}
class Bridge final:public oapi::Module {
public:
  explicit Bridge(HINSTANCE handle):oapi::Module(handle){tileCache=InitTileCache(4);}
  ~Bridge() override {stopWorker();if(tileCache)ReleaseTileCache(tileCache);}
  void clbkSimulationStart(RenderMode) override {
    stopWorker();
    std::lock_guard<std::mutex> lock(queueMutex);
    queue.clear();vesselIds.clear();terrainCaches.clear();nextTerrainId=0;nextVesselId=0;lastTime=0;shutdownAt=0;epoch=0;step=0;sequence=0;overflow=false;
    runId="native-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64());
    running=true;worker=std::thread(&Bridge::sendLoop,this);
  }
  void clbkTimeJump(double simt,double,double) override {
    std::lock_guard<std::mutex> lock(queueMutex);
    ++epoch;step=0;sequence=0;lastTime=simt;terrainCaches.clear();
  }
  void clbkVesselJump(OBJHANDLE) override {
    // Explicit repositioning starts a new interval; it is not a landing trajectory.
    std::lock_guard<std::mutex> lock(queueMutex);++epoch;step=0;sequence=0;terrainCaches.clear();
  }
  void clbkPostStep(double simt,double simdt,double) override {
    if(!running || overflow)return;
    std::lock_guard<std::mutex> lock(queueMutex);
    ++step;lastTime=simt;
    for(DWORD i=0;i<oapiGetVesselCount();++i) {
      OBJHANDLE h=oapiGetVesselByIndex(int(i));
      VESSEL* v=oapiGetVesselInterface(h);
      if(!v)continue;
      if(queue.size()>=MAX_QUEUE) {
        overflow=true;
        OutputDebugStringA("OSG Sim bridge: critical queue overflow; native samples no longer complete\n");
        return;
      }
      // Capture SDK values only. JSON conversion and quaternion math run on the worker.
      auto found=vesselIds.find(h);
      if(found==vesselIds.end())found=vesselIds.emplace(h,++nextVesselId).first;
      const std::string entity=std::to_string(found->second);
      auto sample=captureSample(runId,entity,epoch,step,++sequence,simt,simdt,v);sample.name=displayName(v->GetName());sample.capturedAtUnixMs=captureTime();sample.hasVisual=captureVisual(h,v,sample.visual);queue.emplace_back(std::move(sample));
    }
    cv.notify_one();
  }
  void clbkSimulationEnd() override {stopWorker();}
  void clbkDeleteVessel(OBJHANDLE h) override {
    std::lock_guard<std::mutex> lock(queueMutex);
    auto found=vesselIds.find(h);if(found==vesselIds.end())return;
    if(running&&!overflow){if(queue.size()>=MAX_QUEUE){overflow=true;}else{
      osgsim::Sample event;event.run=runId;event.entity=std::to_string(found->second);event.epoch=epoch;event.step=step;event.sequence=++sequence;event.time=lastTime;event.removed=true;event.capturedAtUnixMs=captureTime();queue.emplace_back(std::move(event));cv.notify_one();}}
    terrainCaches.erase(h);vesselIds.erase(found);
  }
private:
  struct PatchCache {
    OBJHANDLE body=nullptr;
    std::shared_ptr<osgsim::Terrain> ready,building;
    size_t cursor=0;
  };
  std::unordered_map<OBJHANDLE,PatchCache> terrainCaches;
  unsigned long long nextTerrainId=0;
  std::vector<ElevationTile>* tileCache=nullptr;
  bool captureVisual(OBJHANDLE vesselHandle,VESSEL* vessel,osgsim::Visual& out){
    const OBJHANDLE body=vessel->GetSurfaceRef();if(!body)return false;
    char bodyName[128]={};oapiGetObjectName(body,bodyName,127);
    out.vesselClass=displayName(vessel->GetClassName());out.bodyName=displayName(bodyName);out.bodyRadius=oapiGetSize(body);
    VECTOR3 bp,sp;MATRIX3 br;oapiGetGlobalPos(body,&bp);oapiGetRotationMatrix(body,&br);
    char sunName[]="Sun";const OBJHANDLE sun=oapiGetObjectByName(sunName);if(!sun)return false;oapiGetGlobalPos(sun,&sp);
    out.bodyPosition={bp.x,bp.y,bp.z};out.sunPosition={sp.x,sp.y,sp.z};out.bodyRotation={br.m11,br.m12,br.m13,br.m21,br.m22,br.m23,br.m31,br.m32,br.m33};
    out.main=vessel->GetThrusterGroupLevel(THGROUP_MAIN);out.hover=vessel->GetThrusterGroupLevel(THGROUP_HOVER);
    for(DWORD i=0;i<std::min<DWORD>(32,vessel->GetExhaustCount());++i){
      osgsim::Exhaust exhaust;VECTOR3 pos,dir;SURFHANDLE texture=nullptr;
      if(vessel->GetExhaustSpec(i,&exhaust.length,&exhaust.width,&pos,&dir,&texture)){
        exhaust.position={pos.x,pos.y,pos.z};exhaust.direction={dir.x,dir.y,dir.z};exhaust.level=vessel->GetExhaustLevel(i);out.exhausts.push_back(exhaust);
      }
    }
    if(out.vesselClass=="ShuttlePB")for(unsigned int i=0;i<3;i++)out.animations[i]=vessel->GetAnimation(i);
    // The initial landing scope is Moon/ShuttlePB. No terrain is invented for other bodies.
    if(out.bodyName!="Moon")return true;
    double lon=0,lat=0,radius=0;vessel->GetEquPos(lon,lat,radius);
    auto& cache=terrainCaches[vesselHandle];if(cache.body!=body){cache=PatchCache{};cache.body=body;}
    auto distance=[&](const osgsim::Terrain& t){const double d=std::remainder(lon-t.longitude,2*3.14159265358979323846);return out.bodyRadius*std::hypot(d*std::cos(lat),lat-t.latitude);};
    const double desiredSpacing=std::pow(2.0,std::ceil(std::log2(std::max(8.0,(radius-out.bodyRadius)*.5))));
    if(!cache.building&&(!cache.ready||distance(*cache.ready)>cache.ready->spacing*2||desiredSpacing<cache.ready->spacing*.5||desiredSpacing>cache.ready->spacing*2)){
      cache.building=std::make_shared<osgsim::Terrain>();auto& t=*cache.building;
      t.id="terrain-"+std::to_string(++nextTerrainId);t.bodyName=out.bodyName;t.radius=out.bodyRadius;t.longitude=lon;t.latitude=lat;t.spacing=std::min(8192.0,desiredSpacing);t.elevationLevel=32;t.heights.resize(t.size*t.size);cache.cursor=0;
    }
    if(cache.building){
      auto& t=*cache.building;
      // At most four cached SDK elevation queries per step; never a whole-grid scan
      // or file/network operation in the physics callback. Real-host timing is a gate.
      for(int budget=0;budget<4&&cache.cursor<t.heights.size();++budget,++cache.cursor){
        const double x=(static_cast<int>(cache.cursor%t.size)-t.size/2)*t.spacing,z=(static_cast<int>(cache.cursor/t.size)-t.size/2)*t.spacing;
        const double c=std::cos(t.latitude),sn=std::sin(t.latitude),co=std::cos(t.longitude),si=std::sin(t.longitude);
        const double px=t.radius*c*co-x*si-z*sn*co,py=t.radius*sn+z*c,pz=t.radius*c*si+x*co-z*sn*si;
        const double sampleLon=std::atan2(pz,px),sampleLat=std::atan2(py,std::hypot(px,pz));int level=0;
        t.heights[cache.cursor]=oapiSurfaceElevationEx(body,sampleLon,sampleLat,0,tileCache,nullptr,&level);t.elevationLevel=std::min(t.elevationLevel,level);
      }
      if(cache.cursor==t.heights.size()){cache.ready=cache.building;cache.building.reset();out.terrain=cache.ready;}
    }
    if(cache.ready)out.terrainId=cache.ready->id;
    return true;
  }
  std::mutex queueMutex;std::condition_variable cv;
  std::deque<osgsim::Sample> queue;
  std::thread worker;std::atomic<bool> running{false};
  std::atomic<bool> overflow{false};
  std::atomic<ULONGLONG> shutdownAt{0};
  std::string runId;
  std::unordered_map<OBJHANDLE,unsigned long long> vesselIds;
  unsigned long long nextVesselId=0;
  int epoch=0;unsigned long long step=0,sequence=0;double lastTime=0;
  void stopWorker(){
    shutdownAt=GetTickCount64()+2000;running=false;cv.notify_all();if(worker.joinable())worker.join();
  }
  bool expired() const {return !running && GetTickCount64()>=shutdownAt.load();}
  bool waitWritable(SOCKET sock,ULONGLONG deadline){
    while(!overflow && !expired() && GetTickCount64()<deadline){
      fd_set writable,errors;FD_ZERO(&writable);FD_ZERO(&errors);FD_SET(sock,&writable);FD_SET(sock,&errors);
      timeval timeout={0,100000};
      int result=select(0,nullptr,&writable,&errors,&timeout);
      if(result==SOCKET_ERROR||FD_ISSET(sock,&errors))return false;
      if(result>0){int error=0;int length=sizeof(error);
        return getsockopt(sock,SOL_SOCKET,SO_ERROR,reinterpret_cast<char*>(&error),&length)==0&&error==0;}
    }
    return false;
  }
  bool sendBytes(SOCKET sock,const std::string& message){
    const ULONGLONG deadline=GetTickCount64()+5000;size_t offset=0;
    while(offset<message.size()&&!overflow&&!expired()&&GetTickCount64()<deadline){
      const int sent=send(sock,message.data()+offset,static_cast<int>(message.size()-offset),0);
      if(sent>0){offset+=sent;continue;}
      if(sent==SOCKET_ERROR&&WSAGetLastError()==WSAEWOULDBLOCK&&waitWritable(sock,deadline))continue;
      return false;
    }
    return offset==message.size();
  }
  void sendLoop(){
    WSADATA ws={};
    if(WSAStartup(MAKEWORD(2,2),&ws)!=0){overflow=true;OutputDebugStringA("OSG Sim bridge: WSAStartup failed; capture invalidated\n");return;}
    SOCKET sock=INVALID_SOCKET;
    try {
      const std::string token=bridgeToken();
      if(token=="!invalid!")throw std::runtime_error("invalid OSG_BRIDGE_TOKEN");
      while(!overflow&&!expired()){
        {std::lock_guard<std::mutex> lock(queueMutex);if(!running&&queue.empty())break;}
        if(sock==INVALID_SOCKET){
          if(!running)throw std::runtime_error("unsent samples at shutdown");
          sock=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
          if(sock==INVALID_SOCKET)throw std::runtime_error("socket creation failed");
          u_long nonblocking=1;
          if(ioctlsocket(sock,FIONBIO,&nonblocking)!=0)throw std::runtime_error("nonblocking socket failed");
          sockaddr_in addr={};addr.sin_family=AF_INET;addr.sin_port=htons(4378);
          InetPtonA(AF_INET,"127.0.0.1",&addr.sin_addr);
          int result=connect(sock,reinterpret_cast<sockaddr*>(&addr),sizeof(addr));
          if(result!=0&&(WSAGetLastError()!=WSAEWOULDBLOCK||!waitWritable(sock,GetTickCount64()+200))){
            closesocket(sock);sock=INVALID_SOCKET;
            std::unique_lock<std::mutex> lock(queueMutex);
            cv.wait_for(lock,std::chrono::milliseconds(200),[&]{return !running.load()||overflow.load();});continue;
          }
          if(!token.empty()){
            const std::string hello="{\"version\":1,\"type\":\"HELLO\",\"source\":\"native\",\"runId\":\""+runId+"\",\"epoch\":0,\"step\":0,\"sequence\":0,\"bridgeToken\":\""+token+"\"}\n";
            if(!sendBytes(sock,hello))throw std::runtime_error("HELLO transmission failed");
          }
        }
        osgsim::Sample sample;
        {std::unique_lock<std::mutex> lock(queueMutex);
          cv.wait_for(lock,std::chrono::milliseconds(100),[&]{return !queue.empty()||!running.load()||overflow.load();});
          if(queue.empty())continue;
          sample=std::move(queue.front());queue.pop_front();
        }
        if(!sendBytes(sock,osgsim::formatSample(sample)))throw std::runtime_error("sample transmission failed");
      }
      {std::lock_guard<std::mutex> lock(queueMutex);if(!queue.empty())throw std::runtime_error("capture incomplete; unsent queue");}
    }catch(const std::exception& error){
      overflow=true;std::string diagnostic=std::string("OSG Sim bridge: ")+error.what()+"; capture invalidated\n";
      OutputDebugStringA(diagnostic.c_str());
    }
    if(sock!=INVALID_SOCKET)closesocket(sock);
    WSACleanup();
  }
};
Bridge* instance=nullptr;
}
DLLCLBK void InitModule(HINSTANCE dll){instance=new Bridge(dll);oapiRegisterModule(instance);}
DLLCLBK void ExitModule(HINSTANCE){delete instance;instance=nullptr;}
