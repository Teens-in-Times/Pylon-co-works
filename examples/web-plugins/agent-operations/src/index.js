import { createStore, text } from './model.js';
import { createAdapter } from './adapter.js';
import { mountOperations } from './ui.js';
export default {
  activate(context) {
    let saved;try{saved=context.storage.getValue('operations.v1');}catch{}
    const store=createStore({saved});const adapter=createAdapter(store);
    const asset=name=>new URL(`./art/${name}`,import.meta.url).href;
    context.scope.add(()=>adapter.dispose());
    const mounted=new Set();
    context.ui.registerSurface({id:'community.agent-operations.surface',runtime:{framework:'webcomponent',version:'1.0.0'},mount(container){const dispose=mountOperations(container,store,adapter,{asset,compact:true});mounted.add(dispose);return()=>{mounted.delete(dispose);dispose();};}});
    context.scope.add(()=>{for(const dispose of mounted)dispose();mounted.clear();});
    context.contextPanel.register({id:'community.agent-operations.panel',label:'团子调度局',icon:'workflow',scope:'global',placement:'right-dock',minWidth:380,defaultWidth:1080,maxWidth:1700,order:850,renderKind:'isolated-surface',surfaceId:'community.agent-operations.surface'});
    context.presentation.registerProfile({id:'community.agent-operations.tactical',label:'团子调度 · 苔绿作战',description:'低干扰作战风格：细边框、柔和绿焦点与明确状态。',family:'gui',order:910,tokens:{messageRadius:3,inputRadius:3,msgLineHeight:1.65,messageUserBg:'rgba(142,173,92,0.12)',messageAssistantBg:'rgba(20,30,33,0.92)',messageBorderColor:'rgba(119,150,135,0.3)',inputBg:'#142024',inputBorderColor:'#4a615c',inputFocusBorder:'#d4e99a',inputFocusRingWidth:2,assistantDotGlyph:'◆',toolIndicator:'◆',toolIndicatorGlow:0,spinnerFramePreset:'ascii-line',spinnerVerbSet:'engineering'},assets:{assistantGlyph:'◆',runningGlyph:'▶',completedGlyph:'✓',failedGlyph:'!'}});
    const commands=[
      ['snapshot','读取调度台任务与状态',()=>store.snapshot()],
      ['task.add','向队列添加任务',({args})=>store.addTask(args||{})],
      ['task.assign','派遣任务到现有会话',({args})=>adapter.dispatch(text(args?.taskId),text(args?.sessionId))],
      ['refresh','刷新真实会话状态',()=>adapter.poll()],
      ['status','读取当前会话、任务和连接状态',()=>({connected:store.state.connected,agents:store.state.agents.map(a=>({...a})),tasks:store.state.tasks.map(t=>({...t})),auto:store.state.auto})],
      ['task.cancel','请求宿主取消当前任务',({args})=>adapter.cancel(text(args?.taskId))],
      ['task.accept','验收已经结束的任务',({args})=>store.accept(text(args?.taskId))],
    ];
    for(const [name,description,execute] of commands)context.commands.register({id:`community.agent-operations.${name}`,name:`ops.${name}`,description,priority:100,execute});
    let persistTimer;const off=store.subscribe(()=>{clearTimeout(persistTimer);persistTimer=setTimeout(()=>{try{context.storage.setValue('operations.v1',store.snapshot());}catch(error){store.state.error=`任务记录保存失败：${error.message}`;}},500);});
    context.scope.add(()=>{off();clearTimeout(persistTimer);try{context.storage.setValue('operations.v1',store.snapshot());}catch{}});
    // Observation is active even when the surface is closed. No autoplay on reload.
    context.scope.setInterval(()=>{void adapter.poll();},4000);void adapter.poll();
  }
};
