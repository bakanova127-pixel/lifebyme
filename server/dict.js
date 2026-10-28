// Разбор надиктованного текста — тот же, что в приложении (копия из index.html).
function parseKey(k){const [y,m,d]=k.split("-").map(Number);return new Date(Date.UTC(y,m-1,d,12))}
function shift(k,n){const d=parseKey(k);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
/* ---------- dictation parser ---------- */
const DWRX=[[1,/^понедельник(а|у|ом|и|ам)?$/],[2,/^вторник(а|у|ом|и|ам)?$/],[3,/^сред(а|у|ы|е|ам)$/],[4,/^четверг(а|у|ом|и|ам)?$/],[5,/^пятниц(а|у|ы|е|ам)$/],[6,/^суббот(а|у|ы|е|ам)$/],[0,/^воскресен(ье|ья|ью|ьям)$/]];
const DWAB={"пн":1,"вт":2,"ср":3,"чт":4,"пт":5,"сб":6,"вс":0};
const MON_GEN=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const HOURW={"час":1,"один":1,"два":2,"три":3,"четыре":4,"пять":5,"шесть":6,"семь":7,"восемь":8,"девять":9,"десять":10,"одиннадцать":11,"двенадцать":12};
const NUMW={"один":1,"одну":1,"два":2,"две":2,"три":3,"четыре":4,"пять":5,"шесть":6,"семь":7,"десять":10};
const PREP=new Set(["в","во","на","по","к","ко","с","до"]),TPREP=new Set(["в","во","к","ко","с","до","на"]);
const STOPW=new Set(["и","а","еще","потом","также","надо","нужно","мне","у","меня","не","забыть","обязательно","час","часа","часов","утра","дня","вечера","ночи","утром","днем","вечером","полдень","полночь","день","дни","дней","неделю","недели","месяц","раз","следующий","следующую","следующее","это"]);
function pad2(n){return String(n).padStart(2,"0")}
function dwOf(w){for(const [n,r] of DWRX)if(r.test(w))return n;return Object.prototype.hasOwnProperty.call(DWAB,w)?DWAB[w]:null}
function isDateNum(w){const m=/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/.exec(w);return !!m&&+m[2]>=1&&+m[2]<=12&&+m[1]>=1&&+m[1]<=31}
function isDateWord(w){return dwOf(w)!=null||/^(сегодня|завтра|послезавтра|ежедневно|еженедельно|ежемесячно|через|будням|будни|выходным|выходные|числа)$/.test(w)||/^кажд/.test(w)||MON_GEN.includes(w)||isDateNum(w)}
function isContentW(w){return !PREP.has(w)&&!STOPW.has(w)&&!/^\d/.test(w)&&!isDateWord(w)&&!(w in HOURW)}
function parseDictation(text,base,defDate){const out=[];
  for(const chunk of String(text||"").split(/[\n;!?]+|\.(?=\s|$)/)){
    const toks=[];chunk.split(/\s+/).forEach(o=>{if(!o)return;const comma=/,$/.test(o);const cl=o.replace(/^[«"'(\[]+/,"").replace(/[»"')\],:]+$/,"");if(!cl){if(comma&&toks.length)toks[toks.length-1].comma=true;return}toks.push({o:cl,w:cl.toLowerCase().replace(/ё/g,"е"),comma})});
    const segs=[];let sg={T:[],date:false,content:false};
    toks.forEach((t,i)=>{const prev=toks[i-1],prev2=toks[i-2],next=toks[i+1];const numDate=/^\d{1,2}$/.test(t.w)&&next&&(MON_GEN.includes(next.w)||next.w==="числа");
      const start=(PREP.has(t.w)&&next&&(isDateWord(next.w)||(/^\d{1,2}$/.test(next.w)&&toks[i+2]&&MON_GEN.includes(toks[i+2].w))))||numDate||(isDateWord(t.w)&&!(prev&&PREP.has(prev.w))&&!(prev&&/^кажд/.test(prev.w))&&!(prev&&/^\d{1,2}$/.test(prev.w)&&(MON_GEN.includes(t.w)||t.w==="числа"))&&!(prev&&prev.w==="и"&&prev2&&isDateWord(prev2.w)));
      if(start&&sg.date&&sg.content){segs.push(sg);sg={T:[],date:false,content:false}}
      sg.T.push(t);if(isDateWord(t.w)||numDate)sg.date=true;else if(isContentW(t.w))sg.content=true;
      if(t.comma&&sg.content){segs.push(sg);sg={T:[],date:false,content:false}}});
    if(sg.T.length)segs.push(sg);
    let prevDate=null;
    for(const s of segs){const r=parseSeg(s.T,base,defDate);if(!r)continue;if(!r.rep){if(r.date)prevDate=r.date;else r.date=prevDate||defDate}out.push(r)}}
  return out}
function parseSeg(T,base,defDate){const rm=new Set();const W=i=>T[i]?T[i].w:"";let rep=null,dows=[],plur=false,date=null,hour=null,min=0,ampm=null,dom=null;
  const nextDow=d=>{const b=parseKey(base).getUTCDay();return shift(base,(d-b+7)%7)};
  for(let i=0;i<T.length;i++){if(rm.has(i))continue;const w=W(i),n1=W(i+1),n2=W(i+2);let m;
    const rmPrev=()=>{if(i>0&&!rm.has(i-1)&&(PREP.has(W(i-1))||W(i-1)==="и"))rm.add(i-1)};
    if(w==="ежедневно"){rep="daily";rm.add(i);continue}
    if(w==="еженедельно"){rep=rep||"weekly";rm.add(i);continue}
    if(w==="ежемесячно"){rep="monthly";rm.add(i);continue}
    if(/^кажд/.test(w)){if(/^(день|утро|вечер)$/.test(n1)){rep="daily";rm.add(i);rm.add(i+1);if(n1==="утро")ampm=ampm||"am";if(n1==="вечер")ampm="pm";continue}
      if(/^недел/.test(n1)){rep=rep||"weekly";rm.add(i);rm.add(i+1);continue}
      if(/^месяц/.test(n1)){rep="monthly";rm.add(i);rm.add(i+1);continue}
      if(dwOf(n1)!=null){plur=true;rm.add(i);continue}
      continue}
    if(w==="будням"||w==="будни"){rep="weekdays";rm.add(i);rmPrev();continue}
    if(w==="рабочим"&&/^дн/.test(n1)){rep="weekdays";rm.add(i);rm.add(i+1);rmPrev();continue}
    if((w==="выходным"||w==="выходные")&&PREP.has(W(i-1))){rep="weekly";dows.push(6,0);plur=true;rm.add(i);rmPrev();continue}
    const dw=dwOf(w);if(dw!=null){dows.push(dw);rm.add(i);if(W(i-1)==="по"||/ам$/.test(w))plur=true;rmPrev();continue}
    if(w==="сегодня"){date=base;rm.add(i);continue}
    if(w==="завтра"){date=shift(base,1);rm.add(i);continue}
    if(w==="послезавтра"){date=shift(base,2);rm.add(i);continue}
    if(w==="через"){let n=parseInt(n1,10),j=i+1;if(isNaN(n)){n=Object.prototype.hasOwnProperty.call(NUMW,n1)?NUMW[n1]:null}if(n!=null)j=i+2;else n=1;const unit=W(j);let mult=null;
      if(/^недел/.test(unit))mult=7;else if(/^месяц/.test(unit))mult=30;else if(/^(дн|день)/.test(unit))mult=1;
      if(mult!=null){for(let x=i;x<=j;x++)rm.add(x);date=shift(base,n*mult);continue}}
    if(/^\d{1,2}$/.test(w)&&MON_GEN.includes(n1)){const dd=+w,mm=MON_GEN.indexOf(n1)+1;const y=parseKey(base).getUTCFullYear();let k=`${y}-${pad2(mm)}-${pad2(dd)}`;if(k<base)k=`${y+1}-${pad2(mm)}-${pad2(dd)}`;date=k;rm.add(i);rm.add(i+1);rmPrev();continue}
    if(/^\d{1,2}$/.test(w)&&n1==="числа"){dom=+w;const b=parseKey(base);let y=b.getUTCFullYear(),mo=b.getUTCMonth()+1;let k=`${y}-${pad2(mo)}-${pad2(dom)}`;if(k<base){mo++;if(mo>12){mo=1;y++}k=`${y}-${pad2(mo)}-${pad2(dom)}`}date=k;rm.add(i);rm.add(i+1);rmPrev();continue}
    if((m=/^(\d{1,2}):(\d{2})$/.exec(w))&&+m[1]<24&&+m[2]<60){if(hour==null){hour=+m[1];min=+m[2]}rm.add(i);rmPrev();continue}
    if((m=/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/.exec(w))){
      if(!m[3]&&TPREP.has(W(i-1))&&+m[1]<24&&+m[2]<60){if(hour==null){hour=+m[1];min=+m[2]}rm.add(i);rmPrev();continue}
      if(+m[2]>=1&&+m[2]<=12&&+m[1]>=1&&+m[1]<=31){const y=m[3]?(+m[3]<100?2000+(+m[3]):+m[3]):parseKey(base).getUTCFullYear();let k=`${y}-${pad2(+m[2])}-${pad2(+m[1])}`;if(!m[3]&&k<base)k=`${y+1}-${pad2(+m[2])}-${pad2(+m[1])}`;date=k;rm.add(i);rmPrev();continue}
      if(+m[1]<24&&+m[2]<60){if(hour==null){hour=+m[1];min=+m[2]}rm.add(i);rmPrev();continue}}
    if(TPREP.has(w)&&(/^\d{1,2}$/.test(n1)||Object.prototype.hasOwnProperty.call(HOURW,n1))&&!MON_GEN.includes(n2)&&n2!=="числа"&&!/^(день|дней|недел|месяц|минут)/.test(n2)&&!(w==="на"&&/^дн/.test(n2))){const h=/^\d/.test(n1)?+n1:HOURW[n1];
      if(h<=24){if(hour==null){hour=h%24;min=0}rm.add(i);rm.add(i+1);let j=i+2;if(/^час/.test(W(j))){rm.add(j);j++}
        if(W(j)==="утра"){ampm="am";rm.add(j)}else if(W(j)==="дня"||W(j)==="вечера"){ampm="pm";rm.add(j)}else if(W(j)==="ночи"){ampm="night";rm.add(j)}continue}}
    if(w==="полдень"){if(hour==null){hour=12;min=0}rm.add(i);rmPrev();continue}
    if(w==="полночь"){if(hour==null){hour=0;min=0}rm.add(i);rmPrev();continue}
    if(w==="утром"){ampm=ampm||"am";rm.add(i);continue}
    if(w==="вечером"||w==="днем"){ampm="pm";rm.add(i);continue}}
  if(hour!=null){if(ampm==="pm"&&hour<12)hour+=12;if(ampm==="night"&&hour===12)hour=0}
  const tm=hour!=null?`${pad2(hour)}:${pad2(min)}`:"";
  dows=[...new Set(dows)];
  if(dows.length&&(plur||rep==="weekly"))rep="weekly";
  else if(dows.length&&!rep&&!date)date=nextDow(dows[0]);
  if(rep==="weekly"&&!dows.length)dows=[parseKey(date||defDate).getUTCDay()];
  if(rep==="monthly"&&!dom)dom=parseKey(date||defDate).getUTCDate();
  let words=T.filter((_,i)=>!rm.has(i)).map(t=>t.o);const low=s=>(s||"").toLowerCase().replace(/ё/g,"е");
  const LEAD=new Set(["и","а","еще","потом","также","надо","нужно","обязательно","мне","пожалуйста","что","чтобы","напомни","напомню","напомните","запиши","добавь","я","мы"]);
  for(let g=0;g<10&&words.length;g++){const f=low(words[0]);if(LEAD.has(f)){words.shift();continue}if(f==="у"&&low(words[1])==="меня"){words.splice(0,2);continue}if(f==="не"&&/^забыть/.test(low(words[1]))){words.splice(0,2);continue}break}
  while(words.length&&/^(в|во|на|по|к|с|до|и|а)$/.test(low(words[words.length-1])))words.pop();
  if(words.length>=2&&/^(сходить|пойти|поехать|съездить|идти|ехать|зайти)$/.test(low(words[0]))&&/^(к|ко)$/.test(low(words[1])))words.shift();
  if(words.length===2&&/^(к|ко)$/.test(low(words[0]))&&/^[а-яё-]{4,}[ую]$/i.test(words[1])){const w=words[1];words=[/ю$/i.test(w)?w.slice(0,-1)+"ь":w.slice(0,-1)]}
  let t=words.join(" ").trim();if(!t)return null;t=t[0].toUpperCase()+t.slice(1);
  return {t:t.slice(0,120),tm,rep,dows,dom,date,from:rep?(date||base):null}}


// Деньги: «потратила 5000 на зубного», «кофе 350», «заплатила за квартиру 30 тысяч»
const CATW=[["food",/еда|продукт|кофе|обед|ужин|завтрак|кафе|ресторан|доставк|пицц|суши|магазин|перекус/],["beauty",/маникюр|педикюр|ресниц|бров|стрижк|парикмахер|косметик|уход|салон|массаж/],["clothes",/одежд|плать|обув|кроссовк|джинс|куртк|футболк|свитер/],["rent",/аренд|квартир|ипотек|жкх|коммунал/],["home",/дом|посуд|уборк|ремонт|мебел/],["transport",/такси|бензин|метро|автобус|проезд|машин|парковк|автошкол/],["fun",/кино|театр|концерт|бар|развлеч|игр|подписк/],["health",/врач|зуб|стоматолог|аптек|лекарств|анализ|клиник|витамин/],["gifts",/подар/],["study",/курс|книг|обучен|урок|школ|репетитор/]];
const MONEYV=/^(потратил[аи]?|потрачено|заплатил[аи]?|отдал[аи]?|купил[аи]?|расход|минус|оплатил[аи]?)$/;
function numFrom(str){const m=str.replace(/(\d)\s(?=\d{3}(?!\d))/g,"$1").match(/(\d+(?:[.,]\d+)?)\s*(тыс[а-я]*\.?|к(?![а-я]))?/i);if(!m)return null;let v=parseFloat(m[1].replace(",","."));if(m[2])v*=1000;return Math.round(v)}
/* доходы: «получила 5000 за урок», «зарплата 60000», «перевели 3000», «плюс 2000 за заказ» */
const INCW=/(получил[аи]?|заработал[аи]?|зарплат[аыу]?|аванс|преми[яюи]|доход|пришл[оаи]|перевел[аи]\s+мне|мне\s+перевел[аи]?|кэшбэк|кешбэк|кешбек|вернули|(^|\s)плюс(?=\s+\d))/;
const INC_SRC=[["salary",/(зарплат|аванс|преми)/],["clients",/(клиент|заказ|урок|ученик|заняти|консульт|проект)/],["blog",/(блог|реклам|инстаграм|телеграм|канал|интеграц)/],["gift",/(подар)/]];
function parseIncome(text){const out=[];
  for(const ch of String(text||"").split(/[\n;]+|\.\s+/)){const low=ch.toLowerCase().replace(/ё/g,"е").trim();if(!low||!INCW.test(low))continue;
    const amount=numFrom(low);if(!amount||amount<=0||amount>100000000)continue;
    let note=low.replace(INCW,"").replace(/(\d)\s(?=\d{3}(?!\d))/g,"$1").replace(/\d+(?:[.,]\d+)?\s*(тыс[а-я]*\.?|к(?![а-я]))?/g,"").replace(/(рублей|рубля|рубль|руб\.?|₽)/g,"").replace(/\s+/g," ").trim().replace(/^(на|за|от)\s+/,"").trim();
    const src=(INC_SRC.find(([,r])=>r.test(low))||["other_i"])[0];
    out.push({inc:true,amount,src,note:note?note[0].toUpperCase()+note.slice(1):""})}
  return out}
function parseMoney(text){const out=[];
  for(const ch of String(text||"").split(/[\n;]+|,\s*(?=потрат|заплат|купил|оплат)|\.\s+|\sи\s(?=потрат|заплат|купил|оплат)/i)){const low=ch.toLowerCase().replace(/ё/g,"е").trim();if(!low)continue;
    const words=low.split(/\s+/);const bare=(/^[а-яa-z\s-]+\s\d[\d\s]*(\s*(тыс[а-я]*|к))?$/.test(low)||/^\d[\d\s]*(\s*(тыс[а-я]*|к))?\s+(на\s+|за\s+)?[а-яa-z\s-]+$/.test(low))&&!/(^|\s)(в|во|к|ко|до|с|по|на)\s+\d|час|утр|вечер|минут|числ|день|дня|дней|раз/.test(low);const isMoney=words.some(w=>MONEYV.test(w))||/(руб|₽|(^|\s)р(\s|$))/.test(low)||bare;if(!isMoney)continue;
    const amount=numFrom(low);if(!amount||amount<=0||amount>10000000||(bare&&!words.some(w=>MONEYV.test(w))&&amount<10))continue;
    let note=low.replace(/(потратил[аи]?|потрачено|заплатил[аи]?|отдал[аи]?|купил[аи]?|расход|минус|оплатил[аи]?)/g,"").replace(/(\d)\s(?=\d{3}(?!\d))/g,"$1").replace(/\d+(?:[.,]\d+)?\s*(тыс[а-я]*\.?|к(?![а-я]))?/g,"").replace(/(рублей|рубля|рубль|руб\.?|₽)/g,"").replace(/(^|\s)р\.?(?=\s|$)/g," ").replace(/^\s*(на|за)\s+/,"").replace(/\s+/g," ").trim();
    note=note.replace(/^(на|за)\s+/,"").replace(/\s+(на|за|в)$/,"").trim();const cat=(CATW.find(([,r])=>r.test(low))||["other"])[0];
    out.push({amount,cat,note:note?note[0].toUpperCase()+note.slice(1):""})}
  return out}
const REMW=[[1440,/(за|на) (один |1 )?день|накануне|за сутки/],[60,/(за|на) (один |1 )?час/],[15,/(за|на) (15|пятнадцать) минут/],[30,/(за|на) (30|полчаса|тридцать минут)/]];
function remOf(text){const low=String(text).toLowerCase();if(!/напомн/.test(low))return 0;for(const [m,r] of REMW)if(r.test(low))return m===30?60:m;return 60}
// Целиком: деньги отдельно, дела отдельно, служебные слова («добавь в дела», «напомни за час») убираем
function cleanTask(t){return t.replace(/,?\s*(и\s+)?(добавь|запиши|поставь|внеси)(\s+это)?(\s+мне)?\s+в\s+(дела|список|задачи|планы|календарь)/gi,"")
  .replace(/,?\s*(и\s+)?напомн(и|ю|ите|ить)(\s+мне)?(\s+об этом)?(\s+(за|на)\s+((\d+|один|одну|два|две|три)\s+)?(часа?|день|дня|сутки|минут[ау]?|полчаса|пятнадцать минут))?(\s*,?\s*(что|чтобы|о том,? что))?/gi,"")
  .replace(/(^|[\s,])(накануне|за сутки)(?=$|[\s,.])/gi,"$1").replace(/\s+/g," ").replace(/^[\s,]+|[\s,]+$/g,"").trim()}
function parseAll(text,today){const money=[],tasks=[];const rem=remOf(text);let rest=[];
  for(const sent of String(text||"").split(/[\n;!?]+|\.(?=\s|$)/)){if(!sent.trim())continue;const inc=parseIncome(sent);if(inc.length){money.push(...inc);continue}const m=parseMoney(sent);if(m.length)money.push(...m);else rest.push(cleanTask(sent))}
  const t=rest.filter(Boolean).join(". ");if(t)for(const x of parseDictation(t,today,today))if(x.t&&x.t.length>1){if(x.tm&&!/утр|ночи|\d:\d/.test(t.toLowerCase())){const h=+x.tm.slice(0,2);if(h>=1&&h<=7)x.tm=String(h+12).padStart(2,"0")+x.tm.slice(2)}tasks.push(Object.assign(x,{rem:!x.rep?rem:0}))}
  return {money,tasks}}
module.exports={parseDictation,parseMoney,parseIncome,remOf,parseAll};
