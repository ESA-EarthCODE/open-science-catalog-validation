# open-science-catalog-validation
Validation for [open-science-catalog-metadata](https://github.com/ESA-EarthCODE/open-science-catalog-metadata).

# Instructions

To run validation do the following:

```bash
npm install ESA-EarthCODE/open-science-catalog-validation
```

Then, inside a folder containing a STAC structure compatible with Open Science Catalog, run:

```bash
open-science-catalog-validation ./{eo-missions,products,projects,themes,variables}
```

Example for single file validation:

```bash
open-science-catalog-validation ./projects/3d-earth/collection.json
```

# How it works
This validation package is based on [stac-node-validator](https://github.com/stac-utils/stac-node-validator). Additional to generic validation following the [STAC spec](https://github.com/radiantearth/stac-spec) it does some custom validation (see [./validate.js](./validate.js)).

# Open Science Catalog STAC schema
Open Science Catalog requires a certain STAC structure for its entities (products, projects, variables etc.). The schema for these can be found in [./schemas](./schemas).

These schemas can also be used for e.g. automatically rendering an input form.

# Development
For development, copy some compatible folder structure into the root folder, then run `npm install` follwed by a `npm test`.

