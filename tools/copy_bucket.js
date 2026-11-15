// Copy every object from the running app's bucket (old) to a new bucket. Skips objects already present with the same size.
// Usage (on the server, from the app dir): NEW_BUCKET=.. NEW_KEY=.. NEW_SECRET=.. node copy_bucket.js <pid>
const fs=require('fs');
const {S3Client,ListObjectsV2Command,GetObjectCommand,PutObjectCommand,HeadObjectCommand}=require('@aws-sdk/client-s3');
const env=Object.fromEntries(fs.readFileSync(`/proc/${process.argv[2]}/environ`,'utf8').split('\0').filter(Boolean).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const mk=(k,s)=>new S3Client({endpoint:env.S3_ENDPOINT,region:env.S3_REGION||'auto',forcePathStyle:true,credentials:{accessKeyId:k,secretAccessKey:s}});
const A=mk(env.S3_KEY,env.S3_SECRET),B=mk(process.env.NEW_KEY,process.env.NEW_SECRET);
const AB=env.S3_BUCKET,BB=process.env.NEW_BUCKET;
(async()=>{
  let tok,keys=[];
  do{const r=await A.send(new ListObjectsV2Command({Bucket:AB,ContinuationToken:tok}));(r.Contents||[]).forEach(o=>keys.push(o));tok=r.IsTruncated?r.NextContinuationToken:undefined}while(tok);
  let done=0,skip=0,bytes=0,fail=0;
  const work=keys.slice();
  async function worker(){
    while(work.length){const o=work.shift();
      try{let h=null;try{h=await B.send(new HeadObjectCommand({Bucket:BB,Key:o.Key}))}catch(e){}
        if(h&&h.ContentLength===o.Size){skip++;continue}
        const g=await A.send(new GetObjectCommand({Bucket:AB,Key:o.Key}));
        const buf=Buffer.from(await g.Body.transformToByteArray());
        await B.send(new PutObjectCommand({Bucket:BB,Key:o.Key,Body:buf,ContentType:g.ContentType}));
        done++;bytes+=buf.length}catch(e){fail++;console.error('FAIL',o.Key,e.message)}}
  }
  await Promise.all(Array.from({length:8},worker));
  console.log(JSON.stringify({objects:keys.length,copied:done,skipped:skip,failed:fail,mb:Math.round(bytes/1e6)}));
})();
