// SPDX-License-Identifier: MIT
#pragma once
// Portable, deterministic bridge wire serializer. No Windows or simulator SDK dependencies.
// Compiled independently on Linux and with MSVC on the Windows native acceptance machine.
#include <array>
#include "OSGSimVisual.hpp"
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>

namespace osgsim {
using V3=std::array<double,3>;
using M3=std::array<double,9>; // row-major 3x3
using Q4=std::array<double,4>; // x,y,z,w
struct Sample {
  std::string run;
  std::string entity;
  std::uint64_t epoch=0, step=0, sequence=0;
  double time=0, dt=0;
  V3 position{},velocity{},angularVelocity{};
  M3 rotation{};
  bool contact=false;
  bool removed=false;
  std::string name;
  std::uint64_t capturedAtUnixMs=0;
  bool hasVisual=false;
  Visual visual;
};
inline std::string jsonString(const std::string& raw) {
  std::string value;constexpr char hex[]="0123456789abcdef";
  for(unsigned char c:raw){if(c=='"'||c=='\\'){value+='\\';value+=char(c);}else if(c<32){value+="\\u00";value+=hex[c>>4];value+=hex[c&15];}else value+=char(c);}return value;
}
inline std::string cleanName(const std::string& raw) {
  if(raw.empty())throw std::invalid_argument("empty vessel name");
  std::string result="vessel-";
  constexpr char hex[]="0123456789abcdef";
  for(unsigned char c:raw) {
    if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='.')result+=char(c);
    else {result+='_';result+=hex[c>>4];result+=hex[c&15];}
    if(result.size()>128)throw std::invalid_argument("vessel identifier exceeds protocol limit");
  }
  return result;
}
inline Q4 rotationQuaternion(const M3& m) {
  for(double v:m)if(!std::isfinite(v))throw std::invalid_argument("invalid rotation matrix");
  for(int r=0;r<3;r++)for(int c=0;c<3;c++){
    double v=0;for(int k=0;k<3;k++)v+=m[r*3+k]*m[c*3+k];
    if(std::abs(v-(r==c?1.0:0.0))>1e-6)throw std::invalid_argument("rotation must be orthonormal");
  }
  const double det=m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
  if(std::abs(det-1)>1e-6)throw std::invalid_argument("rotation determinant must be +1");
  const double a=m[0], b=m[1], c=m[2], d=m[3], e=m[4], f=m[5], g=m[6], h=m[7], i=m[8];
  double x=0,y=0,z=0,w=1;
  const double trace=a+e+i;
  if(trace>0){const double s=std::sqrt(trace+1)*2;w=s/4;x=(h-f)/s;y=(c-g)/s;z=(d-b)/s;}
  else if(a>e&&a>i){const double s=std::sqrt(1+a-e-i)*2;w=(h-f)/s;x=s/4;y=(b+d)/s;z=(c+g)/s;}
  else if(e>i){const double s=std::sqrt(1+e-a-i)*2;w=(c-g)/s;x=(b+d)/s;y=s/4;z=(f+h)/s;}
  else {const double s=std::sqrt(1+i-a-e)*2;w=(d-b)/s;x=(c+g)/s;y=(f+h)/s;z=s/4;}
  const double norm=std::sqrt(x*x+y*y+z*z+w*w);
  if(!std::isfinite(norm)||norm<1e-12)throw std::invalid_argument("invalid rotation quaternion");
  return {x/norm,y/norm,z/norm,w/norm};
}
inline void formatVisual(std::ostringstream& out,const Visual& v) {
  if(v.vesselClass.empty()||v.vesselClass.size()>128||v.bodyName.empty()||v.bodyName.size()>128||!std::isfinite(v.bodyRadius)||v.bodyRadius<=0||!std::isfinite(v.main)||v.main<0||v.main>1||!std::isfinite(v.hover)||v.hover<0||v.hover>1)throw std::invalid_argument("invalid visual descriptor");
  for(const auto& p:{v.bodyPosition,v.sunPosition,v.animations})for(double x:p)if(!std::isfinite(x))throw std::invalid_argument("nonfinite visual state");
  for(double a:v.animations)if(a<0||a>1)throw std::invalid_argument("invalid animation");
  const auto q=rotationQuaternion(v.bodyRotation);
  out<<",\"visual\":{\"version\":1,\"vesselClass\":\""<<jsonString(v.vesselClass)<<"\",\"bodyName\":\""<<jsonString(v.bodyName)<<"\",\"bodyRadius\":"<<v.bodyRadius;
  out<<",\"bodyPosition\":["<<v.bodyPosition[0]<<","<<v.bodyPosition[1]<<","<<v.bodyPosition[2]<<"],\"bodyOrientation\":["<<q[0]<<","<<q[1]<<","<<q[2]<<","<<q[3]<<"]";
  out<<",\"sunPosition\":["<<v.sunPosition[0]<<","<<v.sunPosition[1]<<","<<v.sunPosition[2]<<"],\"main\":"<<v.main<<",\"hover\":"<<v.hover<<",\"animations\":["<<v.animations[0]<<","<<v.animations[1]<<","<<v.animations[2]<<"]";
  out<<",\"exhausts\":[";
  if(v.exhausts.size()>32)throw std::invalid_argument("too many exhausts");
  for(size_t i=0;i<v.exhausts.size();++i){const auto& e=v.exhausts[i];if(i)out<<",";
    for(double x:e.position)if(!std::isfinite(x))throw std::invalid_argument("invalid nozzle position");
    double norm=0;for(double x:e.direction){if(!std::isfinite(x))throw std::invalid_argument("invalid nozzle direction");norm+=x*x;}
    if(std::abs(norm-1)>1e-3||!std::isfinite(e.length)||e.length<=0||!std::isfinite(e.width)||e.width<=0||!std::isfinite(e.level)||e.level<0||e.level>1)throw std::invalid_argument("invalid nozzle");
    out<<"{\"position\":["<<e.position[0]<<","<<e.position[1]<<","<<e.position[2]<<"],\"direction\":["<<e.direction[0]<<","<<e.direction[1]<<","<<e.direction[2]<<"],\"length\":"<<e.length<<",\"width\":"<<e.width<<",\"level\":"<<e.level<<"}";
  }out<<"]";
  if(!v.terrainId.empty())out<<",\"terrainId\":\""<<jsonString(v.terrainId)<<"\"";
  if(v.terrain){
    const auto& t=*v.terrain;
    if(t.size<3||t.size>33||t.size%2==0||t.heights.size()!=static_cast<size_t>(t.size*t.size)||t.id!=v.terrainId||t.bodyName!=v.bodyName||t.radius!=v.bodyRadius)throw std::invalid_argument("invalid terrain patch");
    for(double h:t.heights)if(!std::isfinite(h))throw std::invalid_argument("invalid terrain elevation");
    out<<",\"terrain\":{\"version\":1,\"id\":\""<<jsonString(t.id)<<"\",\"bodyName\":\""<<jsonString(t.bodyName)<<"\",\"radius\":"<<t.radius<<",\"longitude\":"<<t.longitude<<",\"latitude\":"<<t.latitude<<",\"spacing\":"<<t.spacing<<",\"size\":"<<t.size<<",\"elevationLevel\":"<<t.elevationLevel<<",\"heights\":[";
    for(size_t i=0;i<t.heights.size();++i){if(i)out<<",";out<<t.heights[i];}out<<"]}";
  }
  out<<"}";
}
inline std::string formatSample(const Sample& s) {
  if(s.run.empty()||s.run.size()>128||s.run.find_first_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")!=0||s.run.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")!=std::string::npos)
    throw std::invalid_argument("invalid run identifier");
  if((!s.removed&&s.step==0)||s.sequence==0||!std::isfinite(s.time)||!std::isfinite(s.dt)||s.dt<0)
    throw std::invalid_argument("invalid time/sequence");
  constexpr std::uint64_t safeMax=9007199254740991ULL;
  if(s.epoch>safeMax||s.step>safeMax||s.sequence>safeMax||s.capturedAtUnixMs>safeMax)throw std::invalid_argument("unsafe JS integer");
  if(s.removed){std::ostringstream out;out.imbue(std::locale::classic());out<<std::setprecision(17)
    <<"{\"version\":1,\"wireFormat\":2,\"type\":\"ENTITY_REMOVED\",\"source\":\"native\",\"runId\":\""<<s.run<<"\",\"epoch\":"<<s.epoch<<",\"step\":"<<s.step<<",\"sequence\":"<<s.sequence
    <<",\"capturedAtUnixMs\":"<<s.capturedAtUnixMs<<",\"simTime\":"<<s.time<<",\"simDt\":0,\"frameId\":\"metaverse-global-ecliptic\",\"entityId\":\""<<cleanName(s.entity)<<"\"}\n";return out.str();}
  for(const auto& v:{s.position,s.velocity,s.angularVelocity})for(double x:v)
    if(!std::isfinite(x))throw std::invalid_argument("non-finite physical state");
  const auto q=rotationQuaternion(s.rotation);
  std::ostringstream out;
  out.imbue(std::locale::classic());
  out<<std::setprecision(17);
  out<<"{\"version\":1,\"wireFormat\":2,\"type\":\"PHYSICS_SAMPLE\",\"source\":\"native\",\"runId\":\""<<s.run
     <<"\",\"epoch\":"<<s.epoch<<",\"step\":"<<s.step<<",\"sequence\":"<<s.sequence
     <<",\"capturedAtUnixMs\":"<<s.capturedAtUnixMs<<",\"simTime\":"<<s.time<<",\"simDt\":"<<s.dt
     <<",\"frameId\":\"metaverse-global-ecliptic\",\"entityId\":\""<<cleanName(s.entity)<<"\""
     <<",\"entityName\":\""<<jsonString(s.name)<<"\""
     <<",\"position\":["<<s.position[0]<<","<<s.position[1]<<","<<s.position[2]<<"]"
     <<",\"velocity\":["<<s.velocity[0]<<","<<s.velocity[1]<<","<<s.velocity[2]<<"]"
     <<",\"angularVelocity\":["<<s.angularVelocity[0]<<","<<s.angularVelocity[1]<<","<<s.angularVelocity[2]<<"]"
     <<",\"orientation\":["<<q[0]<<","<<q[1]<<","<<q[2]<<","<<q[3]<<"]"
     <<",\"contact\":"<<(s.contact?"true":"false");
  if(s.hasVisual)formatVisual(out,s.visual);
  out<<"}\n";
  return out.str();
}
} // namespace osgsim
