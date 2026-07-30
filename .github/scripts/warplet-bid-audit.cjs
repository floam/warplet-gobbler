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
  {
    name: 'current',
    address: getAddress('0x2943Fd3DD84BB3Bf51d5C4b288f648ab45e4Fc3D'),
    fromBlock: 47430889n,
  },
  {
    name: 'legacy',
    address: getAddress('0xa1046076E518B3Fe1604B2F19ABE90c55c252fd9'),
    // Conservative floor predating the legacy deployment. Target-filtered scans keep this cheap.
    fromBlock: 44000000n,
  },
];

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL is required');
const client = createPublicClient({ chain: base, transport: http(RPC_URL, { timeout: 30_000 }) });

const bidEvent = parseAbiItem('event BidPlaced(uint256 indexed tokenId,address indexed bidder,uint256 amount)');
const startEvent = parseAbiItem('event AuctionStarted(uint256 indexed tokenId,uint256 endTime)');
const extendEvent = parseAbiItem('event AuctionExtended(uint256 indexed tokenId,uint256 endTime)');
const settleEvent = parseAbiItem('event AuctionSettled(uint256 indexed tokenId,address indexed winner,uint256 amount,uint256 gobbledTokenId)');
const transferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');

const tokenAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function realtimeBalanceOfNow(address account) view returns (int256 availableBalance,uint256 deposit,uint256 owedDeposit,uint256 timestamp)',
]);

function json(value) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
}

function fmt(value, decimals) {
  return formatUnits(BigInt(value), decimals);
}

