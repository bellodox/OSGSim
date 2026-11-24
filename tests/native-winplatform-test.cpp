// SPDX-License-Identifier: MIT
// Windows-only test of WinPlatform.hpp, run on the CI Windows runner after the DLL build:
// UTF-8 environment, files in a non-ASCII folder, WinHTTP against a local server, cancelling a hung request,
// the capture process (no SPEX_GSP_ variables inherited, cancellable) and a real NTP exchange.
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif
#include <cstdio>
#include <thread>
#include "../native/spexgsp-rod/WinPlatform.hpp"
#pragma comment(lib,"Ws2_32.lib")
static int failures=0;
#define CHECK(c,msg) do{if(c)std::printf("ok   %s\n",msg);else{std::printf("FAIL %s\n",msg);++failures;}}while(0)
// A loopback server: answers once with `reply`, or never when reply is empty.
struct Server{
 SOCKET ls=INVALID_SOCKET;int port=0;std::thread t;
 explicit Server(std::string reply){
  ls=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);sockaddr_in a={};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  bind(ls,(sockaddr*)&a,sizeof a);listen(ls,4);int n=sizeof a;getsockname(ls,(sockaddr*)&a,&n);port=ntohs(a.sin_port);
  t=std::thread([this,reply]{SOCKET c=accept(ls,nullptr,nullptr);if(c==INVALID_SOCKET)return;std::string got;char b[4096];
   while(got.find("\r\n\r\n")==std::string::npos){int k=recv(c,b,sizeof b,0);if(k<=0)break;got.append(b,k);}
   if(!reply.empty())send(c,reply.data(),(int)reply.size(),0);else Sleep(8000);closesocket(c);});
 }
 ~Server(){closesocket(ls);if(t.joinable())t.join();}
};
int main(){
 SetConsoleOutputCP(CP_UTF8);WSADATA ws;WSAStartup(MAKEWORD(2,2),&ws);
 // 1. environment as UTF-8
 SetEnvironmentVariableW(L"SPEX_GSP_TEST_PATH",L"C:\\Users\\B\u00fcrger\\\u65e5\u672c");
 CHECK(v26win::envUtf8("SPEX_GSP_TEST_PATH")=="C:\\Users\\B\xc3\xbcrger\\\xe6\x97\xa5\xe6\x9c\xac","non-ASCII environment value arrives as UTF-8");
 // 2. files in a non-ASCII folder
 wchar_t tmp[MAX_PATH];GetTempPathW(MAX_PATH,tmp);const std::string dir=v26win::narrow(tmp)+"spex-B\xc3\xbcrger-\xe6\x97\xa5";
 v26win::Platform pf;const std::string file=dir+"\\sub\\st\xc3\xa4tus.json";
 pf.writeFile(file,"{\"a\":1}");std::string back;CHECK(pf.readFile(file,back)&&back=="{\"a\":1}","write and read a file in a non-ASCII folder (folders created)");
 pf.writeFile(file,"{\"a\":2}");CHECK(pf.readFile(file,back)&&back=="{\"a\":2}","replace an existing file");
 pf.removeFile(file);CHECK(!pf.readFile(file,back),"remove the file");
 // 3. WinHTTP
 {Server s("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
  int status=0;std::string body;pf.http("POST","http://127.0.0.1:"+std::to_string(s.port)+"/x?y=1",{{"content-type","application/json"},{"authorization","Bearer abc"}},"{\"q\":1}",5000,status,body);
  CHECK(status==201&&body=="{\"ok\":true}","WinHTTP POST to loopback: status and body");}
 {bool threw=false;try{int st;std::string b;pf.http("GET","http://127.0.0.1:1/",{},"",3000,st,b);}catch(...){threw=true;}CHECK(threw,"refused connection throws");}
 {bool threw=false;try{int st;std::string b;pf.http("GET","http://example.com/",{},"",3000,st,b);}catch(const std::exception& e){threw=std::string(e.what())=="only_loopback_http";}CHECK(threw,"non-loopback URL refused");}
 // 4. cancelling a request that never gets an answer
 {Server s("");v26win::Platform p2;std::string error;const auto begin=GetTickCount64();
  std::thread call([&]{try{int st;std::string b;p2.http("GET","http://127.0.0.1:"+std::to_string(s.port)+"/hang",{},"",12000,st,b);}catch(const std::exception& e){error=e.what();}});
  Sleep(400);p2.cancel();call.join();const auto took=GetTickCount64()-begin;
  std::printf("     cancelled request returned after %llu ms: %s\n",(unsigned long long)took,error.c_str());
  CHECK(error=="cancelled"&&took<3000,"cancel() ends a hung request within 3 s (timeout was 12 s)");}
 // 5. capture process: environment without SPEX_GSP_, cancellable
 {SetEnvironmentVariableW(L"SPEX_GSP_RPC_PASSWORD",L"secret-should-not-leak");
  const std::string script=dir+"\\capture.ps1",out=dir+"\\env.txt";
  pf.writeFile(script,"param([int]$SimulatorPid,[string]$OutputFile)\r\n$v=[Environment]::GetEnvironmentVariable('SPEX_GSP_RPC_PASSWORD');if($v -eq $null){$v='<none>'}\r\nSet-Content -LiteralPath $OutputFile -Value (\"pid=$SimulatorPid pw=\"+$v) -Encoding ASCII\r\n");
  bool ok=true;try{pf.capture(script,4242,out);}catch(const std::exception& e){ok=false;std::printf("     capture error: %s\n",e.what());}
  std::string text;pf.readFile(out,text);std::printf("     capture wrote: %s",text.c_str());
  CHECK(ok&&text.find("pid=4242")!=std::string::npos,"capture runs PowerShell with the script and arguments (non-ASCII path)");
  CHECK(text.find("secret")==std::string::npos&&text.find("pw=<none>")!=std::string::npos,"capture process does not inherit SPEX_GSP_ variables");
  const std::string slow=dir+"\\slow.ps1";pf.writeFile(slow,"param([int]$SimulatorPid,[string]$OutputFile)\r\nStart-Sleep -Seconds 25\r\n");
  v26win::Platform p3;std::string error;const auto begin=GetTickCount64();
  std::thread call([&]{try{p3.capture(slow,1,out);}catch(const std::exception& e){error=e.what();}});Sleep(1500);p3.cancel();call.join();
  CHECK(error=="cancelled"&&GetTickCount64()-begin<4000,"cancel() stops a running capture");}
 // 6. NTP (network on the runner may block UDP 123: reported, not failed) and cancelled NTP
 {int good=0;for(const char* h:{"time.windows.com","pool.ntp.org","time.cloudflare.com"}){try{const auto x=pf.ntp(h);std::printf("     ntp %s offset %.1f ms, uncertainty %.1f ms\n",h,x.offsetMs,x.uncertaintyMs);++good;}catch(const std::exception& e){std::printf("     ntp %s: %s\n",h,e.what());}}
  std::printf("     ntp servers answering: %d\n",good);
  v26win::Platform p4;p4.cancel();std::string error;try{p4.ntp("pool.ntp.org");}catch(const std::exception& e){error=e.what();}
  CHECK(error=="cancelled","a cancelled platform does not wait for NTP");}
 std::printf("%s (%d failures)\n",failures?"FAILED":"PASSED",failures);
 return failures?1:0;
}
