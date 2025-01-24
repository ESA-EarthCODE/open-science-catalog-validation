const BaseValidator = require('stac-node-validator/src/baseValidator.js');
const { isObject } = require('stac-node-validator/src/utils.js');
const fs = require('fs-extra');
const path = require('path');
const sizeOf = require('image-size');
const Test = require('stac-node-validator/src/test.js');
const {
  EXTENSION_SCHEMES,
  ROOT_CHILDREN,
  THEMES_SCHEME
} = require('./definitions.js');

const RECORDS_CONFORMANCE_CLASS = "http://www.opengis.net/spec/ogcapi-records-1/1.0/req/record-core";

class CustomValidator extends BaseValidator {

  constructor() {
    super();
    this.titles = {};
    this.recordsValidator = null;
  }

  async getRecordsValidator(ajv) {
    if (this.recordsValidator === null) {
      const recordsSchema = await fs.readJson('./schemas/records.json');
      this.recordsValidator = await ajv.compileAsync(recordsSchema);
    }
    return this.recordsValidator;
  }

  async getTitleForFile(file) {
    if (typeof this.titles[file] === 'undefined') {
      const stac = await fs.readJson(file);
      this.registerTitle(file, stac);
    }
    return this.titles[file];
  }

  registerTitle(file, stac) {
    file = path.resolve(file);
    if (stac?.type === "Feature") {
      this.titles[file] = stac?.properties?.title || null;
    }
    else {
      this.titles[file] = stac?.title || null;
    }
  }

  async bypassValidation(data, report, config) {
    if (Array.isArray(data.conformsTo) && data.conformsTo.includes(RECORDS_CONFORMANCE_CLASS)) {
      const setValidity = (errors = []) => {
        report.valid = report.valid !== false && errors.length === 0;
        report.results.core = errors;
      };
      const recordsValidator = await this.getRecordsValidator(config.ajv);
      try {
        const valid = recordsValidator(data);
        if (!valid) {
          setValidity(recordsValidator.errors);
        }
        else {
          setValidity();
        }
      } catch (error) {
        setValidity([{ message: error.message }]);
      }

      const isProcess = !!report.id.match(/\/processes\/[^\/]+\/item.json/);
      const test = new Test();
      const run = new ValidationRun(this, data, test, report);
      if (isProcess) {
        await run.validateProcess();
      }

      // If stac_version is present, continue with STAC validation additionally.
      // Otherwise return report and abort validation.
      return (typeof data.stac_version !== 'string') ? report : null;
    }
    return null;
  }

  async afterLoading(data, report, config) {
    // Add UI schema to STAC extensions to validate against them additionally
    const match = report.id.match(/\/(eo-missions|products|projects|themes|variables|processes)\/(catalog.json|.+)/);

// TODO Load schema files (see https://github.com/ESA-EarthCODE/open-science-catalog-validation/pull/12#issuecomment-2610426543)
//    if (match) {
//      const type = match[1];
//      const level = match[2] === 'catalog.json' ? 'parent' : 'children';
//
//      if (!Array.isArray(data.stac_extensions)) {
//        data.stac_extensions = [];
//      }
//
//      data.stac_extensions.push('./schemas/'+type+'/'+level+'.json');
//    }

    // Cache title to allow checks for consistent titles
    this.registerTitle(report.id, data);

    return data;
  }

  async afterValidation(data, test, report, config) {
    const isRootCatalog = report.id.endsWith('/catalog.json') && data.id === "osc";
    const isEoMission = !!report.id.match(/\/eo-missions\/[^\/]+\/catalog.json/);
    const isProduct = !!report.id.match(/\/products\/[^\/]+\/collection.json/);
    const isProductUserContent = !!report.id.match(/\/products\/[^\/]+\/.+.json/) && !isProduct;
    const isProject = !!report.id.match(/\/projects\/[^\/]+\/collection.json/);
    const isTheme = !!report.id.match(/\/themes\/[^\/]+\/catalog.json/);
    const isVariable = !!report.id.match(/\/variables\/[^\/]+\/catalog.json/);
    const isSubCatalog = !!report.id.match(/\/(eo-missions|products|projects|themes|variables|processes)\/catalog.json/);

    // Ensure consistent STAC version
    // @todo: Enable STAC 1.1.0 support once released
    test.equal(data.stac_version, "1.0.0", `stac_version must be '1.0.0'`);

    // Ensure all catalogs and collections have a title
    test.truthy(!data.isCatalogLike() || (typeof data.title === 'string' && data.title.length > 0), "must have a title");

    const run = new ValidationRun(this, data, test, report);

    if (isProductUserContent) {
      run.validateUserContent();
    }
    else if (isSubCatalog) {
      const childEntity = path.basename(path.dirname(report.id));
      let childStacType = 'Catalog';
      if (['products', 'projects'].includes(childEntity)) {
        childStacType = 'Collection';
      }
      else if (['processes'].includes(childEntity)) {
        childStacType = 'Item';
      }
      await run.validateSubCatalogs(childStacType);
    }
    else if (isRootCatalog) {
      await run.validateRoot();
    }
    else if (isEoMission) {
      await run.validateEoMission();
    }
    else if (isProduct) {
      await run.validateProduct();
    }
    else if (isProject) {
      await run.validateProject();
    }
    else if (isTheme) {
      await run.validateTheme();
    }
    else if (isVariable) {
      await run.validateVariable();
    }
    else {
      test.fail("A file was found in an unexpected location. Validation must occur in the context of a full OSC metadata catalog. Files outside of the expected structure can't be validated.");
    }
  }
}


