// SPDX-License-Identifier: MIT
// Test harness for HubClient.hpp (the sidecar port): runs it on Linux with POSIX sockets against the real hub.
// stdin: the JSON lines the game plugin sends. stdout: the wire lines the plugin receives, and "EVENT {json}" lines.
// argv: hubUrl actor address runNonce runId nativeName rpcUrl rpcUser rpcPassword metaverseRoot captureScript captureDataDir [frozenWallMs]
// With frozenWallMs the world clock stands still at that wall time (monotonic 0), like the Node tests; timers stay real.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>
#include <cstdlib>
#include <sys/stat.h>
#include "../native/spexgsp-rod/HubClient.hpp"
using namespace v26hub;
static std::string slash(std::string p){for(auto& c:p)if(c=='\\')c='/';return p;}
struct Posix:Platform{
 void http(const std::string& method,const std::string& url,const Headers& headers,const std::string& body,int timeoutMs,int& status,std::string& response)override{
  const std::string prefix="http://";if(url.rfind(prefix,0)!=0)throw std::runtime_error("only http");
  const auto hostEnd=url.find('/',prefix.size());const std::string hostPort=url.substr(prefix.size(),hostEnd==std::string::npos?std::string::npos:hostEnd-prefix.size()),path=hostEnd==std::string::npos?"/":url.substr(hostEnd);
  const auto colon=hostPort.find(':');const int port=colon==std::string::npos?80:std::stoi(hostPort.substr(colon+1));
  int fd=socket(AF_INET,SOCK_STREAM,0);sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(uint16_t(port));inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);
  timeval tv{timeoutMs/1000,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&tv,sizeof tv);
  if(connect(fd,(sockaddr*)&a,sizeof a)!=0){close(fd);throw std::runtime_error("ECONNREFUSED");}
  std::string req=method+" "+path+" HTTP/1.1\r\nHost: "+hostPort+"\r\nConnection: close\r\ncontent-length: "+std::to_string(body.size())+"\r\n";
  for(const auto& h:headers)req+=h.first+": "+h.second+"\r\n";req+="\r\n"+body;
  size_t sent=0;while(sent<req.size()){ssize_t k=::send(fd,req.data()+sent,req.size()-sent,0);if(k<=0){close(fd);throw std::runtime_error("send failed");}sent+=size_t(k);}
  std::string raw;char buf[8192];ssize_t k;while((k=recv(fd,buf,sizeof buf,0))>0)raw.append(buf,size_t(k));close(fd);
  const auto split=raw.find("\r\n\r\n");if(raw.rfind("HTTP/1.1 ",0)!=0||split==std::string::npos)throw std::runtime_error("bad response");
  status=std::stoi(raw.substr(9,3));response=raw.substr(split+4);
 }
 v26clock::NtpSample ntp(const std::string& host)override{return {host,0,2,1};}
 double monoMs()override{return double(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count())/1000.0;}
 double wallMs()override{return double(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000.0;}
 bool readFile(const std::string& path,std::string& out)override{std::ifstream f(slash(path),std::ios::binary);if(!f)return false;std::ostringstream s;s<<f.rdbuf();out=s.str();return true;}
 void writeFile(const std::string& path,const std::string& data)override{const auto p=slash(path);const auto cut=p.rfind('/');if(cut!=std::string::npos)mkdir(p.substr(0,cut).c_str(),0700);std::ofstream f(p+".tmp",std::ios::binary);f<<data;f.close();std::rename((p+".tmp").c_str(),p.c_str());}
 void removeFile(const std::string& path)override{std::remove(slash(path).c_str());}
 // The test placed the screenshot already. SPEX_TEST_CAPTURE_MS makes the capture take that long (it runs off the hub thread).
 void capture(const std::string&,unsigned long,const std::string& out)override{
  if(const char* d=std::getenv("SPEX_TEST_CAPTURE_MS"))std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(d)));
  std::ifstream f(slash(out),std::ios::binary);if(!f)throw std::runtime_error("capture_failed");}
};
int main(int argc,char** argv){
 if(argc<13)return 2;Posix pf;Config c;
 c.hubUrl=argv[1];c.actor=argv[2];c.address=argv[3];c.runNonce=argv[4];c.runId=argv[5];c.nativeName=argv[6];c.rpcUrl=argv[7];c.rpcUser=argv[8];c.rpcPassword=argv[9];c.metaverseRoot=argv[10];c.captureScript=argv[11];c.captureDataDir=argv[12];c.pid=1234;c.ntpHosts={"a.test","b.test"};c.pollMs=80;
 int status=0;std::string text;pf.http("GET",c.hubUrl+"/world",{},"",12000,status,text);
 const auto snapshot=v26json::parse(text);
 const bool frozen=argc>13;const double frozenWall=frozen?std::stod(argv[13]):0;
 v26clock::WorldClock clock(v26clock::validatePolicy(snapshot.at("clock")),[&]{return frozen?0.0:pf.monoMs();},[&]{return frozen?frozenWall:pf.wallMs();});
 std::mutex out;
 HubClient hub(c,pf,clock,[&](const std::string& l){std::lock_guard<std::mutex> g(out);std::fputs(l.c_str(),stdout);std::fflush(stdout);},[&](const v26json::Value& e){std::lock_guard<std::mutex> g(out);std::printf("EVENT %s\n",v26json::stringify(e).c_str());std::fflush(stdout);});
 hub.calibrateClock();hub.start();
 std::atomic<bool> done{false};
 std::thread reader([&]{std::string line;while(std::getline(std::cin,line))hub.fromGame(line);done=true;});
 while(!done){hub.step();std::this_thread::sleep_for(std::chrono::milliseconds(20));}
 hub.close();reader.join();return 0;
}
