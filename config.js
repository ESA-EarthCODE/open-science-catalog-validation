const path = require('path');
const SCHEMA_URL = 'https://testing.earthcode.eox.at/schemas/';
module.exports = {
  "lint": false,
  "custom": "./validate.js",
  "schemaMap": {
    [SCHEMA_URL]: path.resolve("./schemas") + path.sep
  },
  SCHEMA_URL
};
