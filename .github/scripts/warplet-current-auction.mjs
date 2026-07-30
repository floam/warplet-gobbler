const RPC_URL=process.env.RPC_URL;if(!RPC_URL)throw new Error('RPC_URL required');
const AUCTION='0x2943fd3dd84bb3bf51d5c4b288f648ab45e4fc3d';
let id=1;
async function rpc(method,params){const r=await fetch(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params}),signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok||b.error)throw new Error(b.error?.message||r.status);return b.result;}
const selector=(await rpc('web3_sha3',[`0x${Buffer.from('auction()').toString('hex')}`])).slice(0,10);
const latest=await rpc('eth_blockNumber',[]);
const block=await rpc('eth_getBlockByNumber',[latest,false]);
const data=await rpc('eth_call',[{to:AUCTION,data:selector},'latest']);
const word=(i)=>data.slice(2+i*64,2+(i+1)*64);
const uint=(i)=>BigInt(`0x${word(i)}`);
const address=(i)=>`0x${word(i).slice(24)}`;
const state={tokenId:uint(0),amount:uint(1),startTime:uint(2),endTime:uint(3),bidder:address(4),settled:uint(5)!==0n};
const fmt=(n)=>{const base=10n**18n;const whole=n/base;const frac=(n%base).toString().padStart(18,'0').replace(/0+$/,'');return `${whole}${frac?'.'+frac:''}`};
console.log(JSON.stringify({fetchedAt:new Date().toISOString(),latestBlock:BigInt(latest).toString(),latestTimestamp:Number(BigInt(block.timestamp)),latestIso:new Date(Number(BigInt(block.timestamp))*1000).toISOString(),auction:AUCTION,state:{...state,tokenId:state.tokenId.toString(),amount:state.amount.toString(),amountFormatted:fmt(state.amount),startTime:state.startTime.toString(),startIso:new Date(Number(state.startTime)*1000).toISOString(),endTime:state.endTime.toString(),endIso:new Date(Number(state.endTime)*1000).toISOString()}},null,2));
