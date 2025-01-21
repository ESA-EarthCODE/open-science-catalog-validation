const EXTENSION_SCHEMES = {
  themes: 'https://stac-extensions.github.io/themes/v1.0.0/schema.json',
  contacts: 'https://stac-extensions.github.io/contacts/v0.1.1/schema.json',
  osc: 'https://stac-extensions.github.io/osc/v1.0.0-rc.3/schema.json'
};

const ROOT_CHILDREN = [
  './eo-missions/catalog.json',
  './products/catalog.json',
  './projects/catalog.json',
  './themes/catalog.json',
  './variables/catalog.json'
];

const THEMES_SCHEME = 'https://github.com/stac-extensions/osc#theme';

module.exports = {
  EXTENSION_SCHEMES,
  ROOT_CHILDREN,
  THEMES_SCHEME
};
