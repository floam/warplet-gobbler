const AUCTION='0x2943Fd3DD84BB3Bf51d5C4b288f648ab45e4Fc3D';
const TOKEN_ID='1152475';
async function get(url){
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'warplet-bid-audit'},signal:AbortSignal.timeout(30000)});
  const text=await r.text(); let body; try{body=JSON.parse(text)}catch{body={raw:text}};
  return {status:r.status,body};
}
const url=new URL('https://base.blockscout.com/api');
url.searchParams.set('module','account');url.searchParams.set('action','txlist');url.searchParams.set('address',AUCTION);
url.searchParams.set('startblock','49285487');url.searchParams.set('page','1');url.searchParams.set('offset','1000');url.searchParams.set('sort','asc');
const txResponse=await get(url);
const rows=Array.isArray(txResponse.body?.result)?txResponse.body.result:[];
const candidates=rows.filter(r=>/bid\(|settle|startAuction|extendAuction/i.test(r.functionName||''));
const details=[];
for(const row of candidates){
  const logs=await get(`https://base.blockscout.com/api/v2/transactions/${row.hash}/logs`);
  const relevant=(logs.body?.items||[]).filter(item=>{
    const d=item.decoded;if(!d)return false;
    const p=Object.fromEntries((d.parameters||[]).map(x=>[x.name,String(x.value)]));
    return p.tokenId===TOKEN_ID || /AuctionStarted|AuctionSettled|BidPlaced|AuctionExtended/.test(d.method_call||'');
  });
  if(relevant.length)details.push({row,relevant});
}
console.log(JSON.stringify({fetchedAt:new Date().toISOString(),auction:AUCTION,tokenId:TOKEN_ID,transactionCount:rows.length,candidateCount:candidates.length,details},null,2));
