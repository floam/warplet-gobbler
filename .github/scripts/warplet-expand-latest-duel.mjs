const hashes = [
  '0xb2dfc9bcf24496981197956d2a7703e5ff79b917c550ae404ec08ab6b6df4d08',
  '0x5c726d3c2f06d3b7f337d9401c768e7c191169a83474e9f9e6dfc6e37faf8554',
  '0x20572471a49641b585286c147bdc6e7759f7e2c37c862c59339025b631310eff',
  '0x5bc3bdd752b5a7a14f0a69ff65b205270811d5a3dcb186444ff500e156d62095',
  '0x450b9ae1e1a6878bc19058d0fc1773a263b515269875106e25d536d3ae66c9d6',
  '0xf1ea3d168abd2ce6aa29b428bc396bca267a4b5f3a6bf93b328f925ad89eb622',
  '0x593b126fc8cc03e4f5c2a97455252bb82a41b5ab00fd95c10b7c96d30cd89aa5',
  '0x290d3199248433bad84c5810a415541483fdca20342bd883189d16f977d946a8',
  '0x88de87bcc188c8c0400cce5e0638d29c521f550195b302f2c595c23c50cd0b23',
  '0x01dcd58a2567ec83fe893c43ef9fc6a3d60be3e6759b11ece8d117a09575c498',
  '0x964c560241d492d3b8d9258bdc33a624efc737907a185d4858d4f97f4a9d6cf9',
  '0x955c7a819bd62c551d0adab77c117e9ec16aafaa6a1ee5ae1caa16e20f5cc39f',
  '0x5490b6d8e1dbe1c15740136987fcc3b20b400917fa7fe185f6fb2fc057bbae6c',
  '0x3440f2034c3c00c9afab7a77c1c88ac31901d5e989e95d6ec01ae3dcbbae8ae7',
  '0x5d39d45ed9619c21ccf7a00a976d0c445921e4926cd43a0ad1795b56d17eeac2',
];
async function get(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'warplet-bid-audit' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, body };
}
const transactions = {};
for (const hash of hashes) {
  transactions[hash] = {
    transaction: await get(`https://base.blockscout.com/api/v2/transactions/${hash}`),
    logs: await get(`https://base.blockscout.com/api/v2/transactions/${hash}/logs`),
  };
}
console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), hashes, transactions }, null, 2));
