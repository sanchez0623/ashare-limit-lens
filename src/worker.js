const CACHE = new Map();
const EM_BASE = 'https://push2ex.eastmoney.com/';
const TOKEN = '7eea3edcaed734bea9cbfc24409ed989';
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function validDate(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const d=new Date(`${date}T00:00:00Z`);return !isNaN(d)&&d.toISOString().slice(0,10)===date;}
async function getPool(endpoint,date){
 const u=new URL(endpoint,EM_BASE);u.search=new URLSearchParams({ut:TOKEN,dpt:'wz.ztzt',Pageindex:'0',pagesize:'10000',sort:endpoint==='getYesterdayZTPool'?'zs:desc':'fbt:asc',date:date.replaceAll('-','')}).toString();
 const response=await fetch(u.toString(),{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://quote.eastmoney.com/'},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error(`行情源 HTTP ${response.status}`);
 const body=await response.json();
 if(body.rc!==0||!body.data||!Array.isArray(body.data.pool))throw new Error('行情源未返回该日期的有效涨停池');
 const pool=body.data.pool;
 if(pool.some(r=>typeof r.c!=='string'||typeof r.n!=='string'))throw new Error('行情字段格式变化');
 const sourceDate=String(body.data.qdate??'').replaceAll('-','');
 if(sourceDate&&sourceDate!==date.replaceAll('-',''))throw new Error('来源数据日期与请求日期不一致');
 return {pool,date,sourceDate:body.data.qdate??null,total:body.data.tc??pool.length};
}
async function marketData(date){
 const hit=CACHE.get(date);if(hit&&Date.now()-hit.time<120000)return {...hit.body,cached:true};
 const [main,broken,yesterday]=await Promise.allSettled([getPool('getTopicZTPool',date),getPool('getTopicZBPool',date),getPool('getYesterdayZTPool',date)]);
 if(main.status==='rejected')throw main.reason;
 const warnings=[];
 if(broken.status==='rejected')warnings.push('炸板池未返回，封板率暂缺。');
 if(yesterday.status==='rejected'||!yesterday.value?.pool.length)warnings.push('昨日涨停池未返回有效样本，晋级率暂缺。');
 const result={date,source:'东方财富公开行情',sourceUrl:'https://quote.eastmoney.com/ztb/detail',scope:'沪深主板、创业板；不含 ST、科创板及连续一字新股',fetchedAt:new Date().toISOString(),rows:main.value.pool,
  broken:broken.status==='fulfilled'?broken.value.pool.length:null,previous:yesterday.status==='fulfilled'&&yesterday.value.pool.length?yesterday.value.pool:null,previousLabel:'上一交易日',warnings,cached:false};
 if(CACHE.size>=20)CACHE.delete(CACHE.keys().next().value);CACHE.set(date,{time:Date.now(),body:result});return result;
}
function sameOrigin(request){const origin=request.headers.get('Origin');return !origin||origin===new URL(request.url).origin;}
export default {
 async fetch(request,env){
  const u=new URL(request.url);
  if(u.pathname.startsWith('/api/')&&request.method==='POST'&&!sameOrigin(request))return json({error:'不接受跨站写入请求'},403);
  if(Number(request.headers.get('Content-Length')||0)>12000)return json({error:'请求内容过长'},413);
  if(u.pathname==='/api/settings'){
   try{if(request.method==='GET')return json({weights:await readWeights(env),ai:aiConfig(env)});
    if(request.method!=='POST')return json({error:'不支持此请求方法'},405);
    const body=await request.json();if(!validWeights(body.weights))return json({error:'权重必须为六个 0–50 的整数，且至少一项大于零'},400);
    await database(env).prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('weights',JSON.stringify(body.weights)).run();return json({saved:true});
   }catch(e){return json({error:e.message},503);}
  }
  if(u.pathname==='/api/history'){try{return json(await historyList(env));}catch(e){return json({error:e.message},503);}}
  if(u.pathname==='/api/review'){
   const date=u.searchParams.get('date')||beijingDate();if(!validDate(date))return json({error:'日期格式无效'},400);
   try{const stored=await database(env).prepare('SELECT payload, ai_payload FROM reviews WHERE trade_date = ?').bind(date).first();return json({review:stored?JSON.parse(stored.payload):null,ai:stored?.ai_payload?JSON.parse(stored.ai_payload):null,reason:stored?null:'该日期尚无保存的反馈。',aiStatus:aiConfig(env)});}catch(e){return json({error:e.message},503);}
  }
  if(u.pathname==='/api/run-daily'){
   if(request.method!=='POST')return json({error:'仅支持 POST'},405);
   const date=beijingDate();if(!afterClose())return json({snapshot:{saved:false,reason:'收盘后 15:05 起保存评分与生成反馈。'},review:null,reason:'盘中结果尚未定稿',aiStatus:aiConfig(env)});
   try{const market=await marketData(date);if(!market.rows.length)return json({snapshot:{saved:false},review:null,reason:'当日无涨停样本，未生成快照或反馈。',aiStatus:aiConfig(env)});
    const weights=await readWeights(env);const result=await loadReview(env,date,market);const snapshot=await saveSnapshot(env,market,weights);
    let ai=result.ai,aiError=null;if(aiConfig(env).configured&&result.review&&!ai){try{ai=await gradeWithAI(env,result);}catch(e){aiError=e.message;}}
    return json({...result,ai,snapshot,aiError,aiStatus:aiConfig(env),history:await historyList(env)});
   }catch(e){return json({error:e.message},503);}
  }
  if(u.pathname==='/api/ai-grade'){
   if(request.method!=='POST')return json({error:'仅支持 POST'},405);
   try{const body=await request.json();if(!validDate(body.date))return json({error:'日期格式无效'},400);const stored=await database(env).prepare('SELECT payload, ai_payload FROM reviews WHERE trade_date = ?').bind(body.date).first();if(!stored)return json({error:'尚无已核验的客观反馈，不能调用 AI 评分。'},409);
    const result={review:JSON.parse(stored.payload),ai:stored.ai_payload?JSON.parse(stored.ai_payload):null};return json({ai:await gradeWithAI(env,result)});
   }catch(e){return json({error:e.message},503);}
  }
  if(u.pathname==='/api/market'){
   if(request.method!=='GET')return json({error:'仅支持 GET'},405);
   const date=u.searchParams.get('date')||new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
   if(!validDate(date))return json({error:'请输入有效日期，格式为 YYYY-MM-DD'},400);
   const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
   if(date>today)return json({error:'所选日期尚未到来，请选择今天或历史交易日。'},400);
   try{
    return json(await marketData(date));
   }catch(e){return json({date,error:'公开行情源暂未返回有效数据。可能是非交易日、历史日期超出保留范围，或接口暂时不可用。请切换近期交易日或稍后刷新。',detail:e instanceof Error?e.message:'数据请求失败',source:'东方财富公开行情',rows:null},503);}
  }
  if(u.pathname!=='/'&&u.pathname!=='/index.html')return new Response('Not found',{status:404});
  if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
  return new Response(request.method==='HEAD'?null:PAGE,{headers:{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'"}});
 }
};
