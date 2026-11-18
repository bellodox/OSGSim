// SPDX-License-Identifier: MIT
#pragma once
// Portable, deterministic bridge wire serializer. No Windows or simulator SDK dependencies.
// Compiled independently on Linux and with MSVC on the Windows native acceptance machine.
#include <array>
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
};
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
inline std::string formatSample(const Sample& s) {
  if(s.run.empty()||s.run.size()>128||s.run.find_first_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")!=0||s.run.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")!=std::string::npos)
    throw std::invalid_argument("invalid run identifier");
  if(s.step==0||s.sequence==0||!std::isfinite(s.time)||!std::isfinite(s.dt)||s.dt<0)
    throw std::invalid_argument("invalid time/sequence");
  constexpr std::uint64_t safeMax=9007199254740991ULL;
  if(s.epoch>safeMax||s.step>safeMax||s.sequence>safeMax)throw std::invalid_argument("unsafe JS integer");
  for(const auto& v:{s.position,s.velocity,s.angularVelocity})for(double x:v)
    if(!std::isfinite(x))throw std::invalid_argument("non-finite physical state");
  const auto q=rotationQuaternion(s.rotation);
  std::ostringstream out;
  out.imbue(std::locale::classic());
  out<<std::setprecision(17);
  out<<"{\"version\":1,\"type\":\"PHYSICS_SAMPLE\",\"source\":\"native\",\"runId\":\""<<s.run
     <<"\",\"epoch\":"<<s.epoch<<",\"step\":"<<s.step<<",\"sequence\":"<<s.sequence
     <<",\"simTime\":"<<s.time<<",\"simDt\":"<<s.dt
     <<",\"frameId\":\"metaverse-global-ecliptic\",\"entityId\":\""<<cleanName(s.entity)<<"\""
     <<",\"position\":["<<s.position[0]<<","<<s.position[1]<<","<<s.position[2]<<"]"
     <<",\"velocity\":["<<s.velocity[0]<<","<<s.velocity[1]<<","<<s.velocity[2]<<"]"
     <<",\"angularVelocity\":["<<s.angularVelocity[0]<<","<<s.angularVelocity[1]<<","<<s.angularVelocity[2]<<"]"
     <<",\"orientation\":["<<q[0]<<","<<q[1]<<","<<q[2]<<","<<q[3]<<"]"
     <<",\"contact\":"<<(s.contact?"true":"false")<<"}\n";
  return out.str();
}
} // namespace osgsim
