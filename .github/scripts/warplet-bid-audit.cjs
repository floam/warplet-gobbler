#!/usr/bin/env node
const path = require('node:path');
const { createRequire } = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '../..');
const webRequire = createRequire(path.join(REPO_ROOT, 'web/package.json'));
const {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} = webRequire('viem');
const { base } = webRequire('viem/chains');

const TARGET = getAddress('0x1034071986fbf826f37d4a6442b056d3442f7777');
const TOKEN = getAddress('0x1A339C38Ae22726F1A4235bCecf8f12aebE4C5E8');
const AUCTIONS = [
  { name: 'current', address: getAddress('0x2943Fd3DD84BB3Bf51d5C4b288f648ab45e4Fc3D'), fromBlock: 47430889n },
  { name: 'legacy', address: getAddress('0xa1046076E518B3Fe1604B2F19ABE90c55c252fd9'), fromBlock: 44000000n },
];

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL is required');
const client = createPublicClient({ chain: base, transport: http(RPC_URL, { timeout: 30_000, retryCount: 0 }) });

const bidEvent = parseAbiItem('event BidPlaced(uint256 indexed tokenId,address indexed bidder,uint256 amount)');
const startEvent = parseAbiItem('event AuctionStarted(uint256 indexed tokenId,uint256 endTime)');
const extendEvent = parseAbiItem('event AuctionExtended(uint256 indexed tokenId,uint256 endTime)');
const settleEvent = parseAbiItem('event AuctionSettled(uint256 indexed tokenId,address indexed winner,uint256 amount,uint256 gobbledTokenId)');
const transferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');

const tokenAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function realtimeBalanceOfNow(address account) view returns (int256 availableBalance,uint256 deposit,uint256 owedDeposit,uint256 timestamp)',
]);
const auctionAbi = parseAbi([
  'function auction() view returns (uint256 tokenId,uint256 amount,uint256 startTime,uint256 endTime,address bidder,bool settled)',
  'function reservePrice() view returns (uint256)',
  'function minBidIncrementPercentage() view returns (uint8)',
  'function timeBuffer() view returns (uint256)',
  'function duration() view returns (uint256)',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(value) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
}
function fmt(value, decimals) {
  return formatUnits(BigInt(value), decimals);
}
function hexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}
function isThrottle(error) {
  const s = String(error?.shortMessage || error?.message || error).toLowerCase();
  return s.includes('compute units per second') || s.includes('rate limit') || s.includes('too many requests') || s.includes('429');
}

async function paced(label, fn) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(450);
    try {
      return await fn();
    } catch (error) {
      if (!isThrottle(error) || attempt === 10) throw error;
      await sleep(attempt * 1200);
    }
  }
  throw new Error(`${label} exhausted retries`);
}

async function alchemyRpc(method, params) {
  return paced(method, async () => {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      const error = new Error(body.error?.message || `${method} returned HTTP ${response.status}`);
      error.code = body.error?.code || response.status;
      throw error;
    }
    return body.result;
  });
}

async function getAssetTransfers({ auction, direction, latestBlock }) {
  const transfers = [];
  let pageKey;
  do {
    const query = {
      fromBlock: hexBlock(auction.fromBlock),
      toBlock: hexBlock(latestBlock),
      category: ['erc20'],
      contractAddresses: [TOKEN],
      excludeZeroValue: false,
      withMetadata: true,
      maxCount: '0x3e8',
      order: 'asc',
    };
    if (direction === 'in') query.toAddress = auction.address;
    else query.fromAddress = auction.address;
    if (pageKey) query.pageKey = pageKey;
    const result = await alchemyRpc('alchemy_getAssetTransfers', [query]);
    transfers.push(...(result.transfers || []));
    pageKey = result.pageKey;
  } while (pageKey);
  return transfers;
}

const blockCache = new Map();
async function blockInfo(blockNumber) {
  const key = BigInt(blockNumber).toString();
  if (!blockCache.has(key)) {
    blockCache.set(key, paced('getBlock', () => client.getBlock({ blockNumber: BigInt(blockNumber) })));
  }
  const block = await blockCache.get(key);
  return { number: block.number, timestamp: block.timestamp, iso: new Date(Number(block.timestamp) * 1000).toISOString() };
}

function decodeTokenTransfers(receipt, decimals) {
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== TOKEN.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      out.push({
        logIndex: log.logIndex,
        from: getAddress(decoded.args.from),
        to: getAddress(decoded.args.to),
        value: decoded.args.value.toString(),
        valueFormatted: fmt(decoded.args.value, decimals),
      });
    } catch {}
  }
  return out;
}

