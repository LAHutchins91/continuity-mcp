import crypto from "node:crypto";
import express, { type Request } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { installPluginAuth } from "./plugin-auth.js";
import { landingConnectLead } from "./connect-page.js";
import { installPublicPages, page } from "./public-pages.js";
import { createStoryServer } from "./story-tools.js";
import { validateMcpClaims } from "./mcp-claims.js";
import { MCP_CORS_HEADERS, mcpBrowserOriginAllowed } from "./mcp-clients.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const app = express();
export default app;
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cache-Control':'no-store'});next();});
const publicLimits = new Map<string,{count:number,end:number}>();
function allowPublic(key:string,limit:number,ms:number) {
 const now=Date.now();
 for(const [k,v] of publicLimits) if(v.end<=now) publicLimits.delete(k);
 const value=publicLimits.get(key);
 if(value) {value.count++;return value.count<=limit;}
 if(publicLimits.size>=10000)return false;
 publicLimits.set(key,{count:1,end:now+ms});return true;
}

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY ?? "";
const STRIPE_PRICE_YEARLY = process.env.STRIPE_PRICE_YEARLY ?? "";
const APP_BASE_URL = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

const validCanonKinds = [
  "CHARACTER", "RELATIONSHIP", "APPEARANCE", "ABILITY", "LOCATION", "WORLD_RULE",
  "TIMELINE", "PLOT_THREAD", "ITEM", "FACTION", "OTHER"
] as const;
const validCanonStatuses = ["LOCKED", "DEVELOPING", "UNKNOWN", "RETIRED"] as const;

type AuthUser = { id: string; email?: string };
type JsonObject = Record<string, unknown>;

function requireEnv(name: string, value: string) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function supabaseRequest<T>(
  path: string,
  options: RequestInit = {},
  accessToken?: string,
  serviceRole = false
): Promise<T> {
  const base = requireEnv("SUPABASE_URL", SUPABASE_URL);
  const key = serviceRole
    ? requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    : requireEnv("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY);
  const headers = new Headers(options.headers);
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${accessToken ?? key}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text || response.statusText}`);
  return (text ? JSON.parse(text) : null) as T;
}

function bearer(req: Request) {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function authenticatedUser(req: Request): Promise<{ user: AuthUser; token: string }> {
  const token = bearer(req);
  if (!token) throw new Error("Authentication required");
  const user = await supabaseRequest<AuthUser>("/auth/v1/user", { method: "GET" }, token);
  if (!user?.id) throw new Error("Invalid authentication token");
  return { user, token };
}

async function stripeRequest<T>(path: string, params: URLSearchParams): Promise<T> {
  const secret = requireEnv("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY);
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Stripe ${response.status}: ${body || response.statusText}`);
  return JSON.parse(body) as T;
}

function stripeEvent(rawBody: Buffer, signatureHeader: string) {
  const secret = requireEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  const fields = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new Error("Malformed Stripe signature");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error("Expired Stripe signature");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const valid = signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });
  if (!valid) throw new Error("Invalid Stripe signature");
  return JSON.parse(rawBody.toString("utf8")) as { type: string; data: { object: JsonObject } };
}

async function updateBillingProfile(userId: string, patch: JsonObject) {
  await supabaseRequest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  }, undefined, true);
}

app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).send("Missing Stripe signature");
    const event = stripeEvent(req.body, signature);
    const object = event.data.object;

    if (event.type === "checkout.session.completed") {
      const userId = typeof object.client_reference_id === "string" ? object.client_reference_id : undefined;
      if (userId) {
        await updateBillingProfile(userId, {
          stripe_customer_id: typeof object.customer === "string" ? object.customer : null,
          stripe_subscription_id: typeof object.subscription === "string" ? object.subscription : null
        });
      }
    }

    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const metadata = (object.metadata ?? {}) as JsonObject;
      const userId = typeof metadata.supabase_user_id === "string" ? metadata.supabase_user_id : undefined;
      if (userId) {
        const status = typeof object.status === "string" ? object.status : "unknown";
        const periodEnd = typeof object.current_period_end === "number"
          ? new Date(object.current_period_end * 1000).toISOString()
          : null;
        const priceId = (((object.items as JsonObject | undefined)?.data as JsonObject[] | undefined)?.[0]?.price as JsonObject | undefined)?.id;
        const plan = priceId === STRIPE_PRICE_YEARLY ? "annual" : ["active", "trialing"].includes(status) ? "pro" : "trial";
        await updateBillingProfile(userId, {
          plan,
          stripe_customer_id: typeof object.customer === "string" ? object.customer : null,
          stripe_subscription_id: typeof object.id === "string" ? object.id : null,
          subscription_status: status,
          current_period_end: periodEnd,
          cancel_at_period_end: Boolean(object.cancel_at_period_end)
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook request failed");
    res.status(400).send("Webhook could not be processed");
  }
});

app.use(express.json({ limit: "128kb" }));
installPublicPages(app, APP_BASE_URL);
app.get('/.well-known/openai-apps-challenge',(_req,res)=>{
 const token=process.env.OPENAI_APPS_CHALLENGE;
 if(!token)return res.status(404).type('text').send('Verification is not configured.');
 res.type('text').send(token);
});
app.post('/api/support',async(req,res)=>{
 if(!allowPublic('support:'+req.ip,5,3600000))return res.status(429).json({error:'Too many requests. Please try again in an hour.'});
 const input=z.object({email:z.string().email().max(254),message:z.string().trim().min(10).max(4000)}).safeParse(req.body);
 if(!input.success)return res.status(400).json({error:'Enter a valid reply email and a message of 10–4000 characters.'});
 try {const rows=await supabaseRequest<Array<{id:string}>>('/rest/v1/continuity_support_requests',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(input.data)},undefined,true);res.json({id:rows[0].id});}
 catch {res.status(503).json({error:'Support could not receive your request. Please retry later.'});}
});
app.get('/data',(_req,res)=>{
 const config=JSON.stringify({url:SUPABASE_URL,key:SUPABASE_ANON_KEY}).replace(/</g,'\\u003c');
 res.type('html').send(page('Your data, your choice', `<p>Export a complete project archive or permanently delete a project and its canon, revision history, scenes, and checkpoints. These controls remain available after Pro expires.</p><p><a href="/app">Sign in first</a>. <a href="/connections">Disconnect applications</a> separately. Manage cancellation in your account’s billing portal. For full account deletion or privacy requests, <a href="/support">contact support</a>.</p><section><label>Project<select id="projects"></select></label><button id="export">Download complete JSON archive</button><label>To delete, type the exact project name<input id="confirm" autocomplete="off"></label><button id="delete">Permanently delete project</button><p id="message" role="status"></p></section><script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/dist/umd/supabase.js"></script><script>(async function(){var cfg=${config},client=window.supabase.createClient(cfg.url,cfg.key),status=document.getElementById('message'),select=document.getElementById('projects');async function rpc(name,args){var session=await client.auth.getSession();if(!session.data.session)throw Error('Sign in to Continuity first.');var r=await fetch(cfg.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:cfg.key,Authorization:'Bearer '+session.data.session.access_token,'Content-Type':'application/json'},body:JSON.stringify(args)});if(!r.ok)throw Error('Request could not complete. Refresh and retry.');return r.json()}async function load(){var rows=await rpc('list_continuity_owned_projects',{});select.replaceChildren();rows.forEach(function(p){select.add(new Option(p.name,p.id))});if(!rows.length)status.textContent='No projects to export or delete.'}document.getElementById('export').onclick=async function(){this.disabled=true;try{if(!select.value)throw Error('Choose a project first.');var data=await rpc('export_continuity_project',{p_project:select.value}),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='continuity-project.json';a.click();setTimeout(function(){URL.revokeObjectURL(url)},1000);status.textContent='Complete archive downloaded.'}catch(e){status.textContent=e.message}finally{this.disabled=false}};document.getElementById('delete').onclick=async function(){this.disabled=true;try{if(!select.value)throw Error('Choose a project first.');if(document.getElementById('confirm').value!==select.selectedOptions[0].textContent)throw Error('Type the exact project name to confirm deletion.');var done=await rpc('delete_continuity_project',{p_project:select.value,p_confirmation:document.getElementById('confirm').value});if(!done)throw Error('Project was not deleted. Refresh and retry.');document.getElementById('confirm').value='';await load();status.textContent='Project and associated story data deleted.'}catch(e){status.textContent=e.message}finally{this.disabled=false}};try{await load()}catch(e){status.textContent=e.message}})();</script>`));
});
installPluginAuth(app, APP_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY);

