/**
 * The landing page, served at GET /.
 *
 * Concept: the page *is* a text thread, and on load it plays the real onboarding
 * flow as a live simulation — START, the welcome, CONNECT, the link, then a
 * price question and the reply, then a trade with the PIN. Typing indicators
 * between messages. The CTA is the compose bar; Send opens the phone's SMS app
 * with START pre-typed. No images, no framework, no external requests.
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
const SCRIPT = [
  { who: "you", t: "START" },
  {
    who: "bina",
    think: 1050,
    t: "Welcome to BinaText! Trade your Binance sub-account by SMS - any phone, no app. Reply CONNECT to link your account. You authorise on Binance's own web page; we never see your keys and cannot withdraw.",
  },
  { who: "you", t: "CONNECT" },
  {
    who: "bina",
    think: 1150,
    t: `Open this to connect Binance:\n${CONNECT_HOST}/connect\nPick Read-only - try it with no deposit.`,
  },
  { who: "sys", t: "Authorised on Binance · Read-only" },
  { who: "bina", think: 700, t: "Connected. Text me anything - “how am I positioned?”, “put $5 into BNB”." },
  { who: "you", t: "what is BTC doing?" },
  { who: "bina", think: 900, tnum: true, t: "BTC $61,240, +1.8% over 24h. Range 60,100-61,900." },
  { who: "you", t: "put $5 into BNB" },
  { who: "bina", think: 1150, t: "Order: BUY ~$5.00 of BNB @ ~$612 (MARKET).\nReply YES 4821 to confirm. Expires in 5 min." },
  { who: "you", t: "YES 4821" },
  { who: "bina", think: 950, tnum: true, t: "Filled. BUY 0.00817 BNB for ~$5.00 (avg $611.9). Order 448210327." },
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
    --send:#1c1a12;--send-line:#463714;--ok:#4ec98a;
  }
  *,*::before,*::after{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--ink);color:var(--text);
    font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;-webkit-tap-highlight-color:transparent}
  ::selection{background:var(--gold);color:#000}
  .mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
  .tnum{font-variant-numeric:tabular-nums}

  .wrap{max-width:468px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column;
    border-inline:1px solid var(--line);background:var(--panel)}

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

  main{padding:20px 16px 16px;display:flex;flex-direction:column;gap:9px}
  .day{align-self:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:2px 0 8px}
  .msg{max-width:82%;padding:10px 13px;border-radius:16px;font-size:15px;line-height:1.45;
    white-space:pre-wrap;overflow-wrap:break-word;border:1px solid transparent;scroll-margin-bottom:96px;
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
  .sys{scroll-margin-bottom:96px}
  @keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
  @keyframes blink{0%,58%,100%{opacity:.22;transform:translateY(0)}30%{opacity:.95;transform:translateY(-3px)}}
  @media (prefers-reduced-motion:reduce){
    .msg,.sys,.typing{animation:none}.live{animation:none}
  }

  .facts{padding:22px 18px 8px;border-top:1px solid var(--line)}
  .facts h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 12px}
  .facts ol{margin:0;padding:0;list-style:none;counter-reset:s}
  .facts li{counter-increment:s;position:relative;padding:0 0 14px 30px;font-size:14.5px}
  .facts li::before{content:counter(s);position:absolute;left:0;top:-1px;width:20px;height:20px;
    border:1px solid var(--send-line);border-radius:6px;color:var(--gold);font:600 11px/20px ui-monospace,monospace;text-align:center}
  .facts li b{font-weight:600}
  .facts li span{color:var(--dim)}
  .safe{padding:16px 18px;border-top:1px solid var(--line);display:grid;gap:9px}
  .safe p{margin:0;font-size:13.5px;color:var(--dim)}
  .safe p b{color:var(--text);font-weight:600}

  .dock{position:sticky;bottom:0;z-index:5;max-width:468px;margin:0 auto;
    background:rgba(16,16,19,.94);backdrop-filter:blur(8px);
    border-top:1px solid var(--line);border-inline:1px solid var(--line)}
  .compose{padding:12px 12px 8px;display:flex;gap:9px;align-items:center}
  .field{flex:1;display:flex;align-items:center;gap:8px;background:var(--ink);border:1px solid var(--line);
    border-radius:22px;padding:9px 8px 9px 15px;min-width:0}
  .field .to{font-size:12px;color:var(--dim);flex:none}
  .field input{flex:1;min-width:0;background:none;border:0;color:var(--text);font-size:16px;
    font-family:ui-monospace,monospace;letter-spacing:.09em;outline:none;-webkit-user-select:none;user-select:none}
  .go{flex:none;appearance:none;border:0;cursor:pointer;background:var(--gold);color:#000;text-decoration:none;
    font:600 15px/1 -apple-system,system-ui,sans-serif;padding:12px 18px;border-radius:22px;
    -webkit-user-select:none;user-select:none;transition:transform .12s ease}
  .go:active{transform:scale(.96)}
  @media (hover:hover){.go:hover{background:#f0b429}}
  .hint{margin:0;padding:2px 16px calc(14px + env(safe-area-inset-bottom));font-size:12.5px;color:var(--dim);text-align:center}
  .hint b{color:var(--text)}
  .copied{color:var(--ok)}

  footer{max-width:468px;margin:0 auto;padding:18px 18px calc(24px + env(safe-area-inset-bottom));
    background:var(--panel);border-inline:1px solid var(--line);border-top:1px solid var(--line);
    font-size:12px;color:var(--dim);line-height:1.6}
  footer a{color:var(--dim);text-decoration:underline;text-underline-offset:2px}

  @media (prefers-color-scheme:light){
    :root{--ink:#fafafa;--panel:#fff;--line:#e6e6e6;--text:#111;--dim:#6b6b73;
      --recv:#f1f1f3;--recv-line:#e4e4e7;--send:#fff6e2;--send-line:#f0d9a6;--gold:#a8710a;--gold-soft:#fff4dd;--ok:#1a8a54}
    header,.dock{background:rgba(255,255,255,.9)}
    .go{color:#000}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="top">
      <div class="avatar">B</div>
      <div>
        <h1>BinaText</h1>
        <p class="sub"><span class="live"></span><span class="mono tnum">${NUMBER_DISPLAY}</span></p>
      </div>
    </div>
  </header>

  <main id="thread" aria-label="Simulated conversation: text START to BinaText, connect Binance, ask the BTC price, place a $5 order confirmed with a PIN">
    <div class="day">Today</div>
  </main>

  <section class="facts">
    <h2>How it works</h2>
    <ol>
      <li>Text <b class="mono">START</b> to ${NUMBER_DISPLAY}, then reply <b class="mono">CONNECT</b>.</li>
      <li>Open the link it sends. Authorise on Binance &mdash; pick <span>Read-only to try it with no deposit</span>, or Full to trade for real.</li>
      <li>Text it plainly: <span>&ldquo;how am I positioned?&rdquo; &nbsp; &ldquo;alert me if SOL drops under 140&rdquo; &nbsp; &ldquo;sell half my ETH&rdquo;</span></li>
      <li>Confirm every order with the one-time PIN it texts back. <span>Text STOP to cancel open orders.</span></li>
    </ol>
  </section>

  <section class="safe" aria-label="Safety">
    <p><b>No withdrawal, ever.</b> It connects through Binance Agent OS to a dedicated sub-account. No permission it can request allows moving funds out.</p>
    <p><b>Hard limits.</b> Per-order and daily USD caps enforced in code, before any order &mdash; not by the language model.</p>
    <p><b>You hold the keys.</b> Authorisation happens on Binance's site. Revoke anytime from your Binance dashboard.</p>
  </section>

  <footer>
    Independent project for the Binance Agent OS Mini Hackathon. Not affiliated with Binance.
    Not financial advice &mdash; you are responsible for every order.
    International SMS isn't supported yet &mdash; Nigerian gateway line only.
    <br><a href="${REPO_URL}">Source on GitHub</a>
  </footer>
</div>

<div class="dock">
  <div class="compose">
    <label class="field" for="cta">
      <span class="to mono">To ${NUMBER_DISPLAY}</span>
      <input id="cta" value="START" readonly tabindex="-1" aria-label="Message to send, prefilled with START"
        autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>
    <a class="go" id="go" href="sms:${BINATEXT_NUMBER}" role="button">Send</a>
  </div>
  <p class="hint" id="hint">Opens your messaging app with <b class="mono">START</b> ready to send.</p>
</div>

<script>
(function(){
  var num=${JSON.stringify(BINATEXT_NUMBER)}, disp=${JSON.stringify(NUMBER_DISPLAY)};
  var SCRIPT=${JSON.stringify(SCRIPT)};
  var thread=document.getElementById("thread");
  var reduce=matchMedia("(prefers-reduced-motion:reduce)").matches;

  function esc(s){return s.replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
  var HOST=${JSON.stringify(CONNECT_HOST)};
  function hl(s){
    return esc(s)
      .replace(/\\b(START|CONNECT|STOP)\\b/g,"<b>$1</b>")
      .replace(/\\bYES 4821\\b/g,"<b>YES 4821</b>")
      .replace(/\\bcannot withdraw\\b/g,"<b>cannot withdraw</b>")
      .replace(HOST+"/connect",'<b>'+HOST+'<wbr>/connect</b>');
  }
  var paused=false;
  addEventListener("wheel",function(e){ if(e.deltaY) paused=true; },{passive:true});
  addEventListener("touchmove",function(){ paused=true; },{passive:true});
  addEventListener("keydown",function(e){ if(/Arrow|Page| /.test(e.key)) paused=true; },{passive:true});
  function follow(el){
    if(paused || !el) return;
    if(el.getBoundingClientRect().bottom > innerHeight - 104){
      el.scrollIntoView({block:"end"});
    }
  }

  function addMsg(step,quiet){
    var d=document.createElement("div");
    if(step.who==="sys"){ d.className="sys"; d.textContent=step.t; }
    else{
      d.className="msg "+(step.who==="you"?"send mono":"recv")+(step.tnum?" tnum":"");
      d.innerHTML=step.who==="you"?esc(step.t):hl(step.t);
    }
    thread.appendChild(d); if(!quiet) follow(d);
    return d;
  }
  function addTyping(){
    var d=document.createElement("div"); d.className="typing";
    d.innerHTML="<i></i><i></i><i></i>"; thread.appendChild(d); follow(d); return d;
  }
  var wait=function(ms){return new Promise(function(r){setTimeout(r,ms);});};

  if(reduce){ SCRIPT.forEach(function(s){addMsg(s,true);}); return; }

  (async function run(){
    await wait(450);
    for(var i=0;i<SCRIPT.length;i++){
      var step=SCRIPT[i];
      if(step.who==="bina"){
        var dots=addTyping();
        await wait(step.think||900);
        dots.remove();
        var el=addMsg(step);
        follow(el);
        await wait(680);
      } else {
        var el2=addMsg(step);
        follow(el2);
        await wait(step.who==="sys"?560:460);
      }
    }
  })();

  // compose bar CTA
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
})();
</script>
</body>
</html>`;