function decodeAuctionEvents(receipt, auctionAddress) {
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== auctionAddress.toLowerCase()) continue;
    for (const [kind, event] of [
      ['bid', bidEvent],
      ['started', startEvent],
      ['extended', extendEvent],
      ['settled', settleEvent],
    ]) {
      try {
        const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
        out.push({ kind, logIndex: log.logIndex, args: decoded.args });
        break;
      } catch {}
    }
  }
  return out;
}

async function snapshotAccounts(accounts, blockNumber, decimals) {
  const contracts = [];
  for (const account of accounts) {
    contracts.push({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [account] });
    contracts.push({ address: TOKEN, abi: tokenAbi, functionName: 'realtimeBalanceOfNow', args: [account] });
  }
  const results = await paced('multicall token snapshots', () => client.multicall({ contracts, blockNumber: BigInt(blockNumber), allowFailure: true }));
  const snapshots = {};
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const balance = results[i * 2];
    const realtime = results[i * 2 + 1];
    const row = { blockNumber: BigInt(blockNumber) };
    if (balance.status === 'success') {
      row.balance = balance.result.toString();
      row.balanceFormatted = fmt(balance.result, decimals);
    } else row.balanceError = String(balance.error?.shortMessage || balance.error?.message || balance.error);
    if (realtime.status === 'success') {
      row.realtimeAvailableBalance = realtime.result[0].toString();
      row.realtimeAvailableBalanceFormatted = fmt(realtime.result[0], decimals);
      row.deposit = realtime.result[1].toString();
      row.depositFormatted = fmt(realtime.result[1], decimals);
      row.owedDeposit = realtime.result[2].toString();
      row.owedDepositFormatted = fmt(realtime.result[2], decimals);
      row.realtimeTimestamp = realtime.result[3].toString();
    } else row.realtimeError = String(realtime.error?.shortMessage || realtime.error?.message || realtime.error);
    snapshots[account] = row;
  }
  return snapshots;
}

async function auctionStateAt(auctionAddress, blockNumber, decimals) {
  const contracts = [
    { address: auctionAddress, abi: auctionAbi, functionName: 'auction' },
    { address: auctionAddress, abi: auctionAbi, functionName: 'reservePrice' },
    { address: auctionAddress, abi: auctionAbi, functionName: 'minBidIncrementPercentage' },
    { address: auctionAddress, abi: auctionAbi, functionName: 'timeBuffer' },
    { address: auctionAddress, abi: auctionAbi, functionName: 'duration' },
  ];
  const r = await paced('multicall auction state', () => client.multicall({ contracts, blockNumber: BigInt(blockNumber), allowFailure: true }));
  const out = {};
  if (r[0].status === 'success') {
    const a = r[0].result;
    out.tokenId = a[0].toString();
    out.amount = a[1].toString();
    out.amountFormatted = fmt(a[1], decimals);
    out.startTime = a[2].toString();
    out.startIso = new Date(Number(a[2]) * 1000).toISOString();
    out.endTime = a[3].toString();
    out.endIso = new Date(Number(a[3]) * 1000).toISOString();
    out.bidder = getAddress(a[4]);
    out.settled = a[5];
  } else out.auctionError = String(r[0].error?.shortMessage || r[0].error?.message || r[0].error);
  if (r[1].status === 'success') {
    out.reservePrice = r[1].result.toString();
    out.reservePriceFormatted = fmt(r[1].result, decimals);
  }
  if (r[2].status === 'success') out.minBidIncrementPercentage = Number(r[2].result);
  if (r[3].status === 'success') out.timeBuffer = r[3].result.toString();
  if (r[4].status === 'success') out.duration = r[4].result.toString();
  return out;
}

async function fetchLedgerEntries(account, auctionAddress) {
  const baseUrl = `https://balances.superfluid.dev/v1/accounts/${account}/tokens/${TOKEN}/entries`;
  const pages = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const url = new URL(baseUrl);
    url.searchParams.set('chain', '8453');
    url.searchParams.set('counterparty', auctionAddress);
    url.searchParams.set('direction', 'asc');
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'warplet-bid-audit/1.0' } });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    pages.push({ offset, status: response.status, body });
    if (!response.ok) break;
    const rows = Array.isArray(body) ? body : body.entries ?? body.items ?? body.data ?? [];
    if (!Array.isArray(rows) || rows.length < 100) break;
  }
  return pages;
}

