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
const topicAddress = (topic) => `0x${topic.slice(-40)}`.toLowerCase();
const fmt = (value) => {
  const n = BigInt(value), base = 10n ** 18n;
  const whole = n / base;
  const fraction = (n % base).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
};
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);

function throttled(s) {
  s = String(s).toLowerCase();
  return s.includes('compute units per second') || s.includes('rate limit') || s.includes('429');
}
async function rpc(method, params) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await sleep(250);
    const response = await fetch(RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json();
    if (response.ok && !body.error) return body.result;
    const message = body.error?.message || `HTTP ${response.status}`;
    if (!throttled(message) || attempt === 8) throw new Error(`${method}: ${message}`);
    await sleep(attempt * 700);
  }
}
async function sha3(signature) {
  return lower(await rpc('web3_sha3', [`0x${Buffer.from(signature).toString('hex')}`]));
}
async function transfers(query) {
  const rows = [];
  let pageKey;
  do {
    const result = await rpc('alchemy_getAssetTransfers', [{ ...query, ...(pageKey ? { pageKey } : {}) }]);
    rows.push(...(result.transfers || []));
    pageKey = result.pageKey;
  } while (pageKey);
  return rows;
}
async function accountTransactions(account, auction, latest) {
  const common = {
    fromBlock: hex(auction.fromBlock), toBlock: latest, maxCount: '0x3e8',
    order: 'asc', excludeZeroValue: false, withMetadata: true,
  };
  const incoming = await transfers({ ...common, category: ['erc20'], contractAddresses: [TOKEN], fromAddress: account, toAddress: auction.address });
  const refunds = await transfers({ ...common, category: ['erc20'], contractAddresses: [TOKEN], fromAddress: auction.address, toAddress: account });
  const native = await transfers({ ...common, category: ['external'], fromAddress: account, toAddress: auction.address });
  return [...new Set([...incoming, ...refunds, ...native].map((x) => x.hash).filter(Boolean))];
}
const blockCache = new Map();
async function blockInfo(number) {
  if (!blockCache.has(number)) blockCache.set(number, rpc('eth_getBlockByNumber', [number, false]));
  const block = await blockCache.get(number);
  const timestamp = Number(BigInt(block.timestamp));
  return { number: BigInt(block.number), timestamp, iso: new Date(timestamp * 1000).toISOString() };
}
function decodeReceipt(receipt, auction, topics) {
  const events = [];
  const tokenTransfers = [];
  for (const log of receipt.logs) {
    const t0 = lower(log.topics?.[0]);
    if (lower(log.address) === TOKEN && t0 === topics.transfer) {
      const value = BigInt(log.data);
      tokenTransfers.push({
        from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]),
        value, valueFormatted: fmt(value), logIndex: Number(BigInt(log.logIndex)),
      });
    }
    if (lower(log.address) !== auction.address) continue;
    if (t0 === topics.bid) {
      const amount = BigInt(log.data);
      events.push({ kind: 'bid', tokenId: BigInt(log.topics[1]), bidder: topicAddress(log.topics[2]), amount, amountFormatted: fmt(amount), logIndex: Number(BigInt(log.logIndex)) });
    } else if (t0 === topics.started || t0 === topics.extended) {
      events.push({ kind: t0 === topics.started ? 'started' : 'extended', tokenId: BigInt(log.topics[1]), endTime: BigInt(log.data), logIndex: Number(BigInt(log.logIndex)) });
    } else if (t0 === topics.settled) {
      events.push({ kind: 'settled', tokenId: BigInt(log.topics[1]), winner: topicAddress(log.topics[2]), amount: BigInt(`0x${log.data.slice(2, 66)}`), gobbledTokenId: BigInt(`0x${log.data.slice(66, 130)}`), logIndex: Number(BigInt(log.logIndex)) });
    }
  }
  return { events, tokenTransfers };
}
async function loadTx(hash, auction, topics) {
  const tx = await rpc('eth_getTransactionByHash', [hash]);
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  const decoded = decodeReceipt(receipt, auction, topics);
  return {
    hash, block: await blockInfo(receipt.blockNumber), from: lower(tx.from), to: lower(tx.to),
    nativeValue: BigInt(tx.value), nativeValueEth: fmt(BigInt(tx.value)),
    status: BigInt(receipt.status) === 1n ? 'success' : 'reverted', ...decoded,
  };
}
async function discover(auction, latest, topics) {
  const queue = [TARGET], seen = new Set(), txs = new Map(), targetLots = new Set();
  while (queue.length && seen.size < 6) {
    const account = lower(queue.shift());
    if (seen.has(account)) continue;
    seen.add(account);
    for (const hash of await accountTransactions(account, auction, latest)) {
      if (!txs.has(hash)) txs.set(hash, await loadTx(hash, auction, topics));
      for (const event of txs.get(hash).events) {
        if (event.kind === 'bid' && event.bidder === TARGET) targetLots.add(event.tokenId.toString());
      }
    }
    for (const tx of txs.values()) {
      const relevant = tx.events.filter((e) => e.kind === 'bid' && targetLots.has(e.tokenId.toString()));
      for (const event of relevant) queue.push(event.bidder);
      if (relevant.length) {
        for (const t of tx.tokenTransfers) if (t.from === auction.address) queue.push(t.to);
      }
    }
  }
  const rows = [...txs.values()].sort((a, b) => Number(a.block.number - b.block.number));
  const sequences = [];
  for (const tokenId of targetLots) {
    const bids = [], lifecycle = [];
    for (const tx of rows) for (const event of tx.events) {
      if (event.tokenId?.toString() !== tokenId) continue;
      const row = { ...event, transactionHash: tx.hash, transactionFrom: tx.from, transactionTo: tx.to, nativeValue: tx.nativeValue, nativeValueEth: tx.nativeValueEth, status: tx.status, block: tx.block, tokenTransfers: tx.tokenTransfers };
      if (event.kind === 'bid') bids.push(row); else lifecycle.push(row);
    }
    bids.sort((a, b) => Number(a.block.number - b.block.number) || a.logIndex - b.logIndex);
    sequences.push({ auctionName: auction.name, auctionAddress: auction.address, tokenId, bidders: [...new Set(bids.map((b) => b.bidder))], bids, lifecycle });
  }
  return { auctionName: auction.name, auctionAddress: auction.address, seenAccounts: [...seen], decodedTransactions: rows.length, sequences };
}

const topics = {
  bid: await sha3('BidPlaced(uint256,address,uint256)'),
  started: await sha3('AuctionStarted(uint256,uint256)'),
  extended: await sha3('AuctionExtended(uint256,uint256)'),
  settled: await sha3('AuctionSettled(uint256,address,uint256,uint256)'),
  transfer: await sha3('Transfer(address,address,uint256)'),
};
const latest = await rpc('eth_blockNumber', []);
const discoveries = [];
for (const auction of AUCTIONS) discoveries.push(await discover(auction, latest, topics));
const sequences = discoveries.flatMap((d) => d.sequences);
process.stdout.write(json({
  generatedAt: new Date().toISOString(), chainId: 8453, latestBlock: BigInt(latest),
  target: TARGET, token: { address: TOKEN, symbol: 'WARPGOBB', decimals: 18 },
  discovery: discoveries.map(({ sequences, ...d }) => d), sequenceCount: sequences.length,
  targetBidCount: sequences.reduce((n, s) => n + s.bids.filter((b) => b.bidder === TARGET).length, 0), sequences,
}));
