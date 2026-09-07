/**
 * The landing page, served at GET /.
 *
 * Left: a phone showing a text thread that plays the real onboarding flow on a
 * loop — START, welcome, CONNECT, the link, a price question, then a trade with
 * a PIN. Right (desktop): how it works + safety. The CTA is the compose bar;
 * Send opens the phone's SMS app with START pre-typed. No images, no framework.
 */

const BINATEXT_NUMBER = "+2347033301963";
const NUMBER_DISPLAY = "+234 703 330 1963";
const REPO_URL = "https://github.com/ibnweb3/binatext";
const CONNECT_HOST = "binatext.ibnweb3lab.workers.dev";

export function landingPage(): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>path{fill:#e8a317}@media(prefers-color-scheme:light){path{fill:#111}}</style><path d="M5 4h22a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H13l-7 5v-5a3 3 0 0 1-3-3V7a3 3 0 0 1 2-3Z"/></svg>`,
  );

// The simulated thread — the same copy BinaText actually sends over SMS.
// `think` = typing-indicator time before a reply; `after` = pause before the next line.
const SCRIPT = [
  { who: "you", t: "START", after: 1300 },
  {
    who: "bina",
    think: 1700,
    after: 2100,
    t: "Welcome to BinaText! Trade your Binance sub-account by SMS - any phone, no app. Reply CONNECT to link your account. You authorise on Binance's own web page; we never see your keys and cannot withdraw.",
  },
  { who: "you", t: "CONNECT", after: 1300 },
  {
    who: "bina",
    think: 1700,
    after: 1800,
    t: `Open this to connect Binance:\n${CONNECT_HOST}/connect\nPick Read-only - try it with no deposit.`,
  },
  { who: "sys", t: "Authorised on Binance · Read-only", after: 1400 },
  { who: "bina", think: 1100, after: 2000, t: "Connected. Text me anything - “how am I positioned?”, “put $5 into BNB”." },
  { who: "you", t: "what is BTC doing?", after: 1200 },
  { who: "bina", think: 1400, after: 2400, tnum: true, t: "BTC $61,240, +1.8% over 24h. Range 60,100-61,900." },
  { who: "you", t: "put $5 into BNB", after: 1200 },
  { who: "bina", think: 1700, after: 2000, t: "Order: BUY ~$5.00 of BNB @ ~$612 (MARKET).\nReply YES 4821 to confirm. Expires in 5 min." },
  { who: "you", t: "YES 4821", after: 1300 },
  { who: "bina", think: 1500, after: 0, tnum: true, t: "Filled. BUY 0.00817 BNB for ~$5.00 (avg $611.9). Order 448210327." },
];

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="description" content="Trade your Binance account by text message. No app, any phone. Text START to ${NUMBER_DISPLAY}.">
<meta name="theme-color" content="#0a0a0b">
<title>BinaText — trade Binance by text</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root{
    --ink:#0a0a0b;--panel:#101013;--line:#22222a;--text:#e9e9ec;--dim:#8a8a94;
    --recv:#17171c;--recv-line:#26262f;--gold:#e8a317;--gold-soft:#2a2113;
    --send:#1c1a12;--send-line:#463714;--ok:#4ec98a;--bezel:#1b1b21;
  }
  *,*::before,*::after{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  html,body{height:100%}
  body{margin:0;background:var(--ink);color:var(--text);overflow:hidden;
    font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;-webkit-tap-highlight-color:transparent}
  ::selection{background:var(--gold);color:#000}
  .mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
  .tnum{font-variant-numeric:tabular-nums}
  a{color:var(--gold)}

  /* base layout = mobile: phone fills, compact info pinned below, no page scroll */
  .page{height:100dvh;display:flex;flex-direction:column;overflow:hidden}

  .phone{display:flex;flex-direction:column;background:var(--panel);
    flex:1 1 auto;min-height:0;border-bottom:1px solid var(--line)}
  header{position:sticky;top:0;z-index:5;background:rgba(16,16,19,.92);backdrop-filter:blur(8px);
    border-bottom:1px solid var(--line);padding:14px 18px calc(14px + env(safe-area-inset-top))}
  header .top{display:flex;align-items:center;gap:10px}
  .avatar{width:34px;height:34px;border-radius:9px;background:var(--gold-soft);border:1px solid var(--send-line);
    display:grid;place-items:center;color:var(--gold);font-weight:600;font-size:15px;flex:none}
  header h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
  header .sub{margin:0;font-size:12.5px;color:var(--dim)}
  .live{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);
    margin-right:5px;vertical-align:1px;animation:pulse 2.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.28}}

  main{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
    padding:20px 16px 16px;display:flex;flex-direction:column;gap:9px;transition:opacity .45s ease}
  main::-webkit-scrollbar{width:0}
  .day{align-self:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:2px 0 8px}
  .msg{max-width:82%;padding:10px 13px;border-radius:16px;font-size:15px;line-height:1.45;
    white-space:pre-wrap;overflow-wrap:break-word;border:1px solid transparent;
    animation:rise .32s cubic-bezier(.2,.7,.3,1) both}
  .recv{align-self:flex-start;background:var(--recv);border-color:var(--recv-line);border-bottom-left-radius:5px}
  .send{align-self:flex-end;background:var(--send);border-color:var(--send-line);border-bottom-right-radius:5px}
  .msg b{color:var(--gold);font-weight:600}
  .sys{align-self:center;font-size:11.5px;color:var(--dim);letter-spacing:.02em;margin:3px 0;
    display:flex;align-items:center;gap:8px;animation:rise .3s ease both}
  .sys::before,.sys::after{content:"";height:1px;width:24px;background:var(--line)}
  .typing{align-self:flex-start;background:var(--recv);border:1px solid var(--recv-line);
    border-radius:16px;border-bottom-left-radius:5px;padding:13px 15px;display:flex;gap:4px;animation:rise .2s ease both}
  .typing i{width:6px;height:6px;border-radius:50%;background:var(--dim);animation:blink 1.3s infinite}
  .typing i:nth-child(2){animation-delay:.18s}
  .typing i:nth-child(3){animation-delay:.36s}
  @keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
  @keyframes blink{0%,58%,100%{opacity:.22;transform:translateY(0)}30%{opacity:.95;transform:translateY(-3px)}}

  .dock{border-top:1px solid var(--line);background:var(--panel)}
  .compose{padding:12px 12px 8px;display:flex;gap:9px;align-items:center}
  .field{flex:1;display:flex;align-items:center;gap:8px;background:var(--ink);border:1px solid var(--line);
    border-radius:22px;padding:9px 8px 9px 15px;min-width:0}
  .field .to{font-size:10px;letter-spacing:.14em;color:var(--dim);flex:none;
    border:1px solid var(--line);border-radius:5px;padding:2px 5px}
  .field input{flex:1;min-width:0;background:none;border:0;color:var(--text);font-size:16px;
    font-family:ui-monospace,monospace;letter-spacing:.14em;outline:none;-webkit-user-select:none;user-select:none}
  .go{flex:none;appearance:none;border:0;cursor:pointer;background:var(--gold);color:#000;text-decoration:none;
    font:600 15px/1 -apple-system,system-ui,sans-serif;padding:12px 18px;border-radius:22px;
    -webkit-user-select:none;user-select:none;transition:transform .12s ease}
  .go:active{transform:scale(.96)}
  @media (hover:hover){.go:hover{background:#f0b429}}
  .hint{margin:0;padding:2px 16px calc(14px + env(safe-area-inset-bottom));font-size:12.5px;color:var(--dim);text-align:center}
  .hint b{color:var(--text)}
  .copied{color:var(--ok)}

  /* ── info (compact) ───────────────────────────────────────────────────── */
  .info{flex:0 0 auto;padding:16px 20px calc(16px + env(safe-area-inset-bottom));
    background:var(--panel);overflow:hidden;display:flex;flex-direction:column;gap:11px}
  .lead{margin:0;font-size:16px;line-height:1.35;font-weight:600;letter-spacing:-.01em}
  .lead span{color:var(--dim);font-weight:400}
  .info ol{margin:0;padding:0;list-style:none;counter-reset:s;display:grid;gap:7px}
  .info li{counter-increment:s;position:relative;padding-left:28px;font-size:13px;line-height:1.4}
  .info li::before{content:counter(s);position:absolute;left:0;top:0;width:18px;height:18px;
    border:1px solid var(--send-line);border-radius:5px;color:var(--gold);
    font:600 10px/18px ui-monospace,monospace;text-align:center}
  .info li b{font-weight:600}
  .info li span{color:var(--dim)}
  .safe{margin:0;font-size:11.5px;line-height:1.5;color:var(--dim)}
  .safe b{color:var(--text);font-weight:600}
  footer{margin:0;font-size:10.5px;line-height:1.5;color:var(--dim)}
  footer a{color:var(--gold)}

  @media (prefers-reduced-motion:reduce){
    .msg,.sys,.typing{animation:none}.live{animation:none}main{transition:none}
  }

  /* ── two columns on wide screens, still one screen, no scroll ──────────── */
  @media (min-width:900px){
    .page{display:grid;grid-template-columns:390px 1fr;gap:clamp(40px,7vw,96px);
      align-items:center;align-content:center;padding:0 40px;max-width:1080px;margin:0 auto}
    .phone{flex:none;height:min(650px,84dvh);border-bottom:0;
      border:11px solid var(--bezel);border-radius:46px;overflow:hidden;position:relative;
      box-shadow:0 50px 90px -28px rgba(0,0,0,.7),0 0 0 1px var(--line)}
    .phone::before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);
      width:120px;height:22px;background:var(--bezel);border-radius:0 0 14px 14px;z-index:6}
    header{padding-top:26px}
    .dock{padding-bottom:6px}
    .info{flex:none;background:none;padding:0;gap:16px;max-width:440px}
    .lead{font-size:22px}
    .info li{font-size:14.5px}
    .safe{font-size:12.5px}
    footer{font-size:11px}
  }

  @media (prefers-color-scheme:light){
    :root{--ink:#fafafa;--panel:#fff;--line:#e6e6e6;--text:#111;--dim:#6b6b73;
      --recv:#f1f1f3;--recv-line:#e4e4e7;--send:#fff6e2;--send-line:#f0d9a6;--gold:#a8710a;--gold-soft:#fff4dd;--ok:#1a8a54;--bezel:#d7d7db}
    header{background:rgba(255,255,255,.9)}
    .go{color:#000}
  }
</style>
</head>
<body>
<div class="page">

  <div class="phone">
    <header>
      <div class="top">
        <div class="avatar">B</div>
        <div>
          <h1>BinaText</h1>
          <p class="sub"><span class="live"></span><span class="mono tnum">${NUMBER_DISPLAY}</span></p>
        </div>
      </div>
    </header>

    <main id="thread" aria-label="Looping demo: text START to BinaText, connect Binance read-only, ask the BTC price, then place a $5 order confirmed with a one-time PIN">
      <div class="day">Today</div>
    </main>

    <div class="dock">
      <div class="compose">
        <label class="field" for="cta">
          <span class="to mono" aria-hidden="true">SMS</span>
          <input id="cta" value="START" readonly tabindex="-1" aria-label="Message to send, prefilled with START, to ${NUMBER_DISPLAY}"
            autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <a class="go" id="go" href="sms:${BINATEXT_NUMBER}" role="button">Send</a>
      </div>
      <p class="hint" id="hint">Opens your messaging app with <b class="mono">START</b> ready to send.</p>
    </div>
  </div>

  <aside class="info">
    <p class="lead">Trade your Binance account by text.<span> No app. Any phone.</span></p>
    <ol>
      <li>Text <b class="mono">START</b> to ${NUMBER_DISPLAY}, reply <b class="mono">CONNECT</b>.</li>
      <li>Open the link. Authorise on Binance <span>&mdash; Read-only needs no deposit</span>.</li>
      <li>Text it. <span>Every order is confirmed with a one-time PIN.</span> <b class="mono">STOP</b> cancels.</li>
    </ol>
    <p class="safe"><b>No withdrawal scope</b> &middot; hard per-order &amp; daily USD caps in code &middot; you authorise on Binance and revoke anytime</p>
    <footer>
      Independent &middot; Binance Agent OS Mini Hackathon &middot; not affiliated with Binance &middot; not financial advice &middot; NG SMS line only for now &middot; <a href="${REPO_URL}">GitHub</a>
    </footer>
  </aside>

</div>

<script>
(function(){
  var num=${JSON.stringify(BINATEXT_NUMBER)}, disp=${JSON.stringify(NUMBER_DISPLAY)};
  var HOST=${JSON.stringify(CONNECT_HOST)};
  var SCRIPT=${JSON.stringify(SCRIPT)};
  var thread=document.getElementById("thread");
  var reduce=matchMedia("(prefers-reduced-motion:reduce)").matches;
  var wait=function(ms){return new Promise(function(r){setTimeout(r,ms);});};

  function esc(s){return s.replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
  function hl(s){
    return esc(s)
      .replace(/\\b(START|CONNECT|STOP)\\b/g,"<b>$1</b>")
      .replace(/\\bYES 4821\\b/g,"<b>YES 4821</b>")
      .replace(/\\bcannot withdraw\\b/g,"<b>cannot withdraw</b>")
      .replace(HOST+"/connect",'<b>'+HOST+'<wbr>/connect</b>');
  }
  function follow(){ thread.scrollTop = thread.scrollHeight; }

  function addMsg(step){
    var d=document.createElement("div");
    if(step.who==="sys"){ d.className="sys"; d.textContent=step.t; }
    else{
      d.className="msg "+(step.who==="you"?"send mono":"recv")+(step.tnum?" tnum":"");
      d.innerHTML=step.who==="you"?esc(step.t):hl(step.t);
    }
    thread.appendChild(d); follow();
  }
  function addTyping(){
    var d=document.createElement("div"); d.className="typing";
    d.innerHTML="<i></i><i></i><i></i>"; thread.appendChild(d); follow(); return d;
  }
  function clearThread(){
    var n=thread.querySelectorAll(".msg,.sys,.typing");
    for(var i=0;i<n.length;i++) n[i].remove();
    thread.scrollTop=0;
  }

  if(reduce){ SCRIPT.forEach(addMsg); wireCTA(); return; }

  async function runOnce(){
    for(var i=0;i<SCRIPT.length;i++){
      var step=SCRIPT[i];
      if(step.who==="bina"){
        var dots=addTyping();
        await wait(step.think||1400);
        dots.remove();
        addMsg(step);
      } else {
        addMsg(step);
      }
      await wait(step.after==null?1400:step.after);
    }
  }

  (async function loop(){
    while(true){
      clearThread();
      await wait(700);
      await runOnce();
      await wait(5200);
      thread.style.opacity="0";
      await wait(500);
      thread.style.opacity="1";
    }
  })();

  wireCTA();

  function wireCTA(){
    var go=document.getElementById("go"), hint=document.getElementById("hint");
    var ua=navigator.userAgent||"", ios=/iPad|iPhone|iPod/.test(ua)&&!window.MSStream;
    var mobile=ios||/Android|Mobi/.test(ua);
    go.href="sms:"+num+(ios?"&":"?")+"body="+encodeURIComponent("START");
    if(!mobile){
      hint.innerHTML='On a phone this opens your SMS app. From here: text <b class="mono">START</b> to <span class="mono">'+disp+'</span>.';
      go.textContent="Copy number";
      go.addEventListener("click",function(e){
        e.preventDefault();
        var done=function(){ go.textContent="Copied"; go.classList.add("copied");
          hint.innerHTML='Text <b class="mono">START</b> to <span class="mono copied">'+disp+'</span>.';
          setTimeout(function(){ go.textContent="Copy number"; go.classList.remove("copied"); },2200); };
        if(navigator.clipboard){ navigator.clipboard.writeText(num).then(done,done); } else { done(); }
      });
    }
  }
})();
</script>
</body>
</html>`;
