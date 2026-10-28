import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountLive2D} from '../src/live2d-bridge.js';

test('only the companion frame can announce readiness or trigger a greeting; disposal detaches it',()=>{
 const dom=new JSDOM('<section><button>Original fallback</button></section>',{url:'http://localhost/'});
 const previous={window:globalThis.window,document:globalThis.document};
 globalThis.window=dom.window;globalThis.document=dom.window.document;
 let greetings=0,subscriptions=0;
 try{
  const stage=document.querySelector('section'),fallback=stage.querySelector('button');
  const bridge=mountLive2D(stage,fallback,{state:{motion:true},subscribe(){subscriptions++;return()=>subscriptions--; }},name=>`http://localhost/art/${name}`,()=>greetings++);
  const frame=stage.querySelector('iframe'),source=frame.contentWindow;
  const emit=(type,origin='http://localhost',sender=source)=>window.dispatchEvent(new window.MessageEvent('message',{source:sender,origin,data:{channel:'pylon-viseran',type}}));
  emit('ready','https://unrelated.invalid');emit('ready','http://localhost',window);
  assert.equal(frame.classList.contains('ready'),false);assert.equal(fallback.style.visibility,'');
  emit('greet');assert.equal(greetings,0);
  emit('ready');assert.equal(frame.classList.contains('ready'),true);assert.equal(fallback.style.visibility,'hidden');
  emit('greet');assert.equal(greetings,1);
  emit('error');assert.equal(fallback.style.visibility,'');assert.equal(frame.tabIndex,-1);
  bridge.dispose();emit('ready');emit('greet');assert.equal(greetings,1);assert.equal(subscriptions,0);assert.equal(stage.querySelector('iframe'),null);
 }finally{dom.window.close();Object.assign(globalThis,previous);}
});

test('repeated explicit interactions restart once while store refreshes keep the same reaction',()=>{
 const dom=new JSDOM('<section><button>Fallback</button></section>',{url:'http://localhost/'});
 const previous={window:globalThis.window,document:globalThis.document};
 globalThis.window=dom.window;globalThis.document=dom.window.document;
 try{
  let refresh;const messages=[];
  const stage=document.querySelector('section'),bridge=mountLive2D(stage,stage.querySelector('button'),{state:{motion:true},subscribe(fn){refresh=fn;return()=>{};}},name=>`http://localhost/art/${name}`,()=>{});
  stage.querySelector('iframe').contentWindow.postMessage=message=>messages.push(message);
  bridge.setEmotion('greeting',true);refresh();bridge.setEmotion('greeting',true);refresh();bridge.setEmotion('focused');
  assert.deepEqual(messages.map(m=>m.reactionId),[1,1,2,2,2]);
  assert.deepEqual(messages.map(m=>m.emotion),['greeting','greeting','greeting','greeting','focused']);
  bridge.dispose();refresh();assert.equal(messages.length,5);
 }finally{dom.window.close();Object.assign(globalThis,previous);}
});
