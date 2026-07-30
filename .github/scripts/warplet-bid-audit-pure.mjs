const TARGET = '0x1034071986fbf826f37d4a6442b056d3442f7777';
const TOKEN = '0x1a339c38ae22726f1a4235bcecf8f12aebe4c5e8';
const ZERO = '0x0000000000000000000000000000000000000000';
const AUCTIONS = [
  { name: 'current', address: '0x2943fd3dd84bb3bf51d5c4b288f648ab45e4fc3d', fromBlock: 47430889n },
  { name: 'legacy', address: '0xa1046076e518b3fe1604b2f19abe90c55c252fd9', fromBlock: 44000000n },
];
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL is required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const lower = (x) => x?.toLowerCase();
const padAddress = (address) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (data, index) => data.slice(2 + index * 64, 2 + (index + 1) * 64);
const uintWord = (data, index) => BigInt(`0x${word(data, index) || '0'}`);
const addressWord = (data, index) => `0x${word(data, index).slice(24)}`.toLowerCase();
const topicAddress = (topic) => `0x${topic.slice(-40)}`.toLowerCase();
const fmt = (value, decimals = 18) => {
  const n = BigInt(value);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};
const signed256 = (value) => {
  const n = BigInt(value);
  return n >= (1n << 255n) ? n - (1n << 256n) : n;
};
const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

function isThrottle(message) {
  const s = String(message).toLowerCase();
  return s.includes('compute units per second') || s.includes('rate limit') || s.includes('too many requests') || s.includes('429');
}

async function rpc(method, params, attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(325);
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (response.ok && !body.error) return body.result;
    const message = body.error?.message || `HTTP ${response.status}`;
    if (!isThrottle(message) || attempt === attempts) throw new Error(`${method}: ${message}`);
    await sleep(attempt * 900);
  }
}

async function selector(signature) {
  const encoded = `0x${Buffer.from(signature, 'utf8').toString('hex')}`;
  return (await rpc('web3_sha3', [encoded])).slice(0, 10);
}

async function assetTransfers(query) {
  const rows = [];
  let pageKey;
  do {
    const result = await rpc('alchemy_getAssetTransfers', [{ ...query, ...(pageKey ? { pageKey } : {}) }]);
    rows.push(...(result.transfers || []));
    pageKey = result.pageKey;
  } while (pageKey);
  return rows;
}

async function transfersForAccount(account, auction, latest) {
  const common = {
    fromBlock: hex(auction.fromBlock),
    toBlock: latest,
    excludeZeroValue: false,
    withMetadata: true,
    maxCount: '0x3e8',
    order: 'asc',
  };
  const erc20To = await assetTransfers({ ...common, category: ['erc20'], contractAddresses: [TOKEN], fromAddress: account, toAddress: auction.address });
  const erc20From = await assetTransfers({ ...common, category: ['erc20'], contractAddresses: [TOKEN], fromAddress: auction.address, toAddress: account });
  const nativeTo = await assetTransfers({ ...common, category: ['external'], fromAddress: account, toAddress: auction.address });
  return { erc20To, erc20From, nativeTo };
}

const blockCache = new Map();
async function blockInfo(blockHex) {
  if (!blockCache.has(blockHex)) blockCache.set(blockHex, rpc('eth_getBlockByNumber', [blockHex, false]));
  const block = await blockCache.get(blockHex);
  const timestamp = Number(BigInt(block.timestamp));
  return { number: BigInt(block.number), timestamp, iso: new Date(timestamp * 1000).toISOString() };
}

function decodeTransferLogs(receipt, transferTopic, decimals) {
  const rows = [];
  for (const log of receipt.logs) {
    if (lower(log.address) !== TOKEN || lower(log.topics?.[0]) !== transferTopic) continue;
    const value = BigInt(log.data);
    rows.push({
      logIndex: Number(BigInt(log.logIndex)),
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      value,
      valueFormatted: fmt(value, decimals),
    });
  }
  return rows;
}

function decodeAuctionLogs(receipt, auction, topics, decimals) {
  const rows = [];
  for (const log of receipt.logs) {
    if (lower(log.address) !== auction.address) continue;
    const t0 = lower(log.topics?.[0]);
    if (t0 === topics.bid) {
      const amount = BigInt(log.data);
      rows.push({ kind: 'bid', logIndex: Number(BigInt(log.logIndex)), tokenId: BigInt(log.topics[1]), bidder: topicAddress(log.topics[2]), amount, amountFormatted: fmt(amount, decimals) });
    } else if (t0 === topics.started) {
      rows.push({ kind: 'started', logIndex: Number(BigInt(log.logIndex)), tokenId: BigInt(log.topics[1]), endTime: BigInt(log.data) });
    } else if (t0 === topics.extended) {
      rows.push({ kind: 'extended', logIndex: Number(BigInt(log.logIndex)), tokenId: BigInt(log.topics[1]), endTime: BigInt(log.data) });
    } else if (t0 === topics.settled) {
      rows.push({ kind: 'settled', logIndex: Number(BigInt(log.logIndex)), tokenId: BigInt(log.topics[1]), winner: topicAddress(log.topics[2]), amount: uintWord(log.data, 0), gobbledTokenId: uintWord(log.data, 1) });
    }
  }
  return rows;
}

