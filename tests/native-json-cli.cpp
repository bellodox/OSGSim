// SPDX-License-Identifier: MIT
// Test helper. "canon <json>" prints the canonical form and its SHA-256; "png <file>" prints the inspection result.
#include <fstream>
#include <iostream>
#include <sstream>
#include "../native/spexgsp-rod/Json.hpp"
#include "../native/spexgsp-rod/Png.hpp"
#include "../native/spexgsp-rod/Sha256.hpp"
#include "../native/spexgsp-rod/HubClient.hpp"
int main(){
 std::string line;v26hub::EventThrottle throttle(30000);
 while(std::getline(std::cin,line)){
  const auto sp=line.find(' ');const std::string cmd=line.substr(0,sp),arg=sp==std::string::npos?"":line.substr(sp+1);
  try{
   if(cmd=="canon"){const auto v=v26json::parse(arg);const auto c=v26json::canonical(v);std::cout<<c<<"\t"<<v26hash::sha256hex(c)<<"\n";}
   else if(cmd=="sha"){std::cout<<v26hash::sha256hex(arg)<<"\n";}
   else if(cmd=="png"){std::ifstream f(arg,std::ios::binary);std::ostringstream o;o<<f.rdbuf();const auto i=v26png::inspect(o.str());std::cout<<"OK "<<i.width<<" "<<i.height<<" "<<i.channels<<" "<<i.distinct<<" "<<i.nonUniform<<"\n";}
   else if(cmd=="throttle"){std::istringstream a(arg);std::string key;double now;a>>key>>now;double rep=0;const bool ok=throttle.admit(key,now,rep);std::cout<<(ok?"write ":"drop ")<<rep<<"\n";}
   else if(cmd=="pick"){const auto tab=arg.find('\t');const auto committed=v26json::parse(arg.substr(0,tab));const auto live=v26json::parse(arg.substr(tab+1));const auto& r=v26hub::pickMotionFrame(committed,live);std::cout<<(&r==&committed?"committed":"live")<<"\n";}
   else std::cout<<"ERR unknown\n";
  }catch(const std::exception& e){std::cout<<"ERR "<<e.what()<<"\n";}
 }
}
