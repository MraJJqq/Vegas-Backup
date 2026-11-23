import { V9_CONFIG } from "./config.js";
const DEFINITIONS=globalThis.V9_INSTRUMENT_CATALOG;
if(!Array.isArray(DEFINITIONS)||DEFINITIONS.length!==22)throw new Error("V9 instrument catalog unavailable");
export const INSTRUMENTS=Object.freeze(DEFINITIONS.map((item,index)=>Object.freeze({...item,index})));
export const GATE_CONTRACTS=Object.freeze(Object.fromEntries(INSTRUMENTS.map(item=>[item.symbol,item.contract.replace(/USDT$/,"_USDT")])));
export const INSTRUMENT_BY_CONTRACT=new Map(INSTRUMENTS.map(item=>[item.contract,item]));
export const INSTRUMENT_BY_SYMBOL=new Map(INSTRUMENTS.map(item=>[item.symbol,item]));
if(INSTRUMENTS.length!==V9_CONFIG.app.instrumentCount)throw new Error("V9 instrument universe size mismatch");
export function createSessionQueue(random=Math.random){const queue=[...INSTRUMENTS];for(let index=queue.length-1;index>0;index--){const swapIndex=Math.floor(random()*(index+1));[queue[index],queue[swapIndex]]=[queue[swapIndex],queue[index]];}return Object.freeze(queue);}