async function loadTx(hash, auction, topics, decimals) {
  const tx = await rpc('eth_getTransactionByHash', [hash]);
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  return {
    hash,
    block: await blockInfo(receipt.blockNumber),
    transactionFrom: lower(tx.from),
    transactionTo: lower(tx.to),
    nativeValue: BigInt(tx.value),
    nativeValueEth: fmt(BigInt(tx.value), 18),
    status: BigInt(receipt.status) === 1n ? 'success' : 'reverted',
    gasUsed: BigInt(receipt.gasUsed),
    tokenTransfers: decodeTransferLogs(receipt, topics.transfer, decimals),
    auctionEvents: decodeAuctionLogs(receipt, auction, topics, decimals),
  };
}

async function ethCall(to, data, block) {
  return rpc('eth_call', [{ to, data }, block]);
}

async function snapshot(account, block, selectors, decimals) {
  const balanceData = `${selectors.balanceOf}${padAddress(account)}`;
  const realtimeData = `${selectors.realtimeBalanceOfNow}${padAddress(account)}`;
  const row = { blockNumber: BigInt(block) };
  try {
    const result = await ethCall(TOKEN, balanceData, hex(block));
    row.balance = BigInt(result);
    row.balanceFormatted = fmt(row.balance, decimals);
  } catch (error) {
    row.balanceError = error.message;
  }
  try {
    const result = await ethCall(TOKEN, realtimeData, hex(block));
    row.realtimeAvailableBalance = signed256(uintWord(result, 0));
    row.realtimeAvailableBalanceFormatted = fmt(row.realtimeAvailableBalance, decimals);
    row.deposit = uintWord(result, 1);
    row.depositFormatted = fmt(row.deposit, decimals);
    row.owedDeposit = uintWord(result, 2);
    row.owedDepositFormatted = fmt(row.owedDeposit, decimals);
    row.realtimeTimestamp = uintWord(result, 3);
  } catch (error) {
    row.realtimeError = error.message;
  }
  return row;
}

async function auctionState(auction, block, selectors, decimals) {
  const out = {};
  try {
    const result = await ethCall(auction.address, selectors.auction, hex(block));
    out.tokenId = uintWord(result, 0);
    out.amount = uintWord(result, 1);
    out.amountFormatted = fmt(out.amount, decimals);
    out.startTime = uintWord(result, 2);
    out.startIso = new Date(Number(out.startTime) * 1000).toISOString();
    out.endTime = uintWord(result, 3);
    out.endIso = new Date(Number(out.endTime) * 1000).toISOString();
    out.bidder = addressWord(result, 4);
    out.settled = uintWord(result, 5) !== 0n;
  } catch (error) {
    out.error = error.message;
  }
  return out;
}

async function ledgerEntries(account, auction) {
  const url = new URL(`https://balances.superfluid.dev/v1/accounts/${account}/tokens/${TOKEN}/entries`);
  url.searchParams.set('chain', '8453');
  url.searchParams.set('counterparty', auction.address);
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('limit', '100');
  url.searchParams.set('offset', '0');
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: response.status, body };
  } catch (error) {
    return { error: error.message };
  }
}

