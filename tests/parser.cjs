const {test}=require('node:test');const assert=require('node:assert/strict');const {parseRollout}=require('../parser.js');
const r=(ms,type,payload)=>({timestamp:new Date(1700000000000+ms).toISOString(),type,payload});const parse=rs=>parseRollout(rs.map(x=>JSON.stringify(x)).join('\n'));
test('pairs call IDs, marks overlap and keeps execution duration distinct',()=>{const s=parse([r(0,'response_item',{type:'function_call',name:'a',call_id:'a'}),r(10,'response_item',{type:'function_call',name:'b',call_id:'b'}),r(20,'event_msg',{type:'mcp_tool_call_end',call_id:'a',duration:{secs:0,nanos:1000000}}),r(30,'response_item',{type:'function_call_output',call_id:'a',output:'a'}),r(40,'response_item',{type:'function_call_output',call_id:'b',output:'b'})]);assert.equal(s.tools.length,2);assert.equal(s.tools[0].duration,30);assert.equal(s.tools[0].execution,1);assert.equal(s.tools[0].parallel,s.tools[1].parallel);});
test('keeps model items and client messages separate while accumulating usage',()=>{const usage=n=>({type:'token_count',info:{total_token_usage:{total_tokens:n}}});const s=parse([r(0,'response_item',{type:'message',role:'user',content:[{text:'hello'}]}),r(0,'event_msg',{type:'user_message',message:'hello'}),r(1,'event_msg',usage(100)),r(2,'event_msg',usage(100)),r(3,'event_msg',usage(150))]);assert.equal(s.projections.modelItems.length,1);assert.equal(s.projections.clientMessages.length,1);assert.equal(s.projections.runtimeEvents.length,4);assert.equal(s.total.total_tokens,150);assert.equal(s.usage.length,2);assert.equal(s.usage[1].delta.total_tokens,50);});
test('handles corrupted JSON, missing output and encrypted reasoning',()=>{const s=parseRollout('bad\n'+JSON.stringify(r(0,'response_item',{type:'function_call',call_id:'a'}))+'\n'+JSON.stringify(r(1,'response_item',{type:'reasoning',encrypted_content:'secret'})));assert.equal(s.warnings.length,1);assert.equal(s.tools[0].status,'未完成');assert.match(s.steps[1].body,/加密/);});

test('parallel groups use connected overlapping intervals and reject adjacent or incomplete intervals',()=>{
 const s=parse([
  r(0,'response_item',{type:'function_call',name:'a',call_id:'a'}),
  r(8,'response_item',{type:'function_call',name:'b',call_id:'b'}),
  r(20,'response_item',{type:'function_call',name:'c',call_id:'c'}),
  r(10,'response_item',{type:'function_call_output',call_id:'a',output:'a'}),
  r(25,'response_item',{type:'function_call_output',call_id:'b',output:'b'}),
  r(30,'response_item',{type:'function_call_output',call_id:'c',output:'c'}),
  r(30,'response_item',{type:'function_call',name:'d',call_id:'d'}),
  r(40,'response_item',{type:'function_call_output',call_id:'d',output:'d'}),
  r(35,'response_item',{type:'function_call',name:'incomplete',call_id:'incomplete'}),
 ]);
 assert.deepEqual(s.tools.slice(0,3).map(t=>t.parallel),[1,1,1]);
 assert.equal(s.tools[3].parallel,undefined);
 assert.equal(s.tools[4].parallel,undefined);
});

test('malformed record boundaries produce warnings instead of crashing',()=>{
 const s=parseRollout('[1]\n'+JSON.stringify({type:'event_msg',payload:{type:[]}})+'\n'+JSON.stringify({type:'response_item',payload:'bad'})+'\n'+JSON.stringify(r(0,'response_item',{type:'message',role:'assistant',content:[null,{text:'valid'}]})));
 assert.equal(s.warnings.length,3);assert.equal(s.steps[0].body,'valid');
});

