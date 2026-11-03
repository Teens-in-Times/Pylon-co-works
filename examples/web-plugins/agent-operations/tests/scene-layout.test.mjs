import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneLayout} from '../src/scene-layout.js';

test('crowded scenes retain every worker and separate their 64 by 84 pixel targets',()=>{
  for(const width of [280,560,800,1200])for(const count of [1,10,40]){
    const agents=Array.from({length:count},(_,i)=>({id:String(i),room:'lounge'}));
    const layout=sceneLayout(agents,width),points=[...layout.positions.values()];
    assert.equal(points.length,count);
    for(const [i,p] of points.entries()){
      assert.ok(p.x>=32&&p.x<=layout.width-32&&p.y>=42&&p.y<=layout.height-42);
      for(const q of points.slice(i+1))assert.ok(Math.abs(p.x-q.x)>=64||Math.abs(p.y-q.y)>=84);
    }
  }
});
test('each room has distinct targets and unknown rooms use standby',()=>{
  const layout=sceneLayout(['brief','build','review','lounge','missing'].map((room,i)=>({id:i,room})),800);
  assert.ok(layout.positions.get(0).x<layout.positions.get(1).x);
  assert.ok(layout.positions.get(0).y<layout.positions.get(3).y);
  assert.equal(layout.positions.get(3).y,layout.positions.get(4).y);
  assert.notEqual(layout.positions.get(3).x,layout.positions.get(4).x);
});
