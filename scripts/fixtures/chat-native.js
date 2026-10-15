// This fixture owns its simulated events. The production appearance code never does.
(() => {
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.nativeTheme = params.get('theme') || 'dark';
  const thread = document.getElementById('thread'), editor = document.getElementById('prompt-textarea');
  const send = document.querySelector('[data-testid="send-button"]'), stop = document.querySelector('[data-testid="stop-button"]');
  let sequence = 2, streamTimer = null;
  const finish = () => { clearInterval(streamTimer);streamTimer=null;send.hidden=false;stop.hidden=true; };
  function reply() {
    if (streamTimer) return;
    const turn=document.createElement('article');turn.dataset.testid='conversation-turn-'+sequence++;turn.dataset.messageId='assistant-'+sequence;
    const message=document.createElement('div');message.dataset.messageAuthorRole='assistant';turn.append(message);thread.append(turn);
    const text='这是逐字到达的模拟回复。切换实验外观时，正在生成的消息仍是同一个节点，草稿、附件和工具展开状态也由原页面保留。';
    let offset=0;send.hidden=true;stop.hidden=false;
    streamTimer=setInterval(()=>{message.textContent=text.slice(0,++offset);if(offset>=text.length)finish();},40);
  }
  document.getElementById('fixtureStream').onclick=reply;
  stop.onclick=finish;
  document.getElementById('nativeComposer').onsubmit=event=>{
    event.preventDefault();if(streamTimer||!editor.textContent.trim())return;
    const turn=document.createElement('article');turn.dataset.testid='conversation-turn-'+sequence++;turn.dataset.messageId='user-'+sequence;
    const message=document.createElement('div');message.dataset.messageAuthorRole='user';message.textContent=editor.textContent;turn.append(message);thread.append(turn);editor.textContent='';reply();
  };
  document.getElementById('fixtureFile').onchange=event=>{
    const label=document.getElementById('fixtureFileName');label.textContent=event.target.files[0]?.name||'';
    send.disabled=true;label.setAttribute('role','progressbar');
    setTimeout(()=>{send.disabled=false;label.removeAttribute('role');},400);
  };
  document.getElementById('fixtureDownload').onclick=()=>{
    const url=URL.createObjectURL(new Blob(['隔离测试附件：切换外观前后内容一致。'],{type:'text/plain;charset=utf-8'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download='验证说明.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  };
})();
