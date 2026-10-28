import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

test('manifest passes the real pinned host parser',async()=>{
 const compiled=await build({entryPoints:['../../../src/plugin-runtime/packageManifest.ts'],bundle:true,format:'esm',platform:'node',write:false});
 const module=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const manifest=JSON.parse(await readFile('pylon-plugin.json','utf8'));
 assert.equal(module.parsePylonPluginManifest(manifest).id,'community.agent-operations');
});
test('installable bundle activates, mounts in a shadow root, and fully disposes',async()=>{
 const dom=new JSDOM('<div id="mount"></div>',{url:'http://localhost/'});const previous={};
 for(const key of ['window','document','HTMLElement','FormData']){previous[key]=globalThis[key];globalThis[key]=dom.window[key];}
 const resources=[],surfaces=[],panels=[],profiles=[],commands=[],saved=new Map();
 const context={identity:{pluginId:'community.agent-operations'},scope:{add:r=>(resources.push(r),r),setInterval:()=>{}},storage:{getValue:k=>saved.get(k),setValue:(k,v)=>saved.set(k,v)},ui:{registerSurface:x=>surfaces.push(x)},contextPanel:{register:x=>panels.push(x)},presentation:{registerProfile:x=>profiles.push(x)},commands:{register:x=>commands.push(x)}};
 try{
  const {default:plugin}=await import('../dist/index.js');plugin.activate(context);
  assert.equal(surfaces.length,1);assert.equal(panels[0].surfaceId,surfaces[0].id);assert.equal(profiles.length,1);assert.equal(commands.length,7);
  const container=document.getElementById('mount'),dispose=surfaces[0].mount(container);const root=container.firstElementChild.shadowRoot;
  assert.ok(root.querySelector('.ops'));assert.equal(document.querySelector('.ops'),null);
  assert.match(root.textContent,/等待 Pylon 连接/);assert.equal(root.querySelectorAll('.task-row').length,0);
  commands.find(c=>c.id.endsWith('task.add')).execute({args:{title:'<img src=x onerror=alert(1)>',content:'safe'}});
  assert.equal(root.querySelectorAll('.task-text img').length,0);assert.match(root.querySelector('.task-text').textContent,/<img/);
  dispose();assert.equal(container.children.length,0);
  for(const resource of resources.reverse())await(typeof resource==='function'?resource():resource.dispose());
  assert.equal(saved.get('operations.v1').tasks.length,1);
 }finally{dom.window.close();for(const key of Object.keys(previous))globalThis[key]=previous[key];}
});
