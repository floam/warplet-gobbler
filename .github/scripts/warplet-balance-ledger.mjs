const account = '0x1034071986fbf826f37d4a6442b056d3442f7777';
const token = '0x1A339C38Ae22726F1A4235bCecf8f12aebE4C5E8';
const counterparties = {
  all: null,
  currentAuction: '0x2943Fd3DD84BB3Bf51d5C4b288f648ab45e4Fc3D',
  legacyAuction: '0xa1046076E518B3Fe1604B2F19ABE90c55c252fd9',
};
const results = {};
for (const [name, counterparty] of Object.entries(counterparties)) {
  const pages = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const url = new URL(`https://balances.superfluid.dev/v1/accounts/${account}/tokens/${token}/entries`);
    url.searchParams.set('chain', '8453');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));
    if (counterparty) url.searchParams.set('counterparty', counterparty);
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'warplet-bid-audit' }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    pages.push({ offset, status: response.status, body });
    if (!response.ok) break;
    const rows = Array.isArray(body) ? body : body.entries ?? body.items ?? body.data ?? [];
    if (!Array.isArray(rows) || rows.length < 100) break;
  }
  results[name] = pages;
}
console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), account, token, results }, null, 2));
