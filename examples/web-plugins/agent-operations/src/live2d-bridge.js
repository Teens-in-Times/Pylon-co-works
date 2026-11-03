export function mountLive2D(stage,fallback,store,asset,onGreet){
 const frame=document.createElement('iframe');
 frame.className='manager-character live2d-frame';frame.title='维瑟兰 · 眨眼互动模型';
 frame.loading='lazy';frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');
 frame.src=asset('live2d/player.html');stage.append(frame);
 const origin=new URL(frame.src).origin,target=origin==='null'?'*':origin;
 let ready=false,visible=true,emotion='idle',disposed=false,reactionId=0;
 const send=()=>{if(!disposed)frame.contentWindow?.postMessage({channel:'pylon-viseran',type:'state',emotion,reactionId,motion:store.state.motion,quiet:store.state.quiet===true,visible},target);};
 const showFallback=()=>{ready=false;frame.classList.remove('ready');frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');fallback.style.visibility='';fallback.removeAttribute('aria-hidden');fallback.tabIndex=0;};
 const receive=e=>{
  if(disposed||e.source!==frame.contentWindow||(target!=='*'&&e.origin!==origin)||e.data?.channel!=='pylon-viseran')return;
  if(e.data.type==='ready'){
   ready=true;frame.classList.add('ready');frame.tabIndex=0;frame.removeAttribute('aria-hidden');fallback.style.visibility='hidden';fallback.setAttribute('aria-hidden','true');fallback.tabIndex=-1;send();
  }else if(e.data.type==='greet'&&ready)onGreet();
  else if(e.data.type==='error')showFallback();
 };
 window.addEventListener('message',receive);frame.addEventListener('load',send);
 const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);send();}):null;
 observer?.observe(frame);const off=store.subscribe(send);
 return {setEmotion(value,restart=false){emotion=value;if(restart)reactionId++;send();},dispose(){disposed=true;off();observer?.disconnect();window.removeEventListener('message',receive);frame.removeEventListener('load',send);frame.remove();}};
}
