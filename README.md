# open-science-catalog-validation
Validation for [open-science-catalog-metadata](https://github.com/ESA-EarthCODE/open-science-catalog-metadata).

# Instructions

To run validation do the following:

```bash
npm install ESA-EarthCODE/open-science-catalog-validation
```

Then, inside a folder containing a STAC structure compatible with Open Science Catalog, run:

```bash
open-science-catalog-validation ./{eo-missions,products,projects,themes,variables,workflows,experiments}
```

Example for single file validation:

```bash
open-science-catalog-validation ./projects/3d-earth/collection.json
```

# How it works
This validation package is based on [stac-node-validator](https://github.com/stac-utils/stac-node-validator). Additional to generic validation following the [STAC spec](https://github.com/radiantearth/stac-spec) it does some custom validation (see [./validate.js](./validate.js)).

# Open Science Catalog STAC schema
Open Science Catalog requires a certain STAC and Records structure for its entities (products, projects, variables, workflows, experiments, etc.). The schema for these can be found in [./schemas](./schemas).

These schemas can also be used for e.g. automatically rendering an input form.

To access the schemas in a bundled format (only internal `$ref`s), use the provided GH pages endpoint, e.g. https://esa-earthcode.github.io/open-science-catalog-validation/schemas/projects/children.json.

# Development
For development, copy some compatible folder structure into the root folder, then run `npm install` followed by a `npm test`.

