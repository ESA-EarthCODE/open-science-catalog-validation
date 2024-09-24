# open-science-catalog-validation
Validation for [open-science-catalog-metadata](https://github.com/ESA-EarthCODE/open-science-catalog-metadata)


## How-to

In order to run the valdation, run the folling steps:

```bash
npm install
```

```bash
npx stac-node-validator --config config.json ../../metadata/{eo-missions,products,projects,themes,variables}
```