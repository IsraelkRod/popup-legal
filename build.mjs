/*
 * build.mjs — builds the popupanalytics.app pages from src/.
 *
 * Why a build step at all: the deployed artifact has to be ONE self-contained
 * HTML file (the preview gate encrypts a single document, and an external
 * stylesheet would sit in this public repo as readable plaintext). But hand
 * duplicating the palette across pages is what let the site drift away from the
 * app in the first place. So the source is split and the output is inlined.
 *
 * Targets:
 *   node build.mjs coming-soon             -> index.html          (plaintext holding page)
 *   node build.mjs preview "<passphrase>"  -> preview/index.html  (encrypted, noindex)
 *   node build.mjs publish                 -> index.html          (the real site, plaintext)
 *
 * The Founding Tester Hub is NOT built here. It stays in build-gate.mjs, and
 * rebuilding it needs the original access code. Leave beta/ alone.
 *
 * Path rule: every asset and link in src/ must be root-absolute (/assets/...),
 * never ./ or ../. That is what lets the SAME bytes work at /preview/ and at /,
 * which is what makes the launch flip a no-op instead of a port.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const src = (p) => path.join(root, 'src', p);
const ITER = 200000;
const ASSET_BUDGET = 250 * 1024;

const target = process.argv[2];
const passphrase = process.argv[3];

const TARGETS = {
  'coming-soon': { source: 'coming-soon.html', out: 'index.html', encrypt: false },
  'publish': { source: 'site.html', out: 'index.html', encrypt: false },
  'preview': { source: 'site.html', out: 'preview/index.html', encrypt: true },
  // Plaintext, gitignored, for looking at the real site on a local server
  // without ever putting it near index.html.
  'local': { source: 'site.html', out: '.local/index.html', encrypt: false },
};

if (!TARGETS[target]) {
  console.error('Usage: node build.mjs <coming-soon|local|preview|publish> ["<passphrase>"]');
  process.exit(1);
}
const cfg = TARGETS[target];
if (cfg.encrypt && !passphrase) {
  console.error('The preview target needs a passphrase: node build.mjs preview "<passphrase>"');
  process.exit(1);
}
if (!existsSync(src(cfg.source))) {
  console.error(`Missing source file: src/${cfg.source}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ build */

let html = readFileSync(src(cfg.source), 'utf8');

// 1) Inline any <!--@include foo.css--> from src/
html = html.replace(/<!--@include\s+([\w.\-/]+)\s*-->/g, (_, file) => {
  const p = src(file);
  if (!existsSync(p)) fail([`<!--@include ${file}--> but src/${file} does not exist`]);
  return readFileSync(p, 'utf8');
});

// 2) Inline the language dictionary at <!--@i18n-->
//
// Only the namespaces THIS page actually uses get inlined. Otherwise the
// public holding page would ship the entire unreleased site copy in plaintext,
// which both leaks it and bloats the page.
const en = JSON.parse(readFileSync(src('i18n/en.json'), 'utf8'));
const es = JSON.parse(readFileSync(src('i18n/es.json'), 'utf8'));

const rawSource = readFileSync(src(cfg.source), 'utf8');
const namespaces = new Set();
for (const m of rawSource.matchAll(/data-i18n="([^".]+)\./g)) namespaces.add(m[1]);
for (const m of rawSource.matchAll(/lookup\([^,]+,\s*"([^".]+)\./g)) namespaces.add(m[1]);

const pick = (dict) => Object.fromEntries(
  Object.entries(dict).filter(([ns]) => namespaces.has(ns))
);
html = html.replace('<!--@i18n-->', JSON.stringify({ en: pick(en), es: pick(es) }));

/* -------------------------------------------------------------- validate */

const errors = [];
const warnings = [];

// Every data-i18n key must resolve in BOTH languages.
const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const flatEn = flatten(en);
const flatEs = flatten(es);

const source = rawSource;
const used = [...source.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
for (const key of new Set(used)) {
  if (!(key in flatEn)) errors.push(`data-i18n="${key}" is used in the markup but missing from en.json`);
  if (!(key in flatEs)) errors.push(`data-i18n="${key}" is used in the markup but missing from es.json`);
}

// The two dictionaries must match key for key. A missing Spanish key silently
// renders English, which is an invisible failure, so make it a loud one.
for (const k of Object.keys(flatEn)) if (!(k in flatEs)) errors.push(`en.json has "${k}", es.json does not`);
for (const k of Object.keys(flatEs)) if (!(k in flatEn)) errors.push(`es.json has "${k}", en.json does not`);

// Relative paths break the moment the same bytes are served from /preview/.
for (const m of source.matchAll(/(?:src|href)="(\.\.?\/[^"]*)"/g)) {
  errors.push(`relative path "${m[1]}" in src/${cfg.source}, use a root-absolute path like /assets/...`);
}

// Page weight.
if (existsSync(path.join(root, 'assets'))) {
  for (const f of readdirSync(path.join(root, 'assets'))) {
    const p = path.join(root, 'assets', f);
    if (!statSync(p).isFile()) continue;
    const size = statSync(p).size;
    if (size > ASSET_BUDGET) {
      warnings.push(`assets/${f} is ${(size / 1024).toFixed(0)}KB, over the ${ASSET_BUDGET / 1024}KB budget`);
    }
  }
}

