// Verify the authored mesh, including independence and interpolated positions.
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
const samples=[];
for(const [angle,eye,mouth] of [[0,1,0],[-30,.5,1],[30,0,-1]]){
 set('ParamAngleZ',angle);set('ParamEyeLOpen',eye);set('ParamEyeROpen',eye);set('ParamMouthForm',mouth);
 for(const side of ['L','R']){
  set('ParamBrowLY',0);set('ParamBrowRY',0);model.update();
  const neutral=positions(),opacity=Array.from(d.opacities),index=d.ids.indexOf('Brow'+side);assert.ok(index>=0);
  for(const value of [-1,-.5,.5,1,0]){
   set('ParamBrow'+side+'Y',value);model.update();const current=positions();
   assert.deepEqual(Array.from(d.opacities),opacity,'Brows preserve all opacities');
   for(let i=0;i<d.count;i++)if(i!==index)assert.deepEqual(current[i],neutral[i],`${side} brow must not move ${d.ids[i]}`);
   const dx=(current[index][0]-neutral[index][0])*1024,dy=(current[index][1]-neutral[index][1])*1024;
   let residual=0;
   for(let j=0;j<neutral[index].length;j+=2){
    const ex=(current[index][j]-neutral[index][j])*1024-dx,ey=(current[index][j+1]-neutral[index][j+1])*1024-dy;
    residual=Math.max(residual,Math.hypot(ex,ey));
   }
   assert.ok(residual<.001,'Brow must translate without distortion');
   if(value){
    assert.ok(Math.hypot(dx,dy)>Math.abs(value)*3&&Math.hypot(dx,dy)<Math.abs(value)*12,'Movement must be visible but restrained');
    assert.ok(Math.sign(dy)===Math.sign(value),'Positive key lifts brow');
   }else assert.deepEqual(current,neutral,'Neutral pose must restore exactly');
   samples.push({side,angle,eye,mouth,value,dx,dy,maxResidualPixels:residual});
  }
 }
}
await writeFile(path.join(root,'brow-validation.json'),JSON.stringify({checks:{independentBrows:true,otherGeometryFixed:true,opacityPreserved:true,neutralRestoresExactly:true},samples},null,2));
console.log('Brow motion passed: independent keys, restrained translation, unaffected eyes/mouth/head, exact neutral restore.');
model.release();moc._release();
