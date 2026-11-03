// Acceptance for a real Cubism export; never synthesize or modify the moc3.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.argv[2]||'art/live2d';
const context=vm.createContext({console,TextDecoder,TextEncoder,WebAssembly,ArrayBuffer,Uint8Array,Float32Array,Int32Array,setTimeout,clearTimeout,atob});
vm.runInContext(await readFile('art/live2d/live2dcubismcore.min.js','utf8'),context);
const bytes=await readFile(path.join(root,'viseran-original.moc3')),Core=context.Live2DCubismCore;
const moc=Core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert.ok(moc,'Official Core must load the model');
const model=Core.Model.fromMoc(moc),d=model.drawables,p=model.parameters,samples=[];
try{
  const opening=d.ids.indexOf('MouthOpen');
  assert.ok(opening>=0,'MouthOpen drawable is absent: mouth-opening binding/export is not complete');
  const closed=['Mouth','MouthSmile','MouthFrown'].map(id=>{const i=d.ids.indexOf(id);assert.ok(i>=0,id);return i;});
  const set=(id,value)=>{const i=p.ids.indexOf(id);assert.ok(i>=0,id);p.values[i]=value;};
  const snapshot=()=>({positions:d.vertexPositions.map(v=>Array.from(v)),opacity:Array.from(d.opacities)});
  for(const [angle,eye,brow] of [[0,1,0],[-30,.5,1],[30,0,-1]])for(const form of [-1,0,1]){
    set('ParamAngleZ',angle);set('ParamEyeLOpen',eye);set('ParamEyeROpen',eye);
    set('ParamBrowLY',brow);set('ParamBrowRY',-brow);set('ParamMouthForm',form);
    set('ParamMouthOpenY',0);model.update();const neutral=snapshot();
    assert.equal(d.opacities[opening],0,'Neutral must hide mouth interior');
    const heights=[];
    // Rotation-independent extent along the transformed mouth vertical axis.
    const radians=-angle/30*7*Math.PI/180;
    for(const value of [0,.1,.25,.5,.75,1]){
      set('ParamMouthOpenY',value);model.update();const current=snapshot();
      for(let i=0;i<d.count;i++){
        assert.ok(current.positions[i].every(Number.isFinite),'Finite mesh coordinates');
        if(i!==opening&&!closed.includes(i)){
          assert.deepEqual(current.positions[i],neutral.positions[i],`Opening must not move ${d.ids[i]}`);
          assert.equal(current.opacity[i],neutral.opacity[i],`Opening must not fade ${d.ids[i]}`);
        }
      }
      const projected=[];
      for(let i=0;i<current.positions[opening].length;i+=2){
        const x=current.positions[opening][i],y=current.positions[opening][i+1];
        projected.push(-x*Math.sin(radians)+y*Math.cos(radians));
      }
      const height=(Math.max(...projected)-Math.min(...projected))*model.canvasinfo.PixelsPerUnit;
      if(heights.length)assert.ok(height>=heights.at(-1)-.001,'Opening height must increase continuously');
      heights.push(height);
      if(value===1){
        assert.ok(d.opacities[opening]>.99,'Full-open interior must be opaque');
        for(const i of closed)assert.equal(d.opacities[i],0,`${d.ids[i]} must disappear at full opening`);
      }
      samples.push({angle,eye,brow,form,value,height,interiorOpacity:d.opacities[opening],closedOpacity:closed.map(i=>d.opacities[i])});
    }
    assert.ok(heights.at(-1)>heights[0]+3,'Opening must deform the mesh, not only fade an image');
    set('ParamMouthOpenY',0);model.update();assert.deepEqual(snapshot(),neutral,'Closing restores exact default');
  }
  set('ParamAngleZ',0);set('ParamMouthOpenY',1);
  const widths=[];
  for(const form of [-1,0,1]){
    set('ParamMouthForm',form);model.update();
    const xs=Array.from(d.vertexPositions[opening]).filter((_,i)=>i%2===0);
    widths.push((Math.max(...xs)-Math.min(...xs))*model.canvasinfo.PixelsPerUnit);
  }
  assert.ok(widths[0]<widths[1]-1&&widths[1]<widths[2]-1,'Worried, neutral and happy openings must have distinct increasing widths');
  await writeFile(path.join(root,'mouth-opening-validation.json'),JSON.stringify({checks:{actualCoreExport:true,openingDeforms:true,neutralRestores:true,otherFacePartsFixed:true,closedMouthHiddenWhenOpen:true,expressionWidths:true},widths,samples},null,2));
  console.log('Mouth opening: actual geometry, closed/open visibility, compound poses and exact restoration passed.');
}finally{model.release();moc._release();}
