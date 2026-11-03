// Falsify adapter, AGPL-3.0-only. Algorithms below are unmodified PlotTracer.
import {runColorTrace} from './engine/colorTraceRun';
import {findLines} from './algorithms/findLines/lines';
import {Calibration} from './core/calibration';
import {XYAxes} from './core/axes/xy';

const UPSTREAM_COMMIT='dcc28a5da453ff5c4e7cadd4478523560d15c0dc';
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
function trace(binary:string,width:number,height:number,colorsJson:string,regionJson:string,maxPoints=480):string{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>12000000||binary.length!==width*height*4)throw Error('invalid-image');
  const colors=JSON.parse(colorsJson),region=JSON.parse(regionJson);
  if(!Array.isArray(colors)||colors.length>8||!region||![region.x,region.y,region.width,region.height].every(finite)||region.width<=0||region.height<=0)throw Error('invalid-trace-options');
  const rgba=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)rgba[i]=binary.charCodeAt(i);
  maxPoints=Math.max(3,Math.min(5000,Math.floor(maxPoints)));
  const box={x0:region.x,y0:region.y,x1:region.x+region.width,y1:region.y+region.height};
  const series=colors.map((c:any)=>{
    if(typeof c.id!=='string'||!Array.isArray(c.rgb)||c.rgb.length!==3||!c.rgb.every((n:unknown)=>finite(n)&&n>=0&&n<=255))throw Error('invalid-color');
    const traced=runColorTrace(rgba,width,height,c.rgb,31,'foreground',region,maxPoints);
    const lines=c.mode==='color'?{lines:[],places:[],unresolved:[]}:findLines(rgba,width,height,c.rgb,box,{contour:false});
    return {id:c.id,rgb:c.rgb,pixels:'points' in traced?traced.points.map(p=>[p.x,p.y]):[],
      lines:lines.lines,places:lines.places,unresolved:lines.unresolved};
  });
  return JSON.stringify({engine:'plottracer',revision:UPSTREAM_COMMIT,series});
}
function calibrate(calibrationJson:string,pixelsJson:string):string{
  const c=JSON.parse(calibrationJson),pixels=JSON.parse(pixelsJson);
  for(const name of ['x','y']){
    const a=c?.[name];
    if(!a||!['linear','log'].includes(a.scale)||!Array.isArray(a.points)||a.points.length!==2||
      !a.points.every((p:any)=>p&&finite(p.pixel)&&finite(p.value)&&(a.scale!=='log'||p.value>0))||
      a.points[0].pixel===a.points[1].pixel||a.points[0].value===a.points[1].value)throw Error('invalid-calibration');
  }
  if(!Array.isArray(pixels)||pixels.length>10000||!pixels.every(p=>Array.isArray(p)&&p.length===2&&p.every(finite)))throw Error('invalid-points');
  const cal=new Calibration();
  for(const p of c.x.points)cal.addPoint(p.pixel,0,p.value,0);
  for(const p of c.y.points)cal.addPoint(0,p.pixel,0,p.value);
  const axes=new XYAxes();
  if(!axes.calibrate(cal,c.x.scale==='log',c.y.scale==='log',true))throw Error('invalid-calibration');
  const points=pixels.map(p=>axes.pixelToData(p[0],p[1]));
  if(!points.every(p=>p.every(finite)))throw Error('value-out-of-range');
  return JSON.stringify({points});
}
Object.defineProperty(globalThis,'FalsifyPlotTracer',{value:Object.freeze({trace,calibrate,VERSION:'2.6.0',UPSTREAM_COMMIT}),configurable:false});
