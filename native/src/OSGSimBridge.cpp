// SPDX-License-Identifier: MIT
// Out-of-tree Metaverse 0.1.6 SDK plugin. Windows x64 build/load requires user verification.
// Captures accepted post-integration state; no socket I/O runs on the physics thread.
#define SPACEXPANSE_MODULE
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <atomic>
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

std::string bridgeToken() {
  std::array<char, 256> buffer{};
  DWORD size=GetEnvironmentVariableA("OSG_BRIDGE_TOKEN",buffer.data(),static_cast<DWORD>(buffer.size()));
  if(size==0)return {};
  if(size>=buffer.size())return "!invalid!";
  std::string token(buffer.data(),size);
  if(token.size()<16 || token.size()>128 || token.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")!=std::string::npos)return "!invalid!";
  return token;
}
osgsim::Sample captureSample(const std::string& run,const std::string& entity,int epoch,unsigned long long step,
  unsigned long long sequence,double simt,double simdt,VESSEL* vessel) {
  VECTOR3 p,v,av; MATRIX3 m;
  vessel->GetGlobalPos(p);vessel->GetGlobalVel(v);
  vessel->GetAngularVel(av);vessel->GetRotationMatrix(m);
  return {run,entity,static_cast<std::uint64_t>(epoch),
    step,sequence,simt,simdt,{p.x,p.y,p.z},{v.x,v.y,v.z},{av.x,av.y,av.z},
    {m.m11,m.m12,m.m13,m.m21,m.m22,m.m23,m.m31,m.m32,m.m33},vessel->GroundContact()};
}
class Bridge final:public oapi::Module {
public:
  explicit Bridge(HINSTANCE handle):oapi::Module(handle){}
  ~Bridge() override {stopWorker();}
  void clbkSimulationStart(RenderMode) override {
    stopWorker();
    std::lock_guard<std::mutex> lock(queueMutex);
    queue.clear();vesselIds.clear();nextVesselId=0;shutdownAt=0;epoch=0;step=0;sequence=0;overflow=false;
    runId="native-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64());
    running=true;worker=std::thread(&Bridge::sendLoop,this);
  }
  void clbkTimeJump(double,double,double) override {
    std::lock_guard<std::mutex> lock(queueMutex);
    ++epoch;step=0;sequence=0;
  }
  void clbkVesselJump(OBJHANDLE) override {
    // Explicit repositioning starts a new interval; it is not a landing trajectory.
    std::lock_guard<std::mutex> lock(queueMutex);++epoch;step=0;sequence=0;
  }
  void clbkPostStep(double simt,double simdt,double) override {
    if(!running || overflow)return;
    std::lock_guard<std::mutex> lock(queueMutex);
    ++step;
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
      const std::string entity=std::to_string(found->second)+":"+v->GetName();
      queue.emplace_back(captureSample(runId,entity,epoch,step,++sequence,simt,simdt,v));
    }
    cv.notify_one();
  }
  void clbkSimulationEnd() override {stopWorker();}
  void clbkDeleteVessel(OBJHANDLE h) override {
    std::lock_guard<std::mutex> lock(queueMutex);vesselIds.erase(h);
  }
private:
  std::mutex queueMutex;std::condition_variable cv;
  std::deque<osgsim::Sample> queue;
  std::thread worker;std::atomic<bool> running{false};
  std::atomic<bool> overflow{false};
  std::atomic<ULONGLONG> shutdownAt{0};
  std::string runId;
  std::unordered_map<OBJHANDLE,unsigned long long> vesselIds;
  unsigned long long nextVesselId=0;
  int epoch=0;unsigned long long step=0,sequence=0;
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
