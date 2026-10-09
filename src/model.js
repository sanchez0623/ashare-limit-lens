export const FACTORS = [
  {key:'quality',name:'封板质量',weight:30,description:'100 − 炸板次数 × 15，最低 10 分'},
  {key:'capital',name:'封单强度',weight:20,description:'封单金额 ÷ 成交额 ÷ 10%，上限 100 分'},
  {key:'liquidity',name:'换手结构',weight:15,description:'4–12%：95；12–25%：80；1–4%：65；25–40%：50；其余：30'},
  {key:'timing',name:'首封时点',weight:15,description:'09:45 前 100；10:30 前 85；11:30 前 65；14:00 前 45；其余 25'},
  {key:'sector',name:'板块协同',weight:15,description:'使用同日、同一行业的板块评分'},
  {key:'ladder',name:'连板结构',weight:5,description:'首板 75；2–3 板 100；4 板 65；5 板及以上 40'}
];
export const PRESETS = {balanced:[30,20,15,15,15,5],first:[30,20,15,20,12,3],relay:[30,20,10,10,20,10]};
export const clamp = (v,a=0,b=100) => Math.max(a,Math.min(b,v));
export const num = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function timeLabel(value) {
  if(value === null || value === undefined) return '—';
  const s=String(value).padStart(6,'0');
  return /^\d{6}$/.test(s) ? `${s.slice(0,2)}:${s.slice(2,4)}` : '—';
}
export function normalize(row) {
  return {code:String(row.c||''),name:String(row.n||''),sector:String(row.hybk||'未分类'),price:num(row.p)===null?null:Number(row.p)/1000,
    change:num(row.zdp),amount:num(row.amount),floatCap:num(row.ltsz),seal:num(row.fund),turnover:num(row.hs),first:num(row.fbt),last:num(row.lbt),breaks:num(row.zbc),height:num(row.lbc),
    history:row.zttj?`${row.zttj.days} 天 ${row.zttj.ct} 板`:null};
}
function mean(rows,key) { const vals=rows.map(r=>r[key]).filter(Number.isFinite); return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null; }
export function sectorAnalysis(rows) {
  const groups=new Map();
  rows.forEach(row=>{if(!groups.has(row.sector))groups.set(row.sector,[]);groups.get(row.sector).push(row);});
  return [...groups].map(([name,list])=>{
    const known=list.filter(r=>r.breaks!==null), quality=known.length?mean(known.map(r=>({...r,q:clamp(100-r.breaks*15,10)})),'q'):null;
    const height=Math.max(0,...list.map(r=>r.height||0));
    const components=[{name:'涨停集聚',weight:35,value:clamp(list.length/6*100)},{name:'连板高度',weight:25,value:clamp(height/5*100)},{name:'封板稳定',weight:25,value:quality},{name:'早盘联动',weight:15,value:list.filter(r=>r.first!==null).length?list.filter(r=>r.first!==null&&r.first<103000).length/list.filter(r=>r.first!==null).length*100:null}];
    const weight=components.filter(c=>c.value!==null).reduce((s,c)=>s+c.weight,0);
    const score=Math.round(components.reduce((s,c)=>s+(c.value===null?0:c.value*c.weight),0)/weight);
    return {name,count:list.length,height,quality,score,coverage:weight,components,amount:list.reduce((s,r)=>s+(r.amount||0),0),members:list.map(r=>r.code)};
  }).sort((a,b)=>b.score-a.score||b.count-a.count);
}
export function analyzeStock(row,sectorScore,weights=PRESETS.balanced) {
  const factorValues={quality:row.breaks===null?null:clamp(100-row.breaks*15,10),capital:row.seal===null||!row.amount?null:clamp(row.seal/row.amount/.10*100),
    liquidity:row.turnover===null?null:row.turnover>=4&&row.turnover<=12?95:row.turnover>12&&row.turnover<=25?80:row.turnover>=1&&row.turnover<4?65:row.turnover>25&&row.turnover<=40?50:30,
    timing:row.first===null?null:row.first<94500?100:row.first<103000?85:row.first<113000?65:row.first<140000?45:25,sector:sectorScore??null,
    ladder:row.height===null?null:row.height===1?75:row.height<=3?100:row.height===4?65:40};
  const risks=[];
  if(row.height>=5) risks.push({text:'高位连板',penalty:8,detail:'5 板及以上，分歧与退潮风险上升。'});
  if(row.turnover>40) risks.push({text:'高换手',penalty:8,detail:'换手率超过 40%，筹码交换剧烈。'});
  if(row.breaks>=3) risks.push({text:'反复炸板',penalty:5,detail:'盘中至少 3 次开板，封板稳定性偏弱。'});
  if(row.first===92500&&row.last===92500&&row.turnover!==null&&row.turnover<1) risks.push({text:'一字特征',penalty:10,detail:'竞价封板且低换手，实际成交机会可能有限。'});
  if(row.last!==null&&row.last>=145000) risks.push({text:'尾盘回封',penalty:4,detail:'最后封板时间接近收盘，需观察次日承接。'});
  const factors=FACTORS.map((f,i)=>({...f,weight:weights[i],value:factorValues[f.key]}));
  const active=factors.filter(f=>f.value!==null),available=active.reduce((s,f)=>s+f.weight,0),total=weights.reduce((a,b)=>a+b,0);
  const raw=available?active.reduce((s,f)=>s+f.value*f.weight,0)/available:null;
  const deduction=Math.min(20,risks.reduce((s,r)=>s+r.penalty,0));
  return {...row,score:raw===null?null:Math.round(clamp(raw-deduction)),rawScore:raw,deduction,factors,risks,coverage:total?Math.round(available/total*100):0,sealRatio:row.seal!==null&&row.amount>0?row.seal/row.amount:null};
}
export function analyze(rows,broken=null,previous=null,weights=PRESETS.balanced) {
  const clean=rows.filter(r=>r.code&&!/ST|退/.test(r.name));
  const sectors=sectorAnalysis(clean),bySector=new Map(sectors.map(s=>[s.name,s.score]));
  const stocks=clean.map(r=>analyzeStock(r,bySector.get(r.sector),weights)).sort((a,b)=>(b.score??-1)-(a.score??-1));
  const sealRate=broken===null?null:(rows.length+broken?rows.length/(rows.length+broken)*100:null);
  const height=Math.max(0,...clean.map(r=>r.height||0)),first=clean.filter(r=>r.height===1).length,relay=clean.filter(r=>r.height>1).length;
  const emotionFactors=[{weight:40,value:clamp(clean.length/80*100)},{weight:35,value:sealRate},{weight:25,value:clamp(height/7*100)}];
  const eWeight=emotionFactors.filter(f=>f.value!==null).reduce((s,f)=>s+f.weight,0);
  const emotion=clean.length?Math.round(emotionFactors.reduce((s,f)=>s+(f.value??0)*f.weight,0)/eWeight):null;
  const prevCodes=previous?new Set(previous.map(r=>r.code)):null,prevEligible=previous?previous.filter(r=>r.height!==null):null;
  const promotion=prevEligible&&prevEligible.length?prevEligible.filter(r=>clean.some(s=>s.code===r.code&&s.height!==null&&s.height>r.height)).length/prevEligible.length*100:null;
  return {stocks,sectors,count:clean.length,excluded:rows.length-clean.length,first,relay,height,sealRate,emotion,emotionCoverage:eWeight,promotion,previousCount:prevCodes?prevCodes.size:null};
}
