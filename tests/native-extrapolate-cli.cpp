// SPDX-License-Identifier: MIT
// Test helper: reads "simMjd px py pz vx vy vz landed nowMjd" lines and prints the position the DLL would apply.
#include <cstdio>
#include "../native/spexgsp-rod/V26Wire.hpp"
int main(){
 double s,px,py,pz,vx,vy,vz,now;int landed;
 while(std::scanf("%lf %lf %lf %lf %lf %lf %lf %d %lf",&s,&px,&py,&pz,&vx,&vy,&vz,&landed,&now)==9){
  v26wire::Motion m;m.simMjd=s;m.p={px,py,pz};m.v={vx,vy,vz};m.landed=landed!=0;
  const auto o=v26wire::extrapolate(m,now);std::printf("%.17g %.17g %.17g\n",o[0],o[1],o[2]);
 }
 return 0;
}