test('orphan result never acquires an invented start after multiple result events',()=>{
 const s=parse([r(0,'event_msg',{type:'mcp_tool_call_end',call_id:'orphan',result:{Ok:'found'}}),r(5,'response_item',{type:'function_call_output',call_id:'orphan',output:'found'})]);
 assert.equal(s.tools[0].duration,null);assert.equal(s.tools[0].status,'缺少调用起点');assert.equal(s.tools[0].parallel,undefined);
});

test('model and client projections retain independent messages without text or turn suppression',()=>{
 const message={type:'message',role:'user',content:[{text:'read file'}]};
 const s=parse([
  r(0,'event_msg',{type:'task_started',turn_id:'one'}),
  r(1,'response_item',message),r(2,'event_msg',{type:'user_message',message:'read file'}),
  r(10,'event_msg',{type:'agent_reasoning',text:'client thought'}),r(20,'response_item',{type:'reasoning',summary:[{text:'model thought'}]}),
  r(21,'response_item',message),r(22,'event_msg',{type:'user_message',message:'read file'}),
  r(30,'event_msg',{type:'task_complete'}),r(31,'event_msg',{type:'task_started',turn_id:'two'}),
  r(32,'event_msg',{type:'user_message',message:'event only'}),
 ]);
 const items=key=>s.projections[key].map(id=>s.steps[id]);
 assert.deepEqual(items('modelItems').map(s=>s.body),['read file','model thought','read file']);
 assert.deepEqual(items('clientMessages').map(s=>s.body),['read file','client thought','read file','event only']);
 assert.equal(items('runtimeEvents').length,7);
 assert.equal(s.records.length,10);
 assert.deepEqual(s.relations,[]);
});

test('structured content phase and proven item identity survive independent projections',()=>{
 const content=[{type:'input_text',text:'look'},{type:'input_image',image_url:'https://private.invalid/image'}];
 const s=parse([
  r(0,'event_msg',{type:'task_started',turn_id:'one'}),
  r(10,'event_msg',{type:'agent_message',message:'UI notification',item_id:'answer'}),
  r(5000,'response_item',{type:'message',id:'answer',role:'assistant',content:[{text:'structured reply'}],phase:'final'}),
  r(6000,'response_item',{type:'message',role:'assistant',content:[{text:'structured reply'}]}),
  r(7000,'response_item',{type:'message',role:'user',content}),
 ]);
 const model=s.projections.modelItems.map(id=>s.steps[id]);
 assert.deepEqual(model.map(s=>s.body),['structured reply','structured reply','look']);
 assert.equal(model[0].channel,'final');
 assert.deepEqual(model[2].content,content);
 assert.equal(model[2].sourceRefs[0].line,5);
 assert.equal(s.relations.length,1);
 assert.equal(s.relations[0].evidence.itemId,'answer');
 assert.equal(s.steps[s.relations[0].to].title,'agent_message');
});

test('everything before the first task starts is a reminder without guessing from its text',()=>{
 const s=parse([
  r(0,'response_item',{type:'message',role:'user',content:[{text:'plain startup material'}]}),
  r(0,'event_msg',{type:'user_message',message:'startup notification'}),
  r(0,'response_item',{type:'reasoning',summary:[{text:'startup reasoning'}]}),
  r(0,'event_msg',{type:'task_started',turn_id:'task'}),
  r(0,'response_item',{type:'message',role:'user',content:[{text:'actual request'}]}),
 ]);
 assert.deepEqual(s.projections.contexts.map(id=>s.steps[id].title),['用户提示','用户提示','用户提示']);
 assert.deepEqual(s.projections.modelItems.map(id=>s.steps[id].body),['actual request']);
 assert.equal(s.projections.clientMessages.length,0);
 assert.equal(s.projections.runtimeEvents.length,2);
 assert.equal(s.steps[0].role,'user');
 assert.equal(s.records[0].payload.role,'user');
});
