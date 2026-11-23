import { EMA_DEFS, calculateEmaFrom } from "./ema-engine.js?v=v9-local-kline-20261123-1";
export { EMA_DEFS, calculateEmaFrom };
export function calculateEma(candles,period){if(!Number.isInteger(period)||period<1)throw new RangeError("EMA period must be a positive integer");return calculateEmaFrom(candles,period,null,0)}
export function calculateVegasEma(candles){return new Map(EMA_DEFS.map(d=>[d.period,calculateEma(candles,d.period)]))}
export function createVegasEmaOverlay({canvas,view=null}={}){
 if(!(canvas instanceof HTMLCanvasElement))throw new TypeError("A canvas element is required");
 const ctx=canvas.getContext("2d",{alpha:true});let candles=[],emas=new Map(),W=0,H=0,dpr=1,currentView=view,raf=0,destroyed=false;
 function ask(){if(!destroyed&&!raf)raf=requestAnimationFrame(draw)}
 function resize(){if(destroyed)return;dpr=Math.min(window.devicePixelRatio||1,2);const r=canvas.getBoundingClientRect();W=r.width;H=r.height;canvas.width=Math.max(1,Math.round(W*dpr));canvas.height=Math.max(1,Math.round(H*dpr));ask()}
 function getVisibleRange(start,end){
  let min=Infinity,max=-Infinity;
  for(const def of EMA_DEFS){const values=emas.get(def.period);if(!values)continue;const a=Math.max(0,start),b=Math.min(values.length-1,end);for(let i=a;i<=b;i++){const value=values[i];if(Number.isFinite(value)&&value>0){if(value<min)min=value;if(value>max)max=value;}}}
  return min===Infinity?null:{min,max};
 }
 function draw(){
  raf=0;if(destroyed)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  const v=currentView;if(!candles.length||!v||!W||!H||!(v.barW>0)||!(v.hi>v.lo)||v.lo<=0)return;
  const{barW,right,lo,hi}=v,rightGap=Number.isFinite(v.rightGap)?v.rightGap:0,xOf=i=>v.W-rightGap-(right-i+.5)*barW,yOf=p=>v.T0+(Math.log(hi)-Math.log(p))/(Math.log(hi)-Math.log(lo))*(v.H-v.T0-v.B),iAt=x=>right+.5-(v.W-rightGap-x)/barW,i0=Math.max(0,Math.floor(iAt(0))),i1=Math.min(candles.length-1,Math.ceil(iAt(v.W)));
  for(const def of EMA_DEFS){const values=emas.get(def.period);if(!values)continue;ctx.beginPath();let started=false;for(let i=i0;i<=i1;i++){const value=values[i];if(!Number.isFinite(value)){started=false;continue}const x=xOf(i),y=yOf(value);if(!started){ctx.moveTo(x,y);started=true}else ctx.lineTo(x,y)}if(started){ctx.strokeStyle=def.color;ctx.lineWidth=def.width;ctx.lineJoin="round";ctx.lineCap="round";ctx.stroke()}}
 }
 function setCandles(next,precomputed=null){const incoming=Array.isArray(next)?next:[];let prefix=0,limit=Math.min(candles.length,incoming.length);while(prefix<limit&&candles[prefix].t===incoming[prefix].t&&candles[prefix].c===incoming[prefix].c)prefix++;if(prefix===candles.length&&prefix===incoming.length&&!precomputed)return;const nextEmas=new Map();for(const def of EMA_DEFS){const source=precomputed?.[String(def.period)]??precomputed?.[def.period];if(Array.isArray(source)&&source.length===incoming.length){const out=new Float64Array(incoming.length);out.fill(NaN);for(let i=0;i<source.length;i++){const value=source[i];if(Number.isFinite(value)&&value>0)out[i]=value}nextEmas.set(def.period,out)}else nextEmas.set(def.period,calculateEmaFrom(incoming,def.period,emas.get(def.period),prefix))}candles=incoming;emas=nextEmas;ask()}
 function setEmaValues(source){
  const next=new Map();
  for(const def of EMA_DEFS){
   const values=source?.[String(def.period)]??source?.[def.period];
   const local=emas.get(def.period),out=new Float64Array(candles.length);
   if(local?.length===candles.length)out.set(local);else out.fill(NaN);
   if(Array.isArray(values)&&values.length===candles.length)for(let i=0;i<values.length;i++){const value=values[i];if(value!==null&&Number.isFinite(value)&&value>0)out[i]=value}
   next.set(def.period,out);
  }
  emas=next;ask();
 }
 function renderNow(){if(destroyed)return;if(raf){cancelAnimationFrame(raf);raf=0}draw()}
 function setView(next){if(!next||![next.barW,next.right,next.lo,next.hi,next.W,next.H,next.T0,next.B].every(Number.isFinite))return;currentView=next;ask()}
 const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
 function destroy(){if(destroyed)return;destroyed=true;observer.disconnect();if(raf)cancelAnimationFrame(raf);ctx.clearRect(0,0,canvas.width,canvas.height);candles=[];emas.clear();currentView=null}
 return Object.freeze({setCandles,setEmaValues,setView,getVisibleRange,renderNow,destroy})
}