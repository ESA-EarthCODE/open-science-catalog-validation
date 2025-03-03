const BaseValidator = require('stac-node-validator/src/baseValidator.js');
const { isObject, loadSchema } = require('stac-node-validator/src/utils.js');
const fs = require('fs-extra');
const path = require('path');
const sizeOf = require('image-size');
const {
  EXTENSION_SCHEMES,
  ROOT_CHILDREN,
  RELATED_TITLE_PREFIX,
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
    if (typeof data.stac_version !== 'undefined') {
      // Skip this for STAC entities
      return null;
    }

    const createTestFn = (fn) => async (report, test) => {
      const run = new ValidationRun(this, data, test, report);

      test.truthy(Array.isArray(data.conformsTo), 'must have a "conformsTo" array');
      test.truthy(data.conformsTo.includes(RECORDS_CONFORMANCE_CLASS), `must conform to ${RECORDS_CONFORMANCE_CLASS}`);
  
      await run[fn]();
    };

    await this.validateSchema(data, report, config, 'core', 'records.json');

    const isWorkflow = !!report.id.match(/\/workflows\/[^\/]+\/record.json/);
    const isExperiment = !!report.id.match(/\/experiments\/[^\/]+\/record.json/);
    if (isWorkflow) {
      await this.validateSchema(data, report, config, 'custom', 'workflows/children.json');
      await this.testFn(report, createTestFn('validateWorkflow'));
    }
    else if (isExperiment) {
      await this.validateSchema(data, report, config, 'custom', 'experiments/children.json');
      await this.testFn(report, createTestFn('validateExperiment'));
    }

    // Return report and abort validation
    return report;
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
    this.linkPrefix = "https://esa-earthcode.github.io/open-science-catalog-metadata/";
    this.folder = path.dirname(this.report.id);
    const rootLink = this.getLinkWithRel(data, 'root');
    if (rootLink) {
      this.rootFolder = path.resolve(this.report.id, rootLink.href);
    }
    else {
      this.rootFolder = path.dirname(this.folder);
    }
  }

  resolve(href, root = false) {
    if (href.startsWith(this.linkPrefix)) {
      href = href.slice(this.linkPrefix.length);
    }
    const basePath = root ? this.rootFolder : this.folder;
    return path.resolve(basePath, href);
  }

  async validateRoot() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.t.equal(this.data.id, "osc", `id must be 'osc'`);
    this.t.equal(this.data.title, "Open Science Catalog", `title must be 'Open Science Catalog'`);

    // check parent and root
    await this.requireRootLink("./catalog.json");
    this.t.truthy(!this.getLinkWithRel(this.data, 'parent'), "must NOT have a parent");
    this.checkStacLinksRelativeAbsolute();

    // check child links
    await this.requireChildLinksForOtherJsonFiles(ROOT_CHILDREN);
  }

  async validateSubCatalogs(childStacType) {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.ensureIdIsFolderName();

    // check that catalog.json is parent and root
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../catalog.json");
    this.checkStacLinksRelativeAbsolute();

    // check child links
    const relType = childStacType === 'Record' ? 'item' : 'child';
    await this.requireChildLinksForOtherJsonFiles(null, childStacType.toLowerCase(), relType);
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
    await this.checkChildLinks();
    this.checkStacLinksRelativeAbsolute();
  }

  async validateProduct() {
    this.t.equal(this.data.type, "Collection", `type must be 'Collection'`);
    this.hasExtensions(["osc"]);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
    this.checkStacLinksRelativeAbsolute(false);

    this.t.equal(this.data["osc:type"], "product", `'osc:type' must be 'product'`);
    this.t.equal(typeof this.data["osc:project"], 'string', `'osc:project' must be a string`);
    await this.checkOscCrossRef(this.data["osc:project"], "projects", true); // required
    await this.checkOscCrossRefArray(this.data, "osc:variables", "variables");
    await this.checkOscCrossRefArray(this.data, "osc:missions", "eo-missions");
    await this.checkOscCrossRef(this.data["osc:experiment"], "experiments");

    await this.checkThemes(this.data);
  }

  async validateProject() {
    this.t.equal(this.data.type, "Collection", `type must be 'Collection'`);
    this.hasExtensions(["osc", "contacts"]);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
    await this.checkChildLinks();
    this.checkStacLinksRelativeAbsolute();

    this.requireTechnicalOfficer();

    this.t.equal(this.data["osc:type"], "project", `'osc:type' must be 'project'`);

    await this.checkOscCrossRefArray(this.data, "osc:workflows", "workflows");

    await this.checkThemes(this.data);
  }

  async validateTheme() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.ensureIdIsFolderName();

    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
    await this.checkChildLinks();
    this.checkStacLinksRelativeAbsolute();

    this.checkPreviewImage();
  }

  async validateVariable() {
    this.t.equal(this.data.type, "Catalog", `type must be 'Catalog'`);
    this.hasExtensions(["themes"]);
    this.ensureIdIsFolderName();

    this.requireViaLink();
    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
    await this.checkChildLinks();
    this.checkStacLinksRelativeAbsolute();

    await this.checkThemes(this.data);
  }

  async validateWorkflow() {
    this.t.equal(this.data.type, "Feature", `type must be 'Feature'`);
    this.ensureIdIsFolderName();

    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
    await this.checkChildLinks("experiments", "record");
    this.checkStacLinksRelativeAbsolute(false);

    // note: osc fields are in properties, not on the top-level!
    this.t.equal(typeof this.data.properties["osc:project"], 'string', `'osc:project' must be a string`);
    await this.checkOscCrossRef(this.data.properties["osc:project"], "projects", true); // required
  }

  async validateExperiment() {
    this.t.equal(this.data.type, "Feature", `type must be 'Feature'`);
    this.ensureIdIsFolderName();

    await this.requireParentLink("../catalog.json");
    await this.requireRootLink("../../catalog.json");
    await this.checkChildLinks();
    this.checkStacLinksRelativeAbsolute(false);

    // note: osc fields are in properties, not on the top-level!
    this.t.equal(typeof this.data.properties["osc:workflow"], 'string', `'osc:workflow' must be a string`);
    await this.checkOscCrossRef(this.data.properties["osc:workflow"], "workflows", true); // required

    this.hasLinkWithRel(this.data, "environment");
    this.hasLinkWithRel(this.data, "input");
  }

  hasLinkWithRel(data, rel) {
    const link = this.getLinkWithRel(data, rel);
    this.t.truthy(isObject(link), `must have ${rel} link`);
    return link;
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
    const link = this.hasLinkWithRel(this.data, "preview");
    if (!link) {
      return;
    }
    this.t.equal(link.type, "image/webp");
    this.t.equal(link["proj:epsg"], null);

    const previewPath = this.resolve(link.href);

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
  async checkChildLinks(expectedType = "products", expectedFilename = "collection") {
    const links = this.data.links.filter(link => link.rel === "child");
    for(const link of links) {
      this.t.equal(link.type, 'application/json', `Link with relation 'child' to ${link.href} must be of type 'application/json'`);
      const type = path.basename(path.dirname(path.dirname(link.href)));
      const filename = path.basename(link.href);
      this.t.equal(type, expectedType, `Link with relation 'child' to ${link.href} must point to a file in folder '${expectedType}'`);
      this.t.equal(filename, expectedFilename + ".json", `Link with relation 'child' to ${link.href} must point to a file with name '${expectedFilename}.json'`);
      await this.checkLinkTitle(link);
    }

    const linkHrefs = links.map(link => this.resolve(link.href));
    const fileChecks = await Promise.all(linkHrefs.map(async (x) => await this.parent.fileExists(x)));
    for (let i = 0; i < linkHrefs.length; i++) {
      this.t.truthy(fileChecks[i], `must have file for link ${linkHrefs[i]} with relation 'child'`);
    }
  }

  // check that all files are linked to as child links and that all child links exist
  async requireChildLinksForOtherJsonFiles(files = null, filename = "collection", linkRel = 'child') {
    if (Array.isArray(files)) {
      files = files.map(file => this.resolve(file));
    }
    else {
      files = [];
      const dir = await fs.opendir(this.folder);
      for await (const file of dir) {
        if (file.isDirectory()) {
          if (filename) {
            files.push(`${this.folder}/${file.name}/${filename}.json`);
          }
          else {
            const subfolder = `${this.folder}/${file.name}`;
            const subdir = await fs.opendir(subfolder);
            for await (const file of subdir) {
              if (file.name.endsWith(`.json`)) {
                files.push(`${subfolder}/${file.name}`);
              }
            }
          }
        }
      }
    }
    files = files.map(file => this.resolve(file));

    const links = this.data.links.filter(link => link.href && link.rel === linkRel);
    for(const link of links) {
      this.t.equal(link.type, 'application/json', `Link with relation ${linkRel} to ${link.href} must be of type 'application/json'`);
      await this.checkLinkTitle(link);
    }

    const linkHrefs = links.map(link => this.resolve(link.href));

    const missingChilds = files.filter(x => !linkHrefs.includes(x));
    for(const file of missingChilds) {
      this.t.fail(`must have link with relation ${linkRel} to ${file}`);
    }

    const missingFiles = linkHrefs.filter(x => !files.includes(x));
    for(const file of missingFiles) {
      this.t.fail(`must have file for link ${file} with relation ${linkRel}`);
    }
  }

  async checkLinkTitle(link, prefix = '') {
    const href = this.resolve(link.href);
    const title = await this.parent.getTitleForFile(href);
    if (typeof title === "string") {
      if (prefix) {
        this.t.equal(link.title, prefix + title, `Title of link to ${link.href} (rel: ${link.rel}) must be '${prefix + title}'`);
      }
      else {
        this.t.equal(link.title, title, `Title of link to ${link.href} (rel: ${link.rel}) is not the title of the linked file ${href}`);
      }
    }
  }

  async checkThemes(data) {
    this.t.truthy(Array.isArray(data.themes), `'themes' must be present as an array`);
    this.t.truthy(data.stac_extensions.includes(EXTENSION_SCHEMES.themes), `themes extension must be implemented`);
    if (!Array.isArray(data.themes)) {
      return;
    }
    const theme = data.themes.find(theme => theme.scheme == THEMES_SCHEME);
    this.t.truthy(theme, `must have theme with scheme '${THEMES_SCHEME}'`);
    this.t.truthy(Array.isArray(theme.concepts), `concepts in themes must be present as an array`);
    // Check cross references (i.e. whether given theme has a catalog in /themes/)
    if (Array.isArray(theme.concepts)) {
      await Promise.all(theme.concepts.map(async (obj) => {
        const filepath = this.resolve(`../../themes/${obj.id}/catalog.json`);
        const exists = await this.parent.fileExists(filepath);
        this.t.truthy(exists, `The referenced theme '${obj.id}' must exist at ${filepath}`);
      }));
      this.t.truthy(Array.isArray(data.links), `'links' must be present as an array`);
      await Promise.all(theme.concepts.map(async (obj) => await this.checkRelatedLink(data, "themes", obj.id, "catalog")));
    }
  }

  async checkRelatedLink(data, type, id, file = "collection") {
    const link = data.links.find(link => link.rel === "related" && link.href.endsWith(`/${type}/${id}/${file}.json`));
    this.t.truthy(link, `must have a 'related' link to ${type} with id '${id}'`);
    if (link) {
      this.t.truthy(link.type === "application/json", `type of 'related' link to ${type} with id '${id}' must be 'application/json'`);
      const prefix = RELATED_TITLE_PREFIX[type] + ': ';
      this.checkLinkTitle(link, prefix);
      const folder = path.basename(path.dirname(path.dirname(link.href)));
      this.t.truthy(folder !== 'products', `products should be 'child' links, not 'related' links`);
    }
  }

  async checkOscCrossRefArray(parent, field, type, required = false) {
    const values = parent[field];
    if (required) {
      this.t.truthy(Array.isArray(values), `'${field}' must be present as an array`);
    }
    if (Array.isArray(values)) {
      await Promise.all(values.map(value => this.checkOscCrossRef(value, type, true)));
    }
  }

  async checkOscCrossRef(value, type, required = false) {
    if (!value && !required) {
      return;
    }
    let filename;
    switch(type) {
      case "projects":
      case "products":
        filename = "collection";
        break;
      case "experiments":
      case "workflows":
        filename = "record";
        break;
      default:
        filename = "catalog";
    }
    const filepath = this.resolve(`../../${type}/${value}/${filename}.json`);
    const exists = await this.parent.fileExists(filepath);
    this.t.truthy(exists, `The referenced ${type} '${value}' must exist at ${filepath}`);
    await this.checkRelatedLink(this.data, type, value, filename);
  }

  requireTechnicalOfficer() {
    // Check for technical officer information
    this.t.truthy(Array.isArray(this.data.contacts), "must have contacts");
    if (!Array.isArray(this.data.contacts)) {
      return;
    }
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

  checkStacLinksRelativeAbsolute(includeItemChild = true) {
    const relativeRelTypes = ['related', 'parent'];
    if (includeItemChild) {
      relativeRelTypes.push('item');
      relativeRelTypes.push('child');
    }
    for(let link of this.data.links) {
      if (link.rel === 'self') {
        this.t.truthy(link.href.startsWith(this.linkPrefix), `Link with rel '${link.rel}' to '${link.href}' must start with '${this.linkPrefix}'`);
      }
      else if (relativeRelTypes.includes(link.rel)) {
        this.t.truthy(!link.href.includes('://'), `Link with rel '${link.rel}' to '${link.href}' must be relative`)
        return ;
      }
    }
  }

  async checkStacLink(type, expectedPath) {
    const link = this.hasLinkWithRel(this.data, type);
    if (!link) {
      return;
    }
    this.t.equal(this.resolve(link.href), this.resolve(expectedPath), `${type} link must point to ${expectedPath}`);
    this.t.equal(link.type, "application/json", `${type} link type must be of type application/json`);

    await this.checkLinkTitle(link);
  }

  requireViaLink() {
    this.hasLinkWithRel(this.data, "via");
  }

}

module.exports = CustomValidator;
