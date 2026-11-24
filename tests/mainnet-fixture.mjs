// SPDX-License-Identifier: MIT
export const mainnetInfo=(blocks=250000)=>({chain:'main',blocks,headers:blocks,initialblockdownload:false,verificationprogress:0.999999,mediantime:Math.floor(Date.now()/1000)-60,bestblockhash:'a'.repeat(64)});
export const mainnetNetwork=()=>({networkactive:true,connections:8});
