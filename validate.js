const BaseValidator = require('stac-node-validator/src/baseValidator.js');
const { isObject, loadSchema } = require('stac-node-validator/src/utils.js');
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
    this.validators = {};
    this.fileExistsCache = {};
  }

  async getValidator(config, filepath) {
    if (!this.validators[filepath]) {
      this.validators[filepath] = await loadSchema(config, filepath);
    }
    return this.validators[filepath];
  }

  async getTitleForFile(file) {
    if (typeof this.titles[file] === 'undefined') {
      try {
        const stac = await fs.readJson(file);
        this.registerTitle(file, stac);
      } catch (error) {
        this.titles[file] = null;
      }
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

  async validateSchema(data, report, config, key, schema) {
    schema = this.getSchemaUrl(config, schema);
    const setValidity = (errors = []) => {
      report.valid = report.valid !== false && errors.length === 0;
      report.results[key] = errors;
    };
    try {
      const fn = await this.getValidator(config, schema);
      const valid = fn(data);
      if (!valid) {
        setValidity(fn.errors);
      }
      else {
        setValidity();
      }
    } catch (error) {
      setValidity([{ message: error.message }]);
    }
  }

  async bypassValidation(data, report, config) {
    if (!Array.isArray(data.conformsTo) || !data.conformsTo.includes(RECORDS_CONFORMANCE_CLASS)) {
      return null;
    }

    await this.validateSchema(data, report, config, 'core', 'records.json');

    const isWorkflow = !!report.id.match(/\/workflows\/[^\/]+\/record.json/);
    const isExperiment = !!report.id.match(/\/experiments\/[^\/]+\/record.json/);
    const test = new Test();
    const run = new ValidationRun(this, data, test, report);
    if (isWorkflow) {
      await this.validateSchema(data, report, config, 'custom', 'workflows/children.json');
      await run.validateWorkflow();
    }
    else if (isExperiment) {
      await this.validateSchema(data, report, config, 'custom', 'experiments/children.json');
      await run.validateExperiment();
    }

    // If stac_version is present, continue with STAC validation additionally.
    // Otherwise return report and abort validation.
    return (typeof data.stac_version !== 'string') ? report : null;
  }

  getSchemaUrl(config, filepath) {
    const url = new URL(filepath, config.SCHEMA_URL);
    return url.toString();
  }

  async afterLoading(data, report, config) {
    // Add UI schema to STAC extensions to validate against them additionally
    const match = report.id.match(/\/(eo-missions|products|projects|themes|variables|workflows|experiments)\/(catalog.json|.+)/);
    if (match) {
      const type = match[1];
      const level = match[2] === 'catalog.json' ? 'parent' : 'children';
      if (!Array.isArray(data.stac_extensions)) {
        data.stac_extensions = [];
      }
      data.stac_extensions.push(this.getSchemaUrl(config, `${type}/${level}.json`));
    }

    // Cache title to allow checks for consistent titles
    this.registerTitle(report.id, data);

    return data;
  }

  async fileExists(filepath) {
    if (typeof this.fileExistsCache[filepath] === 'undefined') {
      this.fileExistsCache[filepath] = await fs.pathExists(filepath);
    }
    return this.fileExistsCache[filepath];
  }

  async afterValidation(data, test, report, config) {
    const isRootCatalog = report.id.endsWith('/catalog.json') && data.id === "osc";
    const isEoMission = !!report.id.match(/\/eo-missions\/[^\/]+\/catalog.json/);
    const isProduct = !!report.id.match(/\/products\/[^\/]+\/collection.json/);
    const isProductUserContent = !!report.id.match(/\/products\/[^\/]+\/.+.json/) && !isProduct;
    const isProject = !!report.id.match(/\/projects\/[^\/]+\/collection.json/);
    const isTheme = !!report.id.match(/\/themes\/[^\/]+\/catalog.json/);
    const isVariable = !!report.id.match(/\/variables\/[^\/]+\/catalog.json/);
    const isSubCatalog = !!report.id.match(/\/(eo-missions|products|projects|themes|variables|workflows|experiments)\/catalog.json/);

    // Ensure consistent STAC version
    test.truthy(["1.0.0", "1.1.0"].includes(data.stac_version), `stac_version must be '1.0.0'`);

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
      else if (['workflows', 'experiments'].includes(childEntity)) {
        childStacType = 'Record';
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
    this.t.truthy(!this.getLinkWithRel(this.data, 'parent'), "must NOT have a parent");

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
    const relType = childStacType === 'Record' ? 'item' : 'child';
    await this.requireChildLinksForOtherJsonFiles(childStacType, [], relType);
  }

  validateUserContent() {
    // todo: Which rules apply?
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

    // todo: require related link to project based on osc:project
    // todo: check related link to variables based on osc:variables
    // todo: check related link to missions based on osc:missions
    // todo: check related link to experiment based on osc:experiment
    // todo: check related link to themes based on themes

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");

    this.t.equal(this.data["osc:type"], "product", `'osc:type' must be 'product'`);
    this.t.equal(typeof this.data["osc:project"], 'string', `'osc:project' must be a string`);
    if (typeof this.data["osc:project"] === 'string') {
      await this.checkOscCrossRef(this.data["osc:project"], "projects");
    }
    await this.checkOscCrossRefArray(this.data, "osc:variables", "variables");
    await this.checkOscCrossRefArray(this.data, "osc:missions", "eo-missions");

    await this.checkThemes(this.data);
  }

  async validateProject() {
    this.t.equal(this.data.type, "Collection", `type must be 'Collection'`);
    this.hasExtensions(["osc", "contacts"]);
    this.ensureIdIsFolderName();

    // todo: check related link to workflows based on osc:workflows
    // todo: check related link to themes based on themes

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");

    this.requireTechnicalOfficer();

    this.t.equal(this.data["osc:type"], "project", `'osc:type' must be 'project'`);
    this.t.truthy(typeof data['osc:project'] === 'undefined', `'osc:project' must be NOT be present`);
    this.t.truthy(typeof data['osc:variables'] === 'undefined', `'osc:variables' must be NOT be present`);
    this.t.truthy(typeof data['osc:missions'] === 'undefined', `'osc:missions' must be NOT be present`);

    await this.checkThemes(this.data);
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

    await this.checkThemes(this.data);
  }

  async validateWorkflow() {
    this.t.equal(this.data.type, "Feature", `type must be 'Feature'`);
    this.ensureIdIsFolderName();

    // todo: require related link to project based on osc:project
    // todo: check related links to experiments based on osc:experiments
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
  }

  async validateExperiment() {
    this.t.equal(this.data.type, "Feature", `type must be 'Feature'`);
    this.ensureIdIsFolderName();

    // todo: require related links to project based on osc:project, osc:workflow, osc:product
    // tood: require links with relation types "environment" and "input"
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
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
    const link = this.getLinkWithRel(this.data, "preview");
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
  async requireChildLinksForOtherJsonFiles(type, files = [], linkRel = 'child', fileExt = 'json', linkType = 'application/json') {
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

  async checkThemes(data) {
    this.t.truthy(Array.isArray(data.themes), `'themes' must be present as an array`);
    this.t.truthy(typeof data['osc:themes'] === 'undefined', `'osc:themes' must be NOT be present any longer`);
    this.t.truthy(data.stac_extensions.includes(EXTENSION_SCHEMES.themes), `themes extension must be implemented`);
    const theme = data.themes.find(theme => theme.scheme == THEMES_SCHEME);
    this.t.truthy(theme, `must have theme with scheme '${THEMES_SCHEME}'`);
    this.t.truthy(Array.isArray(theme.concepts), `concepts in themes must be present as an array`);
    // Check cross references (i.e. whether given theme has a catalog in /themes/)
    if (Array.isArray(theme.concepts)) {
      await Promise.all(theme.concepts.map(async (obj) => {
        const filepath = this.resolve(this.folder, `../../themes/${obj.id}/catalog.json`);
        const exists = await this.parent.fileExists(filepath);
        this.t.truthy(exists, `The referenced theme '${obj.id}' must exist at ${filepath}`);
      }));
      this.t.truthy(Array.isArray(data.links), `'links' must be present as an array`);
      theme.concepts.forEach((obj) => {
        const link = data.links.find(link => link.rel === "related" && link.href.endsWith(`/themes/${obj.id}/catalog.json`));
        this.t.truthy(link, `must have a 'related' link to the theme '${obj.id}'`);
        if (link) {
          this.t.truthy(link.type === "application/json", `type of 'related' link to the theme '${obj.id}' must be 'application/json'`);
        }
      });
    }
  }

  async checkOscCrossRefArray(data, field, type) {
    const values = data[field];
    this.t.truthy(Array.isArray(values), `'${field}' must be present as an array`);
    if (Array.isArray(values)) {
      await Promise.all(values.map(value => this.checkOscCrossRef(value, type)));
    }
  }

  async checkOscCrossRef(value, type) {
    const slug = this.slugify(value);
    const filename = ['products', 'projects'].includes(type) ? 'collection' : 'catalog';
    const filepath = this.resolve(this.folder, `../../${type}/${slug}/${filename}.json`);
    const exists = await await this.parent.fileExists(filepath);
    this.t.truthy(exists, `The referenced ${type} '${value}' must exist at ${filepath}`);
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
    const link = this.getLinkWithRel(this.data, 'related');
    this.t.truthy(!link, `must NOT have a 'related' link`);
  }

  async requireParentLink(path) {
    await this.checkStacLink('parent', path);
  }

  async requireRootLink(path) {
    await this.checkStacLink('root', path);
  }

  getLinkWithRel(data, rel) {
    if (!Array.isArray(data.links)) {
      return null;
    }
    return data.links.find(link => link.href && link.rel === rel) || null;
  }

  async checkStacLink(type, expectedPath) {
    const link = this.getLinkWithRel(this.data, type);
    this.t.truthy(isObject(link), `must have ${type} link`);
    if (!isObject(link)) {
      return;
    }
    // todo: make more robust and make it work with absolute links
    this.t.equal(link.href, expectedPath, `${type} link must point to ${expectedPath}`);
    this.t.equal(link.type, "application/json", `${type} link type must be of type application/json`);

    await this.checkLinkTitle(link);
  }

  requireViaLink() {
    const link = this.getLinkWithRel(this.data, "via");
    this.t.truthy(isObject(link), "must have 'via' link");
    // todo: enable if we can ensure that all links have a HTML media type
    // this.test.equal(link.type, "text/html", "via link type must be of type text/html");
  }

}

module.exports = CustomValidator;