async function main() {
  const latest = await paced('latest block', () => client.getBlock({ blockTag: 'latest' }));
  const symbol = await paced('token symbol', () => client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'symbol' }));
  const decimals = await paced('token decimals', () => client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'decimals' }));

  const allAuctionData = [];
  for (const auction of AUCTIONS) {
    const incoming = await getAssetTransfers({ auction, direction: 'in', latestBlock: latest.number });
    const outgoing = await getAssetTransfers({ auction, direction: 'out', latestBlock: latest.number });
    const txHashes = [...new Set([...incoming, ...outgoing].map((x) => x.hash).filter(Boolean))];
    const transactions = [];
    for (const hash of txHashes) {
      const tx = await paced('getTransaction', () => client.getTransaction({ hash }));
      const receipt = await paced('getTransactionReceipt', () => client.getTransactionReceipt({ hash }));
      transactions.push({
        hash,
        block: await blockInfo(receipt.blockNumber),
        transactionFrom: getAddress(tx.from),
        transactionTo: tx.to ? getAddress(tx.to) : null,
        nativeValue: tx.value.toString(),
        nativeValueEth: formatUnits(tx.value, 18),
        receiptStatus: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        tokenTransfers: decodeTokenTransfers(receipt, decimals),
        auctionEvents: decodeAuctionEvents(receipt, auction.address),
      });
    }
    transactions.sort((a, b) => Number(BigInt(a.block.number) - BigInt(b.block.number)));
    allAuctionData.push({ auction, incoming, outgoing, transactions });
  }

  const sequences = [];
  for (const auctionData of allAuctionData) {
    const bids = [];
    const lifecycle = [];
    for (const tx of auctionData.transactions) {
      for (const event of tx.auctionEvents) {
        if (event.kind === 'bid') {
          bids.push({
            auctionName: auctionData.auction.name,
            auctionAddress: auctionData.auction.address,
            tokenId: event.args.tokenId.toString(),
            bidder: getAddress(event.args.bidder),
            amount: event.args.amount.toString(),
            amountFormatted: fmt(event.args.amount, decimals),
            transactionHash: tx.hash,
            transactionFrom: tx.transactionFrom,
            transactionTo: tx.transactionTo,
            nativeValue: tx.nativeValue,
            nativeValueEth: tx.nativeValueEth,
            receiptStatus: tx.receiptStatus,
            gasUsed: tx.gasUsed,
            block: tx.block,
            logIndex: event.logIndex,
            tokenTransfers: tx.tokenTransfers,
          });
        } else {
          lifecycle.push({ kind: event.kind, transactionHash: tx.hash, block: tx.block, logIndex: event.logIndex, args: event.args });
        }
      }
    }
    bids.sort((a, b) => Number(BigInt(a.block.number) - BigInt(b.block.number)) || Number(a.logIndex - b.logIndex));
    const targetTokenIds = new Set(bids.filter((b) => b.bidder.toLowerCase() === TARGET.toLowerCase()).map((b) => b.tokenId));
    for (const tokenId of targetTokenIds) {
      const sequenceBids = bids.filter((b) => b.tokenId === tokenId);
      const bidders = [...new Set(sequenceBids.map((b) => b.bidder.toLowerCase()))].map(getAddress);
      const accounts = [...bidders, auctionData.auction.address];
      for (const bid of sequenceBids) {
        const blockNumber = BigInt(bid.block.number);
        bid.auctionStateAfterBlock = await auctionStateAt(auctionData.auction.address, blockNumber, decimals);
        bid.snapshots = {
          beforeBlock: await snapshotAccounts(accounts, blockNumber - 1n, decimals),
          afterBlock: await snapshotAccounts(accounts, blockNumber, decimals),
        };
      }
      const ledger = {};
      for (const bidder of bidders) ledger[bidder] = await fetchLedgerEntries(bidder, auctionData.auction.address);
      sequences.push({
        auctionName: auctionData.auction.name,
        auctionAddress: auctionData.auction.address,
        tokenId,
        bidders,
        bids: sequenceBids,
        lifecycle: lifecycle.filter((x) => x.args.tokenId?.toString() === tokenId),
        balancesApi: ledger,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    chain: { id: 8453, name: 'Base', latestBlock: latest.number, latestTimestamp: latest.timestamp, latestIso: new Date(Number(latest.timestamp) * 1000).toISOString() },
    target: TARGET,
    token: { address: TOKEN, symbol, decimals },
    contracts: AUCTIONS,
    discovery: allAuctionData.map((x) => ({
      auctionName: x.auction.name,
      auctionAddress: x.auction.address,
      incomingAssetTransferCount: x.incoming.length,
      outgoingAssetTransferCount: x.outgoing.length,
      decodedTransactionCount: x.transactions.length,
    })),
    targetBidCount: sequences.reduce((n, s) => n + s.bids.filter((b) => b.bidder.toLowerCase() === TARGET.toLowerCase()).length, 0),
    sequenceCount: sequences.length,
    sequences,
  };
  process.stdout.write(json(report));
}

main().catch((error) => {
  const message = String(error?.stack || error?.message || error).replace(/https:\/\/base-mainnet\.g\.alchemy\.com\/v2\/[^\s'\"]+/g, '[REDACTED_RPC_URL]');
  console.error(message);
  process.exit(1);
});
