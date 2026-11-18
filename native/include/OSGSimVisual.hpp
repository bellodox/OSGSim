// SPDX-License-Identifier: MIT
#pragma once
#include <array>
#include <memory>
#include <vector>
#include <string>
namespace osgsim {
struct Terrain {
  std::string id,bodyName;
  double longitude=0,latitude=0,radius=1,spacing=24;
  int size=9,elevationLevel=0;
  std::vector<double> heights;
};
struct Exhaust {
  std::array<double,3> position{},direction{};
  double length=0,width=0,level=0;
};
struct Visual {
  std::string vesselClass,bodyName,terrainId;
  double bodyRadius=1,main=0,hover=0;
  std::array<double,3> bodyPosition{},sunPosition{},animations{.5,.5,.5};
  std::array<double,9> bodyRotation{1,0,0,0,1,0,0,0,1};
  std::shared_ptr<const Terrain> terrain;
  std::vector<Exhaust> exhausts;
};
} // namespace osgsim