function fail(list) {
  console.error(`\nBuild failed. ${list.length} problem${list.length === 1 ? '' : 's'}:\n`);
  for (const e of list) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}
if (errors.length) fail(errors);

/* ----------------------------------------------------------------- write */

let out = html;

if (cfg.encrypt) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, ITER, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([ct, tag]).toString('base64'); // SubtleCrypto wants ct||tag
  out = gatePage(salt.toString('base64'), iv.toString('base64'), payload);
}

const outPath = path.join(root, cfg.out);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');

for (const w of warnings) console.warn(`  warning: ${w}`);
console.log(`Built ${cfg.out} from src/${cfg.source} (${(out.length / 1024).toFixed(1)}KB${cfg.encrypt ? ', encrypted' : ''}).`);

/* ------------------------------------------------------------- gate page */

/**
 * The unlock shell wrapped around an encrypted preview. Deliberately generic in
 * its public meta and noindex: the ciphertext is downloadable by anyone, so the
 * passphrase should be long. Uses its own sessionStorage key so unlocking the
 * preview never clobbers the Founding Tester Hub's saved code.
 */
function gatePage(SALT, IV, CT) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pop Up</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/assets/popup-logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet">
<style>
${readFileSync(src('tokens.css'), 'utf8')}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;
  font-family:var(--font-body);font-size:17px;color:var(--ink);background:var(--paper)}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:
  radial-gradient(38vw 38vw at 12% -6%,rgba(155,89,200,.20),transparent 62%),
  radial-gradient(34vw 34vw at 92% 4%,rgba(94,179,255,.20),transparent 60%),
  radial-gradient(34vw 34vw at 4% 92%,rgba(232,74,104,.14),transparent 60%)}
.gate{width:100%;max-width:420px;text-align:center}
.logo{width:min(240px,70%);height:auto;margin:0 auto 24px;display:block;
  filter:drop-shadow(0 10px 22px rgba(11,16,32,.16))}
.card{background:var(--glass-bg-strong);-webkit-backdrop-filter:blur(20px) saturate(180%);
  backdrop-filter:blur(20px) saturate(180%);border:1.5px solid var(--glass-border);
  border-radius:var(--radius-pill);box-shadow:var(--shadow-card);padding:26px 22px}
h1{font-family:var(--font-display);font-weight:400;font-size:16px;letter-spacing:.02em;margin:0 0 8px}
p.sub{color:var(--muted);margin:0 0 18px;font-size:15px}
input{width:100%;min-height:48px;padding:12px 14px;font-family:var(--font-body);font-size:16px;
  text-align:center;color:var(--ink);background:var(--paper);border:1.5px solid var(--outline-soft);
  border-radius:14px;outline:none}
input:focus{border-color:var(--coral);box-shadow:0 0 0 3px rgba(255,114,137,.18)}
button{width:100%;min-height:52px;margin-top:12px;font-family:var(--font-display);font-weight:400;
  font-size:15px;letter-spacing:.03em;color:var(--coral-text);background:var(--coral);border:none;
  border-radius:var(--radius-round);box-shadow:var(--shadow-control);cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.err{display:none;margin-top:14px;background:rgba(255,114,137,.14);color:#7A1226;
  border-radius:14px;padding:12px 14px;font-size:15px}
.err.show{display:block}
</style>
</head>
<body>
  <div class="gate">
    <img class="logo" src="/assets/popup-logo.png" alt="Pop Up">
    <div class="card">
      <h1>Preview access</h1>
      <p class="sub">Enter the passphrase to view this page.</p>
      <form id="g">
        <input id="code" type="password" placeholder="Passphrase" autocomplete="off" autofocus aria-label="Passphrase">
        <button id="go" type="submit">Unlock</button>
        <div class="err" id="err">That passphrase didn't work. Check it and try again.</div>
      </form>
    </div>
  </div>
<script>
  var SALT="${SALT}", IV="${IV}", CT="${CT}", ITER=${ITER}, STORE="pu_code_preview";
  function b2u(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
  async function unlock(code){
    var m=await crypto.subtle.importKey("raw",new TextEncoder().encode(code),"PBKDF2",false,["deriveKey"]);
    var k=await crypto.subtle.deriveKey({name:"PBKDF2",salt:b2u(SALT),iterations:ITER,hash:"SHA-256"},m,{name:"AES-GCM",length:256},false,["decrypt"]);
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:b2u(IV)},k,b2u(CT)));
  }
  var form=document.getElementById("g"),input=document.getElementById("code"),
      err=document.getElementById("err"),go=document.getElementById("go");
  async function attempt(code,fromStore){
    err.classList.remove("show");
    try{ var html=await unlock(code); try{sessionStorage.setItem(STORE,code);}catch(e){}
      document.open(); document.write(html); document.close(); }
    catch(e){ if(!fromStore){ err.classList.add("show"); input.value=""; input.focus(); }
      go.disabled=false; go.textContent="Unlock"; }
  }
  form.addEventListener("submit",function(e){e.preventDefault();if(!input.value)return;
    go.disabled=true;go.textContent="Unlocking…";attempt(input.value,false);});
  try{ var s=sessionStorage.getItem(STORE); if(s){ attempt(s,true); } }catch(e){}
</script>
</body>
</html>
`;
}
