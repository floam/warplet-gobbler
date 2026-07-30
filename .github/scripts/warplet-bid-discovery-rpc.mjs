const TARGET = '0x1034071986fbf826f37d4a6442b056d3442f7777';
const TOKEN = '0x1a339c38ae22726f1a4235bcecf8f12aebe4c5e8';
const AUCTIONS = [
  { name: 'current', address: '0x2943fd3dd84bb3bf51d5c4b288f648ab45e4fc3d', fromBlock: 47430889n },
  { name: 'legacy', address: '0xa1046076e518b3fe1604b2f19abe90c55c252fd9', fromBlock: 44000000n },
];
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL required');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (x) => x?.toLowerCase();
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const topicUint = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const topicAddress = (a) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const decodedAddress = (topic) => `0x${topic.slice(-40)}`.toLowerCase();
const fmt = (value) => {
  const n = BigInt(value), base = 10n ** 18n;
  const whole = n / base;
  const fraction = (n % base).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
};
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);

async function rpc(method, params) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (response.ok && !body.error) return body.result;
    if (attempt === 5) throw new Error(`${method}: ${body.error?.message || response.status}`);
    await sleep(attempt * 400);
  }
}
async function sha3(signature) {
  return lower(await rpc('web3_sha3', [`0x${Buffer.from(signature).toString('hex')}`]));
}
async function getLogsChunked(filter, fromBlock, toBlock) {
  const logs = [];
  const step = 90_000n;
  for (let start = fromBlock; start <= toBlock; start += step + 1n) {
    const end = start + step > toBlock ? toBlock : start + step;
    logs.push(...await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]));
  }
  return logs;
}
const blockCache = new Map();
async function blockInfo(number) {
  if (!blockCache.has(number)) blockCache.set(number, rpc('eth_getBlockByNumber', [number, false]));
  const block = await blockCache.get(number);
  const timestamp = Number(BigInt(block.timestamp));
  return { number: BigInt(block.number), timestamp, iso: new Date(timestamp * 1000).toISOString() };
}
function decodeTokenTransfers(receipt, transferTopic) {
  const rows = [];
  for (const log of receipt.logs) {
    if (lower(log.address) !== TOKEN || lower(log.topics?.[0]) !== transferTopic) continue;
    const value = BigInt(log.data);
    rows.push({
      from: decodedAddress(log.topics[1]), to: decodedAddress(log.topics[2]),
      value, valueFormatted: fmt(value), logIndex: Number(BigInt(log.logIndex)),
    });
  }
  return rows;
}
async function transactionRow(log, auction, transferTopic) {
  const tx = await rpc('eth_getTransactionByHash', [log.transactionHash]);
  const receipt = await rpc('eth_getTransactionReceipt', [log.transactionHash]);
  const amount = BigInt(log.data);
  return {
    tokenId: BigInt(log.topics[1]), bidder: decodedAddress(log.topics[2]),
    amount, amountFormatted: fmt(amount), transactionHash: log.transactionHash,
    transactionFrom: lower(tx.from), transactionTo: lower(tx.to),
    nativeValue: BigInt(tx.value), nativeValueEth: fmt(BigInt(tx.value)),
    status: BigInt(receipt.status) === 1n ? 'success' : 'reverted',
    block: await blockInfo(receipt.blockNumber), logIndex: Number(BigInt(log.logIndex)),
    tokenTransfers: decodeTokenTransfers(receipt, transferTopic),
  };
}

const topics = {
  bid: await sha3('BidPlaced(uint256,address,uint256)'),
  started: await sha3('AuctionStarted(uint256,uint256)'),
  extended: await sha3('AuctionExtended(uint256,uint256)'),
  settled: await sha3('AuctionSettled(uint256,address,uint256,uint256)'),
  transfer: await sha3('Transfer(address,address,uint256)'),
};
const latest = BigInt(await rpc('eth_blockNumber', []));
const sequences = [];
for (const auction of AUCTIONS) {
  const targetBidLogs = await getLogsChunked({ address: auction.address, topics: [topics.bid, null, topicAddress(TARGET)] }, auction.fromBlock, latest);
  const tokenIds = [...new Set(targetBidLogs.map((log) => BigInt(log.topics[1]).toString()))];
  for (const tokenId of tokenIds) {
    const tokenTopic = topicUint(tokenId);
    const bidLogs = await getLogsChunked({ address: auction.address, topics: [topics.bid, tokenTopic] }, auction.fromBlock, latest);
    const bids = [];
    for (const log of bidLogs) bids.push(await transactionRow(log, auction, topics.transfer));
    bids.sort((a, b) => Number(a.block.number - b.block.number) || a.logIndex - b.logIndex);

    const lifecycle = [];
    for (const [kind, eventTopic] of [['started', topics.started], ['extended', topics.extended], ['settled', topics.settled]]) {
      const logs = await getLogsChunked({ address: auction.address, topics: [eventTopic, tokenTopic] }, auction.fromBlock, latest);
      for (const log of logs) {
        const row = { kind, tokenId: BigInt(tokenId), transactionHash: log.transactionHash, block: await blockInfo(log.blockNumber), logIndex: Number(BigInt(log.logIndex)) };
        if (kind === 'settled') {
          row.winner = decodedAddress(log.topics[2]);
          row.amount = BigInt(`0x${log.data.slice(2, 66)}`);
          row.amountFormatted = fmt(row.amount);
          row.gobbledTokenId = BigInt(`0x${log.data.slice(66, 130)}`);
        } else row.endTime = BigInt(log.data);
        lifecycle.push(row);
      }
    }
    lifecycle.sort((a, b) => Number(a.block.number - b.block.number) || a.logIndex - b.logIndex);
    sequences.push({ auctionName: auction.name, auctionAddress: auction.address, tokenId, bidders: [...new Set(bids.map((b) => b.bidder))], bids, lifecycle });
  }
}
process.stdout.write(json({
  generatedAt: new Date().toISOString(), chainId: 8453, latestBlock: latest,
  target: TARGET, token: { address: TOKEN, symbol: 'WARPGOBB', decimals: 18 },
  sequenceCount: sequences.length,
  targetBidCount: sequences.reduce((n, s) => n + s.bids.filter((b) => b.bidder === TARGET).length, 0),
  sequences,
}));
