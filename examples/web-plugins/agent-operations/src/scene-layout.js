import { ROOMS } from './model.js';

// All dimensions are CSS pixels. Reserve space for labels, room headers and walkways.
export function sceneLayout(agents, availableWidth) {
  const width=Math.max(560,Number.isFinite(availableWidth)?availableWidth:560);
  const padding=24,gap=48,roomWidth=(width-padding*2-gap)/2;
  const columns=Math.max(1,Math.floor((roomWidth-24)/80));
  const groups=ROOMS.map(room=>agents.filter(a=>(ROOMS.some(r=>r.id===a.room)?a.room:'lounge')===room.id));
  const rows=Math.max(1,...groups.map(group=>Math.ceil(group.length/columns)));
  const roomHeight=84+rows*100,height=padding*2+gap+roomHeight*2;
  const positions=new Map();
  groups.forEach((group,index)=>{
    const col=index===1||index===2?1:0,row=index>=2?1:0;
    group.forEach((agent,slot)=>positions.set(agent.id,{
      x:padding+col*(roomWidth+gap)+roomWidth/2+((slot%columns)-(Math.min(columns,group.length)-1)/2)*80,
      y:padding+row*(roomHeight+gap)+110+Math.floor(slot/columns)*100,
    }));
  });
  return {width,height,positions,corridorY:height/2};
}
