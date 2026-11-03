// Validate authored head geometry through the official Core, not the player.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.argv[2]||'art/live2d';
const sandbox=vm.createContext({console,TextDecoder,TextEncoder,WebAssembly,ArrayBuffer,Uint8Array,Float32Array,Int32Array,setTimeout,clearTimeout,atob});
vm.runInContext(await readFile('art/live2d/live2dcubismcore.min.js','utf8'),sandbox);
const b=await readFile(path.join(root,'viseran-original.moc3')),Core=sandbox.Live2DCubismCore;
const moc=Core.Moc.fromArrayBuffer(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));assert.ok(moc);
const model=Core.Model.fromMoc(moc),d=model.drawables,p=model.parameters;
function set(id,value){const i=p.ids.indexOf(id);assert.ok(i>=0,id);p.values[i]=value;}
function positions(){return d.vertexPositions.map(v=>Array.from(v));}
const body=d.ids.indexOf('Body'),head=d.ids.indexOf('Head');assert.ok(body>=0&&head>=0);
const samples=[];
for(const [eye,mouth] of [[1,0],[.5,1],[0,-1]]){
 set('ParamEyeLOpen',eye);set('ParamEyeROpen',eye);set('ParamMouthForm',mouth);set('ParamAngleZ',0);model.update();
 const neutral=positions(),opacity=Array.from(d.opacities);
 for(const value of [-30,-15,15,30,0]){
  set('ParamAngleZ',value);model.update();const current=positions();
  assert.deepEqual(current[body],neutral[body],'Head rotation must leave body geometry unchanged');
  assert.deepEqual(Array.from(d.opacities),opacity,'Rotation must preserve eye and mouth opacity states');
  let mx=0,my=0,nx=0,ny=0,n=0;
  for(let j=0;j<neutral[head].length;j+=2){mx+=neutral[head][j];my+=neutral[head][j+1];nx+=current[head][j];ny+=current[head][j+1];n++;}
  mx/=n;my/=n;nx/=n;ny/=n;
  let dot=0,cross=0;
  for(let j=0;j<neutral[head].length;j+=2){const x=neutral[head][j]-mx,y=neutral[head][j+1]-my,u=current[head][j]-nx,v=current[head][j+1]-ny;dot+=x*u+y*v;cross+=x*v-y*u;}
  const angle=Math.atan2(cross,dot),c=Math.cos(angle),s=Math.sin(angle),tx=nx-c*mx+s*my,ty=ny-s*mx-c*my;
  let maxResidual=0;
  for(let i=0;i<d.count;i++)if(i!==body)for(let j=0;j<neutral[i].length;j+=2){
   const x=neutral[i][j],y=neutral[i][j+1];
   const residual=Math.hypot(current[i][j]-(c*x-s*y+tx),current[i][j+1]-(s*x+c*y+ty));
   assert.ok(Number.isFinite(residual));maxResidual=Math.max(maxResidual,residual);
  }
  const degrees=angle*180/Math.PI;
  assert.ok(Math.abs(degrees+value*7/30)<.02,'Authored neck rotation must be -7..7 degrees with the correct direction');
  assert.ok(maxResidual<1e-6,'Every head and face component must share one rigid transform');
  if(value===0)assert.deepEqual(current,neutral,'Neutral geometry must restore exactly');
  samples.push({eye,mouth,value,degrees,maxResidualPixels:maxResidual*model.canvasinfo.PixelsPerUnit});
 }
}
await writeFile(path.join(root,'head-validation.json'),JSON.stringify({checks:{bodyStationary:true,faceMovesTogether:true,expressionsPreserved:true,neutralRestoresExactly:true},samples},null,2));
console.log('Head motion passed: ±7 degrees, all face layers aligned, body fixed, expressions preserved, exact neutral restore.');
model.release();moc._release();
