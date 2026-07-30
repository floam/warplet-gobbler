const TARGET = '0x1034071986fbf826f37d4a6442b056d3442f7777';
const TOKEN = '0x1A339C38Ae22726F1A4235bCecf8f12aebE4C5E8';
const AUCTIONS = {
  current: '0x2943Fd3DD84BB3Bf51d5C4b288f648ab45e4Fc3D',
  legacy: '0xa1046076E518B3Fe1604B2F19ABE90c55c252fd9',
};
const lower = (x) => x?.toLowerCase();

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'warplet-bid-audit' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function tokenTransfers(address) {
  const url = new URL('https://base.blockscout.com/api');
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'tokentx');
  url.searchParams.set('address', address);
  url.searchParams.set('contractaddress', TOKEN);
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', '10000');
  url.searchParams.set('sort', 'asc');
  const response = await fetchJson(url);
  const rows = Array.isArray(response.body?.result) ? response.body.result : [];
  return { ...response, rows };
}

const target = await tokenTransfers(TARGET);
const auctions = {};
for (const [name, address] of Object.entries(AUCTIONS)) auctions[name] = await tokenTransfers(address);

const auctionSet = new Set(Object.values(AUCTIONS).map(lower));
const targetRelevant = target.rows.filter((row) => auctionSet.has(lower(row.from)) || auctionSet.has(lower(row.to)));
const relatedHashes = new Set(targetRelevant.map((row) => lower(row.hash)));
const related = {};
for (const [name, result] of Object.entries(auctions)) {
  related[name] = result.rows.filter((row) => relatedHashes.has(lower(row.hash)));
}

const transactionDetails = {};
for (const hash of relatedHashes) {
  transactionDetails[hash] = {
    transaction: await fetchJson(`https://base.blockscout.com/api/v2/transactions/${hash}`),
    logs: await fetchJson(`https://base.blockscout.com/api/v2/transactions/${hash}/logs`),
  };
}

console.log(JSON.stringify({
  fetchedAt: new Date().toISOString(),
  target: TARGET,
  token: TOKEN,
  auctionAddresses: AUCTIONS,
  counts: {
    targetAll: target.rows.length,
    targetRelevant: targetRelevant.length,
    currentAuctionAll: auctions.current.rows.length,
    legacyAuctionAll: auctions.legacy.rows.length,
    relatedHashes: relatedHashes.size,
  },
  targetRelevant,
  related,
  transactionDetails,
}, null, 2));
