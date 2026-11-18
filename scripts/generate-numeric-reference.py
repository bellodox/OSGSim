#!/usr/bin/env python3
"""Optional reproducible SciPy/NumPy oracle; runtime and normal tests need only Node."""
import json
from pathlib import Path
import numpy as np
import scipy
from scipy.interpolate import CubicHermiteSpline
from scipy.spatial.transform import Rotation

rng=np.random.default_rng(20261118)
cases=[]
for _ in range(24):
    p=rng.normal(size=(2,3))*100
    v=rng.normal(size=(2,3))*10
    times=[float(rng.uniform(-10,10)),0]
    times[1]=times[0]+float(rng.uniform(.2,9))
    t=float(rng.uniform(*times))
    h=CubicHermiteSpline(times,p,v)
    rot=Rotation.random(random_state=rng)
    a=rng.normal(size=(4,4));cov=a@a.T+np.eye(4)*.2
    mean=rng.normal(size=4)
    gtime=float(mean[3]+.3)
    # Conditional Gaussian via block linear algebra, independent of JS implementation.
    gain=np.linalg.solve(cov[3:,3:],cov[3:,:3]).T
    center=mean[:3]+gain[:,0]*(gtime-mean[3])
    conditional=cov[:3,:3]-gain@cov[3:,:3]
    cases.append(dict(p0=p[0].tolist(),p1=p[1].tolist(),v0=v[0].tolist(),v1=v[1].tolist(),
        t0=times[0],t1=times[1],t=t,position=h(t).tolist(),velocity=h(t,1).tolist(),
        quaternion=rot.as_quat().tolist(),matrix=rot.as_matrix().tolist(),
        gaussian=dict(mean=mean.tolist(),cov=cov.tolist(),start=gtime-1,end=gtime+1),
        gaussianTime=gtime,center=center.tolist(),covariance=conditional.tolist()))
out=Path(__file__).resolve().parents[1]/'fixtures'/'numeric-reference.json'
out.write_text(json.dumps(dict(seed=20261118,numpy=np.__version__,scipy=scipy.__version__,cases=cases),indent=2)+'\n')
print(f'Generated {len(cases)} independent numerical reference cases: {out.name}')
