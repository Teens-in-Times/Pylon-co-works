import {createStore,seedDemo} from './model.js';
import {createAdapter} from './adapter.js';
import {mountOperations} from './ui.js';
const store=createStore({demo:true});seedDemo(store);const adapter=createAdapter(store);
const unmount=mountOperations(document.getElementById('app'),store,adapter,{asset:name=>new URL(`./art/${name}`,import.meta.url).href});
// Demo transitions are deliberately labelled and never imported by the host entry.
const timer=setInterval(()=>{if(document.hidden)return;const t=store.state.tasks.find(t=>t.status==='running'&&Date.now()-t.updatedAt>18000);if(t)store.setTask(t,'review');if(store.state.auto)void adapter.schedule();},3000);
window.addEventListener('pagehide',()=>{clearInterval(timer);adapter.dispose();unmount();},{once:true});
