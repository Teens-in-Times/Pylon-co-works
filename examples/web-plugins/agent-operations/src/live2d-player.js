import {CubismFramework} from '../vendor/live2d/Framework/live2dcubismframework';
import {CubismUserModel} from '../vendor/live2d/Framework/model/cubismusermodel';
import {CubismMatrix44} from '../vendor/live2d/Framework/math/cubismmatrix44';
import {mouthFormFor,easeMouth,headTiltFor,greetingTilt,browLiftFor,mouthOpenFor} from './companion-pose.js';
import {blinkOpenAt,advanceHeadSpring} from './companion-motion.js';

// Runs in a separate document: Cubism globals, WebGL state and event handlers
// belong to the companion frame, never to Pylon's application window.
const canvas=document.querySelector('canvas');
const hostOrigin=location.origin==='null'?'*':location.origin;
const send=(type,extra={})=>parent.postMessage({channel:'pylon-viseran',type,...extra},hostOrigin);
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let alive=true,visible=true,motion=true,quiet=false,emotion='idle',greetAt=-10000,frame=0;
let user,gl,raf,observer,ready=false,started=performance.now(),nextBlink=started+2400;
let blinkAt=-10000,look=0,targetLook=0,lastTime=started,mouthForm=0,headTilt=0,browL=0,browR=0;
let reactionAt=-10000,mouthOpen=0,lastReactionId=0;
const textures=[];
const identity=new CubismMatrix44();
const matrix=new Float32Array(16);
const ids=new Map();
const headSpring={x:0,v:0};

async function bytes(url){const response=await fetch(url);if(!response.ok)throw new Error(`Model asset ${response.status}`);return response.arrayBuffer();}
function resize(){
 const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
 const w=Math.max(1,Math.round(r.width*dpr)),h=Math.max(1,Math.round(r.height*dpr));
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;user?.setRenderTargetSize(w,h);}
}
function signalError(error){if(!alive)return;canvas.dataset.state='error';send('error',{message:'互动模型未能加载'});console.error('Viseran model:',error);dispose();}
function dispose(){
 if(!alive)return;alive=false;cancelAnimationFrame(raf);observer?.disconnect();
 window.removeEventListener('message',receive);window.removeEventListener('pagehide',dispose);
 if(gl){for(const texture of textures)gl.deleteTexture(texture);user?.release();CubismFramework.dispose();}
}
function receive(event){
 if(event.source!==parent||(hostOrigin!=='*'&&event.origin!==hostOrigin))return;
 const m=event.data;if(m?.channel!=='pylon-viseran'||m.type!=='state')return;
 if(typeof m.visible==='boolean')visible=m.visible;
 if(typeof m.motion==='boolean')motion=m.motion;
 if(typeof m.quiet==='boolean')quiet=m.quiet;
 if(typeof m.emotion==='string'&&m.emotion.length<32){
  const restart=Number.isSafeInteger(m.reactionId)&&m.reactionId>lastReactionId;
  if(restart)lastReactionId=m.reactionId;
  if(m.emotion!==emotion||restart)reactionAt=performance.now();
  if((m.emotion!==emotion||restart)&&m.emotion==='greeting')greetAt=reactionAt;
  emotion=m.emotion;
 }
}
window.addEventListener('message',receive);
window.addEventListener('pagehide',dispose,{once:true});
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();signalError(new Error('WebGL context lost'));});
canvas.addEventListener('pointermove',event=>{const r=canvas.getBoundingClientRect();targetLook=Math.max(-1,Math.min(1,(event.clientX-r.left)/r.width*2-1));});
canvas.addEventListener('pointerleave',()=>{targetLook=0;});
canvas.addEventListener('click',()=>{greetAt=performance.now();send('greet');});
canvas.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();greetAt=performance.now();send('greet');}});

