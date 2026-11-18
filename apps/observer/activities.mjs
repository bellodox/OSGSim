// SPDX-License-Identifier: MIT
// Participant tokens remain only in page memory; shared content is always textContent.
export function mountActivities(parent){
  const element=(tag,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
  const panel=element('section');panel.className='side-panel';panel.hidden=true;
  const title=element('h3','SHARED OSG ACTIVITIES'),context=element('p'),list=element('div'),message=element('p');message.setAttribute('aria-live','polite');
  const details=element('details'),summary=element('summary','Contribute an observation');details.append(summary);
  const token=element('input');token.type='password';token.placeholder='Configured participant token';token.autocomplete='off';token.setAttribute('aria-label','Participant token');
  const text=element('textarea');text.placeholder='What are you investigating or observing?';text.maxLength=8192;text.setAttribute('aria-label','Shared observation');
  const buttons=['Start','Update','Finish'].map(label=>{const button=element('button',label);button.type='button';return button;});
  const fresh=element('button','New activity in current run'),review=element('button','Refresh my activity'),more=element('button','Load more activities'),reload=element('button','Refresh list');
  for(const button of [fresh,review,more,reload])button.type='button';
  details.append(token,text,...buttons,review,fresh);panel.append(title,context,list,more,reload,details,message);parent.append(panel);
  const sessionId=crypto.randomUUID();let activityId=crypto.randomUUID(),version=null,stream=null,latest=null,pending=null,busy=false,finished=false,conflicted=false,last=0,reading=false;
  let cursor=null,listHead=null,paging=false;
  const scope=()=>stream?`simulation/${stream.runId}/${stream.epoch}`:null;
  function controls(){buttons.forEach((b,i)=>{b.disabled=busy||!stream||finished||conflicted||(i===0?version!==null:version===null);});
    token.disabled=busy||version!==null||pending!==null;fresh.disabled=busy||!latest||pending!==null;review.disabled=busy||(!version&&!conflicted)||pending!==null;
    more.disabled=reading||!cursor;context.textContent=stream?`Activity and list context: ${stream.runId} / epoch ${stream.epoch}`:'Waiting for a committed run';}
  async function readList(append=false){
    if(!scope())return;const query=new URLSearchParams({contextId:scope(),limit:'64'});
    if(append&&cursor){query.set('after',cursor);query.set('head',listHead);}
    const response=await fetch('/api/world/activities?'+query),data=await response.json();if(!response.ok)throw Error(data.error??'Activity history unavailable');
    if(!append)list.replaceChildren();
    for(const item of data.items??[]){const row=element('p',`${item.actor} · ${item.state}: ${item.text}`);list.append(row);}
    if(!append&&!data.items?.length)list.textContent='No shared activities yet.';
    cursor=data.nextAfter??null;listHead=data.head;more.textContent=cursor?'Load more activities (pinned history)':'All activities shown';
  }
  buttons.forEach((button,i)=>button.addEventListener('click',async()=>{
    if(busy||!stream||conflicted||finished)return;busy=true;controls();
    pending??={sessionId,requestId:crypto.randomUUID(),activityId,action:['start','note','finish'][i],text:text.value,expectedVersion:version,runId:stream.runId,epoch:stream.epoch};
    try{
      const response=await fetch('/api/world/activities',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token.value},body:JSON.stringify(pending)});
      const result=await response.json();
      if(!response.ok){if(response.status===409)conflicted=true;if(response.status<500)pending=null;throw Error(result.error??'Activity rejected');}
      version=result.version;finished=pending.action==='finish';pending=null;
      message.textContent=finished?'Activity finished and stored in OSG.':'Activity stored in OSG.';
      paging=false;await readList();
    }catch(error){message.textContent=error.message+(pending?' — retry to resolve this same request.':conflicted?' — refresh and review before reapplying.':'');}
    finally{busy=false;controls();}
  }));
  review.addEventListener('click',async()=>{if(busy||!stream||pending)return;busy=true;controls();try{
    const response=await fetch('/api/world/activities',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token.value},body:JSON.stringify({action:'get',runId:stream.runId,epoch:stream.epoch,activityId})});
    const data=await response.json();if(!response.ok)throw Error(data.error??'Refresh failed');const item=data.items?.[0];if(!item)throw Error('Activity not found for this participant');
    version=item.version;finished=item.state==='finished';conflicted=false;message.textContent=`Current shared text: ${item.text}. Review your draft before reapplying.`;await readList();
  }catch(error){message.textContent=error.message;}finally{busy=false;controls();}});
  fresh.addEventListener('click',async()=>{if(busy||pending||!latest)return;activityId=crypto.randomUUID();version=null;finished=false;conflicted=false;stream={...latest};paging=false;message.textContent='New activity selected; existing history is retained.';try{await readList();}catch(error){message.textContent=error.message;}controls();});
  more.addEventListener('click',async()=>{if(reading||!cursor)return;reading=true;paging=true;controls();try{await readList(true);}catch(error){message.textContent=error.message;}finally{reading=false;controls();}});
  reload.addEventListener('click',async()=>{if(reading)return;reading=true;paging=false;controls();try{await readList();}catch(error){message.textContent=error.message;}finally{reading=false;controls();}});
  controls();
  return async function poll(info){panel.hidden=!info.osgWorldMode;if(panel.hidden||reading||Date.now()-last<1000)return;reading=true;last=Date.now();
    try{const response=await fetch('/api/world/history');if(!response.ok)throw Error('Run history unavailable');const history=await response.json();
      latest=history.streams?.slice().sort((a,b)=>b.generation-a.generation)[0]??null;
      if(!version&&!pending)stream=latest?{...latest}:null;
      if(!paging)await readList();
    }catch(error){message.textContent=error.message;}finally{reading=false;controls();}};
}
