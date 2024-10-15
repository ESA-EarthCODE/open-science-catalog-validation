const ConfigSource = require('stac-node-validator/src/config.js');
const validate = require('stac-node-validator/src/index.js');
const { printSummary, resolveFiles, printReport, abort } = require('stac-node-validator/src/nodeUtils');
const nodeLoader = require('stac-node-validator/src/loader/node');
const { getSummary } = require('stac-node-validator/src/utils');
const CustomValidator = require('./validate-stac-custom.js');
const validateRecords = require('./validate-records.js');

async function run() {
	console.log(`OSC Validator`);
	console.log();

	// Read config from CLI and config file (if any)
	let config = ConfigSource.fromCLI();
	config.loader = nodeLoader;
	config.custom = "./validate-stac-custom.js";
	config.customValidator = new CustomValidator();

	// Abort if no files have been provided
	if (config.files.length === 0) {
		abort('No path or URL specified.');
	}

	// Verify files exist / read folders
	let data = await resolveFiles(config.files, config.depth);
	delete config.files;
	if (data.length === 1) {
		data = data[0];
	}


	// Run STAC validation
	const result = await validate(data, config);

	// Run Records validation
	await validateRecords(data, config, result);

	// Print report and summary
	printReport(result, config);
	if (config.verbose || !result.valid) {
		console.log();
	}

	const summary = getSummary(result, config);
	printSummary(summary);

	// Exit with error code or report success
	process.exit(summary.invalid > 0 ? 1 : 0);
}

run().catch(error => {
	console.error(error);
	process.exit(2);
});