async function discover(auction, latest, topics, selectors, decimals) {
  const queue = [TARGET];
  const seen = new Set();
  const transfersByAccount = {};
  const txs = new Map();
  const targetTokenIds = new Set();

  while (queue.length && seen.size < 8) {
    const account = lower(queue.shift());
    if (seen.has(account)) continue;
    seen.add(account);
    const transfers = await transfersForAccount(account, auction, latest);
    transfersByAccount[account] = { erc20ToAuction: transfers.erc20To.length, refundsFromAuction: transfers.erc20From.length, nativeCallsToAuction: transfers.nativeTo.length };
    const hashes = [...new Set([...transfers.erc20To, ...transfers.erc20From, ...transfers.nativeTo].map((x) => x.hash).filter(Boolean))];
    for (const hash of hashes) {
      if (!txs.has(hash)) txs.set(hash, await loadTx(hash, auction, topics, decimals));
      const tx = txs.get(hash);
      for (const event of tx.auctionEvents) {
        if (event.kind === 'bid' && event.bidder === TARGET) targetTokenIds.add(event.tokenId.toString());
      }
    }

    for (const tx of txs.values()) {
      const relevant = tx.auctionEvents.filter((e) => e.kind === 'bid' && targetTokenIds.has(e.tokenId.toString()));
      if (!relevant.length) continue;
      for (const event of relevant) queue.push(event.bidder);
      for (const transfer of tx.tokenTransfers) {
        if (transfer.from === auction.address && transfer.to !== ZERO) queue.push(transfer.to);
      }
    }
  }

  const transactions = [...txs.values()].sort((a, b) => Number(a.block.number - b.block.number));
  const sequences = [];
  for (const tokenId of targetTokenIds) {
    const bids = [];
    const lifecycle = [];
    for (const tx of transactions) {
      for (const event of tx.auctionEvents) {
        if (event.tokenId?.toString() !== tokenId) continue;
        if (event.kind === 'bid') {
          bids.push({
            tokenId,
            bidder: event.bidder,
            amount: event.amount,
            amountFormatted: event.amountFormatted,
            transactionHash: tx.hash,
            transactionFrom: tx.transactionFrom,
            transactionTo: tx.transactionTo,
            nativeValue: tx.nativeValue,
            nativeValueEth: tx.nativeValueEth,
            status: tx.status,
            gasUsed: tx.gasUsed,
            block: tx.block,
            logIndex: event.logIndex,
            tokenTransfers: tx.tokenTransfers,
          });
        } else lifecycle.push({ ...event, transactionHash: tx.hash, block: tx.block });
      }
    }
    bids.sort((a, b) => Number(a.block.number - b.block.number) || a.logIndex - b.logIndex);
    const bidders = [...new Set(bids.map((b) => b.bidder))];
    const accounts = [...bidders, auction.address];
    for (const bid of bids) {
      const before = bid.block.number - 1n;
      bid.auctionStateAfterBlock = await auctionState(auction, bid.block.number, selectors, decimals);
      bid.snapshots = { beforeBlock: {}, afterBlock: {} };
      for (const account of accounts) {
        bid.snapshots.beforeBlock[account] = await snapshot(account, before, selectors, decimals);
        bid.snapshots.afterBlock[account] = await snapshot(account, bid.block.number, selectors, decimals);
      }
    }
    const balancesApi = {};
    for (const bidder of bidders) balancesApi[bidder] = await ledgerEntries(bidder, auction);
    sequences.push({ auctionName: auction.name, auctionAddress: auction.address, tokenId, bidders, bids, lifecycle, balancesApi });
  }

  return { auctionName: auction.name, auctionAddress: auction.address, seenAccounts: [...seen], transfersByAccount, decodedTransactions: transactions.length, sequences };
}

const signatures = {
  bid: 'BidPlaced(uint256,address,uint256)',
  started: 'AuctionStarted(uint256,uint256)',
  extended: 'AuctionExtended(uint256,uint256)',
  settled: 'AuctionSettled(uint256,address,uint256,uint256)',
  transfer: 'Transfer(address,address,uint256)',
};

async function main() {
  const topics = {};
  for (const [name, signature] of Object.entries(signatures)) topics[name] = lower(await rpc('web3_sha3', [`0x${Buffer.from(signature).toString('hex')}`]));
  const selectors = {
    balanceOf: await selector('balanceOf(address)'),
    realtimeBalanceOfNow: await selector('realtimeBalanceOfNow(address)'),
    auction: await selector('auction()'),
  };
  const latest = await rpc('eth_blockNumber', []);
  const decimalsResult = await ethCall(TOKEN, '0x313ce567', 'latest');
  const decimals = Number(BigInt(decimalsResult));
  const discoveries = [];
  for (const auction of AUCTIONS) discoveries.push(await discover(auction, latest, topics, selectors, decimals));
  const sequences = discoveries.flatMap((x) => x.sequences);
  const latestBlock = await blockInfo(latest);
  const report = {
    generatedAt: new Date().toISOString(),
    chain: { id: 8453, name: 'Base', latestBlock },
    target: TARGET,
    token: { address: TOKEN, symbol: 'WARPGOBB', decimals },
    contracts: AUCTIONS,
    discovery: discoveries.map(({ sequences, ...rest }) => rest),
    targetBidCount: sequences.reduce((sum, sequence) => sum + sequence.bids.filter((bid) => bid.bidder === TARGET).length, 0),
    sequenceCount: sequences.length,
    sequences,
  };
  process.stdout.write(json(report));
}

main().catch((error) => {
  console.error(String(error?.stack || error).replace(/https:\/\/base-mainnet\.g\.alchemy\.com\/v2\/[^\s'\"]+/g, '[REDACTED_RPC_URL]'));
  process.exit(1);
});
