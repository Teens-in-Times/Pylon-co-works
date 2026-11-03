import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const sandbox=vm.createContext({console,TextDecoder,TextEncoder,WebAssembly,ArrayBuffer,Uint8Array,Float32Array,Int32Array,setTimeout,clearTimeout,atob});
try {vm.runInContext(await readFile('art/live2d/live2dcubismcore.min.js','utf8'),sandbox,{filename:'live2dcubismcore.min.js'});}catch(error){console.error(error.message);process.exit(1);}
const Core=sandbox.Live2DCubismCore;
const file=await readFile('art/live2d/viseran-original.moc3');
const buffer=file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength);
const moc=Core.Moc.fromArrayBuffer(buffer);assert.ok(moc,'Exported moc3 must load in official Core');
const model=Core.Model.fromMoc(moc);assert.ok(model);
const original=Array.from(model.parameters.values);
const eyeL=model.parameters.ids.indexOf('ParamEyeLOpen'),eyeR=model.parameters.ids.indexOf('ParamEyeROpen');
assert.ok(eyeL>=0&&eyeR>=0,'Both blink parameters must be exported');
const samples=[];
let neutralVertices;
for(const value of [1,.75,.5,.25,.1,0,1]){
 model.parameters.values[eyeL]=value;model.parameters.values[eyeR]=value;model.update();
 const opacity=Object.fromEntries(model.drawables.ids.map((name,i)=>[name,model.drawables.opacities[i]]));
 samples.push({value,opacity});
 const openOpacity=value>=.1?1:0;
 assert.ok(Math.abs(opacity.EyeL-openOpacity)<1e-5);assert.ok(Math.abs(opacity.EyeR-openOpacity)<1e-5);
 assert.ok(Math.abs(opacity.EyeLClosed-(1-openOpacity))<1e-5);assert.ok(Math.abs(opacity.EyeRClosed-(1-openOpacity))<1e-5);
 for(const positions of model.drawables.vertexPositions)assert.ok(positions.every(Number.isFinite),'Every deformed vertex must be finite');
 if(value===1){
  const positions=model.drawables.vertexPositions.map(x=>Array.from(x));
  if(neutralVertices)assert.deepEqual(positions,neutralVertices,'Opening again restores all original mesh positions');
  else neutralVertices=positions;
 }
}
model.parameters.values[eyeL]=0;model.parameters.values[eyeR]=1;model.update();
assert.equal(model.drawables.opacities[model.drawables.ids.indexOf('EyeL')],0);
assert.equal(model.drawables.opacities[model.drawables.ids.indexOf('EyeR')],1);
const mouthIndex=model.parameters.ids.indexOf('ParamMouthForm');
assert.ok(mouthIndex>=0,'Mouth expression parameter must be exported');
const mouthSamples=[];
for(const value of [-1,-.7,0,.65,1,0]){
 model.parameters.values[mouthIndex]=value;model.update();
 const opacity=Object.fromEntries(model.drawables.ids.map((name,i)=>[name,model.drawables.opacities[i]]));
 assert.ok(Math.abs(opacity.Mouth-(1-Math.abs(value)))<1e-5);
 assert.ok(Math.abs(opacity.MouthSmile-Math.max(0,value))<1e-5);
 assert.ok(Math.abs(opacity.MouthFrown-Math.max(0,-value))<1e-5);
 for(const name of ['MouthSmile','MouthFrown']){
  const i=model.drawables.ids.indexOf(name);assert.ok(i>=0);
  assert.ok(model.drawables.vertexCounts[i]>=4&&model.drawables.indexCounts[i]>=6,'Mouth must have triangulated geometry');
  assert.ok(model.drawables.vertexUvs[i].every(x=>Number.isFinite(x)&&x>=0&&x<=1));
 }
 assert.equal(opacity.EyeL,0);assert.equal(opacity.EyeR,1,'Mouth must not modify the independent blink');
 mouthSamples.push({value,neutral:opacity.Mouth,smile:opacity.MouthSmile,frown:opacity.MouthFrown});
}
const report={format:'Cubism 5.3 moc3',drawables:model.drawables.ids,samples,mouthSamples,checks:{finiteGeometry:true,independentEyes:true,exactNeutralRestore:true,opaqueIntermediateEyes:true,independentMouth:true,triangulatedMouth:true},status:'Original-pixel blink and mouth expressions working; neck tilt verified separately by check-head-motion.mjs; intermediate blink polish, head X/Y, hair, body and clothing rigging incomplete'};
await writeFile('art/live2d/model-validation.json',JSON.stringify(report,null,2));
console.log('Cubism Core validation passed: independent eyes and mouth, triangulated geometry, exact neutral restore.');
model.parameters.values.set(original);model.release();moc._release();