async function main(){
 gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true});
 if(!gl)throw new Error('WebGL unavailable');
 CubismFramework.startUp();CubismFramework.initialize();
 const setting=JSON.parse(new TextDecoder().decode(await bytes('./viseran-original.model3.json')));
 user=new CubismUserModel();user.loadModel(await bytes(`./${setting.FileReferences.Moc}`),true);
 if(!user._model)throw new Error('Invalid Cubism model');
 resize();user.createRenderer(canvas.width,canvas.height);
 const renderer=user.getRenderer();renderer.startUp(gl);renderer.setIsPremultipliedAlpha(true);
 for(const [index,path] of setting.FileReferences.Textures.entries()){
  const response=await fetch(`./${path}`);if(!response.ok)throw new Error('Missing model texture');
  const bitmap=await createImageBitmap(await response.blob());if(!alive){bitmap.close();return;}
  const texture=gl.createTexture();textures.push(texture);gl.bindTexture(gl.TEXTURE_2D,texture);
  // ImageBitmap alpha is not affected by UNPACK_PREMULTIPLY_ALPHA_WEBGL.
  const upload=document.createElement('canvas');upload.width=bitmap.width;upload.height=bitmap.height;
  upload.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,1);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,upload);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  renderer.bindTexture(index,texture);
 }
 if(!alive)return;
 renderer.loadShaders('./shaders/');
 const model=user._model;model.update();
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(let i=0;i<model.getDrawableCount();i++){
  const p=model.getDrawableVertexPositions(i);
  for(let j=0;j<p.length;j+=2){minX=Math.min(minX,p[j]);maxX=Math.max(maxX,p[j]);minY=Math.min(minY,p[j+1]);maxY=Math.max(maxY,p[j+1]);}
 }
 const width=maxX-minX,height=maxY-minY,cx=(minX+maxX)/2,cy=(minY+maxY)/2;
 if(!(width>0&&height>0))throw new Error('Empty model geometry');
 for(const name of ['ParamEyeLOpen','ParamEyeROpen','ParamMouthForm','ParamMouthOpenY','ParamAngleZ','ParamBrowLY','ParamBrowRY'])ids.set(name,CubismFramework.getIdManager().getId(name));
 // The installed brow-stage model has no mouth interior yet. Enable playback
 // only for an export that actually includes the newly authored drawable.
 const hasMouthOpen=model.getDrawableIndex(CubismFramework.getIdManager().getId('MouthOpen'))>=0;
 observer=new ResizeObserver(resize);observer.observe(canvas);
 function draw(now){
  if(!alive)return;raf=requestAnimationFrame(draw);
  if(document.hidden||!visible){lastTime=now;return;}
  const dt=Math.min(.05,(now-lastTime)/1000);lastTime=now;
  const moving=motion&&!reduced.matches;
  if(now>=nextBlink){blinkAt=now;nextBlink=now+2700+Math.random()*3200;}
  const blink=moving?blinkOpenAt(now-blinkAt):1;
  let left=blink,right=blink;
  if(emotion==='sleepy')left=right=0;
  if(moving&&now-greetAt>=200)left=Math.min(left,blinkOpenAt(now-greetAt-200,250));
  const mouthTarget=mouthFormFor(emotion);
  mouthForm=moving?easeMouth(mouthForm,mouthTarget,dt):mouthTarget;
  const openingTarget=quiet?0:mouthOpenFor(emotion,now-Math.max(reactionAt,greetAt),moving);
  mouthOpen=moving?easeMouth(mouthOpen,openingTarget,dt):openingTarget;
  look+=((moving?targetLook:0)-look)*(1-Math.exp(-dt*6));
  const tiltTarget=Math.max(-24,Math.min(24,headTiltFor(emotion)+(moving?look*12+greetingTilt(now-greetAt):0)));
  headTilt=advanceHeadSpring(headSpring,tiltTarget,dt,moving);
  const [browLeftTarget,browRightTarget]=browLiftFor(emotion);
  browL=moving?easeMouth(browL,browLeftTarget,dt):browLeftTarget;
  browR=moving?easeMouth(browR,browRightTarget,dt):browRightTarget;
  model.loadParameters();
  model.setParameterValueById(ids.get('ParamEyeLOpen'),left);
  model.setParameterValueById(ids.get('ParamEyeROpen'),right);
  model.setParameterValueById(ids.get('ParamMouthForm'),mouthForm);
  if(hasMouthOpen)model.setParameterValueById(ids.get('ParamMouthOpenY'),mouthOpen);
  model.setParameterValueById(ids.get('ParamAngleZ'),headTilt);
  model.setParameterValueById(ids.get('ParamBrowLY'),browL);
  model.setParameterValueById(ids.get('ParamBrowRY'),browR);
  model.update();
  const breathing=moving?Math.sin(now/650)*.004:0;
  const scale=.91*Math.min(canvas.width/width,canvas.height/height);
  const sx=scale*2/canvas.width,sy=scale*2/canvas.height;
  matrix.fill(0);matrix[0]=sx;matrix[5]=sy*(1+breathing);
  matrix[10]=1;matrix[15]=1;matrix[12]=-cx*matrix[0]-cy*matrix[4];matrix[13]=-cx*matrix[1]-cy*matrix[5];
  identity.setMatrix(matrix);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.setMvpMatrix(identity);renderer.setRenderState(null,[0,0,canvas.width,canvas.height]);renderer.drawModel('./shaders/');
  if(!ready&&++frame%10===0){
   const pixels=new Uint8Array(4);gl.readPixels(canvas.width>>1,canvas.height>>1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   if(pixels[3]){ready=true;canvas.dataset.state='ready';send('ready');}
   else if(now-started>20000)signalError(new Error('Model did not render'));
  }
 }
 raf=requestAnimationFrame(now=>{started=now;draw(now);});
}
main().catch(signalError);
