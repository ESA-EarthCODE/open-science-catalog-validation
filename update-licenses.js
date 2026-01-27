const https = require('https');
const fs = require('fs').promises;

const url = "https://raw.githubusercontent.com/spdx/license-list-data/refs/heads/main/json/licenses.json";

const fetchJson = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data)));
    res.on('error', reject);
  }).on('error', reject);
});

const run = async () => {
  const data = await fetchJson(url);
  const licenses = data.licenses.map(license => license.licenseId);
  licenses.push("other"); // STAC 1.1
  licenses.push("proprietary"); // STAC 1.0
  licenses.push("various"); // STAC 1.0
  licenses.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const content = {
    title: "License",
    type: "string",
    enum: licenses,
  };
  await fs.writeFile("schemas/license.json", JSON.stringify(content, null, 2));
  console.log("License data has been written to schemas/license.json");
};

run().catch(console.error);
