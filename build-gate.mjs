/*
 * build-gate.mjs — turns the plaintext homepage (homepage.src.html) into an
 * encrypted, code-gated index.html for the PUBLIC popup-legal repo.
 *
 * Why encrypt (not hide): the repo is public, so any committed plaintext is
 * readable on github.com. We AES-GCM-encrypt the whole homepage — including the
 * confidential app screenshots, inlined as data URIs — so the public repo holds
 * only ciphertext. The access code is the passphrase; without it there is no
 * readable content and no fetchable screenshots.
 *
 * Usage:  node build-gate.mjs "<access-code>"
 * Then commit index.html (privacy/terms/support + the public logo stay as-is).
 * Keep homepage.src.html and assets/app-*.png OUT of git (see .gitignore).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const passphrase = process.argv[2];
if (!passphrase) {
  console.error('Usage: node build-gate.mjs "<access-code>"');
  process.exit(1);
}

const ITER = 200000;

// 1) Load plaintext homepage and inline the confidential screenshots as data URIs
let html = readFileSync(new URL('./homepage.src.html', import.meta.url), 'utf8');
for (const name of ['app-projects', 'app-calendar', 'app-earnings']) {
  const b64 = readFileSync(new URL(`./assets/${name}.png`, import.meta.url)).toString('base64');
  const dataUri = `data:image/png;base64,${b64}`;
  html = html.split(`./assets/${name}.png`).join(dataUri);
}

// 2) Encrypt the whole document (AES-256-GCM, key via PBKDF2-SHA256)
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(passphrase, salt, ITER, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const payload = Buffer.concat([ct, tag]).toString('base64'); // SubtleCrypto wants ct||tag

// 3) Emit the gated index.html (public meta is generic; rich content is encrypted)
const SALT = salt.toString('base64');
const IV = iv.toString('base64');

const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pop Up — Private Beta</title>
<meta name="description" content="Pop Up private beta. Enter your access code to continue.">
<meta name="robots" content="noindex">
<link rel="icon" href="./assets/popup-logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{ --ink:#100F14; --pink:#F4256A; --mint:#2FD08A; --paper:#FBF7FF; --glass:rgba(255,255,255,.5); }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;
    font-family:"Nunito",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);
    background:radial-gradient(60vw 60vw at 15% -8%,rgba(155,81,224,.22),transparent 60%),
      radial-gradient(55vw 55vw at 95% 6%,rgba(74,157,232,.20),transparent 55%),
      radial-gradient(60vw 50vw at 82% 100%,rgba(47,208,138,.18),transparent 60%),
      linear-gradient(180deg,#efeaff,var(--paper));background-attachment:fixed;}
  .gate{width:100%;max-width:420px;text-align:center}
  .logo{width:min(300px,80%);height:auto;margin:0 auto 22px;display:block;filter:drop-shadow(0 8px 18px rgba(16,15,20,.18))}
  .card{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);
    border:3px solid var(--ink);border-radius:24px;box-shadow:4px 4px 0 rgba(16,15,20,.16),0 16px 34px rgba(16,15,20,.12);padding:26px}
  h1{font-family:"Baloo 2",sans-serif;font-weight:800;font-size:1.5rem;margin:0 0 6px}
  p.sub{color:#6b6675;font-weight:700;margin:0 0 18px}
  input{width:100%;padding:14px;font-size:1.05rem;font-family:"Nunito",sans-serif;font-weight:700;text-align:center;
    background:rgba(255,255,255,.75);border:2.5px solid var(--ink);border-radius:13px;outline:none}
  input:focus{border-color:var(--pink)}
  button{width:100%;margin-top:14px;background:var(--pink);color:#fff;font-family:"Baloo 2",sans-serif;font-weight:800;
    font-size:1.1rem;border:3px solid var(--ink);border-radius:14px;padding:14px;box-shadow:4px 4px 0 var(--ink);cursor:pointer;
    transition:transform .08s ease,box-shadow .08s ease}
  button:hover{transform:translate(-1px,-1px)} button:active{transform:translate(4px,4px);box-shadow:0 0 0 var(--ink)}
  button:disabled{opacity:.6}
  .err{display:none;margin-top:14px;background:#FFD60A;border:3px solid var(--ink);border-radius:12px;padding:11px;font-weight:800}
  .err.show{display:block}
  .foot{margin-top:18px;font-weight:700} .foot a{color:var(--ink);margin:0 8px}
</style>
</head>
<body>
  <div class="gate">
    <img class="logo" src="./assets/popup-logo.png" alt="Pop Up">
    <div class="card">
      <h1>Private beta</h1>
      <p class="sub">Enter your access code to continue.</p>
      <form id="g">
        <input id="code" type="password" placeholder="Access code" autocomplete="off" autofocus aria-label="Access code">
        <button id="go" type="submit">Unlock</button>
        <div class="err" id="err">That code didn't work. Check it and try again.</div>
      </form>
      <div class="foot"><a href="./privacy/">Privacy</a><a href="./terms/">Terms</a><a href="mailto:support@popupanalytics.app">Contact</a></div>
    </div>
  </div>
<script>
  var SALT="${SALT}", IV="${IV}", CT="${payload}", ITER=${ITER};
  function b2u(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
  async function unlock(code){
    var keyMat=await crypto.subtle.importKey("raw",new TextEncoder().encode(code),"PBKDF2",false,["deriveKey"]);
    var key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:b2u(SALT),iterations:ITER,hash:"SHA-256"},keyMat,{name:"AES-GCM",length:256},false,["decrypt"]);
    var buf=await crypto.subtle.decrypt({name:"AES-GCM",iv:b2u(IV)},key,b2u(CT));
    return new TextDecoder().decode(buf);
  }
  function reveal(html){ document.open(); document.write(html); document.close(); }
  var form=document.getElementById("g"),input=document.getElementById("code"),err=document.getElementById("err"),go=document.getElementById("go");
  async function attempt(code,fromStore){
    err.classList.remove("show");
    try{ var html=await unlock(code); try{sessionStorage.setItem("pu_code",code);}catch(e){} reveal(html); }
    catch(e){ if(!fromStore){ err.classList.add("show"); input.value=""; input.focus(); } go.disabled=false; go.textContent="Unlock"; }
  }
  form.addEventListener("submit",function(e){ e.preventDefault(); if(!input.value)return; go.disabled=true; go.textContent="Unlocking…"; attempt(input.value,false); });
  try{ var saved=sessionStorage.getItem("pu_code"); if(saved){ attempt(saved,true); } }catch(e){}
</script>
</body>
</html>
`;

writeFileSync(new URL('./index.html', import.meta.url), out, 'utf8');
console.log(`Gated index.html written (${out.length} bytes; payload ${payload.length} b64 chars).`);
