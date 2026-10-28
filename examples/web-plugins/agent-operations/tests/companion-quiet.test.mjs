import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCompanion} from '../src/companion.js';

test('quiet mode updates an unchanged mood immediately and restores its copy',()=>{
  const dom=new JSDOM('<main></main>',{url:'https://pylon.test/'});
  const saved={window:globalThis.window,document:globalThis.document};
  globalThis.window=dom.window;globalThis.document=dom.window.document;
  const listeners=new Set();
  const store={state:{tasks:[],agents:[],motion:true,quiet:false},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const host=document.querySelector('main');
  const companion=mountCompanion(host,store,name=>`https://pylon.test/art/${name}`);
  try{
    const initial=host.querySelector('.manager-line').textContent;
    const mood=host.querySelector('.mood-label').textContent;
    store.state.quiet=true;for(const fn of listeners)fn();
    assert.equal(host.querySelector('.manager-line').textContent,'安静陪伴中');
    assert.equal(host.querySelector('.mood-label').textContent,mood);
    store.state.quiet=false;for(const fn of listeners)fn();
    assert.equal(host.querySelector('.manager-line').textContent,initial);
  }finally{companion.dispose();assert.equal(listeners.size,0);dom.window.close();Object.assign(globalThis,saved);}
});