app.get(["/", "/app"], (_req, res) => {
  const supabaseUrl = JSON.stringify(SUPABASE_URL);
  const supabaseAnonKey = JSON.stringify(SUPABASE_ANON_KEY);
  const appBaseUrl = JSON.stringify(APP_BASE_URL);
  const connectLead = landingConnectLead(APP_BASE_URL);
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="directree-verify" content="directree-verify=79135f57f5cd21f94b6a0e44bfb2ef19">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#080b12">
  <title>Continuity</title><link rel="icon" href="/icon.svg">
  <style>
    :root{color-scheme:dark;--bg:#080b12;--panel:#101520;--panel2:#151c2a;--line:#273247;--text:#f5f7fb;--muted:#aab4c7;--accent:#8b7cff;--accent2:#5eead4;--danger:#ff718c}
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 70% -10%,#202553 0,transparent 34%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
    .shell{max-width:980px;margin:0 auto;padding:28px 20px 72px}.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:56px}.brand{display:flex;align-items:center;gap:12px;font-weight:850;font-size:20px;letter-spacing:-.4px}.mark{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,var(--accent),#50c7ff);box-shadow:0 0 40px #7569ff55}.pill{border:1px solid var(--line);background:#0d121b;color:var(--muted);border-radius:999px;padding:8px 12px;font-size:13px}
    .hero{display:grid;grid-template-columns:1.25fr .75fr;gap:38px;align-items:center}.eyebrow{color:var(--accent2);font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{font-size:clamp(48px,8vw,84px);line-height:.95;letter-spacing:-.06em;margin:14px 0 20px}.hero p{color:var(--muted);font-size:19px;line-height:1.6;max-width:680px}.card{background:linear-gradient(180deg,#151b28,#0d121b);border:1px solid var(--line);border-radius:24px;padding:24px;box-shadow:0 30px 80px #0007}.mini{display:grid;gap:12px}.miniRow{padding:14px 15px;border:1px solid var(--line);border-radius:15px;background:#0b1018}.miniRow b{display:block;margin-bottom:5px}.miniRow span{color:var(--muted);font-size:13px}
    .actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.btn{appearance:none;border:0;border-radius:14px;padding:14px 18px;font-weight:800;font-size:15px;cursor:pointer;transition:.18s transform,.18s opacity;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:9px}.btn:active{transform:scale(.98)}.primary{background:linear-gradient(135deg,var(--accent),#6457ea);color:white}.secondary{background:#151b26;border:1px solid var(--line);color:var(--text)}.btn[disabled]{opacity:.5;cursor:wait}
    .section{margin-top:64px}.section h2{font-size:30px;letter-spacing:-.03em;margin-bottom:8px}.sectionLead{color:var(--muted);margin-top:0}.plans{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}.plan{border:1px solid var(--line);border-radius:22px;padding:24px;background:linear-gradient(180deg,#111722,#0b1018);position:relative}.plan.featured{border-color:#7569ff99;box-shadow:0 0 0 1px #7569ff22 inset}.tag{position:absolute;right:18px;top:18px;background:#7569ff22;color:#bdb5ff;border:1px solid #7569ff55;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase}.plan h3{font-size:24px;margin:0 0 8px}.plan p{color:var(--muted);min-height:44px}.plan ul{list-style:none;padding:0;margin:20px 0}.plan li{padding:7px 0;color:#dce2ed}.plan li:before{content:'✓';color:var(--accent2);margin-right:9px;font-weight:900}.plan .btn{width:100%}
    .account{margin-top:26px;display:none}.account.show{display:block}.accountGrid{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center}.email{font-weight:800}.status{color:var(--muted);font-size:14px;margin-top:5px}.notice{display:none;margin-top:20px;padding:14px 16px;border-radius:14px;border:1px solid #486152;background:#102219;color:#bdf5cf}.notice.show{display:block}.error{display:none;margin-top:16px;padding:13px 15px;border-radius:13px;background:#2a1018;border:1px solid #652334;color:#ffbcc9}.error.show{display:block}.footer{margin-top:72px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;color:#7f899c;font-size:13px}
    [hidden]{display:none!important}.subscriber .hero{grid-template-columns:1fr}.subscriber .hero h1{font-size:clamp(40px,7vw,64px)}.workspaceGrid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.field{display:block;margin:16px 0 6px;color:var(--muted)}input,textarea,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:#0b1018;color:var(--text);font:inherit}textarea{min-height:110px;resize:vertical}.entry{white-space:pre-wrap;overflow-wrap:anywhere}.email{overflow-wrap:anywhere}:focus-visible{outline:3px solid var(--accent2);outline-offset:3px}@media(max-width:760px){.workspaceGrid{grid-template-columns:1fr}}
    .workspaceGrid>*{min-width:0}.workspaceGrid{grid-template-columns:minmax(240px,.7fr) minmax(0,1.3fr)}.miniRow h4{overflow-wrap:anywhere}.workspaceTools{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:20px 0}.workspaceTools label{flex:1;min-width:180px}.workspaceTools button{flex-shrink:0}.subscriber.workspacePage .hero h1{font-size:32px}.subscriber.workspacePage .section{margin-top:28px}.miniRow{min-width:0}.entry{line-height:1.65}.btn{min-height:44px}#projectTitle{overflow-wrap:anywhere}#workspaceMessage{position:sticky;bottom:12px;padding:12px;background:#151b26;border-radius:10px}#workspaceMessage:empty{display:none}@media(max-width:760px){.workspaceGrid{grid-template-columns:minmax(0,1fr)}.hero h1{overflow-wrap:anywhere}.workspaceTools .btn{width:100%}}
    @media(max-width:760px){.shell{padding-top:20px}.nav{margin-bottom:38px}.hero{grid-template-columns:1fr}.heroAside{order:2}.hero h1{font-size:58px}.hero p{font-size:17px}.plans{grid-template-columns:1fr}.accountGrid{grid-template-columns:1fr}.footer{flex-direction:column}.pill{display:none}}
  </style>
</head>
<body>
  <main class="shell">
    <nav class="nav"><div class="brand"><span class="mark"></span>Continuity</div><span class="pill" id="servicePill">Service online</span></nav>
    <section class="hero">
      <div>
        <div class="eyebrow" id="heroEyebrow">Story canon that stays locked</div>
        <h1 id="heroTitle">Stop losing your characters.</h1>
        <p id="heroDescription">Continuity keeps a private story bible for characters, relationships, world rules, timelines, and approved scenes, then brings that canon into ChatGPT, Claude, Gemini, Grok, Cursor, and other MCP assistants.</p>
        ${connectLead}
        <div class="actions" id="signedOutActions"><button class="btn primary" id="googleBtn">Continue with Google</button><a class="btn secondary" href="#plans">See plans</a></div>
        <div class="account card" id="accountCard">
          <div class="accountGrid"><div><div class="eyebrow">Signed in</div><div class="email" id="userEmail">—</div><div class="status" id="subscriptionStatus">Checking account…</div></div><button class="btn secondary" id="signOutBtn">Sign out</button></div>
        </div>
        <div class="actions" id="proActions" hidden><a class="btn primary" href="/app">Open story workspace</a></div>
        <button class="btn secondary" id="refreshAccount" hidden>Refresh subscription status</button>
        <div class="notice" id="notice" role="status"></div><div class="error" id="error" role="alert"></div>
      </div>
      <aside class="heroAside card" id="salesAside">
        <div class="mini">
          <div class="miniRow"><b>Character Bible</b><span>Appearance, personality, abilities, history, relationships.</span></div>
          <div class="miniRow"><b>Locked Canon</b><span>Permanent facts cannot be silently contradicted.</span></div>
          <div class="miniRow"><b>Scene Memory</b><span>The latest approved scenes remain short-range continuity anchors.</span></div>
          <div class="miniRow"><b>Continuity Audit</b><span>Checks new writing against established canon before drift happens.</span></div>
        </div>
      </aside>
    </section>

    <section class="section" id="plans" hidden>
      <h2>Choose your Continuity plan</h2>
      <p class="sectionLead">Start with a 14-day trial. Secure checkout and subscription billing are handled by Stripe.</p>
      <div class="plans">
        <article class="plan"><h3>Monthly</h3><p>Flexible access for active storytellers.</p><ul><li>Persistent story projects</li><li>Character and world canon</li><li>Approved-scene continuity</li><li>Continuity audits</li></ul><button class="btn secondary checkout" data-plan="monthly">Start monthly trial</button></article>
        <article class="plan featured"><span class="tag">Best value</span><h3>Yearly</h3><p>Long-term continuity for stories that keep growing.</p><ul><li>Everything in Monthly</li><li>One annual billing cycle</li><li>Built for long-running universes</li><li>Same 14-day trial</li></ul><button class="btn primary checkout" data-plan="annual">Start yearly trial</button></article>
      </div>
    </section>
    <section class="section" id="workspace" hidden aria-labelledby="workspaceTitle">
      <div class="eyebrow">Your Continuity workspace</div><h2 id="workspaceTitle">Your stories, ready to continue.</h2>
      <p class="sectionLead">Create a story project, save its canon, and revisit your latest approved scenes.</p>
      <section class="card"><h3>Continue this story in a connected assistant</h3><p><a href="/connect">Connect Continuity</a> to ChatGPT, Claude, Gemini, Grok, Cursor, or another MCP client, then ask it to retrieve your project before drafting. Say “save a checkpoint” to preserve progress and open threads without making new canon official.</p><p id="resumePrompt" class="entry"></p></section><div class="workspaceGrid"><div class="card">
        <h3>Story projects</h3><p id="projectMessage" role="status"></p>
        <label class="field" for="projectSelect">Open a project</label><select id="projectSelect"><option value="">Choose a project</option></select>
        <button class="btn secondary" id="reloadProjects" type="button">Refresh projects</button>
        <form id="projectForm"><h3>Start a new story</h3><label class="field" for="projectName">Project name</label><input id="projectName" required maxlength="200">
        <label class="field" for="projectDescription">Description (optional)</label><textarea id="projectDescription" maxlength="4000"></textarea>
        <button class="btn primary" type="submit">Create project</button></form>
      </div><div class="card" id="projectDetail" hidden>
        <h3 id="projectTitle"></h3><p class="entry" id="projectSummary"></p>
        <form id="canonForm"><h3>Add to your story bible</h3>
          <label class="field" for="canonTitle">Entry title</label><input id="canonTitle" required maxlength="200">
          <label class="field" for="canonKind">Category</label><select id="canonKind"><option>CHARACTER</option><option>RELATIONSHIP</option><option>APPEARANCE</option><option>ABILITY</option><option>LOCATION</option><option>WORLD_RULE</option><option>TIMELINE</option><option>PLOT_THREAD</option><option>ITEM</option><option>FACTION</option><option>OTHER</option></select>
          <label class="field" for="canonStatus">Canon state</label><select id="canonStatus"><option>DEVELOPING</option><option>LOCKED</option><option>UNKNOWN</option></select>
          <label class="field" for="canonContent">Facts or story bible text</label><textarea id="canonContent" required maxlength="50000"></textarea>
          <p class="status">Locked facts are established canon. Developing facts remain provisional. Unknown facts stay unspecified.</p>
          <button class="btn primary" type="submit">Save canon entry</button><p class="status">Unfinished entries stay available while switching projects in this tab. Save before leaving or signing out.</p>
        </form>
      </div></div>
      <div id="storyContent" hidden>
        <div class="workspaceTools"><label for="canonSearch">Search story bible<input id="canonSearch" type="search" placeholder="Search titles, facts, or categories"></label><label for="canonFilter">Canon state<select id="canonFilter"><option value="">All states</option><option>LOCKED</option><option>DEVELOPING</option><option>UNKNOWN</option></select></label><button class="btn secondary" id="exportStory" disabled>Export story bible</button><button class="btn secondary" id="retryStory">Refresh story</button></div>
        <h3>Story bible</h3><p id="canonCount" role="status"></p><div class="mini" id="canonList"></div>
        <details class="card" id="canonEditPanel"><summary>Revise an existing canon entry</summary><p>Select “Edit / history” on an entry below. Revisions preserve earlier content.</p><form id="canonEditForm"><p id="editingTitle"></p><label class="field" for="editState">Canon state</label><select id="editState"><option>DEVELOPING</option><option>LOCKED</option><option>UNKNOWN</option><option>RETIRED</option></select><label class="field" for="editContent">Revised content</label><textarea id="editContent" required maxlength="12000"></textarea><label class="field" for="editReason">Reason for revision</label><input id="editReason" required maxlength="1000"><button class="btn primary">Save approved revision</button></form><div id="revisionHistory"></div></details>
        <h3>Story checkpoints <small>· provisional, separate from canon</small></h3><div id="checkpointList" class="mini"></div><button class="btn secondary" id="olderCheckpoints">Show older checkpoints</button>
        <details class="card"><summary>Save a story checkpoint</summary><p>Keep the current situation and next steps recoverable. This does not approve new facts or scenes. A connected assistant can fill these through Continuity tools with your permission.</p><form id="checkpointForm"><label class="field" for="checkpointTitle">Checkpoint title</label><input id="checkpointTitle" required maxlength="200"><label class="field" for="checkpointState">Current story state</label><textarea id="checkpointState" required maxlength="6000"></textarea><label class="field" for="checkpointThreads">Open threads or unapproved ideas, one per line</label><textarea id="checkpointThreads" maxlength="8000"></textarea><label class="field" for="checkpointNext">Next steps, one per line</label><textarea id="checkpointNext" maxlength="4000"></textarea><button class="btn primary">Save provisional checkpoint</button></form><p id="checkpointMessage" role="status"></p></details>
        <h3>Last five approved scenes</h3><div class="mini" id="sceneList"></div>
        <details class="card"><summary>Record an approved scene</summary><form id="sceneForm">
          <label class="field" for="sceneNumber">Scene number</label><input id="sceneNumber" type="number" min="1" max="2147483647" step="1" required>
          <label class="field" for="sceneTitle">Scene title (optional)</label><input id="sceneTitle" maxlength="200">
          <label class="field" for="sceneSummary">Approved scene summary</label><textarea id="sceneSummary" required maxlength="50000"></textarea>
          <label class="field" for="sceneNotes">Continuity notes (optional)</label><textarea id="sceneNotes" maxlength="10000"></textarea>
          <p class="status">Record only scenes you have approved. An existing scene number will not be overwritten.</p><button class="btn primary" type="submit">Save approved scene</button>
        </form></details>
      </div>
      <p class="status" id="workspaceMessage" role="status"></p>
    </section>
    <footer class="footer"><a href="/connect">Connect an assistant</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><a href="/data">Your data</a><span>Continuity · one story bible for your assistants</span><a href="/health" style="color:#9fa8bb">System health</a></footer>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/dist/umd/supabase.js"></script>
<script>
(function(){
  var SUPABASE_URL=${supabaseUrl};
  var SUPABASE_ANON_KEY=${supabaseAnonKey};
  var APP_BASE_URL=${appBaseUrl};
  var token='';
  var currentSession=null, profileVersion=0, projectVersion=0;
  var isPro=false, profileReady=false, workspaceLoaded=false;
  var projects=[], selectedProject='', pollTimer=null, pollAttempts=0;
  var editingEntry=null, checkpointRows=[], checkpointOffset=0, checkpointProject='', checkpointDrafts={}, checkpointKey='', checkpointPayload='', savingCheckpoint=false;
  var canonRows=[], sceneRows=[], storyReady=false, drafts={}, formProject='', savingCanon=false, savingScene=false, creatingProject=false;
  function el(id){return document.getElementById(id);}
  var originalTitle=el('heroTitle').textContent, originalDescription=el('heroDescription').textContent;
  var supabaseClient=null;
  var googleBtn=document.getElementById('googleBtn');
  var signOutBtn=document.getElementById('signOutBtn');
  var accountCard=document.getElementById('accountCard');
  var signedOutActions=document.getElementById('signedOutActions');
  var userEmail=document.getElementById('userEmail');
  var subStatus=document.getElementById('subscriptionStatus');
  var notice=document.getElementById('notice');
  var errorBox=document.getElementById('error');

  function showError(msg){ errorBox.textContent=msg; errorBox.classList.add('show'); }
  function clearError(){ errorBox.classList.remove('show'); }
  function showNotice(msg){ notice.textContent=msg; notice.classList.add('show'); }
  function renderAccess(pro,ready){
    isPro=pro; profileReady=ready;
    document.body.classList.toggle('subscriber',pro); document.body.classList.toggle('workspacePage',pro&&location.pathname==='/app');
    el('plans').hidden=pro||!ready; el('salesAside').hidden=pro;
    el('proActions').hidden=!pro||location.pathname==='/app';
    el('workspace').hidden=!pro||location.pathname!=='/app';
    el('heroEyebrow').textContent=pro?'Continuity Pro':'Story canon that stays locked';
    el('heroTitle').textContent=pro?'Welcome back. Your canon awaits.':originalTitle;
    el('heroDescription').textContent=pro?'Your Pro access is ready. Open your story workspace to pick up an existing project or start a new story bible.':originalDescription;
    document.querySelectorAll('.checkout').forEach(function(btn){btn.disabled=!ready||pro;});
    if(!pro){drafts={}; formProject=''; canonRows=[]; sceneRows=[]; storyReady=false; el('canonCount').textContent=''; checkpointDrafts={};checkpointProject='';editingEntry=null;checkpointKey='';checkpointPayload='';el('checkpointList').replaceChildren();el('checkpointForm').reset();el('canonEditForm').reset();el('revisionHistory').replaceChildren();el('canonSearch').value=''; el('sceneForm').reset(); workspaceLoaded=false; selectedProject=''; projects=[]; projectVersion++; el('projectSelect').replaceChildren(); el('projectDetail').hidden=true; el('storyContent').hidden=true; el('canonList').replaceChildren(); el('sceneList').replaceChildren(); el('projectForm').reset(); el('canonForm').reset(); el('workspaceMessage').textContent='';}
    if(pro&&location.pathname==='/app'&&!workspaceLoaded){workspaceLoaded=true; void loadProjects();}
  }
  function setSignedOut(){token=''; currentSession=null; profileVersion++; clearTimeout(pollTimer); renderAccess(false,true); el('refreshAccount').hidden=true; notice.classList.remove('show'); signedOutActions.style.display='flex'; accountCard.classList.remove('show');}
  function setSignedIn(session){
    if(!currentSession||currentSession.user.id!==session.user.id){renderAccess(false,false); subStatus.textContent='Checking subscription…';}
    currentSession=session;
    token=session&&session.access_token?session.access_token:'';
    if(!token){ setSignedOut(); return; }
    userEmail.textContent=(session.user&&session.user.email)||'Google account';
    signedOutActions.style.display='none';
    accountCard.classList.add('show');
  }
  async function api(path,opts){
    var options=opts||{}; options.headers=Object.assign({'apikey':SUPABASE_ANON_KEY},options.headers||{});
    if(token) options.headers.Authorization='Bearer '+token;
    var controller=new AbortController(), timer=setTimeout(function(){controller.abort();},20000); options.signal=controller.signal;
    try{
      var r=await fetch(SUPABASE_URL+path,options); var txt=await r.text();
      if(!r.ok) throw new Error(txt||('Request failed '+r.status));
      return txt?JSON.parse(txt):null;
    }finally{clearTimeout(timer);}
  }
  async function loadProfile(session){
    if(!session||!session.user) return;
    var version=++profileVersion; clearTimeout(pollTimer); el('refreshAccount').hidden=false;
    try{
      var profiles=await api('/rest/v1/profiles?id=eq.'+encodeURIComponent(session.user.id)+'&select=plan,subscription_status,current_period_end',{method:'GET'});
      if(version!==profileVersion||!currentSession||currentSession.user.id!==session.user.id) return;
      var p=profiles&&profiles[0], pro=Boolean(p&&(p.subscription_status==='trialing'||p.subscription_status==='active'));
      var pending=checkout==='success'&&!pro;
      renderAccess(pro,!pending);
      subStatus.textContent=pro?(p.subscription_status==='trialing'?'Continuity Pro · Trial in progress':'Continuity Pro · Active'):(pending?'Confirming your subscription…':p&&p.subscription_status?'Subscription: '+p.subscription_status:'Signed in · choose a plan below');
      if(pro&&checkout==='success') showNotice('Your Pro access is ready. Welcome to Continuity.');
      if(pending){
        showNotice(pollAttempts<10?'Checkout completed. Waiting for subscription confirmation…':'Confirmation is taking longer than expected. Refresh your subscription status shortly; you do not need to check out again.');
        if(pollAttempts++<10) pollTimer=setTimeout(function(){void loadProfile(currentSession);},3000);
      }
    }catch(e){
      if(version!==profileVersion) return;
      renderAccess(false,false); subStatus.textContent='Unable to confirm your subscription. Use Refresh subscription status to try again.';
    }
  }
  el('refreshAccount').addEventListener('click',function(){pollAttempts=0; if(currentSession) void loadProfile(currentSession);});
  function workspaceMessage(message){el('workspaceMessage').textContent=message;}
  function busyForm(form,busy){form.querySelectorAll('input,textarea,select').forEach(function(field){field.disabled=busy;});}
  async function loadProjects(preferredId){
    var version=++projectVersion; el('projectMessage').textContent='Loading your projects…';
    try{
      var rows=await api('/rest/v1/story_projects?select=id,name,description&order=updated_at.desc&limit=50');
      if(version!==projectVersion||!isPro) return;
      projects=rows||[]; el('projectSelect').replaceChildren(new Option('Choose a project',''));
      projects.forEach(function(p){el('projectSelect').add(new Option(p.name,p.id));});
      el('projectMessage').textContent=projects.length?'Choose a story below. Showing up to 50 recently updated projects.':'No projects yet. Create your first story below.';
      selectedProject=projects.some(function(p){return p.id===preferredId;})?preferredId:''; el('projectSelect').value=selectedProject; await loadStory();
    }catch(e){if(version===projectVersion) el('projectMessage').textContent='Could not load projects. Use Refresh projects to try again.';}
  }
  function keepDraft(){
    if(!formProject) return;
    drafts[formProject]=['canonTitle','canonContent','canonKind','canonStatus','sceneNumber','sceneTitle','sceneSummary','sceneNotes'].map(function(id){return el(id).value;});
  }
  function restoreDraft(){
    el('canonForm').reset(); el('sceneForm').reset();
    var draft=drafts[formProject];
    if(draft) ['canonTitle','canonContent','canonKind','canonStatus','sceneNumber','sceneTitle','sceneSummary','sceneNotes'].forEach(function(id,i){el(id).value=draft[i];});
  }
  function cards(id,rows,empty,heading,body){
    var list=el(id); list.replaceChildren();
    if(!rows.length){var p=document.createElement('p'); p.textContent=empty; list.append(p);}
    rows.forEach(function(row){var card=document.createElement('article'); card.className='miniRow'; var h=document.createElement('h4'); h.textContent=heading(row); var p=document.createElement('p'); p.className='entry'; p.textContent=body(row); card.append(h,p); list.append(card);});
  }
  function renderCanon(){
    var query=el('canonSearch').value.trim().toLowerCase(), state=el('canonFilter').value;
    var rows=canonRows.filter(function(r){return (!state||r.status===state)&&(!query||[r.title,r.content,r.kind].join(' ').toLowerCase().includes(query));});
    el('canonCount').textContent=rows.length+' of '+canonRows.length+' entries';
    cards('canonList',rows,canonRows.length?'No matching entries. Try another search or canon state.':'No canon yet. Add your first character, world rule, or story bible entry above.',function(r){return r.title+' · '+r.kind+' · '+r.status;},function(r){return r.content;});
  }
  var renderCanonBase=renderCanon;
  renderCanon=function(){renderCanonBase();var query=el('canonSearch').value.trim().toLowerCase(),state=el('canonFilter').value;var rows=canonRows.filter(function(r){return (!state||r.status===state)&&(!query||[r.title,r.content,r.kind].join(' ').toLowerCase().includes(query));});el('canonList').querySelectorAll('article').forEach(function(card,i){var row=rows[i],button=document.createElement('button');button.className='btn secondary';button.textContent='Edit / history';button.onclick=async function(){row.project_id=selectedProject;editingEntry=row;var pid=selectedProject;el('canonEditPanel').open=true;el('editingTitle').textContent=row.title+' · revision '+row.revision;el('editState').value=row.status;el('editContent').value=row.content;el('editReason').value='';el('revisionHistory').textContent='Loading history…';try{var history=await api('/rest/v1/canon_revisions?canon_entry_id=eq.'+encodeURIComponent(row.id)+'&order=revision.desc&limit=50');if(pid!==selectedProject||editingEntry!==row)return;cards('revisionHistory',history,'No earlier revisions.',function(r){return 'Revision '+r.revision+' · '+r.reason},function(r){return 'Previous: '+r.previous_content+' → Revised: '+r.new_content})}catch(e){if(pid===selectedProject)el('revisionHistory').textContent='History could not load. Try again.'}};card.append(button)})};
  el('canonEditForm').onsubmit=async function(event){event.preventDefault();if(!editingEntry||!isPro)return;var row=editingEntry,pid=selectedProject,button=this.querySelector('button');button.disabled=true;try{await api('/rest/v1/rpc/save_continuity_canon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_project:pid,p_kind:row.kind,p_title:row.title,p_status:el('editState').value,p_content:el('editContent').value,p_tags:row.tags||[],p_reason:el('editReason').value,p_expected:row.revision})});if(pid!==selectedProject||!isPro)return;editingEntry=null;this.reset();await loadStory();workspaceMessage('Approved revision saved with history.')}catch(e){workspaceMessage('Revision could not save. Another session may have changed this entry. Refresh and compare before retrying; your revised text is still here.')}finally{button.disabled=false}};
  function checkpointDraft(){if(checkpointProject)checkpointDrafts[checkpointProject]=['checkpointTitle','checkpointState','checkpointThreads','checkpointNext'].map(function(id){return el(id).value})}
  var checkpointVersion=0;
  async function loadCheckpoints(append){
    var checkpointRequest=++checkpointVersion;
    var pid=selectedProject;
    if(!append){checkpointDraft();checkpointProject=pid;checkpointOffset=0;checkpointRows=[];el('checkpointForm').reset();var draft=checkpointDrafts[pid];if(draft)['checkpointTitle','checkpointState','checkpointThreads','checkpointNext'].forEach(function(id,i){el(id).value=draft[i]});}
    if(!pid||!isPro){el('checkpointList').replaceChildren();return}
    try{var rows=await api('/rest/v1/story_checkpoints?project_id=eq.'+encodeURIComponent(pid)+'&select=*&order=created_at.desc,id&limit=20&offset='+checkpointOffset);if(checkpointRequest!==checkpointVersion||pid!==selectedProject||!isPro)return;checkpointRows=checkpointRows.concat(rows||[]);checkpointOffset=checkpointRows.length;cards('checkpointList',checkpointRows,'No checkpoints yet. Save progress here or ask your assistant to save a checkpoint.',function(r){return r.title+' · provisional'},function(r){return r.story_state+' | Open: '+(r.open_threads||[]).join('; ')+' | Next: '+(r.next_steps||[]).join('; ')});el('olderCheckpoints').hidden=rows.length<20;}
    catch(e){if(checkpointRequest===checkpointVersion&&pid===selectedProject)el('checkpointList').textContent='Checkpoints could not load. Use Refresh story to retry.'}
  }
  el('olderCheckpoints').onclick=function(){void loadCheckpoints(true)};
  el('checkpointForm').onsubmit=async function(event){event.preventDefault();if(!isPro||!selectedProject||savingCheckpoint)return;var pid=selectedProject,user=currentSession.user.id,button=this.querySelector('button'),a={p_project:pid,p_title:el('checkpointTitle').value.trim(),p_state:el('checkpointState').value.trim(),p_threads:el('checkpointThreads').value.split(String.fromCharCode(10)).map(function(x){return x.trim()}).filter(Boolean),p_next:el('checkpointNext').value.split(String.fromCharCode(10)).map(function(x){return x.trim()}).filter(Boolean)};if(a.p_threads.length>20||a.p_next.length>10||a.p_threads.concat(a.p_next).some(function(x){return x.length>500})){el('checkpointMessage').textContent='Use up to 20 open threads and 10 next steps, at most 500 characters per line.';return}var payload=JSON.stringify(a);if(payload!==checkpointPayload){checkpointKey=crypto.randomUUID();checkpointPayload=payload;}savingCheckpoint=true;button.disabled=true;try{await api('/rest/v1/rpc/save_continuity_checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({p_id:checkpointKey},a))});if(!currentSession||currentSession.user.id!==user)return;delete checkpointDrafts[pid];if(pid===selectedProject){this.reset();checkpointProject='';await loadCheckpoints(false);el('checkpointMessage').textContent='Checkpoint saved. Canon and approved scenes were not changed.'}checkpointKey='';checkpointPayload='';}catch(e){if(pid===selectedProject)el('checkpointMessage').textContent='Checkpoint could not save. Your notes remain here. Retry to safely reuse the same checkpoint.'}finally{savingCheckpoint=false;button.disabled=false}};
  el('canonSearch').addEventListener('input',renderCanon);
  el('canonFilter').addEventListener('change',renderCanon);
  el('retryStory').addEventListener('click',function(){if(isPro) void loadStory();});
  async function loadStory(){
    keepDraft(); formProject=selectedProject; restoreDraft();
    if(editingEntry&&editingEntry.project_id!==selectedProject){editingEntry=null;el('canonEditForm').reset();el('editingTitle').textContent='';el('revisionHistory').replaceChildren();}void loadCheckpoints(false);
    var version=++projectVersion, project=projects.find(function(p){return p.id===selectedProject;});
    storyReady=false; canonRows=[]; sceneRows=[]; el('exportStory').disabled=true;
    el('projectDetail').hidden=!project; el('storyContent').hidden=!project;
    el('canonList').replaceChildren(); el('sceneList').replaceChildren(); el('canonCount').textContent='';
    workspaceMessage(''); if(!project) return false;
    el('resumePrompt').textContent='Use Continuity to resume '+project.name+' (project '+project.id+'). Retrieve canon and the latest checkpoint before drafting.';
    el('projectTitle').textContent=project.name; el('projectSummary').textContent=project.description||'';
    el('canonList').textContent='Loading canon…'; el('sceneList').textContent='Loading scenes…';
    workspaceMessage('Loading story bible and scenes…');
    var results=await Promise.allSettled([
      api('/rest/v1/canon_entries?project_id=eq.'+encodeURIComponent(project.id)+'&status=neq.RETIRED&select=id,kind,title,status,content,tags,revision&order=updated_at.desc'),
      api('/rest/v1/approved_scenes?project_id=eq.'+encodeURIComponent(project.id)+'&select=scene_number,title,summary,continuity_notes&order=approved_at.desc&limit=5')
    ]);
    if(version!==projectVersion||!isPro) return false;
    if(results[0].status==='fulfilled'){canonRows=results[0].value||[];renderCanon();}
    else el('canonList').textContent='Could not load canon. Use Refresh story to retry.';
    if(results[1].status==='fulfilled'){
      sceneRows=results[1].value||[];
      cards('sceneList',sceneRows,'No approved scenes recorded yet.',function(r){return 'Scene '+r.scene_number+(r.title?' · '+r.title:'');},function(r){return r.summary+(r.continuity_notes?'\\n\\nContinuity notes: '+r.continuity_notes:'');});
    }else el('sceneList').textContent='Could not load scenes. Use Refresh story to retry.';
    storyReady=results.every(function(r){return r.status==='fulfilled';}); el('exportStory').disabled=!storyReady;
    workspaceMessage(storyReady?'':'Some story content could not load. Your draft is safe; use Refresh story to retry.');
    return storyReady;
  }
  el('exportStory').addEventListener('click',function(){
    if(!isPro||!storyReady) return;
    var project=projects.find(function(p){return p.id===selectedProject;}); if(!project) return;
    var lines=['# '+project.name,project.description||'','## Story bible'];
    canonRows.forEach(function(r){lines.push('### '+r.title,r.kind+' · '+r.status,r.content);});
    lines.push('## Last five approved scenes');
    sceneRows.forEach(function(r){lines.push('### Scene '+r.scene_number+(r.title?' · '+r.title:''),r.summary,r.continuity_notes||'');});
    var url=URL.createObjectURL(new Blob([lines.join('\\n\\n')],{type:'text/markdown;charset=utf-8'}));
    var a=document.createElement('a'); a.href=url; a.download='continuity-story-bible.md'; a.click(); setTimeout(function(){URL.revokeObjectURL(url);},1000);
    workspaceMessage('Story bible exported with all loaded entries and the last five approved scenes.');
  });
  window.addEventListener('beforeunload',function(event){
    keepDraft(); checkpointDraft();
    if(savingCheckpoint||Object.values(checkpointDrafts).some(function(d){return d.some(Boolean)})||creatingProject||savingCanon||savingScene||el('projectName').value||el('projectDescription').value||Object.values(drafts).some(function(d){return d[0]||d[1]||d[4]||d[5]||d[6]||d[7];})){event.preventDefault();event.returnValue='';}
  });
  el('projectSelect').addEventListener('change',function(){selectedProject=this.value; void loadStory();});
  el('reloadProjects').addEventListener('click',function(){if(isPro) void loadProjects(selectedProject);});
  el('projectForm').addEventListener('submit',async function(event){
    event.preventDefault(); if(!isPro||!currentSession||creatingProject) return;
    var name=el('projectName').value.trim(); if(!name) return;
    var userId=currentSession.user.id, btn=this.querySelector('button'); creatingProject=true; busyForm(this,true); btn.disabled=true; btn.textContent='Creating…';
    try{
      var rows=await api('/rest/v1/story_projects',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({owner_id:userId,name:name,description:el('projectDescription').value.trim()||null})});
      if(!currentSession||currentSession.user.id!==userId) return;
      this.reset(); await loadProjects(rows[0].id); workspaceMessage('Project created. Add your first canon entry.');
    }catch(e){if(currentSession&&currentSession.user.id===userId) workspaceMessage('Could not create the project. Your form is still here; please try again.');}
    finally{creatingProject=false;busyForm(this,false);btn.disabled=false;btn.textContent='Create project';}
  });
  el('canonForm').addEventListener('submit',async function(event){
    event.preventDefault(); if(!isPro||!selectedProject||savingCanon) return;
    var title=el('canonTitle').value.trim(),content=el('canonContent').value.trim(); if(!title||!content) return;
    var projectId=selectedProject, userId=currentSession.user.id, btn=this.querySelector('button'); savingCanon=true; busyForm(this,true); btn.disabled=true; btn.textContent='Saving…';
    try{
      await api('/rest/v1/canon_entries',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({project_id:projectId,title:title,content:content,kind:el('canonKind').value,status:el('canonStatus').value})});
      if(!isPro||!currentSession||currentSession.user.id!==userId) return;
      if(drafts[projectId]) {drafts[projectId][0]='';drafts[projectId][1]='';}
      if(selectedProject!==projectId) return;
      this.reset(); var loaded=await loadStory(); if(isPro&&selectedProject===projectId) workspaceMessage(loaded?'Canon entry saved.':'Canon entry saved, but the list could not refresh. Use Refresh story.');
    }catch(e){if(currentSession&&currentSession.user.id===userId&&selectedProject===projectId) workspaceMessage('Could not save this entry. Your text is still here; check for an existing entry with the same title and category, then try again.');}
    finally{savingCanon=false;busyForm(this,false);btn.disabled=false;btn.textContent='Save canon entry';}
  });
  el('sceneForm').addEventListener('submit',async function(event){
    event.preventDefault(); if(!isPro||!selectedProject||savingScene) return;
    var number=Number(el('sceneNumber').value),summary=el('sceneSummary').value.trim();
    if(!Number.isInteger(number)||number<1||number>2147483647||!summary) return;
    var projectId=selectedProject,userId=currentSession.user.id,btn=this.querySelector('button');savingScene=true;busyForm(this,true);btn.disabled=true;btn.textContent='Saving…';
    try{
      await api('/rest/v1/approved_scenes',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({project_id:projectId,scene_number:number,title:el('sceneTitle').value.trim()||null,summary:summary,continuity_notes:el('sceneNotes').value.trim()||null})});
      if(!isPro||!currentSession||currentSession.user.id!==userId) return;
      if(drafts[projectId]) for(var i=4;i<8;i++) drafts[projectId][i]='';
      if(selectedProject!==projectId) return;
      this.reset();var loaded=await loadStory();if(isPro&&selectedProject===projectId) workspaceMessage(loaded?'Approved scene saved.':'Approved scene saved, but the list could not refresh. Use Refresh story.');
    }catch(e){if(currentSession&&currentSession.user.id===userId&&selectedProject===projectId) workspaceMessage('Could not save the scene. Your draft is still here. Use a new scene number and try again.');}
    finally{savingScene=false;busyForm(this,false);btn.disabled=false;btn.textContent='Save approved scene';}
  });
  function resumePluginConnection(){
    try{
      var saved=sessionStorage.getItem('continuityPluginReturn');if(!saved)return false;
      sessionStorage.removeItem('continuityPluginReturn');var pending=JSON.parse(saved);
      if(!pending||typeof pending.createdAt!=='number'||Date.now()-pending.createdAt>600000||pending.createdAt>Date.now())return false;
      if(pending.id!==null&&(typeof pending.id!=='string'||pending.id.length>200))return false;
      location.assign(pending.id?'/oauth/consent?authorization_id='+encodeURIComponent(pending.id):'/connections');return true;
    }catch(e){return false;}
  }
  async function initializeAuth(){
    if(!SUPABASE_URL||!SUPABASE_ANON_KEY||!window.supabase){ setSignedOut(); showError('Google sign-in is not configured yet.'); return; }
    supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{flowType:'implicit',persistSession:true,detectSessionInUrl:true,autoRefreshToken:true}});
    supabaseClient.auth.onAuthStateChange(function(_event,session){
      if(session){ if(resumePluginConnection())return; setSignedIn(session); void loadProfile(session); }
      else setSignedOut();
    });
    try{
      var result=await supabaseClient.auth.getSession();
      var session=result&&result.data?result.data.session:null;
      if(session){ if(resumePluginConnection())return; setSignedIn(session); await loadProfile(session); }
      else setSignedOut();
    }catch(e){ setSignedOut(); showError(e&&e.message?e.message:String(e)); }
  }
  googleBtn.addEventListener('click',async function(){
    clearError();
    if(!supabaseClient){ showError('Google sign-in is still loading. Try again in a moment.'); return; }
    googleBtn.disabled=true; var old=googleBtn.textContent; googleBtn.textContent='Opening Google…';
    try{
      var result=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo:APP_BASE_URL}});
      if(result.error) throw result.error;
    }catch(e){ googleBtn.disabled=false; googleBtn.textContent=old; showError(e&&e.message?e.message:String(e)); }
  });
  signOutBtn.addEventListener('click',async function(){
    clearError();
    try{
      if(supabaseClient){var result=await supabaseClient.auth.signOut(); if(result.error) throw result.error;}
      setSignedOut(); location.href='/';
    }catch(e){showError('Sign-out failed. You are still signed in; please try again.');}
  });
  document.querySelectorAll('.checkout').forEach(function(btn){
    btn.addEventListener('click',async function(){
      clearError();
      if(!token){ showError('Sign in with Google first, then choose your plan.'); document.getElementById('googleBtn').scrollIntoView({behavior:'smooth',block:'center'}); return; }
      if(isPro||!profileReady){showError('Refresh your subscription status before starting checkout.'); return;}
      var old=btn.textContent; btn.disabled=true; btn.textContent='Opening checkout…';
      try{
        var r=await fetch('/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({plan:btn.getAttribute('data-plan')})});
        var data=await r.json(); if(!r.ok) throw new Error(data.error||'Unable to start checkout');
        location.href=data.url;
      }catch(e){ showError(e.message||String(e)); btn.disabled=false; btn.textContent=old; }
    });
  });
  var checkout=new URLSearchParams(location.search).get('checkout');
  if(checkout==='success') showNotice('Checkout completed. Your subscription is being confirmed.');
  if(checkout==='cancelled') showError('Checkout was cancelled. No changes were made.');
  initializeAuth();
})();
</script>
</body></html>`);
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "continuity",
  version: "0.5.0",
  supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
  stripeSecretConfigured: Boolean(STRIPE_SECRET_KEY),
  stripeMonthlyConfigured: Boolean(STRIPE_PRICE_MONTHLY),
  stripeYearlyConfigured: Boolean(STRIPE_PRICE_YEARLY),
  billingConfigured: Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_MONTHLY && STRIPE_PRICE_YEARLY)
}));

app.post("/billing/checkout", async (req, res) => {
  try {
    const { user } = await authenticatedUser(req);
    const plan = req.body?.plan === "annual" ? "annual" : "monthly";
    const price = plan === "annual"
      ? requireEnv("STRIPE_PRICE_YEARLY", STRIPE_PRICE_YEARLY)
      : requireEnv("STRIPE_PRICE_MONTHLY", STRIPE_PRICE_MONTHLY);
    const profiles = await supabaseRequest<Array<{ stripe_customer_id?: string | null }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
      { method: "GET" }, bearer(req)
    );

    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("line_items[0][price]", price);
    params.set("line_items[0][quantity]", "1");
    params.set("client_reference_id", user.id);
    params.set("metadata[supabase_user_id]", user.id);
    params.set("subscription_data[metadata][supabase_user_id]", user.id);
    params.set("subscription_data[trial_period_days]", "14");
    params.set("payment_method_collection", "always");
    params.set("success_url", `${APP_BASE_URL}/?checkout=success`);
    params.set("cancel_url", `${APP_BASE_URL}/?checkout=cancelled`);
    const customerId = profiles[0]?.stripe_customer_id;
    if (customerId) params.set("customer", customerId);
    else if (user.email) params.set("customer_email", user.email);

    const session = await stripeRequest<{ id: string; url: string }>("checkout/sessions", params);
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    res.status(400).json({ error: "Unable to create checkout. Verify sign-in and retry." });
  }
});

app.post("/billing/portal", async (req, res) => {
  try {
    const { user } = await authenticatedUser(req);
    const profiles = await supabaseRequest<Array<{ stripe_customer_id?: string | null }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
      { method: "GET" }, bearer(req)
    );
    const customer = profiles[0]?.stripe_customer_id;
    if (!customer) return res.status(400).json({ error: "No Stripe customer exists for this account yet" });
    const params = new URLSearchParams({ customer, return_url: APP_BASE_URL });
    const session = await stripeRequest<{ url: string }>("billing_portal/sessions", params);
    res.json({ url: session.url });
  } catch (error) {
    res.status(400).json({ error: "Unable to open billing management. Verify sign-in and retry." });
  }
});

function createMcpServer(token: string, userId: string) {
  return createStoryServer(<T>(path: string, options?: RequestInit) => supabaseRequest<T>(path, options, token), userId);
}

function guardMcpOrigin(req: Request, res: express.Response) {
  const origin = req.header("origin");
  if (!mcpBrowserOriginAllowed(origin, APP_BASE_URL)) {
    res.status(403).json({ error: "Origin is not allowed." });
    return false;
  }
  if (origin) res.set({ ...MCP_CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" });
  return true;
}

app.options("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  res.status(204).end();
});

app.post("/mcp", async (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  if(!allowPublic('mcp:'+req.ip,300,60000))return res.status(429).set('Retry-After','60').json({error:'Too many requests. Retry in one minute.'});
  let server: McpServer | undefined;
  let token = "", userId = "";
  // Tool discovery contains only schemas. All tool execution requires a verified subscriber.
  const publicMethods = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);
  if (!publicMethods.has(req.body?.method)) {
    try {
      const auth = await authenticatedUser(req);
      validateMcpClaims(auth.token,auth.user.id,`${SUPABASE_URL}/auth/v1`,`${APP_BASE_URL}/mcp`);
      if(!await supabaseRequest<boolean>('/rest/v1/rpc/verify_continuity_connection',{method:'POST',body:'{}'},auth.token))throw Error('Connection revoked');
      token = auth.token; userId = auth.user.id;
    } catch {
      res.set("WWW-Authenticate", `Bearer resource_metadata="${APP_BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: "Sign in to Continuity to use story tools." });
    }
    try {
      const profiles = await supabaseRequest<Array<{ subscription_status: string }>>(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=subscription_status`, {}, token);
      if (!profiles[0] || !["active", "trialing"].includes(profiles[0].subscription_status)) {
        return res.status(403).json({ error: "A Continuity Pro subscription or active trial is required.", access_information: `${APP_BASE_URL}/access` });
      }
    } catch {
      return res.status(503).json({ error: "Could not verify your subscription. Please retry." });
    }
  }
  try {
    if(userId) {
      const allowed=await supabaseRequest<boolean>('/rest/v1/rpc/consume_continuity_request',{method:'POST',body:JSON.stringify({p_user:userId})},undefined,true);
      if(!allowed)return res.status(429).set('Retry-After','60').json({error:'Story tool limit reached. Retry in one minute.'});
    }
    server = createMcpServer(token, userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server?.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: "Unable to process the plugin request." });
  }
});
app.get("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${APP_BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
  res.status(401).json({ error: "Use Streamable HTTP POST with your Continuity connection." });
});

app.use((error: any,_req: express.Request,res: express.Response,_next: express.NextFunction)=>{res.status(error?.type==='entity.too.large'?413:400).json({error:'Invalid or oversized request.'});});
const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  // A terminal keeps the HTTP listener only. Glama attaches stdin and speaks MCP there.
  const stdio = process.stdin.isTTY !== true;
  app.listen(port, () => {
    const line = `Continuity listening on ${port}`;
    if (stdio) console.error(line);
    else console.log(line);
  });
  if (stdio) {
    const stdioServer = createMcpServer("", "");
    await stdioServer.connect(new StdioServerTransport());
  }
}
