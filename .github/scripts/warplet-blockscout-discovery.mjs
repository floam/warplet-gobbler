const TARGET = '0x1034071986fbf826f37d4a6442b056d3442f7777';
const TOKEN = '0x1A339C38Ae22726F1A4235bCecf8f12aebE4C5E8';
const AUCTIONS = {
  current: '0x2943Fd3DD84BB3Bf51d5C4b288f648ab45e4Fc3D',
  legacy: '0xa1046076E518B3Fe1604B2F19ABE90c55c252fd9',
};
const lower = (x) => x?.toLowerCase();

const url = new URL('https://base.blockscout.com/api');
url.searchParams.set('module', 'account');
url.searchParams.set('action', 'tokentx');
url.searchParams.set('address', TARGET);
url.searchParams.set('contractaddress', TOKEN);
url.searchParams.set('startblock', '44000000');
url.searchParams.set('page', '1');
url.searchParams.set('offset', '1000');
url.searchParams.set('sort', 'asc');
const response = await fetch(url, {
  headers: { accept: 'application/json', 'user-agent': 'warplet-bid-audit' },
  signal: AbortSignal.timeout(30_000),
});
const text = await response.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
const rows = Array.isArray(body?.result) ? body.result : [];
const auctionSet = new Set(Object.values(AUCTIONS).map(lower));
const relevant = rows.filter((row) => auctionSet.has(lower(row.from)) || auctionSet.has(lower(row.to)));
console.log(JSON.stringify({
  fetchedAt: new Date().toISOString(), status: response.status,
  target: TARGET, token: TOKEN, auctionAddresses: AUCTIONS,
  totalTokenTransfersSinceBlock44000000: rows.length,
  relevantCount: relevant.length,
  relevant,
}, null, 2));
