// SPDX-License-Identifier: MIT
#include "OSGSimWire.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
int main(int argc,char** argv){
  osgsim::Sample s;
  s.run="native-smoke-1";s.entity="A\\\"B\n";s.epoch=0;s.step=1;s.sequence=1;
  s.capturedAtUnixMs=1763500000123ULL;
  s.time=1.0/3.0;s.dt=1.0/60.0;
  s.position={1e9+0.125,2,3};s.velocity={0,-1,0};s.angularVelocity={0,0,0};
  s.rotation={1,0,0,0,1,0,0,0,1};s.contact=true;
  if(argc>1&&std::string(argv[1])=="removed"){s.entity="17";s.removed=true;s.sequence=2;std::cout<<osgsim::formatSample(s);return 0;}
  if(argc>1&&std::string(argv[1])=="named"){s.entity="17";s.name="A B \"quoted\" \xE2\x82\xAC";std::cout<<osgsim::formatSample(s);return 0;}
  if(argc>1&&std::string(argv[1])=="visual"){
    s.hasVisual=true;s.visual.vesselClass="ShuttlePB";s.visual.bodyName="Moon";s.visual.bodyRadius=1737400;s.visual.sunPosition={1e11,0,0};
    auto patch=std::make_shared<osgsim::Terrain>();patch->id="terrain-1";patch->bodyName="Moon";patch->radius=1737400;patch->heights.resize(81,2.5);patch->elevationLevel=12;
    s.visual.exhausts.push_back({{0,0,-4.35},{0,0,-1},8,1,.5});s.visual.terrainId=patch->id;s.visual.terrain=patch;std::cout<<osgsim::formatSample(s);return 0;
  }
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
