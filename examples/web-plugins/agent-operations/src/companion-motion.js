// Temporal motion only; authored Cubism geometry remains the source of poses.
import runtime from '../vendor/anime25d/runtime.cjs';

const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const smooth=t=>t*t*(3-2*t);

// Quick closure, short full closure, slower opening. Explicit winks can hold
// longer without jumping between open/closed meshes at the start and end.
export function blinkOpenAt(elapsedMs,holdMs=24){
  if(!Number.isFinite(elapsedMs)||elapsedMs<0)return 1;
  holdMs=Number.isFinite(holdMs)?clamp(holdMs,0,600):24;
  if(elapsedMs<70)return 1-smooth(elapsedMs/70);
  if(elapsedMs<70+holdMs)return 0;
  if(elapsedMs<215+holdMs)return smooth((elapsedMs-70-holdMs)/145);
  return 1;
}

// State x is a Cubism AngleZ parameter, v is parameter units per second.
// Fixed substeps from Anime2.5DRig keep settling comparable across frame rates.
export function advanceHeadSpring(state,target,dt,moving=true){
  target=Number.isFinite(target)?clamp(target,-24,24):0;
  if(!moving){state.x=target;state.v=0;return target;}
  if(!Number.isFinite(state.x)||!Number.isFinite(state.v)){state.x=0;state.v=0;}
  if(Number.isFinite(dt)&&dt>0)runtime.spring(state,target,70,13,Math.min(dt,.05));
  state.x=clamp(state.x,-30,30);
  if((state.x===30&&state.v>0)||(state.x===-30&&state.v<0))state.v=0;
  return state.x;
}
