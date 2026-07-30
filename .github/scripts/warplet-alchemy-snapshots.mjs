const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL required');
const TOKEN = '0x1a339c38ae22726f1a4235bcecf8f12aebe4c5e8';
const accounts = [
  '0x1034071986fbf826f37d4a6442b056d3442f7777',
  '0x71ce5605ab649d97446ef179bc2983b18ddc9a48',
  '0x46e9beef5dc68dff095eca56dadf90247f1af7ef',
  '0x739739648cf1c4fbfcfc8b348161397c24b6d9a8',
];
const bidBlocks = [49285346n,49285351n,49285356n,49285362n,49285368n,49285374n,49285379n,49285384n,49285389n,49285394n,49285401n,49285414n,49285421n,49285487n];
const blocks = [...new Set(bidBlocks.flatMap((n) => [n - 1n, n]).map(String))].map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const padAddress = (a) => a.replace(/^0x/,'').toLowerCase().padStart(64,'0');
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const uint = (data, i=0) => BigInt(`0x${word(data,i) || '0'}`);
const signed = (n) => n >= (1n<<255n) ? n-(1n<<256n) : n;
const fmt = (n, decimals=18) => {
  n=BigInt(n); const neg=n<0n; if(neg)n=-n;
  const base=10n**BigInt(decimals), whole=n/base;
  const frac=(n%base).toString().padStart(decimals,'0').replace(/0+$/,'');
  return `${neg?'-':''}${whole}${frac?'.'+frac:''}`;
};
const json = (v) => JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2);
let nextId=1;
async function post(payload) {
  for (let attempt=1; attempt<=8; attempt++) {
    await sleep(500);
    const response=await fetch(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    const body=await response.json();
    const errors=Array.isArray(body)?body.filter(x=>x.error):body.error?[body]:[];
    if(response.ok && !errors.length)return body;
    const message=errors.map(x=>x.error?.message).join('; ') || `HTTP ${response.status}`;
    if(attempt===8 || !/compute units|rate limit|429|too many/i.test(message))throw new Error(message);
    await sleep(attempt*1000);
  }
}
const shaPayload={jsonrpc:'2.0',id:nextId++,method:'web3_sha3',params:[`0x${Buffer.from('realtimeBalanceOfNow(address)').toString('hex')}`]};
const realtimeSelector=(await post(shaPayload)).result.slice(0,10);
const balanceSelector='0x70a08231';
const snapshots={};
for(const block of blocks){
  const calls=[];
  const specs=[];
  for(const account of accounts){
    const dataBalance=`${balanceSelector}${padAddress(account)}`;
    const dataRealtime=`${realtimeSelector}${padAddress(account)}`;
    for(const [kind,method,params] of [
      ['balanceOf','eth_call',[{to:TOKEN,data:dataBalance},hex(block)]],
      ['realtimeBalanceOfNow','eth_call',[{to:TOKEN,data:dataRealtime},hex(block)]],
      ['nativeBalance','eth_getBalance',[account,hex(block)]],
    ]){
      const id=nextId++; calls.push({jsonrpc:'2.0',id,method,params}); specs.push({id,account,kind});
    }
  }
  const response=await post(calls);
  const byId=new Map(response.map(x=>[x.id,x]));
  const row={};
  for(const account of accounts)row[account]={};
  for(const spec of specs){
    const result=byId.get(spec.id);
    if(result?.error){row[spec.account][spec.kind]={error:result.error.message};continue;}
    if(spec.kind==='balanceOf'){
      const value=BigInt(result.result); row[spec.account].balanceOf={raw:value,formatted:fmt(value)};
    }else if(spec.kind==='nativeBalance'){
      const value=BigInt(result.result); row[spec.account].nativeBalance={raw:value,eth:fmt(value)};
    }else{
      const available=signed(uint(result.result,0)),deposit=uint(result.result,1),owedDeposit=uint(result.result,2),timestamp=uint(result.result,3);
      row[spec.account].realtimeBalanceOfNow={availableRaw:available,availableFormatted:fmt(available),depositRaw:deposit,depositFormatted:fmt(deposit),owedDepositRaw:owedDeposit,owedDepositFormatted:fmt(owedDeposit),timestamp};
    }
  }
  snapshots[block.toString()]=row;
}
console.log(json({fetchedAt:new Date().toISOString(),chainId:8453,token:TOKEN,accounts,bidBlocks,blocks,snapshots}));
