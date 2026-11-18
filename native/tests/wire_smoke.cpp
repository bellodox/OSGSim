// SPDX-License-Identifier: MIT
#include "OSGSimWire.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
int main(){
  osgsim::Sample s;
  s.run="native-smoke-1";s.entity="A\\\"B\n";s.epoch=0;s.step=1;s.sequence=1;
  s.time=1.0/3.0;s.dt=1.0/60.0;
  s.position={1e9+0.125,2,3};s.velocity={0,-1,0};s.angularVelocity={0,0,0};
  s.rotation={1,0,0,0,1,0,0,0,1};s.contact=true;
  const std::string line=osgsim::formatSample(s);
  assert(line.find("vessel-A_5c_22B_0a")!=std::string::npos);
  assert(osgsim::cleanName("A B")!=osgsim::cleanName("A_B"));
  assert(osgsim::cleanName("A B")!=osgsim::cleanName("A_20B"));
  assert(line.find("\"contact\":true")!=std::string::npos);
  assert(line.find("1000000000.125")!=std::string::npos);
  std::cout<<line;
  struct Comma final:std::numpunct<char>{char do_decimal_point()const override{return ',';}};
  const auto prior=std::locale();std::locale::global(std::locale(prior,new Comma));
  assert(osgsim::formatSample(s)==line);std::locale::global(prior);
  auto reject=[](const osgsim::Sample& v){bool failed=false;try{osgsim::formatSample(v);}catch(const std::invalid_argument&){failed=true;}assert(failed);};
  auto bad=s;bad.rotation={1,2,0,0,1,0,0,0,1};reject(bad);
  bad=s;bad.rotation={1,0,0,0,1,0,0,0,-1};reject(bad);
  bad=s;bad.entity=std::string(200,'a');reject(bad);
  bad=s;bad.sequence=9007199254740992ULL;reject(bad);
  s.position[0]=std::numeric_limits<double>::quiet_NaN();
  bool failed=false;try{osgsim::formatSample(s);}catch(const std::invalid_argument&){failed=true;}
  assert(failed);
}
