// SPDX-License-Identifier: MIT
// Shared numeric checks have no Node dependencies: usable by the browser slicer.
export function assert(condition,message){if(!condition)throw new Error(message);}
export function finite(value,field){assert(typeof value==='number'&&Number.isFinite(value),`invalid ${field}`);return value;}
export function vec3(value,field){assert(Array.isArray(value)&&value.length===3,`invalid ${field} dimensions`);return Array.from(value,(v,i)=>finite(v,`${field}[${i}]`));}
export function quat(value,field){assert(Array.isArray(value)&&value.length===4,`invalid ${field} dimensions`);const q=Array.from(value,(v,i)=>finite(v,`${field}[${i}]`));assert(Math.abs(Math.hypot(...q)-1)<1e-3,`invalid ${field} normalization`);return q;}
