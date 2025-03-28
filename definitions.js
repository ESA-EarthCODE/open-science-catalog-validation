const EXTENSION_SCHEMES = {
  themes: 'https://stac-extensions.github.io/themes/v1.0.0/schema.json',
  contacts: 'https://stac-extensions.github.io/contacts/v0.1.1/schema.json',
  // TODO add "Scientific Citation Extension Specification" for DOIs
  osc: 'https://stac-extensions.github.io/osc/v1.0.0/schema.json'
};

const ROOT_CHILDREN = [
  './eo-missions/catalog.json',
  './products/catalog.json',
  './projects/catalog.json',
  './themes/catalog.json',
  './variables/catalog.json',
  './workflows/catalog.json',
  './experiments/catalog.json'
];


const RELATED_TITLE_PREFIX = {
  projects: 'Project',
  products: 'Product',
  experiments: 'Experiment',
  workflows: 'Workflow',
  themes: 'Theme',
  variables: 'Variable',
  'eo-missions': 'EO Mission'
};

const THEMES_SCHEME = 'https://github.com/stac-extensions/osc#theme';

module.exports = {
  EXTENSION_SCHEMES,
  ROOT_CHILDREN,
  RELATED_TITLE_PREFIX,
  THEMES_SCHEME
};
