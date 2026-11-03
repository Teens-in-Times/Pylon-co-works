// Values target authored Cubism parameters. Unknown states keep the original
// neutral face rather than implying an expression that has not been rigged.
const mouthForms={idle:0,thinking:-.25,dispatch:0,happy:1,worried:-.7,
  sleepy:0,focused:0,proud:.75,surprised:-.45,encourage:.65,greeting:.8,error:-1};

export function mouthFormFor(emotion){return Object.hasOwn(mouthForms,emotion)?mouthForms[emotion]:0;}

// Authored ParamAngleZ -30..30 maps to a gentle -7..7 degree neck pivot.
const headTilts={idle:0,thinking:-10,dispatch:-3,happy:5,worried:-5,
  sleepy:9,focused:0,proud:-5,surprised:-8,encourage:9,greeting:10,error:-6};
export function headTiltFor(emotion){return Object.hasOwn(headTilts,emotion)?headTilts[emotion]:0;}

// Independent lifts make attentive/asymmetric expressions possible without
// shifting the eye position. Full authored travel is about 6.46 source pixels.
const browLifts={idle:[0,0],thinking:[.65,-.15],dispatch:[-.2,-.2],happy:[.45,.45],
  worried:[.25,.4],sleepy:[-.15,-.15],focused:[-.35,-.35],proud:[.35,-.1],
  surprised:[.8,.8],encourage:[.35,.25],greeting:[.55,.55],error:[-.5,-.5]};
export function browLiftFor(emotion){return Object.hasOwn(browLifts,emotion)?browLifts[emotion]:browLifts.idle;}

export function greetingTilt(elapsedMs){
  if(elapsedMs<0||elapsedMs>1800)return 0;
  const t=elapsedMs/1800;
  return Math.sin(t*Math.PI*2)*Math.sin(t*Math.PI)*8;
}

// Brief silent reaction, not audio lip-sync. Pulses start/end with a closed
// mouth and settle, so an attentive companion does not talk endlessly.
export function mouthOpenFor(emotion,elapsedMs,moving=true){
  if(!moving)return emotion==='surprised'?.35:0;
  if(!Number.isFinite(elapsedMs)||elapsedMs<0)return 0;
  if(emotion==='surprised'){
    const attack=Math.min(1,elapsedMs/180);
    return .65*attack*Math.max(0,1-Math.max(0,elapsedMs-500)/900);
  }
  const pulses=emotion==='greeting'?[[0,380,.55],[420,420,.7],[1000,500,.38]]
    :emotion==='encourage'?[[120,440,.38],[720,560,.5]]:[];
  return pulses.reduce((value,[start,duration,amount])=>{
    const t=(elapsedMs-start)/duration;
    return value+(t>0&&t<1?amount*Math.sin(Math.PI*t)**2:0);
  },0);
}

export function easeMouth(current,target,dt){
  const next=current+(target-current)*(1-Math.exp(-Math.max(0,dt)*14));
  return Math.abs(next-target)<.002?target:next;
}