class ValidationRun {

  constructor(parent, data, test, report) {
    this.parent = parent;
    this.data = data;
    this.t = test;
    this.report = report;
    this.folder = path.dirname(report.id);
  }

  resolve(folder, href) {
    const linkPrefix = "https://esa-earthcode.github.io/open-science-catalog-metadata/";
    if (href.startsWith(linkPrefix)) {
      href = href.slice(linkPrefix.length);
    }
    return path.resolve(folder, href);
  }

  async validateRoot() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.t.equal(this.data.id, "osc", `id must be 'osc'`);
    this.t.equal(this.data.title, "Open Science Catalog", `title must be 'Open Science Catalog'`);

    // check parent and root
    await this.requireRootLink("./catalog.json");
    this.t.truthy(!this.data.getLinkWithRel('parent'), "must NOT have a parent");

    // check child links
    await this.requireChildLinksForOtherJsonFiles("Catalog", ROOT_CHILDREN);
  }

  async validateSubCatalogs(childStacType) {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.ensureIdIsFolderName();

    // check that catalog.json is parent and root
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../catalog.json");

    // check child links
    await this.requireChildLinksForOtherJsonFiles(childStacType);
  }

  validateUserContent() {
    // @todo: Which rules apply?
  }

  async validateEoMission() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
  }

  async validateProduct() {
    this.t.equal(this.data.type, "Collection", `type must be 'Collection'`);
    this.hasExtensions(["osc"]);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");

    await this.checkOscExtension("product");
  }

  async validateProject() {
    this.t.equal(this.data.type, "Collection", `type must be 'Collection'`);
    this.hasExtensions(["osc", "contacts"]);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");

    this.requireTechnicalOfficer();

    await this.checkOscExtension("project");
  }

  async validateTheme() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.ensureIdIsFolderName();

    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");

    this.checkPreviewImage();
  }

  async validateVariable() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.hasExtensions(["themes"]);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");

    const theme = this.data.themes.find(theme => theme.scheme === THEMES_SCHEME);

    this.t.truthy(theme, `must have theme with scheme '${THEMES_SCHEME}'`);

    const copy = {
      concepts: theme.concepts.map(concept => concept.id)
    };
    await this.checkOscCrossRefArray(copy, "concepts", "themes");
  }

  async validateProcess() {
    this.t.equal(this.data.type, "Feature", `type must be 'Feature'`);
    this.hasExtensions(["themes"]);
    this.ensureIdIsFolderName();

    //TODO add support for relative links

// TODO Extend process validation (see https://github.com/ESA-EarthCODE/open-science-catalog-validation/pull/12#issuecomment-2610426543)
//    this.requireDataLink();
//    await this.requireParentLink("../catalog.json");
//    await this.requireRootLink("../../catalog.json");
  }

  hasExtensions(extensions) {
    if (Array.isArray(this.data.stac_extensions)) {
      for(let ext of extensions) {
        this.t.truthy(this.data.stac_extensions.includes(EXTENSION_SCHEMES[ext]), "must implement extension: " + ext);
      }
    }
    else {
      this.t.fail("must implement extensions: " + extensions.join(", "));
    }
  }

  checkPreviewImage() {
    // Check that the theme has a preview image with valid properties and that the file exists
    const link = this.data.getLinkWithRel("preview");
    this.t.truthy(isObject(link), "must have 'preview' link");
    if (!isObject(link)) {
      return;
    }
    this.t.equal(link.type, "image/webp");
    this.t.equal(link["proj:epsg"], null);

    const previewPath = this.resolve(this.folder, link.href);

    try {
      const dimensions = sizeOf(previewPath);
      this.t.deepEqual(link["proj:shape"], [dimensions.height, dimensions.width]);
    } catch(error) {
      this.t.fail(`Preview image doesn't exist or is corrupt: ${previewPath}`);
    }
  }

  ensureIdIsFolderName() {
    const match = this.report.id.match(/\/([^\/]+)\/[^\/]+.json/);
    this.t.equal(this.data.id, match[1], "parent folder name must match id");
  }

  // check that all files are linked to as child links and that all child links exist
  async requireChildLinksForOtherJsonFiles(type, files = [], fileExt = 'json', linkRel = 'child', linkType = 'application/json') {
    if(files.length === 0) {
      const dir = await fs.opendir(this.folder);
      for await (const file of dir) {
        if (file.isDirectory()) {
          if (type) {
            const filename = type.toLowerCase();
            const filepath = path.normalize(`${this.folder}/${file.name}/${filename}.${fileExt}`);
            files.push(filepath);
          }
          else {
            const subfolder = `${this.folder}/${file.name}`;
            const subdir = await fs.opendir(subfolder);
            for await (const file of subdir) {
              if (file.name.endsWith(`.${fileExt}`)) {
                const filepath = path.normalize(`${subfolder}/${file.name}`);
                files.push(filepath);
              }
            }
          }
        }
      }
    }
    else {
      files = files.map(file => this.resolve(this.folder, file));
    }

    const links = this.data.getLinksWithRels([linkRel]);
    for(const link of links) {
      this.t.equal(link.type, linkType, `Link with relation ${linkRel} to ${link.href} must be of type ${linkType}`);
      if (link.href.endsWith('.json')) {
        await this.checkLinkTitle(link, this.folder);
      }
    }

    const linkHrefs = links.map(link => this.resolve(this.folder, link.href));

    let missingChilds = files.filter(x => !linkHrefs.includes(x));
    for(const file of missingChilds) {
      this.t.fail(`must have link with relation ${linkRel} to ${file}`);
    }

    let missingFiles = linkHrefs.filter(x => !files.includes(x));
    for(const file of missingFiles) {
      this.t.fail(`must have file for link ${file} with relation ${linkRel}`);
    }
  }

  async checkLinkTitle(link) {
    const href = this.resolve(this.folder, link.href);
    const title = await this.parent.getTitleForFile(href);
    if (typeof title === "string") {
      this.t.equal(link.title, title, `Title of link to ${link.href} is not the title of the linked file ${href}`);
    }
  }

  async checkOscExtension(type) {
    this.t.equal(this.data["osc:type"], type, `'osc:type' must be '${type}'`);

    if (type === "product") {
      this.t.equal(typeof this.data["osc:project"], 'string', `'osc:project' must be a string`);
      if (typeof this.data["osc:project"] === 'string') {
        await this.checkOscCrossRef(this.data["osc:project"], "projects");
      }
      await this.checkOscCrossRefArray(this.data, "osc:variables", "variables");
    }
    await this.checkOscCrossRefArray(this.data, "osc:missions", "eo-missions");
    if (typeof this.data["osc:themes"] !== 'undefined') {
      await this.checkOscCrossRefArray(this.data, "osc:themes", "themes");
    }
  }

  async checkOscCrossRefArray(data, field, type) {
    const values = data[field];
    this.t.truthy(Array.isArray(values), `'${field}' must be an array`);
    if (Array.isArray(values)) {
      await Promise.all(values.map(value => this.checkOscCrossRef(value, type)));
    }
  }

  async checkOscCrossRef(value, type) {
    const slug = this.slugify(value);
    const filename = ['products', 'projects'].includes(type) ? 'collection' : 'catalog';
    const filepath = this.resolve(this.folder, `../../${type}/${slug}/${filename}.json`);

    this.t.truthy(await fs.pathExists(filepath), `The referenced ${type} '${value}' must exist at ${filepath}`);
  }

  slugify(value) {
    return String(value)
      .replace(/[^a-z0-9]+/gi, '-') // Replace all sequences of non-alphanumeric characters with a dash
      .replace(/^-+|-+$/g, '') // Trim leading/trailing dashes
      .toLowerCase();
  }

  requireTechnicalOfficer() {
    // Check for technical officer information
    this.t.truthy(Array.isArray(this.data.contacts), "must have contacts");
    const contact = this.data.contacts.find(c => Array.isArray(c.roles) && c.roles.includes("technical_officer"));
    if (contact) {
      this.t.truthy(typeof contact.name === "string" && contact.name.length > 1, "must have name for technical officer");
      this.t.truthy(Array.isArray(contact.emails) && contact.emails.length > 0, "must have email array for technical officer");
      const email = contact.emails[0].value;
      this.t.truthy(typeof email === 'string' && email.length > 1, "must have email value for technical officer");
    }
    else {
      this.t.fail("must have technical officer as contact");
    }
  }

  disallowRelatedLinks() {
    const link = this.data.getLinkWithRel('related');
    this.t.truthy(!link, `must NOT have a 'related' link`);
  }

  async requireParentLink(path) {
    await this.checkStacLink('parent', path);
  }

  async requireRootLink(path) {
    await this.checkStacLink('root', path);
  }

  async checkStacLink(type, expectedPath) {
    const link = this.data.getLinkWithRel(type);
    this.t.truthy(isObject(link), `must have ${type} link`);
    if (!isObject(link)) {
      return;
    }
    // @todo: make more robust and make it work with absolute links
    this.t.equal(link.href, expectedPath, `${type} link must point to ${expectedPath}`);
    this.t.equal(link.type, "application/json", `${type} link type must be of type application/json`);

    if (typeof link.title !== 'undefined') {
      await this.checkLinkTitle(link);
    }
  }

  requireViaLink() {
    const link = this.data.getLinkWithRel("via");
    this.t.truthy(isObject(link), "must have 'via' link");
    // @todo: enable if we can ensure that all links have a HTML media type
    // this.test.equal(link.type, "text/html", "via link type must be of type text/html");
  }

}

module.exports = CustomValidator;
