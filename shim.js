/* Cloud stand-in for the claude.ai runtime (window.claude.use: db, user, downloads, assets). */
(function(){
"use strict";
const subs={};const docs={};let seq=0;let timer=null;let ready=null;
window.__CLOUD_FILES=new Set();
function toLogin(r){if(r.status===401){location.href="/login";throw new Error("login")}return r}
async function j(url,opt){const r=toLogin(await fetch(url,Object.assign({credentials:"same-origin"},opt||{})));if(!r.ok){let e={};try{e=await r.json()}catch(x){}const err=new Error(e.message||e.error||("HTTP "+r.status));err.code=e.error==="storage_full"?"quota_exceeded":"http_"+r.status;throw err}return r.json()}
function colKey(c){return c}
function emit(c){(subs[c]||[]).forEach(s=>{try{s()}catch(e){console.error(e)}})}
function snapOf(c){const m=docs[c]||{};return{docs:Object.keys(m).map(id=>({id,data:()=>m[id],exists:true}))}}
function apply(ch){const touched=new Set();ch.forEach(x=>{const m=docs[x.col]||(docs[x.col]={});if(x.deleted)delete m[x.id];else m[x.id]=x.data;touched.add(x.col)});touched.forEach(emit)}
async function load(){const a=await j("/api/all");seq=a.seq;a.docs.forEach(d=>{(docs[d.col]||(docs[d.col]={}))[d.id]=d.data});window.__CLOUD_FILES=new Set(a.files);poll()}
async function poll(){clearTimeout(timer);try{const c=await j("/api/changes?since="+seq);if(c.changes.length){seq=c.seq;apply(c.changes)}}catch(e){}timer=setTimeout(poll,document.hidden?60000:12000)}
document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll()});
function onSnap(c,isDoc,id){return function(cb,err){const fire=isDoc?()=>{const m=docs[c]||{};cb({exists:id in m,data:()=>m[id]})}:()=>cb(snapOf(c));(subs[c]||(subs[c]=[])).push(fire);ready.then(fire,e=>err&&err(e));return()=>{subs[c]=(subs[c]||[]).filter(f=>f!==fire)}}}
async function put(c,id,data){await j("/api/doc/"+c+"/"+encodeURIComponent(id),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});(docs[c]||(docs[c]={}))[id]=JSON.parse(JSON.stringify(data));emit(c);poll()}
async function del(c,id){await j("/api/doc/"+c+"/"+encodeURIComponent(id),{method:"DELETE"});if(docs[c])delete docs[c][id];emit(c);poll()}
const db={
  collection(c){return{onSnapshot:onSnap(c,false),doc(id){return{set:d=>put(c,id,d),delete:()=>del(c,id),onSnapshot:onSnap(c,true,id)}}}},
  doc(p){const [c,id]=p.split("/");return{set:d=>put(c,id,d),delete:()=>del(c,id),onSnapshot:onSnap(c,true,id)}}
};
const user={can:async()=>true,canEdit:async()=>true};
const downloads={async save({filename,data}){const b=data instanceof Blob?data:new Blob([data]);const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download=filename||"download";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);return{status:"saved"}}};
const assets={
  async upload(blob,o){const t=(o&&o.type)||blob.type||"application/octet-stream";const r=await j("/api/assets?type="+encodeURIComponent(t),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:blob});window.__CLOUD_FILES.add(r.id);return r},
  async list(){return j("/api/assets")},
  async delete(id){await j("/api/assets/"+id,{method:"DELETE"});window.__CLOUD_FILES.delete(id)}
};
ready=load();
const caps={db,user,downloads,assets};
window.claude={use:async n=>{if(!(n in caps))throw new Error("unavailable");if(n==="db")await ready;return caps[n]}};
})();