async function getLogsChunked({ address, event, args, fromBlock, toBlock }) {
  const out = [];
  const step = 90_000n;
  for (let start = fromBlock; start <= toBlock; start += step + 1n) {
    const end = start + step > toBlock ? toBlock : start + step;
    const logs = await client.getLogs({ address, event, args, fromBlock: start, toBlock: end });
    out.push(...logs);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function blockInfo(blockNumber) {
  const block = await client.getBlock({ blockNumber });
  return {
    number: block.number,
    timestamp: block.timestamp,
    iso: new Date(Number(block.timestamp) * 1000).toISOString(),
  };
}

async function tokenSnapshot(account, blockNumber, auctionAddress, decimals) {
  const safeBlock = blockNumber < 1n ? 1n : blockNumber;
  const [balance, realtime, allowance] = await Promise.all([
    client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [account], blockNumber: safeBlock }),
    client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'realtimeBalanceOfNow', args: [account], blockNumber: safeBlock }),
    client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'allowance', args: [account, auctionAddress], blockNumber: safeBlock }),
  ]);
  return {
    blockNumber: safeBlock,
    balance: balance.toString(),
    balanceFormatted: fmt(balance, decimals),
    realtimeAvailableBalance: realtime[0].toString(),
    realtimeAvailableBalanceFormatted: fmt(realtime[0], decimals),
    deposit: realtime[1].toString(),
    depositFormatted: fmt(realtime[1], decimals),
    owedDeposit: realtime[2].toString(),
    owedDepositFormatted: fmt(realtime[2], decimals),
    realtimeTimestamp: realtime[3].toString(),
    allowance: allowance.toString(),
    allowanceFormatted: fmt(allowance, decimals),
  };
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
  const [latest, symbol, decimals] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'symbol' }),
    client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'decimals' }),
  ]);

  const targetHits = [];
  for (const auction of AUCTIONS) {
    const logs = await getLogsChunked({
      address: auction.address,
      event: bidEvent,
      args: { bidder: TARGET },
      fromBlock: auction.fromBlock,
      toBlock: latest.number,
    });
    for (const log of logs) {
      targetHits.push({ auction, log });
    }
  }

  const keys = new Map();
  for (const hit of targetHits) {
    const tokenId = hit.log.args.tokenId;
    keys.set(`${hit.auction.address.toLowerCase()}:${tokenId}`, { auction: hit.auction, tokenId });
  }

  const sequences = [];
  for (const { auction, tokenId } of keys.values()) {
    const [bids, starts, extensions, settlements] = await Promise.all([
      getLogsChunked({ address: auction.address, event: bidEvent, args: { tokenId }, fromBlock: auction.fromBlock, toBlock: latest.number }),
      getLogsChunked({ address: auction.address, event: startEvent, args: { tokenId }, fromBlock: auction.fromBlock, toBlock: latest.number }),
      getLogsChunked({ address: auction.address, event: extendEvent, args: { tokenId }, fromBlock: auction.fromBlock, toBlock: latest.number }),
      getLogsChunked({ address: auction.address, event: settleEvent, args: { tokenId }, fromBlock: auction.fromBlock, toBlock: latest.number }),
    ]);

    const enrichedBids = await mapLimit(bids, 4, async (log) => {
      const bidder = getAddress(log.args.bidder);
      const [block, tx, receipt] = await Promise.all([
        blockInfo(log.blockNumber),
        client.getTransaction({ hash: log.transactionHash }),
        client.getTransactionReceipt({ hash: log.transactionHash }),
      ]);
      const beforeBlock = log.blockNumber > 0n ? log.blockNumber - 1n : log.blockNumber;
      const [bidderBefore, bidderAfter, targetBefore, targetAfter, auctionBefore, auctionAfter] = await Promise.all([
        tokenSnapshot(bidder, beforeBlock, auction.address, decimals),
        tokenSnapshot(bidder, log.blockNumber, auction.address, decimals),
        bidder.toLowerCase() === TARGET.toLowerCase() ? Promise.resolve(null) : tokenSnapshot(TARGET, beforeBlock, auction.address, decimals),
        bidder.toLowerCase() === TARGET.toLowerCase() ? Promise.resolve(null) : tokenSnapshot(TARGET, log.blockNumber, auction.address, decimals),
        tokenSnapshot(auction.address, beforeBlock, auction.address, decimals),
        tokenSnapshot(auction.address, log.blockNumber, auction.address, decimals),
      ]);
      return {
        block,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        transactionFrom: getAddress(tx.from),
        transactionTo: tx.to ? getAddress(tx.to) : null,
        nativeValue: tx.value.toString(),
        nativeValueEth: formatUnits(tx.value, 18),
        receiptStatus: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        bidder,
        amount: log.args.amount.toString(),
        amountFormatted: fmt(log.args.amount, decimals),
        tokenTransfers: decodeTokenTransfers(receipt, decimals),
        snapshots: {
          bidderBefore,
          bidderAfter,
          targetBefore,
          targetAfter,
          auctionBefore,
          auctionAfter,
        },
      };
    });

    enrichedBids.sort((a, b) => Number(BigInt(a.block.number) - BigInt(b.block.number)) || Number(a.logIndex - b.logIndex));
    const bidders = [...new Set(enrichedBids.map((x) => x.bidder.toLowerCase()))].map(getAddress);

    const lifecycle = await mapLimit([
      ...starts.map((log) => ({ kind: 'started', log, args: { endTime: log.args.endTime } })),
      ...extensions.map((log) => ({ kind: 'extended', log, args: { endTime: log.args.endTime } })),
      ...settlements.map((log) => ({ kind: 'settled', log, args: { winner: log.args.winner, amount: log.args.amount, gobbledTokenId: log.args.gobbledTokenId } })),
    ], 4, async (item) => ({
      kind: item.kind,
      block: await blockInfo(item.log.blockNumber),
      transactionHash: item.log.transactionHash,
      logIndex: item.log.logIndex,
      args: item.args,
    }));
    lifecycle.sort((a, b) => Number(BigInt(a.block.number) - BigInt(b.block.number)) || Number(a.logIndex - b.logIndex));

    const ledger = {};
    for (const bidder of bidders) {
      ledger[bidder] = await fetchLedgerEntries(bidder, auction.address);
    }

    sequences.push({
      auctionName: auction.name,
      auctionAddress: auction.address,
      tokenId: tokenId.toString(),
      bidders,
      bids: enrichedBids,
      lifecycle,
      balancesApi: ledger,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    chain: { id: 8453, name: 'Base', latestBlock: latest.number, latestTimestamp: latest.timestamp, latestIso: new Date(Number(latest.timestamp) * 1000).toISOString() },
    target: TARGET,
    token: { address: TOKEN, symbol, decimals },
    contracts: AUCTIONS,
    targetBidCount: targetHits.length,
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
