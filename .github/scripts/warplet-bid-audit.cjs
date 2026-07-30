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

const auctionAbi = parseAbi([
  'function auction() view returns (uint256 tokenId,uint256 amount,uint256 startTime,uint256 endTime,address bidder,bool settled)',
  'function reservePrice() view returns (uint256)',
  'function minBidIncrementPercentage() view returns (uint8)',
  'function timeBuffer() view returns (uint256)',
  'function duration() view returns (uint256)',
]);

function json(value) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
}

function fmt(value, decimals) {
  return formatUnits(BigInt(value), decimals);
}

function hexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}

async function alchemyRpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    const message = body.error?.message || `${method} returned HTTP ${response.status}`;
    throw new Error(`${method}: ${message}`);
  }
  return body.result;
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

async function safeRead(request) {
  try {
    return { ok: true, value: await client.readContract(request) };
  } catch (error) {
    return { ok: false, error: String(error?.shortMessage || error?.message || error) };
  }
}

async function tokenSnapshot(account, blockNumber, auctionAddress, decimals) {
  const safeBlock = blockNumber < 1n ? 1n : blockNumber;
  const [balanceResult, realtimeResult, allowanceResult] = await Promise.all([
    safeRead({ address: TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [account], blockNumber: safeBlock }),
    safeRead({ address: TOKEN, abi: tokenAbi, functionName: 'realtimeBalanceOfNow', args: [account], blockNumber: safeBlock }),
    safeRead({ address: TOKEN, abi: tokenAbi, functionName: 'allowance', args: [account, auctionAddress], blockNumber: safeBlock }),
  ]);
  const out = { blockNumber: safeBlock };
  if (balanceResult.ok) {
    out.balance = balanceResult.value.toString();
    out.balanceFormatted = fmt(balanceResult.value, decimals);
  } else out.balanceError = balanceResult.error;
  if (realtimeResult.ok) {
    const realtime = realtimeResult.value;
    out.realtimeAvailableBalance = realtime[0].toString();
    out.realtimeAvailableBalanceFormatted = fmt(realtime[0], decimals);
    out.deposit = realtime[1].toString();
    out.depositFormatted = fmt(realtime[1], decimals);
    out.owedDeposit = realtime[2].toString();
    out.owedDepositFormatted = fmt(realtime[2], decimals);
    out.realtimeTimestamp = realtime[3].toString();
  } else out.realtimeError = realtimeResult.error;
  if (allowanceResult.ok) {
    out.allowance = allowanceResult.value.toString();
    out.allowanceFormatted = fmt(allowanceResult.value, decimals);
  } else out.allowanceError = allowanceResult.error;
  return out;
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

async function auctionStateAt(auctionAddress, blockNumber, decimals) {
  const [auction, reserve, increment, timeBuffer, duration] = await Promise.all([
    safeRead({ address: auctionAddress, abi: auctionAbi, functionName: 'auction', blockNumber }),
    safeRead({ address: auctionAddress, abi: auctionAbi, functionName: 'reservePrice', blockNumber }),
    safeRead({ address: auctionAddress, abi: auctionAbi, functionName: 'minBidIncrementPercentage', blockNumber }),
    safeRead({ address: auctionAddress, abi: auctionAbi, functionName: 'timeBuffer', blockNumber }),
    safeRead({ address: auctionAddress, abi: auctionAbi, functionName: 'duration', blockNumber }),
  ]);
  const out = {};
  if (auction.ok) {
    out.tokenId = auction.value[0].toString();
    out.amount = auction.value[1].toString();
    out.amountFormatted = fmt(auction.value[1], decimals);
    out.startTime = auction.value[2].toString();
    out.startIso = new Date(Number(auction.value[2]) * 1000).toISOString();
    out.endTime = auction.value[3].toString();
    out.endIso = new Date(Number(auction.value[3]) * 1000).toISOString();
    out.bidder = getAddress(auction.value[4]);
    out.settled = auction.value[5];
  } else out.auctionError = auction.error;
  if (reserve.ok) {
    out.reservePrice = reserve.value.toString();
    out.reservePriceFormatted = fmt(reserve.value, decimals);
  } else out.reservePriceError = reserve.error;
  if (increment.ok) out.minBidIncrementPercentage = Number(increment.value);
  else out.minBidIncrementPercentageError = increment.error;
  if (timeBuffer.ok) out.timeBuffer = timeBuffer.value.toString();
  else out.timeBufferError = timeBuffer.error;
  if (duration.ok) out.duration = duration.value.toString();
  else out.durationError = duration.error;
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

  const allAuctionData = [];
  for (const auction of AUCTIONS) {
    const [incoming, outgoing] = await Promise.all([
      getAssetTransfers({ auction, direction: 'in', latestBlock: latest.number }),
      getAssetTransfers({ auction, direction: 'out', latestBlock: latest.number }),
    ]);
    const txHashes = [...new Set([...incoming, ...outgoing].map((x) => x.hash).filter(Boolean))];
    const transactions = await mapLimit(txHashes, 5, async (hash) => {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash }),
        client.getTransactionReceipt({ hash }),
      ]);
      const block = await blockInfo(receipt.blockNumber);
      return {
        hash,
        block,
        transactionFrom: getAddress(tx.from),
        transactionTo: tx.to ? getAddress(tx.to) : null,
        nativeValue: tx.value.toString(),
        nativeValueEth: formatUnits(tx.value, 18),
        receiptStatus: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        tokenTransfers: decodeTokenTransfers(receipt, decimals),
        auctionEvents: decodeAuctionEvents(receipt, auction.address),
      };
    });
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
          lifecycle.push({
            kind: event.kind,
            transactionHash: tx.hash,
            block: tx.block,
            logIndex: event.logIndex,
            args: event.args,
          });
        }
      }
    }
    bids.sort((a, b) => Number(BigInt(a.block.number) - BigInt(b.block.number)) || Number(a.logIndex - b.logIndex));
    const targetTokenIds = new Set(bids.filter((b) => b.bidder.toLowerCase() === TARGET.toLowerCase()).map((b) => b.tokenId));
    for (const tokenId of targetTokenIds) {
      const sequenceBids = bids.filter((b) => b.tokenId === tokenId);
      const bidders = [...new Set(sequenceBids.map((b) => b.bidder.toLowerCase()))].map(getAddress);
      for (const bid of sequenceBids) {
        const beforeBlock = BigInt(bid.block.number) - 1n;
        bid.auctionStateAfterBlock = await auctionStateAt(auctionData.auction.address, BigInt(bid.block.number), decimals);
        bid.snapshots = {};
        for (const account of [...bidders, auctionData.auction.address]) {
          bid.snapshots[account] = {
            before: await tokenSnapshot(account, beforeBlock, auctionData.auction.address, decimals),
            afterBlock: await tokenSnapshot(account, BigInt(bid.block.number), auctionData.auction.address, decimals),
          };
        }
      }
      const ledger = {};
      for (const bidder of bidders) {
        ledger[bidder] = await fetchLedgerEntries(bidder, auctionData.auction.address);
      }
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

  const targetBidCount = sequences.reduce((n, s) => n + s.bids.filter((b) => b.bidder.toLowerCase() === TARGET.toLowerCase()).length, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    chain: {
      id: 8453,
      name: 'Base',
      latestBlock: latest.number,
      latestTimestamp: latest.timestamp,
      latestIso: new Date(Number(latest.timestamp) * 1000).toISOString(),
    },
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
    targetBidCount,
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
